import json
import stat
from pathlib import Path

import pytest

from diffusion.agent import AgentRequest, DoneEvent, SandboxError, TextEvent, ToolEvent, ToolSpec, within
from diffusion.backends.api import SessionStore, api_runner
from diffusion.backends.claude_code import sandbox_decision
from diffusion.backends.codex import build_args, codex_runner, strict_schema
from diffusion.backends.providers import (
    AnthropicProvider,
    Completion,
    OpenAIProvider,
    TextDelta,
    ToolCall,
    Usage,
)
from diffusion.backends.tools import glob, grep, read_file
from diffusion.config import Config


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "repo"
    (r / "src").mkdir(parents=True)
    (r / "src" / "a.py").write_text("def refresh():\n    return 1\n\nrefresh()\n")
    (r / "README.md").write_text("hello\n")
    (r / "node_modules").mkdir()
    (r / "node_modules" / "x.js").write_text("refresh()\n")
    (tmp_path / "secret.txt").write_text("SECRET\n")
    return r


def cfg(tmp_path, **kw):
    base = dict(
        profile="t", source="t", backend="api", guide_model="m", chat_model="m", cache_dir=tmp_path / "c"
    )
    return Config(**{**base, **kw})


# ---------- sandboxed repo tools ----------


def test_within_blocks_escapes(repo):
    assert within(repo, "src/a.py") == (repo / "src/a.py").resolve()
    for bad in ["../secret.txt", str(repo.parent / "secret.txt"), "/etc/passwd", "src/../../secret.txt"]:
        with pytest.raises(SandboxError):
            within(repo, bad)


def test_within_blocks_symlink_escape(repo):
    (repo / "link").symlink_to(repo.parent / "secret.txt")
    with pytest.raises(SandboxError):
        within(repo, "link")


def test_read_file_numbers_and_pages(repo):
    out = read_file(repo, "src/a.py", offset=2, limit=2)
    assert out.splitlines()[0] == "src/a.py (4 lines)"
    assert "     2\t    return 1" in out and "     4" not in out and "use offset" in out
    with pytest.raises(SandboxError):
        read_file(repo, "../secret.txt")


def test_grep_and_glob(repo):
    hits = grep(repo, r"refresh\(\)")
    assert "src/a.py:4:refresh()" in hits and "node_modules" not in hits
    assert "secret" not in grep(repo, "SECRET")
    assert glob(repo, "*.py") == "src/a.py"
    assert glob(repo, "**/*.md") == "README.md" or "README.md" in glob(repo, "*.md")
    with pytest.raises(SandboxError):
        glob(repo, "../*")


# ---------- api backend loop ----------


class FakeProvider:
    """Scripted model: each call pops the next list of (text, tool_calls)."""

    def __init__(self, *script):
        self.script = list(script)
        self.calls = []

    async def stream(self, system, messages, tools, model):
        self.calls.append(
            {"system": system, "messages": json.loads(json.dumps(messages)), "tools": [t.name for t in tools]}
        )
        text, calls = self.script.pop(0)
        for i in range(0, len(text), 3):
            yield TextDelta(text[i : i + 3])
        yield Completion(
            text, [ToolCall(f"c{i}", n, a) for i, (n, a) in enumerate(calls)], Usage(10, 5, cost_usd=0.01)
        )


async def collect(gen):
    return [e async for e in gen]


async def test_loop_runs_tools_until_terminal(tmp_path, repo):
    got = []

    async def submit(args):
        got.append(args)
        return "received"

    prov = FakeProvider(
        ("Looking.", [("grep", {"pattern": "refresh"}), ("read_file", {"path": "../secret.txt"})]),
        ("", [("nope", {}), ("submit", {"x": 1})]),
        ("never reached", []),
    )
    run = api_runner(cfg(tmp_path), provider=prov, sessions=SessionStore(tmp_path / "s"))
    tools = [ToolSpec("submit", "d", {"type": "object"}, submit, terminal=True)]
    evs = await collect(run(AgentRequest("sys", "go", "m", repo, tools, include_partial=True)))

    assert got == [{"x": 1}]
    assert len(prov.script) == 1  # stopped after terminal tool accepted
    assert "".join(e.text for e in evs if isinstance(e, TextEvent)) == "Looking."
    assert [e.summary for e in evs if isinstance(e, ToolEvent)] == [
        "Grep refresh",
        "Read secret.txt",
        "nope",
        "submit",
    ]
    results = prov.calls[1]["messages"][-1]["results"]
    assert (
        "src/a.py" in results[0]["content"] and results[1]["is_error"] and "outside" in results[1]["content"]
    )
    assert prov.calls[0]["tools"][:3] == ["read_file", "grep", "glob"]
    done = evs[-1]
    assert (
        isinstance(done, DoneEvent)
        and not done.is_error
        and done.turns == 2
        and done.cost_usd == pytest.approx(0.02)
    )


