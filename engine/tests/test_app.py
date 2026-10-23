import asyncio
import json

import httpx
import pytest

from diffusion.agent import DoneEvent, ToolEvent
from diffusion.app import Deps, create_app
from diffusion.config import Config
from diffusion.github import PRMeta, PRRef
from diffusion.hunks import parse_diff
from diffusion.jobs import Jobs
from diffusion.pipeline import Prepared
from diffusion.store import Store

URL = "https://github.com/acme/web/pull/7"


def parse_sse(text):
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


class GatedRunner:
    """Fake agent that waits on a gate so tests can attach mid-run."""

    def __init__(self):
        self.gate = asyncio.Event()
        self.calls = 0

    async def __call__(self, req):
        self.calls += 1
        yield ToolEvent("Grep", "Grep refreshTokens")
        await self.gate.wait()
        submit = next(t for t in req.tools if t.name == "submit_guide")
        idx_ids = [line.split()[0] for line in req.prompt.split("```")[1].strip().splitlines()]
        await submit.handler(
            {
                "tldr": "t",
                "steps": [
                    {"title": "All", "kind": "core", "summary": "s", "refs": [{"hunk": h} for h in idx_ids]}
                ],
            }
        )
        yield DoneEvent(2, 0.01, False, "s1")


@pytest.fixture
def setup(upstream, checkout, tmp_path):
    meta = PRMeta(PRRef("github.com", "acme", "web", 7), "T", "", "jy", "main", "feature",
                  upstream.base_sha, upstream.head_sha, 1, 1, 1)  # fmt: skip
    prep = Prepared(meta, checkout, parse_diff(checkout.diff()))
    cfg = Config(
        profile="test",
        source="test",
        backend="api",
        guide_model="g",
        chat_model="c",
        cache_dir=tmp_path / "c",
    )
    runner = GatedRunner()
    deps = Deps(cfg, runner, lambda cfg, url: prep, Store(cfg.cache_dir), Jobs())
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(deps)), base_url="http://t")
    return client, runner, deps, prep


async def test_pr_endpoint_returns_files_and_hunks(setup):
    client, *_ = setup
    r = await client.get("/api/pr", params={"url": URL})
    assert r.status_code == 200
    body = r.json()
    assert body["pr"]["number"] == 7 and body["guide"] is None
    by = {f["path"]: f for f in body["files"]}
    assert by["package-lock.json"]["skip"] == "lockfile"
    assert by["src/auth/session.ts"]["skip"] is None
    assert by["src/auth/session.ts"]["hunks"][0]["id"].startswith("H")


async def test_bad_url_is_400(setup):
    client, *_ = setup
    r = await client.get("/api/pr", params={"url": "nope"})
    assert r.status_code == 400


async def test_guide_stream_order_reattach_and_cache(setup):
    client, runner, deps, prep = setup

    async def stream():
        r = await client.post("/api/guide", json={"url": URL})
        return parse_sse(r.text)

    first = asyncio.create_task(stream())
    await asyncio.sleep(0.05)
    second = asyncio.create_task(stream())  # attaches to the same running job
    await asyncio.sleep(0.05)
    runner.gate.set()
    a, b = await first, await second

    names = [e for e, _ in a]
    assert "tool" in names and names[-1] == "guide"
    assert a == b
    assert runner.calls == 1
    guide = a[-1][1]
    assert guide["uncovered"] == [] and guide["meta"]["head_sha"] == prep.meta.head_sha

    # cached: no new agent run, single guide event; /api/pr includes it
    again = parse_sse((await client.post("/api/guide", json={"url": URL})).text)
    assert [e for e, _ in again] == ["guide"] and runner.calls == 1
    assert (await client.get("/api/pr", params={"url": URL})).json()["guide"]["tldr"] == "t"

    # force regenerates
    forced = parse_sse((await client.post("/api/guide", json={"url": URL, "force": True})).text)
    assert forced[-1][0] == "guide" and runner.calls == 2


