import json

from diffusion.chat_agent import TURN_NOTE
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


def test_reads_newer_codex_exec_scripts_and_skill_runs(tmp_path):
    def item(payload):
        return {"type": "response_item", "payload": payload}

    def say(role, text, **kw):
        return item(
            {"type": "message", "role": role, "content": [{"type": "input_text", "text": text}], **kw}
        )

    p = tmp_path / "rollout-2026-11-15T23-42-18-th_7.jsonl"
    write(p, [
        say("user", "# AGENTS.md instructions for /repo"),
        say("user", "$diffusion:review https://github.com/o/r/pull/1"),
        say("user", "<skill>\n<name>diffusion:review</name>\nWrite a guide.\n</skill>"),
        say("assistant", "Reading the skill.", phase="commentary"),
        item({"type": "custom_tool_call", "name": "exec", "call_id": "x1",
              "input": 'text(await tools.exec_command({cmd:"cat SKILL.md; ls \\"a b\\""}));'}),
        item({"type": "custom_tool_call", "name": "exec", "call_id": "x2",
              "input": 'for (const cmd of ["gh pr view 1", \'cat PORTING.md\']) text(await tools.exec_command({cmd}));'}),
        item({"type": "custom_tool_call", "name": "exec", "call_id": "x3",
              "input": "text(await tools.write_stdin({session_id:1,chars:''}));"}),
        item({"type": "custom_tool_call", "name": "exec", "call_id": "x4", "input": "const n = 1 + 1;"}),
        say("assistant", "[Open the review](http://x)\n\n<oai-mem-citation>\nMEMORY.md:1\n</oai-mem-citation>",
            phase="final_answer"),
    ])  # fmt: skip
    (t,) = read_codex(p)
    assert t["questions"][0]["text"] == "$diffusion:review https://github.com/o/r/pull/1"
    assert t["answers"]["0"] == "Reading the skill.\n\n[Open the review](http://x)"
    assert [x["tool"] for x in t["trace"]] == [
        'Ran cat SKILL.md; ls "a b"',
        "Ran gh pr view 1",
        "Ran cat PORTING.md",
        "Ran a script",
    ]


def test_codex_messages_carry_their_turn_id_to_revert_to(tmp_path):
    def item(text):
        return {
            "type": "response_item",
            "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]},
        }

    def ctx(tid):
        return {"type": "turn_context", "payload": {"turn_id": tid}}

    p = tmp_path / "rollout-x-th_9.jsonl"
    write(p, [
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t1"}},
        item("<environment_context>x"), ctx("t1"), item("first"), item("steered in"),
        ctx("t2"), item("second"),
    ])  # fmt: skip
    assert [(t["questions"][0]["text"], t.get("uuid")) for t in read_codex(p)] == [
        ("first", "t1"),
        ("steered in", None),  # it joined t1, so only reverting all of t1 would drop it
        ("second", "t2"),
    ]


def test_codex_history_follows_a_reverted_thread_into_its_new_segment(tmp_path, monkeypatch):
    def user(text):
        return {
            "type": "response_item",
            "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]},
        }

    def ctx(tid):
        return {"type": "turn_context", "payload": {"turn_id": tid}}

    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    day = tmp_path / "sessions/2026/11/14"
    first = day / "rollout-2026-11-14T10-00-00-th_9.jsonl"
    write(first, [{"type": "session_meta", "payload": {"id": "th_9"}}, ctx("tA"), user("A")])
    kept = first.stat().st_size  # the revert keeps the file up to here: B goes
    with first.open("a") as f:
        f.write(json.dumps(ctx("tB")) + "\n" + json.dumps(user("B")) + "\n")
    base = {"thread_id": "th_9", "end_byte_offset": kept}
    write(day / "rollout-2026-11-14T10-05-00-th_9_seg2.jsonl", [
        {"type": "session_meta", "payload": {"id": "th_9", "history_base": base}}, ctx("tB2"), user("B prime"),
    ])  # fmt: skip
    path = find_transcript("codex", "th_9")
    assert path and path.name.endswith("_seg2.jsonl")
    assert [(t["questions"][0]["text"], t["uuid"]) for t in read_codex(path)] == [
        ("A", "tA"),
        ("B prime", "tB2"),
    ]


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

    session = [t("terminal"), t(f"About `a.ts:3`\nwhy?\n\n{TURN_NOTE}"), t("terminal again")]
    session[1]["trace"] = [{"tool": "post_message", "id": "t1", "failed": True}]
    stored = [{**t("why?"), "guide_version": 2, "trace": [{"tool": "post_message"}]}, t("still streaming")]
    out = merge(session, stored, lambda text: text.endswith(TURN_NOTE))
    assert [q["questions"][0]["text"] for q in out] == [
        "terminal",
        "why?",
        "terminal again",
        "still streaming",
    ]
    assert out[1]["guide_version"] == 2 and out[1]["trace"][0]["failed"]
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
        t(f"why?\n\n{TURN_NOTE}", [{"tool": "Read a"}]),
        t(f"and b?\n\n{TURN_NOTE}"),
        t("later"),
    ]
    mine = {
        "questions": [{"n": 1, "text": "why?"}, {"n": -1, "text": "and b?", "steered": 1}],
        "answers": {},
        "steers": 1,
        "trace": [{"tool": "Read a"}, {"steered": 1}, {"tool": "Read b"}],
    }
    out = merge(session, [mine], lambda text: text.endswith(TURN_NOTE))
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
