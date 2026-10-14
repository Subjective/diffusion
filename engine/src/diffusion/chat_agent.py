"""Chat about a PR: one Agent SDK session per chat, seeded with the PR, hunk table, and guide.

A turn carries one or more questions (queued line comments are sent together). Multi-question turns ask the
model for ``### Q<n>`` sections; ``SectionSplitter`` routes streamed text to each question as it arrives.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from importlib.resources import files

from pydantic import BaseModel, Field

from .agent import AgentRequest, DoneEvent, Event, Runner, TextEvent, ToolEvent
from .guide_agent import guide_tools
from .hunks import DiffIndex
from .pipeline import Prepared

SYSTEM_PROMPT = files("diffusion.prompts").joinpath("chat.md").read_text()
MAX_ANCHOR_LINES = 80


class Anchor(BaseModel):
    file: str
    start: int
    end: int
    side: str = "new"
    code: str = ""
    step: int | None = None
    ui: dict | None = Field(None, description="Opaque client data; stored, not prompted.")


class Question(BaseModel):
    n: int = Field(description="Question number within the chat (1-based).")
    text: str
    anchor: Anchor | None = None


def seed_context(prep: Prepared, guide: dict | None) -> str:
    """Stable per-PR prefix appended to the system prompt (prompt-cached across turns)."""
    m = prep.meta
    parts = [
        f"# {_title(m)}: {m.title}",
        f"Author: {m.author} · {m.head_ref} → {m.base_ref} · head {m.head_sha[:12]}",
        "## Description",
        m.body.strip() or "(none)",
        "## Hunk table",
        "```",
        prep.index.table(),
        "```",
    ]
    if guide:
        slim = {
            k: guide[k] for k in ("tldr", "context", "steps", "flow", "skippable", "uncovered") if k in guide
        }
        parts += ["## Reviewer's guide (JSON)", "```json", json.dumps(slim, ensure_ascii=False), "```"]
    return "\n".join(parts)


def _hunk_for(idx: DiffIndex, a: Anchor) -> str | None:
    for h in idx.hunks:
        if h.file != a.file:
            continue
        lo, hi = (h.new_start, h.new_end) if a.side == "new" else (h.old_start, h.old_end)
        if a.start <= hi and a.end >= lo:
            return h.id
    return None


def format_turn(questions: list[Question], idx: DiffIndex) -> str:
    multi = len(questions) > 1
    blocks = []
    for q in questions:
        head = f"## Q{q.n}" if multi else ""
        body = []
        if q.anchor:
            a = q.anchor
            rng = f"{a.start}" if a.start == a.end else f"{a.start}–{a.end}"
            hid = _hunk_for(idx, a)
            where = f"`{a.file}:{rng}`" + (f" ({a.side} side, hunk {hid})" if hid else f" ({a.side} side)")
            code = "\n".join(a.code.splitlines()[:MAX_ANCHOR_LINES])
            body.append(f"About {where}:\n```\n{code}\n```")
        body.append(q.text.strip())
        blocks.append("\n".join(x for x in [head, *body] if x))
    if multi:
        nums = ", ".join(f"Q{q.n}" for q in questions)
        blocks.append(f"Answer {nums}, each under its own `### Q<n>` heading.")
    return "\n\n".join(blocks)


_MARK = re.compile(r"^\s*#{1,4}\s*Q(\d+)\b.*$")
_MAYBE_MARK = re.compile(r"^\s*#{0,4}\s*Q?\d*$")


class SectionSplitter:
    """Route streamed text to questions on ``### Q<n>`` marker lines.

    Complete lines are emitted as they arrive; a partial line is emitted immediately unless it could still
    become a marker, so markers never leak into answers. Text before the first marker goes to the first
    question.
    """

    def __init__(self, ns: list[int]):
        self.valid = set(ns)
        self.cur = ns[0]
        self.partial = ""  # current incomplete line (not yet emitted)
        self.emitted = 0  # chars of `partial` already emitted

    def _route(self, line: str) -> bool:
        m = _MARK.match(line)
        if m and int(m.group(1)) in self.valid:
            self.cur = int(m.group(1))
            return True
        return False

    def feed(self, text: str) -> list[tuple[int, str]]:
        out: list[tuple[int, str]] = []
        for piece in re.split(r"(?<=\n)", text):
            if not piece:
                continue
            self.partial += piece
            if self.partial.endswith("\n"):
                line = self.partial
                if self.emitted == 0 and self._route(line.rstrip("\n")):
                    pass
                else:
                    out.append((self.cur, line[self.emitted :]))
                self.partial, self.emitted = "", 0
            elif self.emitted or not (_MAYBE_MARK.match(self.partial) or _MARK.match(self.partial)):
                out.append((self.cur, self.partial[self.emitted :]))
                self.emitted = len(self.partial)
        return [(n, t) for n, t in out if t]

    def break_line(self) -> list[tuple[int, str]]:
        """End the current line (e.g. before a tool call), separating narration from what follows."""
        had = bool(self.partial)
        out = self.flush()
        if had:
            out.append((self.cur, "\n\n"))
        return out

    def flush(self) -> list[tuple[int, str]]:
        rest = self.partial[self.emitted :]
        line, self.partial, self.emitted = self.partial, "", 0
        if not rest or (line == rest and self._route(line)):
            return []
        return [(self.cur, rest)]


@dataclass
class ChatDelta:
    n: int
    text: str


async def run_turn(
    prep: Prepared,
    guide: dict | None,
    questions: list[Question],
    runner: Runner,
    model: str,
    resume: str | None,
    max_turns: int = 24,
) -> AsyncIterator[ChatDelta | ToolEvent | DoneEvent]:
    tools = [t for t in guide_tools(prep.index, []) if t.name == "get_hunk"]
    req = AgentRequest(
        system_prompt=SYSTEM_PROMPT + "\n\n" + seed_context(prep, guide),
        prompt=format_turn(questions, prep.index),
        model=model,
        cwd=prep.checkout.worktree,
        tools=tools,
        max_turns=max_turns,
        resume=resume,
        include_partial=True,
    )
    split = SectionSplitter([q.n for q in questions])
    ev: Event
    async for ev in runner(req):
        if isinstance(ev, TextEvent):
            for n, t in split.feed(ev.text):
                yield ChatDelta(n, t)
        elif isinstance(ev, ToolEvent):
            # Text before a tool call is narration ("Let me check…"); reset so it doesn't glue to the answer.
            for n, t in split.break_line():
                yield ChatDelta(n, t)
            yield ev
        elif isinstance(ev, DoneEvent):
            for n, t in split.flush():
                yield ChatDelta(n, t)
            yield ev


def _title(meta) -> str:
    r = meta.ref
    return f"Local branch {meta.head_ref} vs {meta.base_ref}" if r.is_local else f"PR {r.slug}#{r.number}"