async def test_agent_error_emits_error_and_allows_retry(setup):
    client, runner, deps, _ = setup

    async def failing(req):
        yield DoneEvent(1, None, True, None, "API Error: 400 too old")

    deps.runner = failing
    evs = parse_sse((await client.post("/api/guide", json={"url": URL})).text)
    assert evs[-1] == ("error", {"message": "API Error: 400 too old"})

    deps.runner = runner
    runner.gate.set()
    evs = parse_sse((await client.post("/api/guide", json={"url": URL})).text)
    assert evs[-1][0] == "guide"


async def test_chat_lifecycle(setup):
    client, runner, deps, prep = setup
    seen = []

    async def chat_runner(req):
        seen.append(req)
        yield ToolEvent("Grep", "Grep end")
        from diffusion.agent import TextEvent

        if "## Q2" in req.prompt:
            yield TextEvent("### Q1\nfirst\n### Q2\nsecond")
        else:
            show = next(t for t in req.tools if t.name == "show_code")
            await show.handler({"file": "src/api/client.ts", "start": 2, "label": "call site"})
            yield TextEvent("only answer")
        yield DoneEvent(1, 0.0, False, f"sess-{len(seen)}")

    deps.runner = chat_runner
    assert (await client.get("/api/chats", params={"url": URL})).json() == []
    chat = (await client.post("/api/chats", json={"url": URL})).json()
    cid = chat["id"]
    assert (await client.get("/api/chats", params={"url": URL})).json() == []  # empty chats hidden

    anchor = {"file": "src/auth/types.ts", "start": 4, "end": 4, "code": "  expiresAt: number;"}
    r = await client.post(f"/api/chats/{cid}/turn", json={"url": URL, "questions": [
        {"n": 1, "text": "Why?", "anchor": anchor}, {"n": 2, "text": "Overall?"}]})  # fmt: skip
    evs = parse_sse(r.text)
    assert [e for e, _ in evs] == ["tool", "delta", "delta", "done"]
    assert {d["n"]: d["text"] for e, d in evs if e == "delta"} == {1: "first\n", 2: "second"}

    r2 = await client.post(
        f"/api/chats/{cid}/turn", json={"url": URL, "questions": [{"n": 3, "text": "More?"}]}
    )
    evs2 = parse_sse(r2.text)
    assert evs2[-1][0] == "done"
    focus = {"n": 3, "file": "src/api/client.ts", "start": 2, "end": 2, "side": "new", "label": "call site"}
    assert ("focus", focus) in evs2
    assert seen[0].resume is None and seen[1].resume == "sess-1"

    stored = (await client.get(f"/api/chats/{cid}", params={"url": URL})).json()
    assert [t["answers"] for t in stored["turns"]] == [{"1": "first\n", "2": "second"}, {"3": "only answer"}]
    assert stored["turns"][0]["questions"][0]["anchor"]["file"] == "src/auth/types.ts"
    assert stored["session_id"] == "sess-2"
    assert [t["shows"] for t in stored["turns"]] == [[], [focus]]

    listing = (await client.get("/api/chats", params={"url": URL})).json()
    assert listing == [{**listing[0], "id": cid, "title": "Why?", "questions": 3, "anchored": 1}]

    other = (await client.post("/api/chats", json={"url": URL})).json()
    assert other["session_id"] is None and other["id"] != cid


