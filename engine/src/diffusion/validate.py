"""Check a model-submitted guide against the hunk table.

Every reference in the output resolves to real lines: unknown hunks are dropped, ranges are clamped into
their hunk, and hunks no step covers (and that aren't skippable) are reported as ``uncovered``.
"""

from __future__ import annotations

from .classify import classify
from .hunks import DiffIndex, Hunk
from .schema import Flow, Guide, GuideDraft, Issue, Ref, SkipGroup, Step, Substep, Validation

RETRY_THRESHOLD = 0.2
# A ref is "coarse" if it spans a whole hunk this big (or a range this long). Steps should break these up.
COARSE_LINES = 25


def _span(h: Hunk, side: str) -> tuple[int, int] | None:
    if side == "new":
        return (h.new_start, h.new_end) if h.new_len else None
    return (h.old_start, h.old_end) if h.old_len else None


def _fix_ref(ref: Ref, idx: DiffIndex, where: str, issues: list[Issue]) -> tuple[Ref | None, bool]:
    """Return (fixed ref or None if invalid, clamped?)."""
    h = idx.by_id.get(ref.hunk.strip().upper())
    if h is None:
        issues.append(Issue(where=where, problem=f"unknown hunk {ref.hunk!r}"))
        return None, False
    side = ref.side
    span = _span(h, side)
    if span is None:  # e.g. 'new' on a deletion-only hunk: use the side that has lines
        side = "old" if side == "new" else "new"
        span = _span(h, side)
        if span is None:
            return Ref(hunk=h.id, side=ref.side), False
        ref = Ref(hunk=h.id, side=side)  # line numbers were for the wrong side; reference whole hunk
    if ref.start is None and ref.end is None:
        return Ref(hunk=h.id, side=side), False

    lo, hi = span
    start = ref.start if ref.start is not None else lo
    end = ref.end if ref.end is not None else start
    if start > end:
        start, end = end, start
    if end < lo or start > hi:
        issues.append(Issue(where=where, problem=f"{h.id} lines {start}–{end} outside {lo}–{hi}"))
        return None, False
    cs, ce = max(start, lo), min(end, hi)
    clamped = (cs, ce) != (start, end)
    if clamped:
        issues.append(Issue(where=where, problem=f"{h.id} lines {start}–{end} clamped to {cs}–{ce}"))
    return Ref(hunk=h.id, side=side, start=cs, end=ce), clamped


