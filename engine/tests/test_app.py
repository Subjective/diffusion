import asyncio
import json

import httpx
import pytest

from diffusion.agent import DoneEvent, ToolEvent
from diffusion.app import Deps, create_app
from diffusion.config import Config
from diffusion.github import PRMeta, PRRef
from diffusion.hunks import parse_diff
from diffusion.pipeline import Prepared
from diffusion.store import Store

URL = "https://github.com/acme/web/pull/7"


def parse_sse(text):
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def guide_for(prep, tldr="t"):
    """A draft that covers every changed file whole, as an agent would cite it."""
    files = [f.path for f in prep.index.files]
    return {
        "label": "Everything",
        "tldr": tldr,
        "steps": [{"title": "All", "kind": "core", "summary": "s", "refs": [{"file": f} for f in files]}],
    }


def submit(deps, prep, raw, source="agent", **meta):
    from diffusion.validate import check

    draft, g = check(raw, prep.index)
    record = {
        **g.model_dump(by_alias=True),
        "meta": {"head_sha": prep.meta.head_sha, "source": source, **meta},
    }
    return deps.store.save_guide(
        prep.meta.ref.key, prep.meta.head_sha, record, draft.model_dump(by_alias=True)
    )


@pytest.fixture
def setup(upstream, checkout, tmp_path):
    meta = PRMeta(PRRef("github.com", "acme", "web", 7), "T", "", "jy", "main", "feature",
                  upstream.base_sha, upstream.head_sha, 1, 1, 1)  # fmt: skip
    prep = Prepared(meta, checkout, parse_diff(checkout.diff()))
    cfg = Config(cache_dir=tmp_path / "c")
    runners: dict = {}
    deps = Deps(cfg, lambda h: runners["chat"], lambda cfg, url: prep, Store(cfg.cache_dir))
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(deps)), base_url="http://t")
    return client, runners, deps, prep


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


async def test_file_endpoint_serves_changed_files_at_head(setup):
    client, *_ = setup
    r = await client.get("/api/file", params={"url": URL, "path": "src/auth/types.ts"})
    assert r.status_code == 200
    assert r.json()["text"].count("expiresAt") == 1
    # only files in the diff are served
    r = await client.get("/api/file", params={"url": URL, "path": "README.md"})
    assert r.status_code == 404


async def test_definition_endpoint_finds_imported_definitions(setup):
    client, *_ = setup
    r = await client.get(
        "/api/definition", params={"url": URL, "symbol": "refreshTokens", "path": "src/auth/session.ts"}
    )
    assert r.status_code == 200
    m = r.json()["matches"][0]
    assert m["path"] == "src/api/client.ts"
    assert m["text"].startswith("export async function refreshTokens")
    r = await client.get("/api/definition", params={"url": URL, "symbol": "a b", "path": "x"})
    assert r.status_code == 400


async def test_bad_url_is_400(setup):
    client, *_ = setup
    r = await client.get("/api/pr", params={"url": "nope"})
    assert r.status_code == 400


async def test_guide_versions(setup):
    client, _, deps, prep = setup
    assert (await client.get("/api/guides", params={"url": URL})).json()["versions"] == []
    assert submit(deps, prep, guide_for(prep, "one")) == 1
    assert submit(deps, prep, guide_for(prep, "two"), source="chat") == 2

    body = (await client.get("/api/pr", params={"url": URL})).json()
    assert body["guide"]["tldr"] == "two" and body["guide"]["version"] == 2
    assert [(v["version"], v["source"], v["label"]) for v in body["versions"]] == [
        (1, "agent", "Everything"),
        (2, "chat", "Everything"),
    ]
    assert body["guide"]["uncovered"] == []
    first = (await client.get("/api/pr", params={"url": URL, "v": 1})).json()["guide"]
    assert first["tldr"] == "one"
    assert (await client.get("/api/guide", params={"url": URL, "v": 1})).json()["tldr"] == "one"
    assert (await client.get("/api/guide", params={"url": URL, "v": 9})).status_code == 404
    polled = (await client.get("/api/guides", params={"url": URL})).json()
    assert polled["head_sha"] == prep.meta.head_sha and len(polled["versions"]) == 2


async def test_polling_after_a_push_does_not_re_prepare(setup):
    """After a push with no new guide yet, the latest guide is for the old head; polls mustn't prepare again."""
    import dataclasses

    client, _, deps, prep = setup
    submit(deps, prep, guide_for(prep))
    pushed = dataclasses.replace(prep, meta=dataclasses.replace(prep.meta, head_sha="f" * 40))
    calls = []

    def prepare(cfg, url):
        calls.append(url)
        return pushed

    deps.prepare = prepare
    assert (await client.get("/api/pr", params={"url": URL})).json()["pr"]["head_sha"] == "f" * 40
    for _ in range(3):
        assert (await client.get("/api/guides", params={"url": URL})).status_code == 200
    assert len(calls) == 1


async def test_health_marks_the_app(setup):
    client, *_ = setup
    h = (await client.get("/api/health")).json()
    assert h["ok"] and h["app"] == "diffusion"


