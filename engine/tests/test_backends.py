import json
import stat

import pytest

from diffusion.agent import AgentRequest, SandboxError, TextEvent, ToolEvent, ToolSpec, within
from diffusion.backends.claude_code import sandbox_decision, tool_names_note
from diffusion.backends.codex import build_args, codex_runner
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


def test_codex_args_resume_or_fork(tmp_path):
    req = AgentRequest("s", "p", "gpt-x", tmp_path, resume="th_1")
    args = build_args(req)
    assert args[:2] == ["exec", "--experimental-json"]
    assert args[2:4] == ["--sandbox", "read-only"] and args[-2:] == ["resume", "th_1"]
    assert args[args.index("--model") + 1] == "gpt-x"
    forked = AgentRequest("s", "p", "", tmp_path, resume="th_1", fork=True)
    assert build_args(forked)[-2:] == ["fork", "th_1"] and "--model" not in build_args(forked)
    # a fork is someone else's session: it needs our system prompt; our own resumed one already has it
    assert codex_prompt(forked).startswith("s") and codex_prompt(req) == "p"


def fake_codex(tmp_path, events, code=0):
    script = tmp_path / "codex"
    lines = "\n".join(json.dumps(e) for e in events)
    script.write_text(
        f"#!/bin/sh\ncat > {tmp_path}/stdin.txt\necho \"$@\" > {tmp_path}/args.txt\ncat <<'EOF'\n{lines}\nEOF\nexit {code}\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


async def test_codex_runner_streams_text_and_tools(tmp_path, repo):
    exe = fake_codex(tmp_path, [
        {"type": "thread.started", "thread_id": "th_9"},
        {"type": "item.started", "item": {"id": "1", "type": "command_execution", "command": "rg refresh", "status": "in_progress"}},
        {"type": "item.completed", "item": {"id": "2", "type": "agent_message", "text": "answer"}},
        {"type": "turn.completed", "usage": {"input_tokens": 1}},
    ])  # fmt: skip
    evs = await collect(codex_runner(str(exe))(AgentRequest("SYS", "PROMPT", "m", repo)))
    done = evs[-1]
    assert not done.is_error and done.session_id == "th_9"
    assert [e.summary for e in evs if isinstance(e, ToolEvent)] == ["rg refresh"]
    assert [e.text for e in evs if isinstance(e, TextEvent)] == ["answer\n"]
    stdin = (tmp_path / "stdin.txt").read_text()
    assert stdin.startswith("SYS") and "PROMPT" in stdin


async def test_codex_runner_failure(tmp_path, repo):
    exe = fake_codex(tmp_path, [
        {"type": "thread.started", "thread_id": "th_1"},
        {"type": "item.completed", "item": {"id": "1", "type": "agent_message", "text": "answer"}},
        {"type": "turn.failed", "error": {"message": "quota exceeded"}},
    ], code=1)  # fmt: skip
    evs = await collect(codex_runner(str(exe))(AgentRequest("s", "p", "", repo)))
    assert [e.text for e in evs if isinstance(e, TextEvent)] == ["answer\n"]
    assert evs[-1].is_error and evs[-1].result == "quota exceeded"
    assert "--model" not in (tmp_path / "args.txt").read_text()


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
        "python3 -c ' import x print(x)'",
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
