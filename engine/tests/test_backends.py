import json
import stat
from pathlib import Path

import httpx2
import pytest
from pydantic_ai import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from pydantic_ai.usage import RequestUsage

from diffusion.agent import AgentRequest, DoneEvent, SandboxError, TextEvent, ToolEvent, ToolSpec, within
from diffusion.backends.api import SessionStore, _cost, api_runner, make_model
from diffusion.backends.claude_code import sandbox_decision, tool_names_note
from diffusion.backends.codex import build_args, codex_runner, strict_schema
from diffusion.backends.cursor import build_args as cursor_args
from diffusion.backends.cursor import cursor_runner, parse_json_reply
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


class Scripted:
    """A model that plays back a script: each request pops the next (text, [(tool, args), ...])."""

    def __init__(self, *script):
        self.script = list(script)
        self.requests: list[list[ModelMessage]] = []
        self.model = FunctionModel(stream_function=self.stream)

    async def stream(self, messages, info):
        self.requests.append(list(messages))
        self.tools = [t.name for t in info.function_tools]
        text, calls = self.script.pop(0)
        for i in range(0, len(text), 3):
            yield text[i : i + 3]
        for i, (name, args) in enumerate(calls):
            yield {i: DeltaToolCall(name, json.dumps(args), tool_call_id=f"c{len(self.requests)}{i}")}


def returns(messages: list[ModelMessage]) -> list:
    last = messages[-1]
    assert isinstance(last, ModelRequest)
    return [p for p in last.parts if isinstance(p, ToolReturnPart | RetryPromptPart)]


async def collect(gen):
    return [e async for e in gen]


async def test_loop_runs_tools_until_terminal(tmp_path, repo):
    got = []

    async def submit(args):
        got.append(args)
        return "received"

    m = Scripted(
        ("Looking.", [("grep", {"pattern": "refresh"}), ("read_file", {"path": "../secret.txt"})]),
        ("", [("nope", {}), ("submit", {"x": 1})]),
        ("never reached", []),
    )
    run = api_runner(cfg(tmp_path), model=m.model, sessions=SessionStore(tmp_path / "s"))
    tools = [ToolSpec("submit", "d", {"type": "object"}, submit, terminal=True)]
    evs = await collect(run(AgentRequest("sys", "go", "m", repo, tools, include_partial=True)))

    assert got == [{"x": 1}]
    assert len(m.script) == 1  # stopped after terminal tool accepted
    assert "".join(e.text for e in evs if isinstance(e, TextEvent)) == "Looking."
    assert [e.summary for e in evs if isinstance(e, ToolEvent)] == [
        "Grep refresh",
        "Read secret.txt",
        "nope",
        "submit",
    ]
    grep_out, secret = returns(m.requests[1])
    assert "src/a.py" in grep_out.content
    assert (
        isinstance(secret, ToolReturnPart) and secret.outcome == "failed" and "outside" in str(secret.content)
    )
    assert m.tools[:3] == ["read_file", "grep", "glob"]
    done = evs[-1]
    assert isinstance(done, DoneEvent) and not done.is_error and done.turns == 2


async def test_rejected_terminal_tool_keeps_going(tmp_path, repo):
    replies = iter(["rejected: fix it", "received"])

    async def submit(args):
        return next(replies)

    m = Scripted(("", [("submit", {})]), ("", [("submit", {})]), ("never reached", []))
    run = api_runner(cfg(tmp_path), model=m.model, sessions=SessionStore(tmp_path / "s"))
    tools = [ToolSpec("submit", "d", {"type": "object"}, submit, terminal=True)]
    done = (await collect(run(AgentRequest("s", "p", "m", repo, tools))))[-1]
    assert not done.is_error and done.turns == 2 and returns(m.requests[1])[0].content == "rejected: fix it"


async def test_resume_after_terminal_tool_keeps_its_result(tmp_path, repo):
    async def submit(args):
        return "received"

    m = Scripted(("", [("submit", {})]), ("again", []))
    run = api_runner(cfg(tmp_path), model=m.model, sessions=SessionStore(tmp_path / "s"))
    tools = [ToolSpec("submit", "d", {"type": "object"}, submit, terminal=True)]
    d1 = (await collect(run(AgentRequest("s", "p", "m", repo, tools))))[-1]
    d2 = (await collect(run(AgentRequest("s", "retry", "m", repo, tools, resume=d1.session_id))))[-1]
    assert not d2.is_error and d2.result == "again"
    tail = [type(p).__name__ for p in m.requests[1][-1].parts]
    assert tail == ["ToolReturnPart", "UserPromptPart"]


