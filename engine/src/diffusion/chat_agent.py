"""Chat about a PR: one agent session per chat, seeded with the PR, hunk table, and guide.

The first turn forks the session that wrote the guide when the agent can (so chat starts from everything that
session read); otherwise it starts fresh. A turn carries one or more questions (queued line comments are sent
together). Multi-question turns ask the model for ``### Q<n>`` sections; ``SectionSplitter`` routes streamed
text to each question as it arrives. The model can point the reviewer's diff at a region with ``show_code``;
each accepted call becomes a ``ChatFocus`` attached to the question being answered at that moment. Asked to
change the guide, it ends its answer with the whole updated guide in a ``diffusion-guide`` block, which
``GuideBlock`` keeps out of the streamed answer and the caller stores as a new version.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path

from pydantic import BaseModel, Field

from .agent import AgentRequest, DoneEvent, Event, Runner, TextEvent, ToolEvent, ToolSpec
from .hunks import DiffIndex
from .pipeline import Prepared

SYSTEM_PROMPT = files("diffusion.prompts").joinpath("chat.md").read_text()
MAX_ANCHOR_LINES = 80
MAX_SHOWS_PER_TURN = 6
MAX_HUNKS_PER_CALL = 12
GUIDE_FENCE = "```diffusion-guide"
SHOW_REMINDER = "(If a question asks where something is or happens, or to show code, call `show_code` first.)"


class Anchor(BaseModel):
    file: str
    start: int
    end: int
    side: str = "new"
    code: str = ""
    step: int | None = None
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
            k: guide[k] for k in ("tldr", "context", "steps", "flow", "skippable") if k in guide
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
        body.append(q.text.strip())
        blocks.append("\n".join(x for x in [head, *body] if x))
    if multi:
        nums = ", ".join(f"Q{q.n}" for q in questions)
        blocks.append(f"Answer {nums}, each under its own `### Q<n>` heading.")
    # A per-turn reminder: the system prompt alone gets show_code skipped on plain "where is…" questions.
    blocks.append(SHOW_REMINDER)
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
class ChatFocus:
    """A diff region the model asked the reviewer's view to focus on (validated against the diff)."""

    n: int
    file: str
    start: int
    end: int
    side: str
    label: str = ""

    def to_dict(self) -> dict:
        return {"n": self.n, "file": self.file, "start": self.start, "end": self.end, "side": self.side,
                "label": self.label}  # fmt: skip


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


def show_code_tool(idx: DiffIndex, shown: list[dict]) -> ToolSpec:
    async def show_code(args: dict) -> str:
        if len(shown) >= MAX_SHOWS_PER_TURN:
            return f"rejected: at most {MAX_SHOWS_PER_TURN} regions per answer"
        f = idx.resolve(str(args.get("file", "")))
        if not f:
            return "rejected: file is not in the diff; cite it as `path:line` in the answer instead"
        side = "old" if args.get("side") == "old" else "new"
        try:
            start = int(args["start"])
            end = int(args.get("end") or start)
        except (KeyError, TypeError, ValueError):
            return "rejected: start/end must be line numbers"
        start, end = min(start, end), max(start, end)
        spans = [(h.new_start, h.new_end) if side == "new" else (h.old_start, h.old_end) for h in f.hunks]
        hit = [(lo, hi) for lo, hi in spans if start <= hi and end >= lo]
        if not hit:
            near = ", ".join(f"{lo}–{hi}" for lo, hi in spans) or "none"
            return f"rejected: {f.path}:{start}–{end} is outside the diff ({side} side hunks: {near})"
        # Clamp to the changed region so the client can always highlight something.
        start, end = max(start, min(lo for lo, _ in hit)), min(end, max(hi for _, hi in hit))
        label = str(args.get("label") or "").strip()[:80]
        q = args.get("q")
        q = int(q) if isinstance(q, int | str) and str(q).isdigit() else None
        shown.append({"file": f.path, "start": start, "end": end, "side": side, "label": label, "q": q})
        return f"shown {f.path}:{start}–{end}"

    return ToolSpec(
        "show_code",
        "Focus the reviewer's diff view on a region of the diff. Use when the reviewer asks where something "
        "happens or asks you to show them code. Only regions inside the diff (see the hunk table) can be shown.",
        {
            "type": "object",
            "properties": {
                "file": {"type": "string", "description": "Path as in the hunk table."},
                "start": {"type": "integer", "description": "First line (on `side`)."},
                "end": {"type": "integer", "description": "Last line, inclusive; defaults to start."},
                "side": {
                    "type": "string",
                    "enum": ["new", "old"],
                    "description": "'old' only for deleted lines.",
                },
                "label": {
                    "type": "string",
                    "description": "A few words on what is there, e.g. 'retry loop'.",
                },
                "q": {
                    "type": "integer",
                    "description": "When answering several questions: which one (2 for Q2).",
                },
            },
            "required": ["file", "start"],
        },
        show_code,
    )


async def run_turn(
    prep: Prepared,
    guide: dict | None,
    questions: list[Question],
    runner: Runner,
    model: str,
    resume: str | None,
    fork: bool = False,
    cwd: Path | None = None,
    block: GuideBlock | None = None,
    max_turns: int = 24,
) -> AsyncIterator[ChatDelta | ChatFocus | ToolEvent | DoneEvent]:
    """``block`` collects an updated guide the answer ends with (``block.found``)."""
    shown: list[dict] = []
    tools = [hunk_tool(prep.index), show_code_tool(prep.index, shown)]
    req = AgentRequest(
        system_prompt=SYSTEM_PROMPT + "\n\n" + seed_context(prep, guide),
        prompt=format_turn(questions, prep.index),
        model=model,
        cwd=cwd or prep.checkout.worktree,
        tools=tools,
        max_turns=max_turns,
        resume=resume,
        fork=fork,
        include_partial=True,
    )
    block = block if block is not None else GuideBlock()
    split = SectionSplitter([q.n for q in questions])
    drained = 0

    def focuses() -> list[ChatFocus]:
        # Tool handlers run inside the runner; pick up what they accepted since the last event.
        nonlocal drained
        new, drained = shown[drained:], len(shown)
        out = []
        for s in new:
            # The model may call show_code before writing a question's marker, so prefer the question it names.
            n = s["q"] if s["q"] in split.valid else split.cur
            out.append(ChatFocus(n, s["file"], s["start"], s["end"], s["side"], s["label"]))
        return out

    ev: Event
    async for ev in runner(req):
        for f in focuses():
            yield f
        if isinstance(ev, TextEvent):
            for n, t in split.feed(block.feed(ev.text)):
                yield ChatDelta(n, t)
        elif isinstance(ev, ToolEvent):
            # Text before a tool call is narration ("Let me check…"); reset so it doesn't glue to the answer.
            for n, t in split.break_line():
                yield ChatDelta(n, t)
            yield ev
        elif isinstance(ev, DoneEvent):
            for n, t in split.feed(block.flush()) + split.flush():
                yield ChatDelta(n, t)
            for f in focuses():
                yield f
            yield ev


def _title(meta) -> str:
    r = meta.ref
    return f"Local branch {meta.head_ref} vs {meta.base_ref}" if r.is_local else f"PR {r.slug}#{r.number}"
