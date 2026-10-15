"""Backend-neutral agent interface: requests, events, custom tools, and the runner seam.

A *runner* takes an ``AgentRequest`` and yields ``Event``s. Backends (``backends/``) implement it on top of a
model API (our own loop) or an agent CLI (Claude Code, Codex). Everything else in the engine only sees this.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .config import Config


def inline_refs(schema: dict) -> dict:
    """Inline ``$defs`` so tool schemas are flat (some tool-callers handle ``$ref`` poorly)."""
    defs = schema.get("$defs", {})

    def walk(node: Any, is_props: bool = False) -> Any:
        if isinstance(node, list):
            return [walk(v) for v in node]
        if not isinstance(node, dict):
            return node
        if is_props:  # {property name: schema}: keys are names (e.g. "title"), not keywords
            return {k: walk(v) for k, v in node.items()}
        if "$ref" in node:
            return walk(defs[node["$ref"].rsplit("/", 1)[-1]])
        return {k: walk(v, k == "properties") for k, v in node.items() if k not in ("$defs", "title")}

    return walk(schema)


# ---------- events surfaced to callers (CLI progress, SSE) ----------


@dataclass
class ToolEvent:
    name: str
    summary: str


@dataclass
class TextEvent:
    text: str


@dataclass
class DoneEvent:
    turns: int
    cost_usd: float | None
    is_error: bool
    session_id: str | None
    result: str | None = None


Event = ToolEvent | TextEvent | DoneEvent


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
    """A custom tool the engine exposes to the agent (e.g. ``get_hunk``, ``submit_guide``).

    ``terminal`` tools end the task: backends that support structured final output (Codex) may use the tool's
    schema as the output schema and call the handler with the final result instead of exposing it as a tool.
    """

    name: str
    description: str
    schema: dict
    handler: Callable[[dict], Awaitable[str]]
    terminal: bool = False


@dataclass
class AgentRequest:
    system_prompt: str
    prompt: str
    model: str
    cwd: Path
    tools: list[ToolSpec] = field(default_factory=list)
    max_turns: int = 40
    resume: str | None = None
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


def make_runner(cfg: Config) -> Runner:
    """The runner for the configured backend."""
    if cfg.backend == "api":
        from .backends.api import api_runner

        return api_runner(cfg)
    if cfg.backend == "claude-code":
        from .backends.claude_code import claude_code_runner

        return claude_code_runner(cfg)
    if cfg.backend == "codex":
        from .backends.codex import codex_runner

        return codex_runner(cfg)
    raise ValueError(f"unknown backend {cfg.backend!r}")
