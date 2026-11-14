import json
import stat
import sys

import pytest

from diffusion.agent import (
    AgentRequest,
    SandboxError,
    TextEvent,
    ThinkingEvent,
    ToolEvent,
    ToolFailedEvent,
    ToolSpec,
    within,
)
from diffusion.backends.claude_code import sandbox_decision, tool_names_note
from diffusion.backends.codex import codex_runner, thread_params
from diffusion.backends.codex import compose_prompt as codex_prompt
from diffusion.backends.cursor import build_args as cursor_args
from diffusion.backends.cursor import cursor_runner


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "repo"
    (r / "src").mkdir(parents=True)
    (r / "src" / "a.py").write_text("def refresh():\n    return 1\n\nrefresh()\n")
    (tmp_path / "secret.txt").write_text("SECRET\n")
    return r


async def collect(gen):
    return [e async for e in gen]


def test_within_blocks_escapes(repo):
    assert within(repo, "src/a.py") == (repo / "src/a.py").resolve()
    for bad in ["../secret.txt", str(repo.parent / "secret.txt"), "/etc/passwd", "src/../../secret.txt"]:
        with pytest.raises(SandboxError):
            within(repo, bad)


def test_within_blocks_symlink_escape(repo):
    (repo / "link").symlink_to(repo.parent / "secret.txt")
    with pytest.raises(SandboxError):
        within(repo, "link")


# ---------- claude-code sandbox hook ----------


def test_claude_code_sandbox_decision(repo):
    assert sandbox_decision("Read", {"file_path": str(repo / "src/a.py")}, repo) is None
    assert "outside" in (sandbox_decision("Read", {"file_path": str(repo.parent / "secret.txt")}, repo) or "")
    assert "outside" in (sandbox_decision("Grep", {"pattern": "x", "path": "/etc"}, repo) or "")
    assert sandbox_decision("Glob", {"pattern": "/etc/*"}, repo)
    assert sandbox_decision("Grep", {"pattern": "x"}, repo) is None
    assert sandbox_decision("mcp__diffusion__get_hunk", {"ids": ["H1"]}, repo) is None


# ---------- codex backend ----------


def test_codex_prompt_carries_the_system_prompt_where_the_session_lacks_it(tmp_path):
    req = AgentRequest("s", "p", "gpt-x", tmp_path, resume="th_1")
    assert thread_params(req)["model"] == "gpt-x" and thread_params(req)["approvalPolicy"] == "never"
    # a fork is someone else's session: it needs our system prompt; our own resumed one already has it
    forked = AgentRequest("s", "p", "", tmp_path, resume="th_1", fork=True)
    assert (
        codex_prompt(forked).startswith("s")
        and codex_prompt(req) == "p"
        and "model" not in thread_params(forked)
    )
    # the guide's own session, continued: written into, but it hasn't seen our system prompt yet
    adopted = AgentRequest("s", "p", "", tmp_path, resume="th_1", adopt=True)
    assert codex_prompt(adopted).startswith("s")


FAKE_APP_SERVER = r"""
import json, sys
log = open(sys.argv[1], "a")
script = json.load(open(sys.argv[2]))

def send(m):
    sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()

def note(method, **params):
    send({"method": method, "params": params})

for line in sys.stdin:
    m = json.loads(line)
    log.write(line); log.flush()
    method, rid, p = m.get("method"), m.get("id"), m.get("params") or {}
    if rid is None:
        continue
    if method == "initialize":
        send({"id": rid, "result": {}})
    elif method in ("thread/start", "thread/resume", "thread/fork"):
        send({"id": rid, "result": {"thread": {"id": p.get("threadId", "th_new") + ("_fork" if method == "thread/fork" else "")}}})
    elif method == "skills/list":
        send({"id": rid, "result": {"data": [{"cwd": ".", "skills": [{"name": "release", "description": "d", "path": "/s/release/SKILL.md", "enabled": True}]}]}})
    elif method == "turn/start":
        send({"id": rid, "result": {"turn": {"id": "tu_1"}}})
        for n in script["turn"]:
            send(n)
    elif method == "turn/steer":
        if script.get("steer") is None:
            send({"id": rid, "error": {"code": 1, "message": "no active turn"}})
        else:
            send({"id": rid, "result": {"turnId": "tu_1"}})
            text = p["input"][0]["text"]
            note("item/started", turnId="tu_1", item={"type": "userMessage", "id": "u2", "content": [{"type": "text", "text": text}]})
            for n in script["steer"]:
                send(n)
    elif method == "turn/interrupt":
        send({"id": rid, "result": {}})
"""


