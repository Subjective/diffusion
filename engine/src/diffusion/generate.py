"""One-click reviews: Diffusion starts the reviewer's own agent on a PR with the review skill, as if they had typed
``/diffusion:review <url>`` in a terminal. The session it starts submits the guide (so it becomes the guide's session,
continued from the guide chat) and runs in Diffusion's checkout of the PR.

The agent reads someone else's code, which can carry instructions, so it gets the skill's own read-and-submit tools
and nothing else: reading, git's read commands, ``gh pr view/diff``, ``uvx``/``diffusion`` for submitting, and
writing the guide to the temp directory. Anything else is declined."""

from __future__ import annotations

import asyncio
import tempfile
import time
from collections.abc import AsyncIterator, Callable
from pathlib import Path

from .agent import (
    AgentRequest,
    Approver,
    Decision,
    DoneEvent,
    Event,
    Runner,
    TextEvent,
    ThinkingEvent,
    ToolEvent,
)

COMMAND = "/diffusion:review"
READ = {"Read", "Grep", "Glob", "LS", "Skill", "Task", "TodoWrite", "ToolSearch"}
BASH = (
    "uvx ",
    "diffusion ",
    "git diff",
    "git log",
    "git show",
    "git status",
    "gh pr view",
    "gh pr diff",
    "ls ",
)
CHAINING = (";", "&&", "||", "|", "`", "$(", ">", "<", "\n")


def generate_approver(worktree: Path, tmp: Path | None = None) -> Approver:
    """What the generating agent may do beyond what the reviewer's own settings already allow."""
    tmp = (tmp or Path(tempfile.gettempdir())).resolve()
    tree = worktree.resolve()

    async def approve(name: str, _summary: str, args: dict) -> Decision:
        if name in READ:
            return "allow"
        if name == "Bash":
            cmd = str(args.get("command", "")).strip()
            ok = cmd.startswith(BASH) and not any(c in cmd for c in CHAINING)
            return "allow" if ok else "deny"
        if name == "Write":
            p = Path(str(args.get("file_path", "")))
            if not p.is_absolute():
                return "deny"
            p = p.resolve()
            inside = (tmp == p.parent or tmp in p.parents) and not (tree == p or tree in p.parents)
            return "allow" if inside else "deny"
        return "deny"

    return approve


LOG_MAX = 400  # steps kept for the chat to show while it runs


def generate_prompt(url: str, focus: str = "") -> str:
    """What the reviewer would type: the command, the PR, and what to focus on, if anything."""
    return f"{COMMAND} {url} {' '.join(focus.split())}".strip()


def generate_request(url: str, worktree: Path, model: str = "", focus: str = "") -> AgentRequest:
    return AgentRequest(
        system_prompt="",
        prompt=generate_prompt(url, focus),
        model=model,
        cwd=worktree,
        max_turns=200,
        mode="default",
        approve=generate_approver(worktree),
        # The review opens where it was asked for (here), so the submit shouldn't open a browser too.
        env={"DIFFUSION_NO_BROWSER": "1"},
    )


class Jobs:
    """Reviews being written, by PR key: running, done, failed or stopped, with what the agent is doing now and
    what it has done (``log``: its steps; ``text``: what it has said), for the chat to show."""

    def __init__(self) -> None:
        self.jobs: dict[str, dict] = {}

    def get(self, key: str) -> dict:
        return self.jobs.get(key) or {"state": "none"}

    def running(self, key: str) -> bool:
        return self.get(key)["state"] == "running"

    async def run(self, key: str, events: Callable[[], AsyncIterator[Event]], prompt: str = "") -> None:
        job = self.jobs[key] = {
            "state": "running", "started_at": time.time(), "prompt": prompt, "doing": "", "error": None,
            "log": [], "text": "",
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
        except asyncio.CancelledError:  # stopped from the UI
            job["state"] = "stopped"
            job["ended_at"] = time.time()
            raise
        except Exception as e:  # the agent couldn't start, or stopped part way
            job.update(state="failed", error=str(e)[:500] or type(e).__name__)
        finally:
            del log[:-LOG_MAX]
        job["ended_at"] = time.time()


def run_generate(runner: Runner, req: AgentRequest) -> Callable[[], AsyncIterator[Event]]:
    return lambda: runner(req)
