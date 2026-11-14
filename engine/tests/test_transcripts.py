import json

from diffusion.chat_agent import SHOW_REMINDER
from diffusion.transcripts import find_transcript, merge, read_claude, read_codex, session_turns


def write(path, entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\nnot json\n")


def user(content, **kw):
    return {"type": "user", "message": {"role": "user", "content": content}, **kw}


def assistant(*blocks):
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks)}}


CLAUDE = [
    user("<command-name>/clear</command-name>"),
    user("Write the guide <system-reminder>noise</system-reminder>"),
    assistant({"type": "thinking", "thinking": "Look at the diff."}),
    assistant({"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "git diff"}}),
    user([{"type": "tool_result", "tool_use_id": "t1", "content": "…"}]),
    assistant({"type": "tool_use", "id": "t2", "name": "mcp__x__post_message", "input": {}}),
    user([{"type": "tool_result", "tool_use_id": "t2", "content": "no such tool", "is_error": True}]),
    assistant({"type": "text", "text": "Done."}),
    user("side quest", isSidechain=True),
    user("meta", isMeta=True),
    user([{"type": "text", "text": "And the tests?"}]),
    assistant({"type": "text", "text": "They pass."}),
]


def test_reads_a_claude_session_as_turns(tmp_path):
    p = tmp_path / "s.jsonl"
    write(p, CLAUDE)
    turns = read_claude(p)
    assert [t["questions"][0]["text"] for t in turns] == ["Write the guide", "And the tests?"]
    assert turns[0]["answers"]["0"] == "Done."
    assert turns[0]["trace"] == [
        {"think": "Look at the diff."},
        {"tool": "Ran git diff", "id": "t1"},
        {"tool": "post_message", "id": "t2", "failed": True},
    ]
    assert turns[1]["answers"]["0"] == "They pass." and turns[1]["source"] == "session"


def test_harness_envelopes_keep_the_persons_words_and_drop_the_rest(tmp_path):
    p = tmp_path / "s.jsonl"
    wake = '<wake reason="mention"><thread><message from="human" id="m1">No, not &lt;that&gt;.</message></thread></wake>'
    write(p, [
        user(wake),
        assistant({"type": "text", "text": "Got it."}),
        user("<task-notification>\n<status>pending</status>\n</task-notification>"),
        assistant({"type": "tool_use", "id": "n1", "name": "ReadNotifications", "input": {}}),
        assistant({"type": "text", "text": "No response requested."}),
        user("plain"),
    ])  # fmt: skip
    turns = read_claude(p)
    assert [t["questions"][0]["text"] for t in turns] == ["No, not <that>.", "plain"]
    # the work done for the notification stays with the turn before it; the reply to the harness doesn't
    assert turns[0]["answers"]["0"] == "Got it."
    assert turns[0]["trace"] == [{"tool": "ReadNotifications", "id": "n1"}]


def test_reads_a_codex_session_as_turns(tmp_path):
    def item(payload):
        return {"type": "response_item", "payload": payload}

    p = tmp_path / "rollout-2026-11-13T10-00-00-th_9.jsonl"
    write(p, [
        {"type": "session_meta", "payload": {"id": "th_9"}},
        item({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>x"}]}),
        item({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Explain it"}]}),
        item({"type": "reasoning", "summary": [{"type": "summary_text", "text": "**Reading**"}]}),
        item({"type": "function_call", "name": "shell", "arguments": '{"command": ["rg", "foo"]}', "call_id": "c1"}),
        item({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "It's foo."}]}),
    ])  # fmt: skip
    (t,) = read_codex(p)
    assert t["questions"][0]["text"] == "Explain it" and t["answers"]["0"] == "It's foo."
    assert t["trace"] == [{"think": "**Reading**"}, {"tool": "Ran rg foo", "id": "c1"}]


def test_finds_transcripts_where_each_cli_keeps_them(tmp_path, monkeypatch):
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    write(tmp_path / ".claude/projects/-repo/abc.jsonl", CLAUDE)
    write(tmp_path / ".codex/sessions/2026/11/13/rollout-x-th_9.jsonl", [])
    assert getattr(find_transcript("claude-code", "abc", tmp_path), "name", None) == "abc.jsonl"
    assert str(find_transcript("codex", "th_9", tmp_path)).endswith("th_9.jsonl")
    assert find_transcript("cursor", "abc", tmp_path) is None
    assert find_transcript("claude-code", "../abc", tmp_path) is None
    assert session_turns("claude-code", "nope", tmp_path) is None


def test_merge_keeps_diffusions_own_record_of_its_turns():
    def t(text):
        return {"questions": [{"n": 1, "text": text}], "answers": {}}

    session = [t("terminal"), t(f"About `a.ts:3`\nwhy?\n\n{SHOW_REMINDER}"), t("terminal again")]
    session[1]["trace"] = [{"tool": "post_message", "id": "t1", "failed": True}]
    stored = [{**t("why?"), "shows": ["x"], "trace": [{"tool": "post_message"}]}, t("still streaming")]
    out = merge(session, stored, lambda text: text.endswith(SHOW_REMINDER))
    assert [q["questions"][0]["text"] for q in out] == [
        "terminal",
        "why?",
        "terminal again",
        "still streaming",
    ]
    assert out[1]["shows"] == ["x"] and out[1]["trace"][0]["failed"]
    assert merge(None, stored, lambda _: False) == stored


def test_a_slash_command_shows_as_typed():
    from diffusion.transcripts import _user_text

    rec = "<command-message>code-review</command-message>\n<command-name>/code-review</command-name>\n<command-args>auth</command-args>"
    assert _user_text(rec) == "/code-review auth"
    assert _user_text("<command-name>/compact</command-name>") == "/compact"


def test_merge_keeps_a_steered_message_in_the_turn_it_joined():
    def t(text, trace=()):
        return {"questions": [{"n": 1, "text": text}], "answers": {}, "trace": list(trace)}

    # the transcript has the steered message as a prompt of its own
    session = [
        t(f"why?\n\n{SHOW_REMINDER}", [{"tool": "Read a"}]),
        t(f"and b?\n\n{SHOW_REMINDER}"),
        t("later"),
    ]
    mine = {
        "questions": [{"n": 1, "text": "why?"}, {"n": -1, "text": "and b?", "steered": 1}],
        "answers": {},
        "steers": 1,
        "trace": [{"tool": "Read a"}, {"steered": 1}, {"tool": "Read b"}],
    }
    out = merge(session, [mine], lambda text: text.endswith(SHOW_REMINDER))
    assert [len(x["questions"]) for x in out] == [2, 1]
    assert out[0]["trace"] == mine["trace"] and out[1]["questions"][0]["text"] == "later"


def test_a_rewound_claude_session_shows_only_the_branch_it_continued(tmp_path):
    def link(e, uuid, parent, **kw):
        return {**e, "uuid": uuid, "parentUuid": parent, **kw}

    p = tmp_path / "s.jsonl"
    write(p, [
        link(user("first"), "a", None),
        link(assistant({"type": "text", "text": "one"}), "b", "a"),
        link(user("second"), "c", "b"),  # rewound: edited into "second, edited"
        link(assistant({"type": "text", "text": "two"}), "d", "c"),
        link(user("second, edited"), "e", "b"),
        link(assistant({"type": "text", "text": "two again"}), "f", "e"),
        {"type": "system", "subtype": "compact_boundary", "uuid": "g", "parentUuid": None, "logicalParentUuid": "f"},
        link(user("after compacting"), "h", "g"),
    ])  # fmt: skip
    turns = read_claude(p)
    assert [t["questions"][0]["text"] for t in turns] == ["first", "second, edited", "after compacting"]
    assert turns[1]["answers"]["0"] == "two again"