def fake_app_server(tmp_path, turn, steer=None):
    """A stand-in for ``codex app-server``: answers the calls, and plays ``turn`` (then ``steer``) as notifications."""
    (tmp_path / "server.py").write_text(FAKE_APP_SERVER)
    (tmp_path / "script.json").write_text(json.dumps({"turn": turn, "steer": steer}))
    exe = tmp_path / "codex"
    exe.write_text(
        f'#!/bin/sh\nexec "{sys.executable}" {tmp_path}/server.py {tmp_path}/calls.jsonl {tmp_path}/script.json\n'
    )
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return exe


def calls(tmp_path):
    return [json.loads(x) for x in (tmp_path / "calls.jsonl").read_text().splitlines()]


def n(method, **params):
    return {"method": method, "params": {"turnId": "tu_1", **params}}


async def test_codex_runner_streams_text_and_tools(tmp_path, repo):
    exe = fake_app_server(tmp_path, [
        n("item/reasoning/summaryTextDelta", delta="**Finding callers**"),
        n("item/started", item={"id": "1", "type": "commandExecution", "command": "rg refresh"}),
        n("item/completed", item={"id": "1", "type": "commandExecution", "command": "rg refresh", "exitCode": 1}),
        n("item/agentMessage/delta", delta="ans"),
        n("item/agentMessage/delta", delta="wer"),
        n("item/completed", item={"id": "2", "type": "agentMessage", "text": "answer"}),
        {"method": "turn/completed", "params": {"turn": {"id": "tu_1", "status": "completed"}}},
    ])  # fmt: skip
    evs = await collect(codex_runner(str(exe))(AgentRequest("SYS", "PROMPT", "m", repo)))
    done = evs[-1]
    assert not done.is_error and done.session_id == "th_new" and done.result == "answer"
    assert [e.summary for e in evs if isinstance(e, ToolEvent)] == ["Ran rg refresh"]
    assert [e.id for e in evs if isinstance(e, ToolFailedEvent)] == ["1"]
    assert "".join(e.text for e in evs if isinstance(e, TextEvent)) == "answer\n\n"
    assert [e.text for e in evs if isinstance(e, ThinkingEvent)] == ["**Finding callers**"]
    sent = {c["method"]: c.get("params") for c in calls(tmp_path)}
    assert sent["thread/start"]["sandbox"] == "read-only" and sent["thread/start"]["model"] == "m"
    prompt = sent["turn/start"]["input"][0]["text"]
    assert prompt.startswith("SYS") and "PROMPT" in prompt


async def test_codex_runner_failure(tmp_path, repo):
    exe = fake_app_server(tmp_path, [
        n("item/agentMessage/delta", delta="answer"),
        {"method": "turn/completed", "params": {"turn": {"id": "tu_1", "status": "failed", "error": {"message": "quota exceeded"}}}},
    ])  # fmt: skip
    evs = await collect(codex_runner(str(exe))(AgentRequest("s", "p", "", repo, resume="th_1", fork=True)))
    assert [e.text for e in evs if isinstance(e, TextEvent)] == ["answer"]
    assert evs[-1].is_error and evs[-1].result == "quota exceeded"
    assert "thread/fork" in {c["method"] for c in calls(tmp_path)}


async def test_codex_runs_a_skill_by_name(tmp_path, repo):
    exe = fake_app_server(
        tmp_path, [{"method": "turn/completed", "params": {"turn": {"id": "tu_1", "status": "completed"}}}]
    )
    await collect(codex_runner(str(exe))(AgentRequest("s", "$release cut 1.2", "", repo, resume="th_1")))
    start = next(c for c in calls(tmp_path) if c["method"] == "turn/start")["params"]["input"]
    assert start[1] == {"type": "skill", "name": "release", "path": "/s/release/SKILL.md"}


async def test_codex_takes_a_steered_message_into_the_running_turn(tmp_path, repo):
    import asyncio

    from diffusion.agent import SteeredEvent

    exe = fake_app_server(
        tmp_path,
        [n("item/agentMessage/delta", delta="first")],  # still working: the turn hasn't completed
        steer=[
            n("item/agentMessage/delta", delta="second"),
            {"method": "turn/completed", "params": {"turn": {"id": "tu_1", "status": "completed"}}},
        ],
    )
    steer: asyncio.Queue = asyncio.Queue()
    accepted = asyncio.get_running_loop().create_future()
    evs = []
    async for ev in codex_runner(str(exe))(AgentRequest("s", "p", "", repo, steer=steer)):
        evs.append(ev)
        if isinstance(ev, TextEvent) and ev.text == "first":
            await steer.put(("also this", accepted))
    assert accepted.result() is True
    kinds = [(type(e).__name__, getattr(e, "text", "")) for e in evs[:-1]]
    assert kinds == [("TextEvent", "first"), ("SteeredEvent", "also this"), ("TextEvent", "second")]
    assert isinstance(evs[1], SteeredEvent) and not evs[-1].is_error
    sent = next(c for c in calls(tmp_path) if c["method"] == "turn/steer")["params"]
    assert sent["expectedTurnId"] == "tu_1"


