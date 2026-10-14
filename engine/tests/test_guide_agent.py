import os

import pytest

from diffusion.agent import DoneEvent, ToolEvent, inline_refs
from diffusion.github import PRMeta, PRRef
from diffusion.guide_agent import GuideDone, GuideError, build_prompt, generate_guide
from diffusion.hunks import parse_diff
from diffusion.schema import GuideDraft


@pytest.fixture
def meta(upstream):
    return PRMeta(
        ref=PRRef("github.com", "acme", "web", upstream.number),
        title="Add token refresh",
        body="Refresh tokens before expiry.",
        author="jy",
        base_ref="main",
        head_ref="feature",
        base_sha=upstream.base_sha,
        head_sha=upstream.head_sha,
        additions=20,
        deletions=3,
        changed_files=8,
        commits=[{"sha": upstream.head_sha[:12], "headline": "add token refresh"}],
    )


@pytest.fixture
def idx(checkout):
    return parse_diff(checkout.diff())


def code_hunks(idx):
    return [h.id for h in idx.hunks if h.file.startswith(("src/", "tests/"))]


class FakeRunner:
    """Scripted agent: each call submits the next payload via the real submit_guide tool."""

    def __init__(self, *payloads):
        self.payloads = list(payloads)
        self.requests = []

    async def __call__(self, req):
        self.requests.append(req)
        tools = {t.name: t for t in req.tools}
        text = await tools["get_hunk"].handler({"ids": ["H1", "h99"]})
        assert "[H1]" in text and "[h99] unknown hunk" in text
        yield ToolEvent("mcp__diffusion__get_hunk", "Hunk H1")
        payload = self.payloads.pop(0)
        if payload is not None:
            self.last_reply = await tools["submit_guide"].handler(payload)
        yield DoneEvent(turns=3, cost_usd=0.01, is_error=False, session_id="sess-1")


def payload(refs):
    return {"tldr": "t", "steps": [{"title": "All", "kind": "core", "summary": "s", "refs": refs}]}


async def collect(gen):
    return [ev async for ev in gen]


def test_prompt_contains_table_and_meta(meta, idx):
    p = build_prompt(meta, idx)
    assert "Add token refresh" in p and "Refresh tokens before expiry." in p
    assert idx.table() in p


def test_submit_schema_is_flat():
    s = inline_refs(GuideDraft.model_json_schema(by_alias=True))
    assert "$ref" not in str(s) and "$defs" not in s
    step = s["properties"]["steps"]["items"]
    assert step["properties"]["kind"]["enum"][0] == "entry"
    assert (
        "title" in step["properties"] and "title" in step["required"]
    )  # a property named like a keyword survives
    assert "title" in step["properties"]["substeps"]["items"]["properties"]


async def test_happy_path(meta, checkout, idx):
    runner = FakeRunner(payload([{"hunk": h} for h in code_hunks(idx)]))
    evs = await collect(generate_guide(meta, checkout, idx, runner, "m"))
    done = evs[-1]
    assert isinstance(done, GuideDone)
    assert done.attempts == 1 and done.turns == 3
    assert done.guide.uncovered == []
    req = runner.requests[0]
    assert req.cwd == checkout.worktree and req.model == "m" and req.resume is None


async def test_retry_on_bad_refs_resumes_session(meta, checkout, idx):
    bad = payload([{"hunk": "H90"}, {"hunk": "H91"}, {"hunk": code_hunks(idx)[0]}])
    good = payload([{"hunk": h} for h in code_hunks(idx)])
    runner = FakeRunner(bad, good)
    done = (await collect(generate_guide(meta, checkout, idx, runner, "m")))[-1]
    assert done.attempts == 2 and done.guide.validation.invalid_refs == 0
    assert runner.requests[1].resume == "sess-1"
    assert "unknown hunk 'H90'" in runner.requests[1].prompt


async def test_schema_errors_are_reported_back(meta, checkout, idx):
    runner = FakeRunner({"tldr": "t", "steps": []})
    with pytest.raises(GuideError):
        await collect(generate_guide(meta, checkout, idx, runner, "m"))
    assert runner.last_reply.startswith("rejected")


async def test_no_submission_raises(meta, checkout, idx):
    with pytest.raises(GuideError):
        await collect(generate_guide(meta, checkout, idx, FakeRunner(None), "m"))


async def test_keeps_first_guide_if_retry_does_not_submit(meta, checkout, idx):
    bad = payload([{"hunk": "H90"}, {"hunk": "H91"}, {"hunk": code_hunks(idx)[0]}])
    done = (await collect(generate_guide(meta, checkout, idx, FakeRunner(bad, None), "m")))[-1]
    assert done.guide.validation.invalid_refs == 2


@pytest.mark.live
async def test_live_guide_on_fixture(meta, checkout, idx):
    from diffusion.agent import make_runner
    from diffusion.config import load_config

    cfg = load_config()
    model = os.environ.get("DIFFUSION_LIVE_MODEL", cfg.chat_model)
    evs = await collect(generate_guide(meta, checkout, idx, make_runner(cfg), model, max_turns=20))
    done = evs[-1]
    assert isinstance(done, GuideDone)
    g = done.guide
    assert g.steps and g.tldr
    assert g.validation.invalid_refs == 0, g.validation.issues
    covered = {r.hunk for s in g.steps for r in s.refs}
    assert set(code_hunks(idx)) - {
        "H" + h.id[1:] for h in idx.hunks if h.file == "src/legacy.ts"
    } <= covered | set(g.uncovered)
    assert any(isinstance(e, ToolEvent) for e in evs)
