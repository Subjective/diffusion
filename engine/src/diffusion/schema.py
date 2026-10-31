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


class FlowNode(BaseModel):
    id: str = Field(description="Short unique id, e.g. 'refresh'.")
    label: str = Field(description="Function/component name, e.g. 'refresh()'.")
    step: int = Field(description="1-based index of the step this node belongs to.")
    substep: int | None = Field(
        default=None, description="1-based substep index within the step, if specific."
    )


class FlowEdge(BaseModel):
    source: str = Field(alias="from")
    target: str = Field(alias="to")
    label: str | None = Field(default=None, description="≤ 2 words, e.g. 'timer', 'ok'.")
    kind: Literal["normal", "error"] = "normal"

    model_config = {"populate_by_name": True}


class Flow(BaseModel):
    nodes: list[FlowNode] = Field(default_factory=list, max_length=12)
    edges: list[FlowEdge] = Field(default_factory=list)


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
    flow: Flow = Field(default_factory=Flow)
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
    flow: Flow
    skippable: list[SkipGroup]
    uncovered: list[str]
    validation: Validation