async def test_resume_continues_conversation(tmp_path, repo):
    store = SessionStore(tmp_path / "s")
    m = Scripted(("first", []), ("second", []))
    run = api_runner(cfg(tmp_path), model=m.model, sessions=store)
    d1 = (await collect(run(AgentRequest("sys", "q1", "m", repo))))[-1]
    d2 = (await collect(run(AgentRequest("sys", "q2", "m", repo, resume=d1.session_id))))[-1]
    assert d2.session_id == d1.session_id and d2.result == "second"
    kinds = [type(msg).__name__ for msg in m.requests[1]]
    assert kinds == ["ModelRequest", "ModelResponse", "ModelRequest"]
    first = m.requests[1][0].parts[-1]
    assert isinstance(first, UserPromptPart) and first.content == "q1"


async def test_max_turns_and_model_errors(tmp_path, repo):
    m = Scripted(*[("", [("glob", {"pattern": "*"})])] * 3)
    run = api_runner(cfg(tmp_path), model=m.model, sessions=SessionStore(tmp_path / "s"))
    done = (await collect(run(AgentRequest("s", "p", "m", repo, max_turns=2))))[-1]
    assert done.is_error and "2 turns" in done.result and done.turns == 2

    async def boom(messages, info):
        raise RuntimeError("401 bad key")
        yield ""  # pragma: no cover

    run = api_runner(
        cfg(tmp_path), model=FunctionModel(stream_function=boom), sessions=SessionStore(tmp_path / "s")
    )
    done = (await collect(run(AgentRequest("s", "p", "m", repo))))[-1]
    assert done.is_error and "401 bad key" in done.result


def test_cost_prefers_reported_then_prices():
    reported = ModelResponse([TextPart("x")], model_name="anything", provider_details={"cost": 0.25})
    priced = ModelResponse(
        [TextPart("x")],
        usage=RequestUsage(input_tokens=100_000),
        model_name="claude-sonnet-4-5",
        provider_name="anthropic",
    )
    unknown = ModelResponse([TextPart("x")], model_name="my-local-model")
    assert _cost([unknown]) is None
    assert _cost([reported, unknown]) == pytest.approx(0.25)
    assert _cost([priced]) == pytest.approx(0.3)


# ---------- api backend wire format (requests captured before they leave) ----------


