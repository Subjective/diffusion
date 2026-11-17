"""Backend-neutral agent interface: requests, events, custom tools, and the runner seam.

A *runner* takes an ``AgentRequest`` and yields ``Event``s. Backends (``backends/``) implement it on top of an
agent CLI (Claude Code, Codex, Cursor). Chat is the only thing in the engine that runs an agent; guides are
written by the agent Diffusion is launched from.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

# ---------- events surfaced to callers (CLI progress, SSE) ----------


@dataclass
class ToolEvent:
    name: str
    summary: str
    id: str | None = None


@dataclass
class ToolFailedEvent:
    """A tool call that came back as an error (the tool doesn't exist here, was denied, or failed)."""

    id: str


@dataclass
class TextEvent:
    text: str


@dataclass
class ThinkingEvent:
    """Reasoning the agent shows (Claude's thinking summaries, Codex reasoning items, Cursor thinking)."""

    text: str


@dataclass
class SteeredEvent:
    """A message sent into the running turn (``AgentRequest.steer``) reached the model."""

    text: str
    uuid: str | None = None  # the session's id for it, where the harness gives one (to edit it later)


@dataclass
class DoneEvent:
    turns: int
    cost_usd: float | None
    is_error: bool
    session_id: str | None
    result: str | None = None
    prompt_id: str | None = (
        None  # the session's id for the message that started the turn (to rewind to it later)
    )


Event = ToolEvent | ToolFailedEvent | TextEvent | ThinkingEvent | SteeredEvent | DoneEvent


def ran(command: str) -> str:
    """A shell command as one short line: ``Ran git diff --stat``."""
    cmd = " ".join(command.split())
    return f"Ran {cmd if len(cmd) <= 60 else cmd[:57] + '…'}"


def summarize_tool(name: str, args: dict) -> str:
    short = name.rsplit("__", 1)[-1]
    if short == "Bash" and args.get("command"):
        return ran(str(args["command"]))
    if short.lower() in ("grep", "glob"):
        return f"{short.capitalize()} {args.get('pattern', '')}".strip()
    if short.lower() in ("read", "read_file"):
        return f"Read {Path(args.get('file_path') or args.get('path') or '').name}"
    if short == "get_hunk":
        ids = args.get("ids") or []
        return f"Hunk {', '.join(ids) if isinstance(ids, list) else ids}"
    return short


@dataclass
class ToolSpec:
    """A custom tool the engine exposes to the agent (e.g. ``get_hunk``)."""

    name: str
    description: str
    schema: dict
    handler: Callable[[dict], Awaitable[str]]


Mode = Literal["read-only", "default", "acceptEdits", "plan", "auto", "full-access"]
"""How much a chat may do. read-only: Diffusion's read tools only (for agents without modes, like Cursor). The rest are Claude Code's own permission
modes (Manual, Accept edits, Plan, Auto), run with the session's own tools and settings: default asks before anything
those don't allow, acceptEdits also lets file edits through, plan only plans, auto lets Claude Code's safety check
decide instead of asking. Codex has its own (its /approvals presets): read-only (reads, asks to do more), auto (writes
in the workspace, asks to go past it), full-access (anything, never asks)."""

# Each agent's own modes, its default first. Agents not listed (Cursor) only read.
HARNESS_MODES: dict[str, tuple[Mode, ...]] = {
    "claude-code": ("default", "acceptEdits", "plan", "auto"),
    "codex": ("auto", "read-only", "full-access"),
}


def mode_for(harness: str, mode: str) -> Mode:
    """The mode a session of ``harness`` runs in when ``mode`` is asked: it, if the agent has it, else its default."""
    modes = HARNESS_MODES.get(harness)
    if not modes:
        return "read-only"
    found: Mode = modes[0]
    for m in modes:
        if m == mode:
            found = m
    return found


Decision = Literal["allow", "deny", "always"]
"""The reviewer's answer to a tool call; always also allows its kind for the rest of the session."""

Approver = Callable[[str, str, dict], Awaitable[Decision]]
"""Ask the reviewer about a tool call: (tool name, one-line summary, input) -> decision."""

EDIT_TOOLS = ("Edit", "MultiEdit", "Write", "NotebookEdit")


def allowed_in(mode: Mode, tool: str) -> bool:
    """Whether switching to ``mode`` answers a waiting ask for ``tool``: Auto takes anything, Accept edits edits."""
    return mode in ("auto", "full-access") or (mode == "acceptEdits" and tool in EDIT_TOOLS)


@dataclass
class AgentRequest:
    system_prompt: str
    prompt: str
    model: str
    cwd: Path
    tools: list[ToolSpec] = field(default_factory=list)
    max_turns: int = 40
    resume: str | None = None
    fork: bool = False  # branch the resumed session instead of adding to it
    adopt: bool = False  # add to someone else's session (the guide's), which hasn't seen our system prompt
    include_partial: bool = False
    mode: Mode = "read-only"
    approve: Approver | None = None
    # Messages to slip into the running turn, as (text, accepted): the runner sets accepted True once it has sent
    # the text on, or False when the turn is already over. Only runners that can steer read it.
    steer: asyncio.Queue[tuple[str, asyncio.Future[bool]]] | None = None
    # Rewinding (editing an earlier message): resume the session only up to this point (Claude Code: the entry
    # before the message; Codex: the message's turn, reverted with what followed), and, for Claude Code, first put
    # the files back as they were at that user message (``restore_files``), as its rewind does.
    resume_at: str | None = None
    restore_files: str | None = None
    # Extra environment for the agent's process (and so for the commands it runs).
    env: dict[str, str] = field(default_factory=dict)
    # Modes picked while it runs, to switch the running session to (as Shift+Tab does). Only Claude Code reads it.
    modes: asyncio.Queue[Mode] | None = None
    # Beyond the checkout, where a sandboxed agent (Codex) may write, and whether it may reach the network, when its
    # mode lets it write: a review's submit writes Diffusion's cache and may fetch the package.
    writable_roots: list[Path] = field(default_factory=list)
    network: bool = False

    @property
    def native(self) -> bool:
        """Run as the session itself would: its own tools, settings and instructions."""
        return self.mode != "read-only"


class Runner(Protocol):
    def __call__(self, req: AgentRequest) -> AsyncIterator[Event]: ...


class SandboxError(ValueError):
    pass


def within(root: Path, path: str | Path) -> Path:
    """Resolve ``path`` (relative to ``root`` unless absolute) and require it to stay inside ``root``."""
    root = root.resolve()
    p = Path(path)
    p = (p if p.is_absolute() else root / p).resolve()
    if p != root and root not in p.parents:
        raise SandboxError(f"{path} is outside the repository")
    return p


def make_runner(harness: str, cli_path: str | None) -> Runner:
    """The runner for an agent CLI."""
    if harness == "claude-code":
        from .backends.claude_code import claude_code_runner

        return claude_code_runner(cli_path)
    if harness == "codex":
        from .backends.codex import codex_runner

        return codex_runner(cli_path)
    if harness == "cursor":
        from .backends.cursor import cursor_runner

        return cursor_runner(cli_path)
    raise ValueError(f"unknown agent {harness!r}")