async def test_resume_continues_conversation(tmp_path, repo):
    store = SessionStore(tmp_path / "s")
    prov = FakeProvider(("first", []), ("second", []))
    run = api_runner(cfg(tmp_path), provider=prov, sessions=store)
    d1 = (await collect(run(AgentRequest("sys", "q1", "m", repo))))[-1]
    d2 = (await collect(run(AgentRequest("sys", "q2", "m", repo, resume=d1.session_id))))[-1]
    assert d2.session_id == d1.session_id and d2.result == "second"
    roles = [m["role"] for m in prov.calls[1]["messages"]]
    assert roles == ["user", "assistant", "user"] and prov.calls[1]["messages"][0]["content"] == "q1"


async def test_max_turns_and_provider_errors(tmp_path, repo):
    prov = FakeProvider(*[("", [("glob", {"pattern": "*"})])] * 3)
    run = api_runner(cfg(tmp_path), provider=prov, sessions=SessionStore(tmp_path / "s"))
    done = (await collect(run(AgentRequest("s", "p", "m", repo, max_turns=2))))[-1]
    assert done.is_error and "2 turns" in done.result

    class Boom:
        async def stream(self, system, messages, tools, model):
            raise RuntimeError("401 bad key")
            yield  # pragma: no cover

    run = api_runner(cfg(tmp_path), provider=Boom(), sessions=SessionStore(tmp_path / "s"))
    done = (await collect(run(AgentRequest("s", "p", "m", repo))))[-1]
    assert done.is_error and "401 bad key" in done.result


# ---------- provider wire formats ----------

CONVO = [
    {"role": "user", "content": "hi"},
    {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"id": "t1", "name": "grep", "args": {"pattern": "x"}}],
    },
    {"role": "tool", "results": [{"id": "t1", "content": "out", "is_error": False}]},
    {"role": "user", "content": "follow-up"},
]


def test_anthropic_wire_merges_roles_and_caches_tail():
    wire = AnthropicProvider.to_wire(CONVO)
    assert [m["role"] for m in wire] == ["user", "assistant", "user"]
    assert wire[1]["content"][0] == {
        "type": "tool_use",
        "id": "t1",
        "name": "grep",
        "input": {"pattern": "x"},
    }
    tail = wire[2]["content"]
    assert tail[0]["type"] == "tool_result" and tail[1]["text"] == "follow-up"
    assert tail[-1]["cache_control"] == {"type": "ephemeral"}


def test_openai_wire_format():
    wire = OpenAIProvider.to_wire("sys", CONVO)
    assert wire[0] == {"role": "system", "content": "sys"}
    assert wire[2]["tool_calls"][0]["function"] == {"name": "grep", "arguments": '{"pattern": "x"}'}
    assert wire[3] == {"role": "tool", "tool_call_id": "t1", "content": "out"}
    assert wire[4] == {"role": "user", "content": "follow-up"}


# ---------- claude-code sandbox hook ----------


def test_claude_code_sandbox_decision(repo):
    assert sandbox_decision("Read", {"file_path": str(repo / "src/a.py")}, repo) is None
    assert "outside" in (sandbox_decision("Read", {"file_path": str(repo.parent / "secret.txt")}, repo) or "")
    assert "outside" in (sandbox_decision("Grep", {"pattern": "x", "path": "/etc"}, repo) or "")
    assert sandbox_decision("Glob", {"pattern": "/etc/*"}, repo)
    assert sandbox_decision("Grep", {"pattern": "x"}, repo) is None
    assert sandbox_decision("mcp__diffusion__get_hunk", {"ids": ["H1"]}, repo) is None


# ---------- codex backend ----------