def capture(requests: list) -> httpx2.AsyncClient:
    def handler(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        return httpx2.Response(400, json={"error": {"type": "invalid_request_error", "message": "captured"}})

    return httpx2.AsyncClient(transport=httpx2.MockTransport(handler))


async def test_anthropic_request_caches_and_authenticates(tmp_path, repo):
    sent: list[httpx2.Request] = []
    c = cfg(tmp_path, protocol="anthropic", base_url="https://gw.example", api_key="tok", auth="bearer")
    run = api_runner(c, http_client=capture(sent), sessions=SessionStore(tmp_path / "s"))
    done = (await collect(run(AgentRequest("SYS", "hi", "claude-x", repo))))[-1]
    assert done.is_error and "captured" in done.result

    req = sent[0]
    body = json.loads(req.content)
    assert req.url.host == "gw.example" and req.headers["authorization"] == "Bearer tok"
    assert body["model"] == "claude-x" and body["max_tokens"] == 16000 and body["stream"] is True
    assert body["system"][-1]["text"] == "SYS" and body["system"][-1]["cache_control"]["type"] == "ephemeral"
    assert [t["name"] for t in body["tools"]] == ["read_file", "grep", "glob"]
    assert body["tools"][-1]["cache_control"]["type"] == "ephemeral"
    assert body["messages"][-1]["content"][-1]["cache_control"]["type"] == "ephemeral"


async def test_openai_compatible_request(tmp_path, repo):
    sent: list[httpx2.Request] = []
    c = cfg(
        tmp_path, protocol="openai", base_url="http://localhost:11434/v1", api_key=None, headers={"X-A": "1"}
    )
    run = api_runner(c, http_client=capture(sent), sessions=SessionStore(tmp_path / "s"))
    await collect(run(AgentRequest("SYS", "hi", "llama", repo)))
    body = json.loads(sent[0].content)
    assert sent[0].url.path == "/v1/chat/completions" and sent[0].headers["x-a"] == "1"
    assert body["messages"][0] == {"role": "system", "content": "SYS"}
    assert body["messages"][1]["role"] == "user" and body["tools"][0]["function"]["name"] == "read_file"


def test_openrouter_gets_its_own_model(tmp_path):
    from pydantic_ai.models.openrouter import OpenRouterModel

    c = cfg(tmp_path, protocol="openai", base_url="https://openrouter.ai/api/v1", api_key="k")
    assert isinstance(make_model(c, "anthropic/claude-sonnet-5.5")[0], OpenRouterModel)
    assert not isinstance(
        make_model(cfg(tmp_path, protocol="openai", api_key="k"), "gpt-5")[0], OpenRouterModel
    )


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


# ---------- cursor backend ----------


def test_cursor_args(tmp_path):
    args = cursor_args(
        cfg(tmp_path, backend="cursor"), AgentRequest("s", "p", "sonnet-4", tmp_path, resume="c1"), "P"
    )
    assert args[:3] == ["-p", "--output-format", "stream-json"]
    assert args[args.index("--mode") + 1] == "ask" and "--force" not in args
    assert args[args.index("--model") + 1] == "sonnet-4" and args[args.index("--resume") + 1] == "c1"
    assert args[args.index("--workspace") + 1] == str(tmp_path) and args[-1] == "P"


def test_parse_json_reply():
    assert parse_json_reply('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json_reply('Here is the guide:\n{"a": {"b": 2}}\nDone.') == {"a": {"b": 2}}
    with pytest.raises(ValueError):
        parse_json_reply("no json here")


def fake_cursor(tmp_path, events, code=0):
    script = tmp_path / "cursor-agent"
    lines = "\n".join(json.dumps(e) for e in events)
    script.write_text(
        f'#!/bin/sh\nfor a in "$@"; do echo "$a"; done > {tmp_path}/args.txt\ncat <<\'EOF\'\n{lines}\nEOF\nexit {code}\n'
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


async def test_cursor_runner_structured_output(tmp_path, repo):
    final = json.dumps({"tldr": "t"})
    exe = fake_cursor(tmp_path, [
        {"type": "system", "subtype": "init", "model": "Auto", "session_id": "c9"},
        {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Looking."}]}, "session_id": "c9"},
        {"type": "tool_call", "subtype": "started", "call_id": "1", "tool_call": {"grepToolCall": {"args": {"pattern": "refresh"}}}},
        {"type": "tool_call", "subtype": "started", "call_id": "2", "tool_call": {"readToolCall": {"args": {"path": "src/a.py"}}}},
        {"type": "tool_call", "subtype": "completed", "call_id": "2", "tool_call": {"readToolCall": {"args": {"path": "src/a.py"}, "result": {}}}},
        {"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": f"```json\n{final}\n```"}]}},
        {"type": "result", "subtype": "success", "is_error": False, "result": f"Looking.```json\n{final}\n```", "session_id": "c9"},
    ])  # fmt: skip
    got = []

    async def submit(a):
        got.append(a)
        return "received"

    run = cursor_runner(cfg(tmp_path, backend="cursor", cli_path=str(exe)))
    schema = {"type": "object", "properties": {"tldr": {"type": "string"}}}
    tools = [ToolSpec("submit_guide", "the guide", schema, submit, terminal=True)]
    evs = await collect(run(AgentRequest("SYS", "PROMPT", "", repo, tools)))
    done = evs[-1]
    assert got == [{"tldr": "t"}] and not done.is_error and done.session_id == "c9"
    assert [e.summary for e in evs if isinstance(e, ToolEvent)] == ["Grep refresh", "Read a.py"]
    assert not [e for e in evs if isinstance(e, TextEvent)]
    prompt = (tmp_path / "args.txt").read_text()
    assert "SYS" in prompt and "PROMPT" in prompt and '"tldr"' in prompt and "--model" not in prompt


async def test_cursor_runner_rejection_chat_and_failure(tmp_path, repo):
    exe = fake_cursor(tmp_path, [
        {"type": "system", "subtype": "init", "session_id": "c1"},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": '{"tldr": "t"}'}]}},
        {"type": "result", "subtype": "success", "is_error": False, "result": '{"tldr": "t"}'},
    ])  # fmt: skip

    async def reject(_):
        return "rejected: H9 doesn't exist"

    run = cursor_runner(cfg(tmp_path, backend="cursor", cli_path=str(exe)))
    tools = [ToolSpec("submit_guide", "g", {"type": "object"}, reject, terminal=True)]
    done = (await collect(run(AgentRequest("s", "p", "", repo, tools))))[-1]
    assert done.is_error and "H9" in (done.result or "") and done.session_id == "c1"

    exe = fake_cursor(tmp_path, [
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "answer"}]}},
        {"type": "result", "subtype": "error", "is_error": True, "result": "usage limit reached"},
    ], code=1)  # fmt: skip
    evs = await collect(run(AgentRequest("s", "p", "", repo)))
    assert [e.text for e in evs if isinstance(e, TextEvent)] == ["answer\n"]
    assert evs[-1].is_error and evs[-1].result == "usage limit reached"


def test_paths_exist():
    assert Path(__file__).exists()


def test_claude_code_prompt_maps_plain_tool_names():
    async def h(_):
        return ""

    assert tool_names_note([]) == ""
    note = tool_names_note([ToolSpec("show_code", "", {}, h)])
    assert "`show_code` is `mcp__diffusion__show_code`" in note
