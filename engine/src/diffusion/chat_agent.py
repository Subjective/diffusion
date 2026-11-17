"""Chat about a PR: one agent session per chat, seeded with the PR, hunk table, and guide.

The first turn forks the session that wrote the guide when the agent can (so chat starts from everything that
session read); otherwise it starts fresh. A turn carries one or more questions (queued line comments are sent
together). Multi-question turns ask the model for ``### Q<n>`` sections; ``SectionSplitter`` routes streamed
text to each question as it arrives. Asked to change the guide, the model ends its answer with the whole updated guide in a ``diffusion-guide`` block, which
``GuideBlock`` keeps out of the streamed answer and the caller stores as a new version.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path
from typing import cast

from pydantic import BaseModel, Field

from .agent import (
    AgentRequest,
    Approver,
    DoneEvent,
    Event,
    Mode,
    Runner,
    SteeredEvent,
    TextEvent,
    ThinkingEvent,
    ToolEvent,
    ToolFailedEvent,
    ToolSpec,
)
from .commands import raw_command
from .hunks import DiffIndex
from .pipeline import Prepared

SYSTEM_PROMPT = files("diffusion.prompts").joinpath("chat.md").read_text()

_NATIVE = (
    "## Your tools here\n"
    "This is your own session, continued in Diffusion's review panel: you have your usual tools, settings and "
    "permissions on your usual working directory. When the reviewer asks you to change code, run something, or fix "
    "what you found, do it as you would in the terminal; anything your settings don't already allow is put to the "
    "reviewer to approve in the chat. "
)
# What the chat may do, said plainly: the model otherwise guesses from what it remembers of earlier turns.
MODE_NOTE: dict[str, str] = {
    "read-only": "## Your tools here\nThis chat can only read the repository (checked out at the PR head): you "
    "can't change files or run commands. If asked for a change, say so and give the exact edit instead.",
    "default": _NATIVE + "This mode asks before edits and commands.",
    "acceptEdits": _NATIVE + "This mode makes file edits without asking and asks before commands.",
    "auto": _NATIVE + "This mode acts without asking; a safety check blocks risky actions.",
    "plan": "## Your tools here\nThis is your own session, continued in Diffusion's review panel, in plan mode: "
    "read and plan, and present the plan for the reviewer to approve before changing anything.",
}
_CODEX = (
    "## Your tools here\nThis is your own session, continued in Diffusion's review panel, with your usual tools and "
    "settings. "
)
CODEX_MODE_NOTE: dict[str, str] = {
    "read-only": _CODEX
    + "This mode reads; anything that writes or reaches the network is put to the reviewer.",
    "auto": _CODEX
    + "This mode edits and runs commands in the workspace; going past it is put to the reviewer.",
    "full-access": _CODEX + "This mode can do anything without asking.",
}
MAX_ANCHOR_LINES = 80
MAX_HUNKS_PER_CALL = 12
GUIDE_FENCE = "```diffusion-guide"
# Ends every turn Diffusion sends, so a session transcript can tell its turns from ones typed in the terminal.
TURN_NOTE = "(Cite code as `path:line` so the reviewer can click through to it.)"


class Anchor(BaseModel):
    file: str
    start: int
    end: int
    side: str = "new"
    code: str = ""
    step: int | None = None
    comment: str | None = Field(default=None, description="Title and text of the guide comment asked about.")
    ui: dict | None = Field(default=None, description="Opaque client data; stored, not prompted.")


class Question(BaseModel):
    n: int = Field(description="Question number within the chat (1-based).")
    text: str
    anchor: Anchor | None = None


def seed_context(prep: Prepared, guide: dict | None) -> str:
    """Stable per-PR prefix appended to the system prompt (prompt-cached across turns). The guide is given as
    its draft (refs by path and line), the form an updated guide is written back in."""
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
        draft = guide.get("draft") or {
            k: guide[k] for k in ("tldr", "comments", "steps", "views", "skippable") if k in guide
        }
        parts += ["## Reviewer's guide (JSON)", "```json", json.dumps(draft, ensure_ascii=False), "```"]
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
            if a.comment:
                body.append(f"Your guide left this comment on those lines: {a.comment}")
        body.append(q.text.strip())
        blocks.append("\n".join(x for x in [head, *body] if x))
    if multi:
        nums = ", ".join(f"Q{q.n}" for q in questions)
        blocks.append(f"Answer {nums}, each under its own `### Q<n>` heading.")
    blocks.append(TURN_NOTE)
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


@dataclass
class ChatSteered:
    """Questions sent into the running turn reached the model; what it writes from here answers them."""

    questions: list[Question]
    uuid: str | None = None


def _could_open(partial: str) -> bool:
    head = partial.lstrip()
    return GUIDE_FENCE.startswith(head) or head.startswith(GUIDE_FENCE)


class GuideBlock:
    """Pass streamed text through, holding back a ``diffusion-guide`` fenced block and keeping its body.

    Text is cut into lines; a partial line is passed on at once unless it could still become the fence."""

    def __init__(self) -> None:
        self.partial = ""
        self.inside = False
        self.body: list[str] = []
        self.found: str | None = None

    def _line(self, line: str) -> str:
        if self.inside:
            if line.strip() == "```":
                self.inside, self.found = False, "".join(self.body)
            else:
                self.body.append(line)
            return ""
        if line.strip().startswith(GUIDE_FENCE):
            self.inside, self.body = True, []
            return ""
        return line

    def feed(self, text: str) -> str:
        out = []
        for piece in re.split(r"(?<=\n)", text):
            if not piece:
                continue
            self.partial += piece
            if self.partial.endswith("\n"):
                out.append(self._line(self.partial))
                self.partial = ""
            elif not self.inside and not _could_open(self.partial):
                out.append(self.partial)
                self.partial = ""
        return "".join(out)

    def flush(self) -> str:
        rest, self.partial = self.partial, ""
        out = self._line(rest) if rest else ""
        if self.inside:  # the answer ended before the closing fence
            self.inside, self.found = False, "".join(self.body)
        return out


def hunk_summary(summary: str, idx: DiffIndex) -> str:
    """``Hunk H1, H2`` names hunks by ID, which mean nothing to the reviewer; say which lines they cover instead:
    ``Diff session.ts:1–8, types.ts:1–3``."""
    spans: dict[str, list[str]] = {}
    for hid in re.findall(r"H\d+", summary.upper()):
        if h := idx.by_id.get(hid):
            a, b = (h.new_start, h.new_end) if h.new_len else (h.old_start, h.old_end)
            spans.setdefault(Path(h.file).name, []).append(f"{a}–{b}" if b > a else str(a))
    return "Diff " + ", ".join(f"{f}:{', '.join(r)}" for f, r in spans.items()) if spans else summary


def hunk_tool(idx: DiffIndex) -> ToolSpec:
    async def get_hunk(args: dict) -> str:
        ids = args.get("ids") or []
        ids = [ids] if isinstance(ids, str) else ids
        out = []
        for hid in ids[:MAX_HUNKS_PER_CALL]:
            h = idx.by_id.get(str(hid).strip().upper())
            out.append(h.annotated() if h else f"[{hid}] unknown hunk")
        if len(ids) > MAX_HUNKS_PER_CALL:
            out.append(f"(only first {MAX_HUNKS_PER_CALL} returned; request the rest separately)")
        return "\n\n".join(out)

    return ToolSpec(
        "get_hunk",
        "Return the annotated diff for hunks by ID (new line, old line, +/-, code).",
        {
            "type": "object",
            "properties": {
                "ids": {"type": "array", "items": {"type": "string"}, "description": "e.g. ['H1','H4']"}
            },
            "required": ["ids"],
        },
        get_hunk,
    )


async def run_turn(
    prep: Prepared,
    guide: dict | None,
    questions: list[Question],
    runner: Runner,
    model: str,
    resume: str | None,
    fork: bool = False,
    adopt: bool = False,
    cwd: Path | None = None,
    block: GuideBlock | None = None,
    max_turns: int = 24,
    mode: Mode = "read-only",
    approve: Approver | None = None,
    harness: str = "",
    steer: asyncio.Queue[tuple[list[Question], asyncio.Future[bool]]] | None = None,
    resume_at: str | None = None,
    restore_files: str | None = None,
    modes: asyncio.Queue[Mode] | None = None,
) -> AsyncIterator[ChatDelta | ChatSteered | ToolEvent | ToolFailedEvent | ThinkingEvent | DoneEvent]:
    """``block`` collects an updated guide the answer ends with (``block.found``). ``steer`` takes questions to
    send into the running turn, for runners that can (see ``AgentRequest.steer``)."""
    tools = [hunk_tool(prep.index)]
    req = AgentRequest(
        system_prompt=SYSTEM_PROMPT
        + "\n\n"
        + (
            (harness == "codex" and CODEX_MODE_NOTE.get(mode))
            or MODE_NOTE.get(mode)
            or MODE_NOTE["read-only"]
        )
        + "\n\n"
        + seed_context(prep, guide),
        # A command (`/code-review`, a Codex `$skill`) goes as typed, so the harness runs it rather than reading it.
        prompt=(len(questions) == 1 and not questions[0].anchor and raw_command(harness, questions[0].text))
        or format_turn(questions, prep.index),
        model=model,
        cwd=cwd or prep.checkout.worktree,
        tools=tools,
        max_turns=max_turns,
        resume=resume,
        fork=fork,
        adopt=adopt,
        include_partial=True,
        mode=mode,
        approve=approve,
        steer=asyncio.Queue() if steer else None,
        resume_at=resume_at,
        restore_files=restore_files,
        modes=modes,
    )
    block = block if block is not None else GuideBlock()
    split = SectionSplitter([q.n for q in questions])
    sent: dict[str, list[Question]] = {}  # steered text -> its questions

    async def forward(src: asyncio.Queue, dst: asyncio.Queue) -> None:
        while True:
            qs, accepted = await src.get()
            text = format_turn(qs, prep.index)
            sent[text] = qs
            await dst.put((text, accepted))

    relay = asyncio.create_task(forward(steer, req.steer)) if steer and req.steer else None

    try:
        async with aclosing(cast(AsyncGenerator[Event], runner(req))) as events:
            async for out in _events(events, split, block, prep, sent):
                yield out
    finally:
        if relay:
            relay.cancel()


async def _events(
    events: AsyncIterator[Event],
    split: SectionSplitter,
    block: GuideBlock,
    prep: Prepared,
    sent: dict[str, list[Question]],
) -> AsyncIterator[ChatDelta | ChatSteered | ToolEvent | ToolFailedEvent | ThinkingEvent | DoneEvent]:
    """The runner's events, as the chat's: text routed to questions, guide blocks held back, steers marked."""
    ev: Event
    async for ev in events:
        if isinstance(ev, SteeredEvent):
            qs = sent.pop(ev.text, None)
            if qs:
                for n, t in split.flush():
                    yield ChatDelta(n, t)
                split.valid |= {q.n for q in qs}
                split.cur = qs[0].n
                yield ChatSteered(qs, ev.uuid)
        elif isinstance(ev, TextEvent):
            for n, t in split.feed(block.feed(ev.text)):
                yield ChatDelta(n, t)
        elif isinstance(ev, ThinkingEvent | ToolFailedEvent):
            yield ev
        elif isinstance(ev, ToolEvent):
            # Text before a tool call is narration ("Let me check…"); reset so it doesn't glue to the answer.
            for n, t in split.break_line():
                yield ChatDelta(n, t)
            if ev.name.endswith("get_hunk"):
                ev = ToolEvent(ev.name, hunk_summary(ev.summary, prep.index), ev.id)
            yield ev
        elif isinstance(ev, DoneEvent):
            for n, t in split.feed(block.flush()) + split.flush():
                yield ChatDelta(n, t)
            yield ev


def _title(meta) -> str:
    r = meta.ref
    return f"Local branch {meta.head_ref} vs {meta.base_ref}" if r.is_local else f"PR {r.slug}#{r.number}"