# ---------- cursor backend ----------


def test_cursor_args(tmp_path):
    args = cursor_args(AgentRequest("s", "p", "sonnet-4", tmp_path, resume="c1"), "P")
    assert args[:3] == ["-p", "--output-format", "stream-json"]
    assert args[args.index("--mode") + 1] == "ask" and "--force" not in args
    assert args[args.index("--model") + 1] == "sonnet-4" and args[args.index("--resume") + 1] == "c1"
    assert args[args.index("--workspace") + 1] == str(tmp_path) and args[-1] == "P"


def test_cursor_call_summaries_fit_one_line():
    from diffusion.backends.cursor import summarize_call

    assert summarize_call({"shellToolCall": {"args": {"command": "python3 -c '\nimport x\nprint(x)'"}}}) == (
        "shell",
        "Ran python3 -c ' import x print(x)'",
    )


def fake_cursor(tmp_path, events, code=0):
    script = tmp_path / "cursor-agent"
    lines = "\n".join(json.dumps(e) for e in events)
    script.write_text(
        f'#!/bin/sh\nfor a in "$@"; do echo "$a"; done > {tmp_path}/args.txt\ncat <<\'EOF\'\n{lines}\nEOF\nexit {code}\n'
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


async def test_cursor_runner_streams_text_and_tools(tmp_path, repo):
    exe = fake_cursor(tmp_path, [
        {"type": "system", "subtype": "init", "model": "Auto", "session_id": "c9"},
        {"type": "thinking", "subtype": "delta", "text": "Check the "},
        {"type": "thinking", "subtype": "delta", "text": "callers."},
        {"type": "thinking", "subtype": "completed"},
        {"type": "tool_call", "subtype": "started", "call_id": "1", "tool_call": {"grepToolCall": {"args": {"pattern": "refresh"}}}},
        {"type": "tool_call", "subtype": "started", "call_id": "2", "tool_call": {"readToolCall": {"args": {"path": "src/a.py"}}}},
        {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "answer"}]}, "session_id": "c9"},
        {"type": "result", "subtype": "success", "is_error": False, "result": "answer", "session_id": "c9"},
    ])  # fmt: skip
    evs = await collect(cursor_runner(str(exe))(AgentRequest("SYS", "PROMPT", "", repo)))
    done = evs[-1]
    assert not done.is_error and done.session_id == "c9"
    assert [e.summary for e in evs if isinstance(e, ToolEvent)] == ["Grep refresh", "Read a.py"]
    assert "".join(e.text for e in evs if isinstance(e, TextEvent)).strip() == "answer"
    assert "".join(e.text for e in evs if isinstance(e, ThinkingEvent)) == "Check the callers.\n"
    prompt = (tmp_path / "args.txt").read_text()
    assert "SYS" in prompt and "PROMPT" in prompt and "--model" not in prompt


async def test_cursor_runner_failure(tmp_path, repo):
    exe = fake_cursor(tmp_path, [
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "answer"}]}},
        {"type": "result", "subtype": "error", "is_error": True, "result": "usage limit reached"},
    ], code=1)  # fmt: skip
    evs = await collect(cursor_runner(str(exe))(AgentRequest("s", "p", "", repo)))
    assert [e.text for e in evs if isinstance(e, TextEvent)] == ["answer\n"]
    assert evs[-1].is_error and evs[-1].result == "usage limit reached"


def test_claude_code_prompt_maps_plain_tool_names():
    async def h(_):
        return ""

    assert tool_names_note([]) == ""
    note = tool_names_note([ToolSpec("show_code", "", {}, h)])
    assert "`show_code` is `mcp__diffusion__show_code`" in note


async def _claude_options(monkeypatch, tmp_path, **kw):
    import claude_agent_sdk

    from diffusion.backends.claude_code import claude_code_runner

    seen = {}

    class Fake:
        def __init__(self, options):
            seen["opts"] = options

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def query(self, prompt):
            pass

        async def receive_messages(self):
            return
            yield

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Fake)
    req = AgentRequest(system_prompt="SYS", prompt="hi", model="", cwd=tmp_path, **kw)
    async for _ in claude_code_runner()(req):
        pass
    return seen["opts"]


async def test_claude_read_only_chat_ignores_the_users_setup(monkeypatch, tmp_path):
    o = await _claude_options(monkeypatch, tmp_path)
    assert o.permission_mode == "dontAsk" and o.setting_sources == [] and "Bash" in o.disallowed_tools
    assert o.can_use_tool is None


