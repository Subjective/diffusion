import asyncio
from pathlib import Path

from diffusion.agent import DoneEvent, TextEvent, ToolEvent
from diffusion.generate import NOT_SUBMITTED, Jobs, generate_prompt, generate_request


def test_the_request_runs_the_review_command_in_the_checkout_without_opening_a_browser():
    req = generate_request("https://github.com/a/b/pull/1", Path("/wt"), mode="auto")
    assert req.prompt == "/diffusion:review https://github.com/a/b/pull/1"
    assert (
        req.cwd == Path("/wt")
        and req.mode == "auto"
        and req.env == {"DIFFUSION_NO_BROWSER": "1", "BROWSER": "true"}
    )


def test_jobs_track_a_run_to_done_or_failed():
    jobs = Jobs()

    async def good():
        yield ToolEvent("Read", "Read a.py")
        yield DoneEvent(turns=3, cost_usd=None, is_error=False, session_id="s1")

    async def bad():
        yield ToolEvent("Bash", "Ran gh pr diff")
        raise RuntimeError("not signed in")

    asyncio.run(jobs.run("k1", good, "/diffusion:review x"))
    asyncio.run(jobs.run("k2", bad))
    assert jobs.get("k1")["state"] == "done" and jobs.get("k1")["session"] == "s1"
    assert (
        jobs.get("k1")["log"] == [{"tool": "Read a.py"}] and jobs.get("k1")["prompt"] == "/diffusion:review x"
    )
    assert jobs.get("k2")["state"] == "failed" and jobs.get("k2")["error"] == "not signed in"
    assert jobs.get("k3") == {"state": "none"}


def test_a_run_that_ends_without_submitting_a_review_failed():
    jobs = Jobs()

    async def chat_only():
        yield TextEvent("Here's what I found…")
        yield DoneEvent(turns=3, cost_usd=None, is_error=False, session_id="s1")

    asyncio.run(jobs.run("k", chat_only, submitted=lambda since: False))
    assert jobs.get("k")["state"] == "failed" and jobs.get("k")["error"] == NOT_SUBMITTED
    assert jobs.get("k")["text"] == "Here's what I found…"
    asyncio.run(jobs.run("k", chat_only, submitted=lambda since: True))
    assert jobs.get("k")["state"] == "done"


def test_the_prompt_carries_what_to_focus_on():
    assert generate_prompt("u", "  the  retry\nlogic ") == "/diffusion:review u the retry logic"
    assert generate_prompt("u") == "/diffusion:review u"
