import os

import pytest

from diffusion.agent import DoneEvent, ToolEvent, inline_refs
from diffusion.github import PRMeta, PRRef
from diffusion.guide_agent import MAX_CORRECTIONS, GuideDone, GuideError, build_prompt, generate_guide
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
    """Scripted agent: each call submits its payloads in turn via the real submit_guide tool, stopping once
    one is received, like a model that reads the tool's reply. ``None`` submits nothing."""

    def __init__(self, *runs, error_on_reject=False):
        self.runs = [r if isinstance(r, list) else [r] for r in runs]
        self.requests = []
        self.replies = []
        self.error_on_reject = error_on_reject  # like Codex, which ends the run on a rejected final output

    async def __call__(self, req):
        self.requests.append(req)
        tools = {t.name: t for t in req.tools}
        text = await tools["get_hunk"].handler({"ids": ["H1", "h99"]})
        assert "[H1]" in text and "[h99] unknown hunk" in text
        yield ToolEvent("mcp__diffusion__get_hunk", "Hunk H1")
        reply = ""
        for p in self.runs.pop(0):
            if p is None:
                break
            reply = await tools["submit_guide"].handler(p)
            self.replies.append(reply)
            if reply == "received" or self.error_on_reject:
                break
        error = self.error_on_reject and reply.startswith("rejected")
        yield DoneEvent(turns=3, cost_usd=0.01, is_error=error, session_id="sess-1", result=reply)


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


def bad(idx):
    return payload([{"hunk": "H90"}, {"hunk": code_hunks(idx)[0]}])


def good(idx):
    return payload([{"hunk": h} for h in code_hunks(idx)])


async def test_bad_refs_are_sent_back_within_the_run(meta, checkout, idx):
    runner = FakeRunner([bad(idx), good(idx)])
    done = (await collect(generate_guide(meta, checkout, idx, runner, "m")))[-1]
    assert done.attempts == 2 and done.guide.validation.invalid_refs == 0
    assert len(runner.requests) == 1
    assert runner.replies[0].startswith("rejected") and "unknown hunk 'H90'" in runner.replies[0]
    assert "uncovered hunks" in runner.replies[0]


async def test_accepts_as_is_after_max_corrections(meta, checkout, idx):
    runner = FakeRunner([bad(idx)] * (MAX_CORRECTIONS + 2))
    done = (await collect(generate_guide(meta, checkout, idx, runner, "m")))[-1]
    assert done.attempts == MAX_CORRECTIONS + 1 and runner.replies[-1] == "received"
    assert done.guide.validation.invalid_refs == 1  # validator dropped what the model never fixed


async def test_run_ending_with_correction_owed_is_resumed(meta, checkout, idx):
    runner = FakeRunner(bad(idx), good(idx), error_on_reject=True)
    evs = await collect(generate_guide(meta, checkout, idx, runner, "m"))
    assert not any(isinstance(e, DoneEvent) and e.is_error for e in evs)
    done = evs[-1]
    assert done.attempts == 2 and done.guide.validation.invalid_refs == 0
    assert runner.requests[1].resume == "sess-1"
    assert "unknown hunk 'H90'" in runner.requests[1].prompt


async def test_schema_errors_are_reported_back(meta, checkout, idx):
    runner = FakeRunner({"tldr": "t", "steps": []})
    with pytest.raises(GuideError):
        await collect(generate_guide(meta, checkout, idx, runner, "m"))
    assert runner.replies[0].startswith("rejected: schema")


async def test_no_submission_raises(meta, checkout, idx):
    with pytest.raises(GuideError):
        await collect(generate_guide(meta, checkout, idx, FakeRunner(None), "m"))


async def test_keeps_last_guide_if_resume_does_not_submit(meta, checkout, idx):
    runner = FakeRunner(bad(idx), None, error_on_reject=True)
    done = (await collect(generate_guide(meta, checkout, idx, runner, "m")))[-1]
    assert done.guide.validation.invalid_refs == 1 and len(runner.requests) == 2


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