def validate(draft: GuideDraft, idx: DiffIndex) -> Guide:
    issues: list[Issue] = []
    total = invalid = clamped = 0

    # Rule-based skippable files first; they are never "uncovered".
    skippable: list[SkipGroup] = []
    skip_ids: set[str] = set()
    for f in idx.files:
        reason = classify(f)
        if reason:
            ids = [h.id for h in f.hunks]
            skippable.append(SkipGroup(file=f.path, hunks=ids, reason=reason))
            skip_ids.update(ids)

    def fix_refs(raw: list[Ref], where: str) -> list[Ref]:
        nonlocal total, invalid, clamped
        out: list[Ref] = []
        for j, r in enumerate(raw):
            total += 1
            fixed, was_clamped = _fix_ref(r, idx, f"{where} ref {j + 1}", issues)
            if fixed is None:
                invalid += 1
                continue
            clamped += was_clamped
            if fixed not in out:
                out.append(fixed)
        return out

    # Steps, renumbered 1..n in order; old index → new id for flow mapping.
    steps: list[Step] = []
    step_map: dict[int, int] = {}
    sub_map: dict[tuple[int, int], int] = {}
    for i, s in enumerate(draft.steps, start=1):
        refs = fix_refs(s.refs, f"step {i}")
        subs: list[Substep] = []
        for k, sub in enumerate(s.substeps, start=1):
            srefs = fix_refs(sub.refs, f"step {i}.{k}")
            if not srefs:
                issues.append(Issue(where=f"step {i}.{k}", problem="no valid refs; substep dropped"))
                continue
            sub_map[(i, k)] = len(subs) + 1
            subs.append(Substep(id=len(subs) + 1, title=sub.title, summary=sub.summary, refs=srefs))
        # A step's refs are its own plus its substeps' (so hovering the step highlights everything).
        for sub in subs:
            refs += [r for r in sub.refs if r not in refs]
        if not refs:
            issues.append(Issue(where=f"step {i}", problem="no valid refs; step dropped"))
            continue
        step_map[i] = len(steps) + 1
        steps.append(
            Step(id=len(steps) + 1, title=s.title, kind=s.kind, summary=s.summary, refs=refs, substeps=subs)
        )

    coarse = sum(
        _is_coarse(r, idx)
        for st in steps
        for r in (st.refs if not st.substeps else [x for sb in st.substeps for x in sb.refs])
    )

    # Model-flagged skippable hunks (formatting/trivial), excluding ones already covered by a step.
    covered = {r.hunk for s in steps for r in s.refs}
    for g in draft.skippable:
        by_file: dict[str, list[str]] = {}
        for hid in g.hunks:
            h = idx.by_id.get(hid.strip().upper())
            if h is None:
                issues.append(Issue(where="skippable", problem=f"unknown hunk {hid!r}"))
            elif h.id not in skip_ids and h.id not in covered:
                by_file.setdefault(h.file, []).append(h.id)
                skip_ids.add(h.id)
        skippable += [SkipGroup(file=f, hunks=ids, reason=g.reason) for f, ids in by_file.items()]

    # Flow: nodes must point at surviving steps; edges at surviving nodes.
    nodes, node_ids = [], set()
    for n in draft.flow.nodes:
        if n.step in step_map and n.id not in node_ids:
            sub = sub_map.get((n.step, n.substep)) if n.substep else None
            nodes.append(n.model_copy(update={"step": step_map[n.step], "substep": sub}))
            node_ids.add(n.id)
        else:
            issues.append(
                Issue(where=f"flow node {n.id!r}", problem=f"invalid step {n.step} or duplicate id")
            )
    edges = [e for e in draft.flow.edges if e.source in node_ids and e.target in node_ids]
    if len(edges) != len(draft.flow.edges):
        issues.append(Issue(where="flow", problem=f"{len(draft.flow.edges) - len(edges)} edges dropped"))

    uncovered = [h.id for h in idx.hunks if h.id not in covered and h.id not in skip_ids]

    context = [
        c.model_copy(update={"refs": fix_refs(c.refs, f"note {i}")})
        for i, c in enumerate(draft.context, start=1)
    ]

    return Guide(
        tldr=draft.tldr,
        context=context,
        steps=steps,
        flow=Flow(nodes=nodes, edges=edges),
        skippable=skippable,
        uncovered=uncovered,
        validation=Validation(
            total_refs=total, invalid_refs=invalid, clamped_refs=clamped, coarse_refs=coarse, issues=issues
        ),
    )


def _is_coarse(r: Ref, idx: DiffIndex) -> bool:
    h = idx.by_id[r.hunk]
    if r.start is None:
        return len(h.lines) > COARSE_LINES
    return (r.end or r.start) - r.start + 1 > COARSE_LINES


def needs_retry(g: Guide) -> bool:
    return not g.steps or g.validation.invalid_ratio > RETRY_THRESHOLD


def retry_feedback(g: Guide, idx: DiffIndex) -> str:
    lines = [f"- {i.where}: {i.problem}" for i in g.validation.issues]
    if g.uncovered:
        lines.append(f"- uncovered hunks (add them to a step or mark skippable): {', '.join(g.uncovered)}")
    return (
        "Your guide had invalid references. Use only hunk IDs and line numbers from the annotated hunks.\n"
        + "\n".join(lines)
        + "\n\nHunk table:\n"
        + idx.table()
        + "\n\nCall submit_guide again with a corrected guide."
    )
