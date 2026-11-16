"""One-click reviews: Diffusion starts the reviewer's own agent on a PR with the review skill, as if they had typed
``/diffusion:review <url>`` in a terminal. The session it starts submits the guide (so it becomes the guide's session,
continued from the guide chat) and runs in Diffusion's checkout of the PR.

It runs in the permission mode the reviewer picked in the chat, with their own Claude Code settings: what those
don't allow is put to the reviewer, in the chat, as in any guide chat turn."""

from __future__ import annotations

import asyncio
import tempfile
import time
import uuid
from collections.abc import AsyncIterator, Callable
from pathlib import Path

from .agent import (
    AgentRequest,
    Approver,
    Decision,
    DoneEvent,
    Event,
    Mode,
    TextEvent,
    ThinkingEvent,
    ToolEvent,
    allowed_in,
)

# The review skill as each agent's composer names it.
COMMANDS = {"claude-code": "/diffusion:review", "codex": "$diffusion:review"}
COMMAND = COMMANDS["claude-code"]
NOT_SUBMITTED = "It finished without submitting a review."
LOG_MAX = 400  # steps kept for the chat to show while it runs


def uv_dirs(environ: dict[str, str]) -> list[Path]:
    """Where ``uvx`` writes when the skill submits: its cache and its tools folder (as uv finds them)."""
    home = Path(environ.get("HOME") or Path.home())
    cache = environ.get("UV_CACHE_DIR") or Path(environ.get("XDG_CACHE_HOME") or home / ".cache") / "uv"
    data = Path(environ.get("XDG_DATA_HOME") or home / ".local" / "share") / "uv"
    return [Path(cache), Path(environ.get("UV_TOOL_DIR") or data / "tools"), data]


def generate_prompt(url: str, focus: str = "", harness: str = "claude-code") -> str:
    """What the reviewer would type: the command, the PR, and what to focus on, if anything."""
    return f"{COMMANDS[harness]} {url} {' '.join(focus.split())}".strip()


def generate_request(
    url: str,
    worktree: Path,
    model: str = "",
    focus: str = "",
    mode: Mode = "default",
    approve: Approver | None = None,
    harness: str = "claude-code",
    writable: list[Path] | None = None,
) -> AgentRequest:
    """``writable``: where the submit writes (Diffusion's cache, uv's), for an agent that sandboxes its commands."""
    return AgentRequest(
        system_prompt="",
        prompt=generate_prompt(url, focus, harness),
        model=model,
        cwd=worktree,
        max_turns=200,
        mode=mode,
        approve=approve,
        # The review opens where it was asked for (here), so the submit shouldn't open a browser too.
        # Published versions before DIFFUSION_NO_BROWSER still use Python's webbrowser, which runs $BROWSER: make
        # that a no-op too.
        env={"DIFFUSION_NO_BROWSER": "1", "BROWSER": "true"},
        writable_roots=[*(writable or []), Path(tempfile.gettempdir())],
        network=True,
    )


class Jobs:
    """Reviews being written, by PR key: running, done, failed or stopped, with what the agent is doing now and
    what it has done (``log``: its steps; ``text``: what it has said), for the chat to show. ``asks`` are the tool
    calls waiting on the reviewer."""

    def __init__(self) -> None:
        self.jobs: dict[str, dict] = {}
        self.waiting: dict[str, asyncio.Future[Decision]] = {}
        self._modes: dict[str, asyncio.Queue[Mode]] = {}

    def modes(self, key: str) -> asyncio.Queue[Mode]:
        """Where modes picked while the run goes are sent, for its session to switch to."""
        q = self._modes[key] = asyncio.Queue()
        return q

    async def switch(self, key: str, mode: Mode) -> list[str]:
        """Switch the running review's session to ``mode``; asks it now allows go ahead (their ids)."""
        if not self.running(key) or key not in self._modes:
            return []
        await self._modes[key].put(mode)
        answered = []
        for a in list(self.get(key).get("asks") or []):
            if allowed_in(mode, a["tool"]) and self.answer(a["id"], "allow"):
                answered.append(a["id"])
        return answered

    def approver(self, key: str) -> Approver:
        """Puts a tool call to the reviewer: it waits in the job's ``asks`` until ``answer``."""

        async def ask(tool: str, summary: str, tool_input: dict) -> Decision:
            aid = uuid.uuid4().hex[:12]
            f: asyncio.Future[Decision] = asyncio.get_running_loop().create_future()
            self.waiting[aid] = f
            asks = self.jobs[key].setdefault("asks", [])
            asks.append({"id": aid, "tool": tool, "summary": summary, "input": tool_input})
            try:
                return await f
            finally:
                self.waiting.pop(aid, None)
                asks[:] = [a for a in asks if a["id"] != aid]

        return ask

    def answer(self, aid: str, decision: Decision) -> bool:
        f = self.waiting.get(aid)
        if not f or f.done():
            return False
        f.set_result(decision)
        return True

    def get(self, key: str) -> dict:
        return self.jobs.get(key) or {"state": "none"}

    def running(self, key: str) -> bool:
        return self.get(key)["state"] == "running"

    async def run(
        self,
        key: str,
        events: Callable[[], AsyncIterator[Event]],
        prompt: str = "",
        submitted: Callable[[float], bool] | None = None,
        harness: str = "claude-code",
    ) -> None:
        """Run the agent to the end. ``submitted(since)`` says whether a guide was saved since the start: a run that
        ends without one failed, whatever the agent said."""
        job = self.jobs[key] = {
            "state": "running", "started_at": time.time(), "prompt": prompt, "doing": "", "error": None,
            "log": [], "text": "", "asks": [], "harness": harness,
        }  # fmt: skip
        log: list = job["log"]
        try:
            async for ev in events():
                if isinstance(ev, ToolEvent):
                    job["doing"] = ev.summary
                    log.append({"tool": ev.summary})
                elif isinstance(ev, ThinkingEvent) and ev.text.strip():
                    log.append({"think": ev.text})
                elif isinstance(ev, TextEvent):
                    job["text"] += ev.text
                elif isinstance(ev, DoneEvent):
                    if ev.is_error:
                        job.update(
                            state="failed", error=(ev.result or "The agent stopped with an error.")[:500]
                        )
                    else:
                        job["state"] = "done"
                    job["session"] = ev.session_id
            if job["state"] == "running":
                job["state"] = "done"
            if job["state"] == "done" and submitted and not submitted(job["started_at"]):
                job.update(state="failed", error=NOT_SUBMITTED)
        except asyncio.CancelledError:  # stopped from the UI
            job["state"] = "stopped"
            job["ended_at"] = time.time()
            raise
        except Exception as e:  # the agent couldn't start, or stopped part way
            job.update(state="failed", error=str(e)[:500] or type(e).__name__)
        finally:
            del log[:-LOG_MAX]
            job["asks"] = []
        job["ended_at"] = time.time()
