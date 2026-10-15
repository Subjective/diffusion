"""Guide schema.

``GuideDraft`` is what the model submits (via the ``submit_guide`` tool). ``Guide`` is what the UI renders:
the validated draft plus fields computed by code (skippable files, uncovered hunks, validation report).
Visuals are chosen from fixed enums; the UI maps them to icons.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

StepKind = Literal["entry", "core", "contract", "wiring", "cleanup", "test", "config", "docs"]
ContextIcon = Literal["fact", "dependency", "risk", "history", "config", "security", "performance"]
SkipReason = Literal[
    "lockfile", "generated", "snapshot", "vendored", "rename", "binary", "formatting", "trivial"
]
Side = Literal["new", "old"]


class Ref(BaseModel):
    hunk: str = Field(description="Hunk ID from the hunk table, e.g. 'H3'.")
    side: Side = Field(
        default="new", description="'new' for added/context lines, 'old' for deleted-only ranges."
    )
    start: int | None = Field(
        default=None, description="First line (on `side`) within the hunk; omit for whole hunk."
    )
    end: int | None = Field(default=None, description="Last line (inclusive); omit for whole hunk.")


class ContextItem(BaseModel):
    icon: ContextIcon
    text: str = Field(description="One sentence, ≤ 18 words. Inline `code` allowed.")
    refs: list[Ref] = Field(
        default_factory=list, description="Optional: the changed lines this note is about."
    )


class SubstepDraft(BaseModel):
    title: str = Field(description="1–4 words, e.g. 'Load affinity'.")
    summary: str = Field(description="≤ 20 words: what this part does and what to check.")
    refs: list[Ref] = Field(min_length=1, description="Narrow line ranges; several if the logic is split.")


class StepDraft(BaseModel):
    title: str = Field(description="1–3 words, e.g. 'Refresh loop'.")
    kind: StepKind
    summary: str = Field(
        description="≤ 25 words of markdown explaining what to look for. Inline `code` allowed."
    )
    refs: list[Ref] = Field(
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


class SkipDraft(BaseModel):
    hunks: list[str] = Field(min_length=1)
    reason: Literal["formatting", "trivial"]


class GuideDraft(BaseModel):
    tldr: str = Field(description="1–2 sentences: what changes and why it matters.")
    context: list[ContextItem] = Field(default_factory=list, max_length=5)
    steps: list[StepDraft] = Field(min_length=1, max_length=12)
    flow: Flow = Field(default_factory=Flow)
    skippable: list[SkipDraft] = Field(
        default_factory=list, description="Extra hunks that are pure formatting or trivially safe."
    )


# ---------- validated output ----------


class Substep(SubstepDraft):
    id: int


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
    tldr: str
    context: list[ContextItem]
    steps: list[Step]
    flow: Flow
    skippable: list[SkipGroup]
    uncovered: list[str]
    validation: Validation
