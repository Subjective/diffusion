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
from .validate import needs_retry, retry_feedback, validate

SYSTEM_PROMPT = files("diffusion.prompts").joinpath("guide.md").read_text()
MAX_HUNKS_PER_CALL = 12
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


def guide_tools(idx: DiffIndex, submissions: list[dict]) -> list[ToolSpec]:
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
            GuideDraft.model_validate(args)
        except ValidationError as e:
            return f"rejected: schema errors, fix and resubmit:\n{e}"
        submissions.append(args)
        return "received"

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
            "Submit the final reviewer's guide. Call exactly once when done.",
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
    """Yield agent events, then a final ``GuideDone``. Retries once if references are badly off."""
    submissions: list[dict] = []
    tools = guide_tools(idx, submissions)
    prompt = build_prompt(meta, idx)
    session: str | None = None
    turns, cost = 0, 0.0
    guide: Guide | None = None

    for attempt in (1, 2):
        before = len(submissions)
        req = AgentRequest(SYSTEM_PROMPT, prompt, model, checkout.worktree, tools, max_turns, resume=session)
        async for ev in runner(req):
            if isinstance(ev, DoneEvent):
                session = ev.session_id
                turns += ev.turns
                cost += ev.cost_usd or 0.0
            yield ev
        if len(submissions) == before:
            if guide is not None:
                break
            raise GuideError("agent finished without calling submit_guide")
        guide = validate(GuideDraft.model_validate(submissions[-1]), idx)
        if not needs_retry(guide) or attempt == 2:
            break
        prompt = retry_feedback(guide, idx)

    assert guide is not None
    yield GuideDone(guide=guide, turns=turns, cost_usd=cost or None, attempts=attempt)


def _title(meta) -> str:
    r = meta.ref
    return f"Local branch {meta.head_ref} vs {meta.base_ref}" if r.is_local else f"PR {r.slug}#{r.number}"