async def test_claude_guide_chat_runs_as_the_session_and_asks_the_reviewer(monkeypatch, tmp_path):
    from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

    asked = []

    async def approve(name, summary, inp):
        asked.append(summary)
        return {"Bash": "allow", "Edit": "always", "Grep": "always", "ExitPlanMode": "allow"}.get(
            name, "deny"
        )

    o = await _claude_options(monkeypatch, tmp_path, mode="default", approve=approve)
    assert o.permission_mode == "default" and o.setting_sources == ["user", "project", "local"]
    assert o.system_prompt["preset"] == "claude_code" and o.system_prompt["append"].startswith("SYS")
    assert not o.disallowed_tools and not o.tools
    assert isinstance(await o.can_use_tool("Bash", {"command": "ls"}, None), PermissionResultAllow)
    assert isinstance(await o.can_use_tool("Write", {"file_path": "x"}, None), PermissionResultDeny)
    assert asked == ["Ran ls", "Write"]
    # "for this session": edits switch the session to accepting edits; anything else allows that call
    edit = await o.can_use_tool("Edit", {"file_path": "x"}, None)
    assert [(u.type, u.mode, u.destination) for u in edit.updated_permissions] == [
        ("setMode", "acceptEdits", "session")
    ]
    # approving a plan leaves plan mode, as the terminal does
    plan = await o.can_use_tool("ExitPlanMode", {"plan": "p"}, None)
    assert [(u.type, u.mode) for u in plan.updated_permissions] == [("setMode", "default")]
    grep = await o.can_use_tool("Grep", {"pattern": "x"}, None)
    assert (
        grep.updated_permissions[0].type == "addRules"
        and grep.updated_permissions[0].rules[0].tool_name == "Grep"
    )
    for mode in ("acceptEdits", "plan", "auto"):
        assert (
            await _claude_options(monkeypatch, tmp_path, mode=mode, approve=approve)
        ).permission_mode == mode


async def _steered_run(monkeypatch, tmp_path, late: bool):
    """A turn steered after its first message: mid-turn (taken in before the result), or late (after it)."""
    import asyncio

    import claude_agent_sdk
    from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock, ToolUseBlock, UserMessage

    from diffusion.agent import DoneEvent, SteeredEvent, TextEvent
    from diffusion.backends.claude_code import claude_code_runner

    def result(n):
        return ResultMessage("success", 1, 1, False, n, "s1", total_cost_usd=0.1 * n, result=f"r{n}")

    class Fake:
        def __init__(self, options):
            self.out: asyncio.Queue = asyncio.Queue()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def query(self, prompt):
            if prompt == "hi":
                await self.out.put(AssistantMessage([ToolUseBlock("t1", "Read", {"file_path": "a"})], "m"))
            else:
                if late:  # the turn ends before the session gets to it
                    await self.out.put(AssistantMessage([TextBlock("done")], "m"))
                    await self.out.put(result(1))
                await self.out.put(UserMessage(prompt))
                await self.out.put(AssistantMessage([TextBlock("steered answer")], "m"))
                await self.out.put(result(2))

        async def receive_messages(self):
            while True:
                yield await self.out.get()

    monkeypatch.setattr(claude_agent_sdk, "ClaudeSDKClient", Fake)
    steer: asyncio.Queue = asyncio.Queue()
    req = AgentRequest(system_prompt="SYS", prompt="hi", model="", cwd=tmp_path, steer=steer)
    seen, accepted = [], asyncio.get_running_loop().create_future()
    async for ev in claude_code_runner()(req):
        seen.append(ev)
        if len(seen) == 1:
            await steer.put(("also this", accepted))
    assert accepted.result() is True
    assert [e.text for e in seen if isinstance(e, SteeredEvent)] == ["also this"]
    assert seen[-1] == DoneEvent((1 if late else 0) + 2, 0.2, False, "s1", "r2")
    return [e.text for e in seen if isinstance(e, TextEvent)]


async def test_claude_takes_a_steered_message_into_the_running_turn(monkeypatch, tmp_path):
    assert await _steered_run(monkeypatch, tmp_path, late=False) == ["steered answer"]


async def test_claude_answers_a_message_steered_too_late_before_ending(monkeypatch, tmp_path):
    # the turn ended before the session took it in: it runs as one more turn, and the run waits for it
    assert await _steered_run(monkeypatch, tmp_path, late=True) == ["done", "steered answer"]


def test_codex_modes_are_its_sandboxes(tmp_path):
    def sandbox(mode):
        return thread_params(AgentRequest(system_prompt="", prompt="", model="", cwd=tmp_path, mode=mode))[
            "sandbox"
        ]

    modes = ("read-only", "plan", "default", "acceptEdits", "auto")
    assert [sandbox(m) for m in modes] == [
        "read-only",
        "read-only",
        "read-only",
        "workspace-write",
        "workspace-write",
    ]