async def test_chat_errors(setup):
    client, _, deps, _ = setup
    assert (
        await client.post("/api/chats/nope/turn", json={"url": URL, "questions": [{"n": 1, "text": "x"}]})
    ).status_code == 404
    cid = (await client.post("/api/chats", json={"url": URL})).json()["id"]
    dup = [{"n": 1, "text": "a"}, {"n": 1, "text": "b"}]
    assert (
        await client.post(f"/api/chats/{cid}/turn", json={"url": URL, "questions": dup})
    ).status_code == 400

    async def failing(req):
        from diffusion.agent import TextEvent

        yield TextEvent("partial")
        yield DoneEvent(1, None, True, None, "boom")

    deps.runner = failing
    evs = parse_sse(
        (
            await client.post(
                f"/api/chats/{cid}/turn", json={"url": URL, "questions": [{"n": 1, "text": "x"}]}
            )
        ).text
    )
    assert evs[-1] == ("error", {"message": "boom"})
    t = (await client.get(f"/api/chats/{cid}", params={"url": URL})).json()["turns"][0]
    assert t["status"] == "error" and t["answers"]["1"] == "partial"


async def test_overlapping_turns_serialize_and_both_persist(setup):
    client, _, deps, _ = setup
    from diffusion.agent import TextEvent

    gate = asyncio.Event()
    resumes = []

    async def runner(req):
        resumes.append(req.resume)
        if "A" in req.prompt:
            await gate.wait()
        yield TextEvent("ans")
        yield DoneEvent(1, 0, False, f"sess-{len(resumes)}")

    deps.runner = runner
    cid = (await client.post("/api/chats", json={"url": URL})).json()["id"]

    def turn(text):
        body = {"url": URL, "questions": [{"n": 0, "text": text}]}
        return client.post(f"/api/chats/{cid}/turn", json=body)

    a = asyncio.create_task(turn("A"))
    await asyncio.sleep(0.05)
    b = asyncio.create_task(turn("B"))
    await asyncio.sleep(0.05)
    assert resumes == [None]  # B waits for A
    gate.set()
    await asyncio.gather(a, b)
    assert resumes == [None, "sess-1"]  # B continues A's session
    stored = (await client.get(f"/api/chats/{cid}", params={"url": URL})).json()
    assert [t["questions"][0]["text"] for t in stored["turns"]] == ["A", "B"]
    assert all(t["status"] == "done" for t in stored["turns"]) and stored["session_id"] == "sess-2"


async def test_local_target_end_to_end_with_api_backend(tmp_path):
    """Real prepare + real api backend loop (scripted model) + real run_guide, through HTTP."""
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel

    from diffusion.backends.api import SessionStore, api_runner
    from diffusion.pipeline import local_target, prepare
    from diffusion.sample import build_sample_repo

    repo = tmp_path / "sample"
    build_sample_repo(repo)
    target = local_target(repo, "main", "feature")

    async def model(messages, info):
        if len(messages) == 1:
            prompt = messages[0].parts[-1].content
            table = prompt.split("## Hunk table")[1].split("```")[1].strip()
            ids = [ln.split()[0] for ln in table.splitlines()]
            step = {"title": "All", "kind": "core", "summary": "s", "refs": [{"hunk": h} for h in ids]}
            yield {0: DeltaToolCall("submit_guide", json.dumps({"tldr": "local!", "steps": [step]}))}
        else:
            yield "done"

    cfg = Config(
        profile="t", source="t", backend="api", guide_model="m", chat_model="m", cache_dir=tmp_path / "c"
    )
    runner = api_runner(
        cfg, model=FunctionModel(stream_function=model), sessions=SessionStore(tmp_path / "s")
    )
    deps = Deps(cfg, runner, prepare, Store(cfg.cache_dir), Jobs())
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(deps)), base_url="http://t")

    pr = (await client.get("/api/pr", params={"url": target})).json()
    assert pr["pr"]["local"] is True and pr["pr"]["url"] == target
    evs = parse_sse((await client.post("/api/guide", json={"url": target})).text)
    assert evs[-1][0] == "guide", evs[-1]
    g = evs[-1][1]
    assert g["tldr"] == "local!" and g["uncovered"] == [] and g["meta"]["backend"] == "api"
    assert (await client.get("/api/pr", params={"url": target})).json()["guide"]["tldr"] == "local!"
