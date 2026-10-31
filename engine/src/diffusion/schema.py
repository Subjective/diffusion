"""Guide schema.

``GuideDraft`` is what an agent writes and ``diffusion submit`` checks: it cites changed lines by path and line
number. ``Guide`` is what the UI renders: the draft with every citation mapped onto the diff's hunks, plus
fields computed by code (skippable files, uncovered hunks, validation report). Visuals are chosen from fixed
enums; the UI maps them to icons.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

StepKind = Literal["entry", "core", "contract", "wiring", "cleanup", "test", "config", "docs"]
Tone = Literal["bug", "check", "note"]
SkipReason = Literal[
    "lockfile", "generated", "snapshot", "vendored", "rename", "binary", "formatting", "trivial"
]
Side = Literal["new", "old"]
BlockKind = Literal["box", "region"]
ArrowKind = Literal["call", "data", "event", "error"]
Layout = Literal["flow"]


class LineRef(BaseModel):
    """Changed lines as an agent cites them: a path and line numbers in the diff."""

    file: str = Field(description="Path of a changed file, relative to the repository root.")
    start: int | None = Field(
        default=None, description="First line on `side`; omit for every change in the file."
    )
    end: int | None = Field(default=None, description="Last line, inclusive; defaults to `start`.")
    side: Side = Field(
        default="new",
        description="'new' for added and unchanged lines (head numbers), 'old' for deleted lines.",
    )


class Ref(BaseModel):
    """Lines within one hunk, as the UI links them."""

    hunk: str
    side: Side = "new"
    start: int | None = None
    end: int | None = None


class CommentDraft(BaseModel):
    title: str = Field(description="2–4 words naming the point, e.g. 'Never re-armed'.")
    text: str = Field(description="1–2 sentences, ≤ 35 words. Inline `code` allowed.")
    tone: Tone = Field(
        default="note",
        description="'bug' for a likely defect, 'check' for something worth verifying, 'note' for context.",
    )
    refs: list[LineRef] = Field(min_length=1, description="The changed lines this comment is about.")


class SubstepDraft(BaseModel):
    title: str = Field(description="1–4 words, e.g. 'Load affinity'.")
    summary: str = Field(description="≤ 20 words: what this part does and what to check.")
    refs: list[LineRef] = Field(
        min_length=1, description="Narrow line ranges; several if the logic is split."
    )


class StepDraft(BaseModel):
    title: str = Field(description="1–3 words, e.g. 'Refresh loop'.")
    kind: StepKind
    summary: str = Field(
        description="≤ 25 words of markdown explaining what to look for. Inline `code` allowed."
    )
    refs: list[LineRef] = Field(
        default_factory=list,
        description="Refs for the step as a whole. May be empty when substeps carry them.",
    )
    substeps: list[SubstepDraft] = Field(
        default_factory=list, max_length=8, description="Ordered parts of this step to read one at a time."
    )


class BlockDraft(BaseModel):
    id: str = Field(description="Short unique id within the view, e.g. 'refresh'.")
    label: str = Field(
        description="What the reader sees: a function, type or component name, e.g. 'refresh()'."
    )
    kind: BlockKind = Field(
        default="box",
        description="'box' for a piece of code; 'region' groups boxes (a file, class or module).",
    )
    parent: str | None = Field(default=None, description="Id of the region this box sits in.")
    step: int | None = Field(default=None, description="1-based index of the step that covers this block.")
    refs: list[LineRef] = Field(
        default_factory=list,
        description="The changed lines this block stands for. Leave empty for unchanged code shown as context.",
    )


class ArrowDraft(BaseModel):
    source: str = Field(alias="from", description="Block id.")
    target: str = Field(alias="to", description="Block id.")
    label: str | None = Field(default=None, description="≤ 2 words, e.g. 'fires', 'tokens'.")
    kind: ArrowKind = Field(
        default="call", description="'call', 'data' (a value passed along), 'event' (async), or 'error'."
    )

    model_config = {"populate_by_name": True}


class SceneDraft(BaseModel):
    title: str = Field(description="1–4 words, e.g. 'Arm the timer'.")
    text: str = Field(description="1–2 sentences, ≤ 30 words. Inline `code` allowed.")
    blocks: list[str] = Field(min_length=1, description="Ids of the blocks this scene frames and lights.")
    step: int | None = Field(default=None, description="1-based index of the step this scene tells.")


class ViewDraft(BaseModel):
    title: str = Field(description="A few words, e.g. 'Token refresh'.")
    layout: Layout = "flow"
    blocks: list[BlockDraft] = Field(min_length=1, max_length=20)
    arrows: list[ArrowDraft] = Field(default_factory=list)
    scenes: list[SceneDraft] = Field(
        default_factory=list, max_length=10, description="A walk through the view, outside-in."
    )


class SkipDraft(LineRef):
    reason: Literal["formatting", "trivial"]


class Scope(BaseModel):
    files: list[str] = Field(
        default_factory=list, description="Paths or globs the guide covers; empty means the whole diff."
    )
    note: str = Field(default="", description="What the reviewer asked to focus on, in a few words.")


class GuideDraft(BaseModel):
    label: str = Field(default="", description="A few words naming this version, e.g. 'Split config step'.")
    scope: Scope | None = Field(
        default=None, description="Set when the review is narrowed to part of the diff."
    )
    brief: str = Field(
        default="", description="What the reviewer cares about or already knows, passed on to chat."
    )
    tldr: str = Field(description="1–2 sentences: what changes and why it matters.")
    comments: list[CommentDraft] = Field(
        default_factory=list, max_length=8, description="Comments left on the changed lines they are about."
    )
    steps: list[StepDraft] = Field(min_length=1, max_length=12)
    views: list[ViewDraft] = Field(
        default_factory=list, max_length=4, description="Diagrams of the change; the first is the overview."
    )
    skippable: list[SkipDraft] = Field(
        default_factory=list, description="Changes that are pure formatting or trivially safe."
    )


# ---------- validated output ----------


class Comment(BaseModel):
    id: int
    title: str
    text: str
    tone: Tone
    refs: list[Ref]


class Block(BaseModel):
    id: str
    label: str
    kind: BlockKind
    parent: str | None = None
    step: int | None = None
    refs: list[Ref]


class Arrow(BaseModel):
    source: str = Field(alias="from")
    target: str = Field(alias="to")
    label: str | None = None
    kind: ArrowKind = "call"

    model_config = {"populate_by_name": True}


class Scene(BaseModel):
    title: str
    text: str
    blocks: list[str]
    step: int | None = None


class View(BaseModel):
    id: int
    title: str
    layout: Layout
    blocks: list[Block]
    arrows: list[Arrow]
    scenes: list[Scene]


class Substep(BaseModel):
    id: int
    title: str
    summary: str
    refs: list[Ref]


class Step(BaseModel):
    id: int
    title: str
    kind: StepKind
    summary: str
    refs: list[Ref]
    substeps: list[Substep] = Field(default_factory=list)


class SkipGroup(BaseModel):
    file: str
    hunks: list[str]
    reason: SkipReason


class Issue(BaseModel):
    where: str
    problem: str


class Validation(BaseModel):
    total_refs: int
    invalid_refs: int
    clamped_refs: int
    coarse_refs: int = 0
    issues: list[Issue] = Field(default_factory=list)

    @property
    def invalid_ratio(self) -> float:
        return self.invalid_refs / self.total_refs if self.total_refs else 1.0


class Guide(BaseModel):
    label: str = ""
    scope: Scope | None = None
    brief: str = ""
    tldr: str
    comments: list[Comment]
    steps: list[Step]
    views: list[View] = Field(default_factory=list)
    skippable: list[SkipGroup]
    uncovered: list[str]
    validation: Validation
