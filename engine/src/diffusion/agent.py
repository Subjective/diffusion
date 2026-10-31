"""Backend-neutral agent interface: requests, events, custom tools, and the runner seam.

A *runner* takes an ``AgentRequest`` and yields ``Event``s. Backends (``backends/``) implement it on top of an
agent CLI (Claude Code, Codex, Cursor). Chat is the only thing in the engine that runs an agent; guides are
written by the agent Diffusion is launched from.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

# ---------- events surfaced to callers (CLI progress, SSE) ----------


@dataclass
class ToolEvent:
    name: str
    summary: str


@dataclass
class TextEvent:
    text: str


@dataclass
class ThinkingEvent:
    """Reasoning the agent shows (Claude's thinking summaries, Codex reasoning items, Cursor thinking)."""

    text: str


@dataclass
class DoneEvent:
    turns: int
    cost_usd: float | None
    is_error: bool
    session_id: str | None
    result: str | None = None


Event = ToolEvent | TextEvent | ThinkingEvent | DoneEvent


def summarize_tool(name: str, args: dict) -> str:
    short = name.rsplit("__", 1)[-1]
    if short.lower() in ("grep", "glob"):
        return f"{short.capitalize()} {args.get('pattern', '')}".strip()
    if short.lower() in ("read", "read_file"):
        return f"Read {Path(args.get('file_path') or args.get('path') or '').name}"
    if short == "get_hunk":
        ids = args.get("ids") or []
        return f"Hunk {', '.join(ids) if isinstance(ids, list) else ids}"
    if short == "show_code":
        return f"Show {Path(str(args.get('file', ''))).name}:{args.get('start', '')}"
    return short


@dataclass
class ToolSpec:
    """A custom tool the engine exposes to the agent (e.g. ``get_hunk``, ``show_code``)."""

    name: str
    description: str
    schema: dict
    handler: Callable[[dict], Awaitable[str]]


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
    include_partial: bool = False


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