def test_strict_schema_keeps_properties_named_like_keywords():
    s = strict_schema(
        {
            "type": "object",
            "title": "Step",
            "properties": {"title": {"type": "string", "title": "T"}, "default": {"type": "integer"}},
            "required": ["title"],
        }
    )
    assert (
        set(s["properties"]) == {"title", "default"}
        and "title" not in s
        and "title" not in s["properties"]["title"]
    )
    assert s["required"] == ["title", "default"]


def test_drop_nulls():
    from diffusion.backends.codex import drop_nulls

    assert drop_nulls({"a": None, "b": [{"c": None, "d": 1}], "e": 0}) == {"b": [{"d": 1}], "e": 0}


def test_strict_schema_requires_all_and_nullable_optionals():
    s = strict_schema({
        "type": "object",
        "properties": {"a": {"type": "string"}, "b": {"type": "integer", "default": 1}, "c": {"$ref": "#/x"}},
        "required": ["a"],
    })  # fmt: skip
    assert s["required"] == ["a", "b", "c"] and s["additionalProperties"] is False
    assert s["properties"]["b"] == {"type": ["integer", "null"]}
    assert s["properties"]["c"] == {"anyOf": [{"$ref": "#/x"}, {"type": "null"}]}


def test_codex_args(tmp_path):
    req = AgentRequest("s", "p", "gpt-x", tmp_path, resume="th_1")
    args = build_args(cfg(tmp_path, backend="codex"), req, "/tmp/schema.json")
    assert args[:2] == ["exec", "--experimental-json"]
    assert (
        args[2:4] == ["--sandbox", "read-only"]
        and "--output-schema" in args
        and args[-2:] == ["resume", "th_1"]
    )
    assert args[args.index("--model") + 1] == "gpt-x"


def fake_codex(tmp_path, events, code=0):
    script = tmp_path / "codex"
    lines = "\n".join(json.dumps(e) for e in events)
    script.write_text(
        f"#!/bin/sh\ncat > {tmp_path}/stdin.txt\necho \"$@\" > {tmp_path}/args.txt\ncat <<'EOF'\n{lines}\nEOF\nexit {code}\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


async def test_codex_runner_structured_output(tmp_path, repo):
    final = json.dumps({"tldr": "t"})
    exe = fake_codex(tmp_path, [
        {"type": "thread.started", "thread_id": "th_9"},
        {"type": "item.started", "item": {"id": "1", "type": "command_execution", "command": "rg refresh", "status": "in_progress"}},
        {"type": "item.completed", "item": {"id": "2", "type": "agent_message", "text": f"```json\n{final}\n```"}},
        {"type": "turn.completed", "usage": {"input_tokens": 1}},
    ])  # fmt: skip
    got = []

    async def submit(a):
        got.append(a)
        return "received"

    run = codex_runner(cfg(tmp_path, backend="codex", cli_path=str(exe)))
    tools = [
        ToolSpec(
            "submit_guide",
            "the guide",
            {"type": "object", "properties": {"tldr": {"type": "string"}}},
            submit,
            terminal=True,
        )
    ]
    evs = await collect(run(AgentRequest("SYS", "PROMPT", "m", repo, tools)))
    done = evs[-1]
    assert got == [{"tldr": "t"}] and not done.is_error and done.session_id == "th_9"
    assert [e.summary for e in evs if isinstance(e, ToolEvent)] == ["rg refresh"]
    stdin = (tmp_path / "stdin.txt").read_text()
    assert stdin.startswith("SYS") and "PROMPT" in stdin and "submit_guide" in stdin
    assert "--output-schema" in (tmp_path / "args.txt").read_text()


async def test_codex_runner_chat_and_failure(tmp_path, repo):
    exe = fake_codex(tmp_path, [
        {"type": "thread.started", "thread_id": "th_1"},
        {"type": "item.completed", "item": {"id": "1", "type": "agent_message", "text": "answer"}},
        {"type": "turn.failed", "error": {"message": "quota exceeded"}},
    ], code=1)  # fmt: skip
    run = codex_runner(cfg(tmp_path, backend="codex", cli_path=str(exe)))
    evs = await collect(run(AgentRequest("s", "p", "", repo)))
    assert [e.text for e in evs if isinstance(e, TextEvent)] == ["answer\n"]
    assert evs[-1].is_error and evs[-1].result == "quota exceeded"
    assert "--model" not in (tmp_path / "args.txt").read_text()


def test_paths_exist():
    assert Path(__file__).exists()
