"""Generate a validated review guide for a checked-out PR."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from importlib.resources import files

from pydantic import ValidationError

from .agent import AgentRequest, DoneEvent, Event, Runner, ToolSpec, inline_refs
from .github import PRMeta
from .hunks import DiffIndex
from .repo import Checkout
from .schema import Guide, GuideDraft
from .validate import feedback, validate

SYSTEM_PROMPT = files("diffusion.prompts").joinpath("guide.md").read_text()
MAX_HUNKS_PER_CALL = 12
MAX_CORRECTIONS = 2  # times submit_guide sends a guide back for bad references before accepting it as is
INLINE_DIFF_LINES = 1500  # include annotated hunks in the prompt up to this many diff lines


class GuideError(RuntimeError):
    pass


@dataclass
class GuideDone:
    guide: Guide
    turns: int
    cost_usd: float | None
    attempts: int


def build_prompt(meta: PRMeta, idx: DiffIndex) -> str:
    commits = "\n".join(f"- {c['sha']} {c['headline']}" for c in meta.commits) or "- (none)"
    body = meta.body.strip() or "(no description)"
    return (
        f"# {_title(meta)}: {meta.title}\n"
        f"Author: {meta.author} · {meta.head_ref} → {meta.base_ref} · "
        f"+{meta.additions} −{meta.deletions} in {meta.changed_files} files\n\n"
        f"## Description\n{body}\n\n## Commits\n{commits}\n\n"
        f"## Hunk table\n```\n{idx.table()}\n```\n\n"
        f"{_inline_hunks(idx)}"
        "Explore as needed, then call submit_guide with granular line ranges and substeps."
    )


def _inline_hunks(idx: DiffIndex) -> str:
    """Annotated hunks inline (excluding rule-skippable files) so the model can cite exact lines."""
    from .classify import classify

    hunks = [h for f in idx.files if not classify(f) for h in f.hunks]
    if sum(len(h.lines) for h in hunks) > INLINE_DIFF_LINES:
        return "(Diff is large: use get_hunk to read hunks.)\n\n"
    return "## Annotated hunks\n```\n" + "\n\n".join(h.annotated() for h in hunks) + "\n```\n\n"


class Submissions:
    """Every schema-valid guide the model submitted, validated, plus what it was last asked to fix."""

    def __init__(self, idx: DiffIndex):
        self.idx = idx
        self.guides: list[Guide] = []
        self.pending: str | None = None  # feedback on the last guide, while a correction is still owed

    def submit(self, draft: GuideDraft) -> str:
        guide = validate(draft, self.idx)
        self.guides.append(guide)
        self.pending = feedback(guide) if len(self.guides) <= MAX_CORRECTIONS else None
        if self.pending:
            return f"rejected: fix these and call submit_guide again with the full guide:\n{self.pending}"
        return "received"


def guide_tools(idx: DiffIndex, submissions: Submissions) -> list[ToolSpec]:
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

    async def submit_guide(args: dict) -> str:
        try:
            draft = GuideDraft.model_validate(args)
        except ValidationError as e:
            return f"rejected: schema errors, fix and resubmit:\n{e}"
        return submissions.submit(draft)

    return [
        ToolSpec(
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
        ),
        ToolSpec(
            "submit_guide",
            "Submit the reviewer's guide when done. If it is rejected, fix the problems and submit it again.",
            inline_refs(GuideDraft.model_json_schema(by_alias=True)),
            submit_guide,
            terminal=True,
        ),
    ]


async def generate_guide(
    meta: PRMeta,
    checkout: Checkout,
    idx: DiffIndex,
    runner: Runner,
    model: str,
    max_turns: int = 40,
) -> AsyncIterator[Event | GuideDone]:
    """Yield agent events, then a final ``GuideDone``.

    ``submit_guide`` checks every reference against the diff and sends the guide back with the problems, up
    to ``MAX_CORRECTIONS`` times. A run that ends with a correction still owed (the model stopped, or the
    backend can't take tool replies) is resumed with the feedback. The last guide is used as validated.
    """
    subs = Submissions(idx)
    tools = guide_tools(idx, subs)
    prompt = build_prompt(meta, idx)
    session: str | None = None
    turns, cost = 0, 0.0

    while True:
        before = len(subs.guides)
        req = AgentRequest(SYSTEM_PROMPT, prompt, model, checkout.worktree, tools, max_turns, resume=session)
        async for ev in runner(req):
            if isinstance(ev, DoneEvent):
                session = ev.session_id
                turns += ev.turns
                cost += ev.cost_usd or 0.0
                if ev.is_error and subs.pending:
                    continue  # the backend surfaced our rejection as an error; resumed below
            yield ev
        if not subs.guides:
            raise GuideError("agent finished without calling submit_guide")
        if not subs.pending or len(subs.guides) == before:
            break
        prompt = f"{subs.pending}\n\nSubmit the full corrected guide."

    yield GuideDone(guide=subs.guides[-1], turns=turns, cost_usd=cost or None, attempts=len(subs.guides))


def _title(meta) -> str:
    r = meta.ref
    return f"Local branch {meta.head_ref} vs {meta.base_ref}" if r.is_local else f"PR {r.slug}#{r.number}"