async def test_chat_answer_can_edit_the_guide(setup):
    client, runners, deps, prep = setup
    from diffusion.agent import TextEvent

    submit(deps, prep, guide_for(prep, "before"), harness="codex", session="th_1")
    seen = []
    edited = json.dumps({**guide_for(prep, "after"), "label": ""})

    async def runner(req):
        seen.append(req)
        yield TextEvent(f"Done, I split it.\n```diffusion-guide\n{edited}\n```\n")
        yield DoneEvent(1, 0.0, False, "fork-1")

    runners["chat"] = runner
    cid = (await client.post("/api/chats", json={"url": URL})).json()["id"]
    r = await client.post(
        f"/api/chats/{cid}/turn", json={"url": URL, "version": 1, "questions": [{"n": 1, "text": "Split it"}]}
    )
    evs = parse_sse(r.text)
    assert ("guide", {"n": 1, "version": 2}) in evs and evs[-1][0] == "done"
    text = "".join(d["text"] for e, d in evs if e == "delta")
    assert "diffusion-guide" not in text and text.startswith("Done")
    # the guide's codex session is forked, not written into
    assert seen[0].resume == "th_1" and seen[0].fork is True

    g = (await client.get("/api/pr", params={"url": URL})).json()
    assert g["guide"]["tldr"] == "after" and g["guide"]["label"] == "Edited in chat"
    assert g["guide"]["meta"]["source"] == "chat" and g["guide"]["meta"]["chat"] == cid
    stored = (await client.get(f"/api/chats/{cid}", params={"url": URL})).json()
    assert stored["turns"][0]["guide_version"] == 2 and stored["session_id"] == "fork-1"


async def test_chat_bad_guide_block_is_explained_not_saved(setup):
    client, runners, deps, prep = setup
    from diffusion.agent import TextEvent

    async def runner(req):
        yield TextEvent('ok\n```diffusion-guide\n{"steps": 3}\n```')
        yield DoneEvent(1, 0.0, False, "s")

    runners["chat"] = runner
    cid = (await client.post("/api/chats", json={"url": URL})).json()["id"]
    evs = parse_sse(
        (
            await client.post(
                f"/api/chats/{cid}/turn", json={"url": URL, "questions": [{"n": 1, "text": "x"}]}
            )
        ).text
    )
    assert "wasn't saved" in "".join(d["text"] for e, d in evs if e == "delta")
    assert (await client.get("/api/guides", params={"url": URL})).json()["versions"] == []


async def test_fork_failure_falls_back_to_a_fresh_session(setup):
    client, runners, deps, prep = setup
    from diffusion.agent import TextEvent

    submit(deps, prep, guide_for(prep), harness="claude-code", session="gone", cwd="/nope")
    seen = []

    async def runner(req):
        seen.append((req.resume, req.fork))
        if req.fork:
            yield DoneEvent(0, None, True, None, "No conversation found")
            return
        yield TextEvent("hi")
        yield DoneEvent(1, 0.0, False, "fresh")

    runners["chat"] = runner
    cid = (await client.post("/api/chats", json={"url": URL})).json()["id"]
    evs = parse_sse(
        (
            await client.post(
                f"/api/chats/{cid}/turn", json={"url": URL, "questions": [{"n": 1, "text": "x"}]}
            )
        ).text
    )
    assert evs[-1][0] == "done" and seen == [("gone", True), (None, False)]


async def test_chat_lifecycle(setup):
    client, runners, deps, prep = setup
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

    runners["chat"] = chat_runner
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
    client, runners, deps, _ = setup
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

    runners["chat"] = failing
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


async def test_thinking_streams_and_is_kept_with_the_turn(setup):
    client, runners, deps, _ = setup
    from diffusion.agent import TextEvent, ThinkingEvent

    async def runner(req):
        yield ThinkingEvent("Look at ")
        yield ThinkingEvent("the timer.")
        yield ToolEvent("Read", "Read session.ts")
        yield TextEvent("ans")
        yield DoneEvent(1, 0, False, "s")

    runners["chat"] = runner
    cid = (await client.post("/api/chats", json={"url": URL})).json()["id"]
    body = {"url": URL, "questions": [{"n": 0, "text": "x"}]}
    evs = parse_sse((await client.post(f"/api/chats/{cid}/turn", json=body)).text)
    assert [e for e, _ in evs] == ["thinking", "thinking", "tool", "delta", "done"]
    assert "seconds" in evs[-1][1]
    t = (await client.get(f"/api/chats/{cid}", params={"url": URL})).json()["turns"][0]
    assert t["trace"] == [{"think": "Look at the timer."}, {"tool": "Read session.ts"}] and t["seconds"] >= 0


async def test_overlapping_turns_serialize_and_both_persist(setup):
    client, runners, deps, _ = setup
    from diffusion.agent import TextEvent

    gate = asyncio.Event()
    resumes = []

    async def runner(req):
        resumes.append(req.resume)
        if "A" in req.prompt:
            await gate.wait()
        yield TextEvent("ans")
        yield DoneEvent(1, 0, False, f"sess-{len(resumes)}")

    runners["chat"] = runner
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


async def test_local_target_end_to_end(tmp_path):
    """Real prepare of a local branch, a guide saved for it, served over HTTP."""
    from sample import build_sample_repo

    from diffusion.pipeline import local_target, prepare

    repo = tmp_path / "sample"
    build_sample_repo(repo)
    target = local_target(repo, "main", "feature")
    cfg = Config(cache_dir=tmp_path / "c")
    deps = Deps(cfg, lambda h: None, prepare, Store(cfg.cache_dir))  # type: ignore[arg-type]
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(deps)), base_url="http://t")

    pr = (await client.get("/api/pr", params={"url": target})).json()
    assert pr["pr"]["local"] is True and pr["pr"]["url"] == target and pr["guide"] is None
    prep = prepare(cfg, target)
    submit(deps, prep, guide_for(prep, "local!"))
    g = (await client.get("/api/pr", params={"url": target})).json()["guide"]
    assert g["tldr"] == "local!" and g["uncovered"] == []
