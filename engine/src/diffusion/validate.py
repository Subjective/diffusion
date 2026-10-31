"""Check a submitted guide against the diff.

Agents cite changed lines by path and line number. Each citation is mapped onto the hunks it touches and
clamped into them; citations that touch no change are dropped and reported, and hunks in scope that no step
covers (and that aren't skippable) are reported as ``uncovered``.
"""

from __future__ import annotations

import fnmatch

from pydantic import ValidationError

from .classify import classify
from .hunks import DiffIndex, Hunk
from .schema import Flow, Guide, GuideDraft, Issue, LineRef, Ref, Scope, SkipGroup, Step, Substep, Validation

# A ref is "coarse" if it spans a whole hunk this big (or a range this long). Steps should break these up.
COARSE_LINES = 25


def _span(h: Hunk, side: str) -> tuple[int, int] | None:
    if side == "new":
        return (h.new_start, h.new_end) if h.new_len else None
    return (h.old_start, h.old_end) if h.old_len else None


def _ranges(hunks: list[Hunk], side: str) -> str:
    spans = [s for h in hunks if (s := _span(h, side))]
    return ", ".join(f"{lo}–{hi}" for lo, hi in spans) or "none"


def map_ref(ref: LineRef, idx: DiffIndex, where: str, issues: list[Issue]) -> tuple[list[Ref], bool]:
    """The hunk refs a citation covers (empty if it touches no change), and whether it was clamped."""
    f = idx.resolve(ref.file)
    if f is None:
        issues.append(Issue(where=where, problem=f"{ref.file} isn't a changed file in this diff"))
        return [], False
    if ref.start is None:  # every change in the file
        return [Ref(hunk=h.id, side="new" if h.new_len else "old") for h in f.hunks], False

    start, end = ref.start, ref.end if ref.end is not None else ref.start
    start, end = min(start, end), max(start, end)
    hits = [(h, s) for h in f.hunks if (s := _span(h, ref.side)) and start <= s[1] and end >= s[0]]
    if not hits:
        issues.append(
            Issue(
                where=where,
                problem=f"{f.path}:{start}–{end} ({ref.side} side) touches no change; "
                f"changed ranges: {_ranges(f.hunks, ref.side)}",
            )
        )
        return [], False
    lo, hi = min(s[0] for _, s in hits), max(s[1] for _, s in hits)
    clamped = start < lo or end > hi
    if clamped:
        issues.append(
            Issue(
                where=where,
                problem=f"{f.path}:{start}–{end} clamped to {max(start, lo)}–{min(end, hi)}",
            )
        )
    return [
        Ref(hunk=h.id, side=ref.side, start=max(start, s[0]), end=min(end, s[1])) for h, s in hits
    ], clamped


def in_scope(path: str, scope: Scope | None) -> bool:
    if not scope or not scope.files:
        return True
    return any(
        path == p or fnmatch.fnmatch(path, p) or path.startswith(p.rstrip("/") + "/") for p in scope.files
    )


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

    def fix_refs(raw: list[LineRef], where: str) -> list[Ref]:
        nonlocal total, invalid, clamped
        out: list[Ref] = []
        for j, r in enumerate(raw):
            total += 1
            mapped, was_clamped = map_ref(r, idx, f"{where} ref {j + 1}", issues)
            if not mapped:
                invalid += 1
                continue
            clamped += was_clamped
            out += [m for m in mapped if m not in out]
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

    # Agent-flagged skippable changes (formatting/trivial), excluding hunks a step already covers.
    covered = {r.hunk for s in steps for r in s.refs}
    for j, g in enumerate(draft.skippable, start=1):
        mapped, _ = map_ref(g, idx, f"skippable {j}", issues)
        ids = [r.hunk for r in mapped if r.hunk not in skip_ids and r.hunk not in covered]
        if ids:
            skippable.append(SkipGroup(file=idx.by_id[ids[0]].file, hunks=ids, reason=g.reason))
            skip_ids.update(ids)

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

    uncovered = [
        h.id
        for h in idx.hunks
        if h.id not in covered and h.id not in skip_ids and in_scope(h.file, draft.scope)
    ]

    context = [
        {"icon": c.icon, "text": c.text, "refs": fix_refs(c.refs, f"note {i}")}
        for i, c in enumerate(draft.context, start=1)
    ]

    return Guide.model_validate(
        {
            "label": draft.label,
            "scope": draft.scope,
            "brief": draft.brief,
            "tldr": draft.tldr,
            "context": context,
            "steps": steps,
            "flow": Flow(nodes=nodes, edges=edges),
            "skippable": skippable,
            "uncovered": uncovered,
            "validation": Validation(
                total_refs=total,
                invalid_refs=invalid,
                clamped_refs=clamped,
                coarse_refs=coarse,
                issues=issues,
            ),
        }
    )


def _is_coarse(r: Ref, idx: DiffIndex) -> bool:
    h = idx.by_id[r.hunk]
    if r.start is None:
        return len(h.lines) > COARSE_LINES
    return (r.end or r.start) - r.start + 1 > COARSE_LINES


def _where(h: Hunk) -> str:
    if h.new_len:
        return f"{h.file}:{h.new_start}–{h.new_end}"
    return f"{h.file}:{h.old_start}–{h.old_end} (old side)"


def feedback(g: Guide, idx: DiffIndex) -> str | None:
    """What the agent should fix before its guide is accepted, or None if every reference is clean."""
    lines = [f"- {i.where}: {i.problem}" for i in g.validation.issues]
    if not g.steps:
        lines.append("- no steps survived validation")
    if g.uncovered:
        where = ", ".join(_where(idx.by_id[hid]) for hid in g.uncovered)
        lines.append(f"- changes no step covers (add them to a step, or mark them skippable): {where}")
    if not lines:
        return None
    return (
        "Some references don't match the diff. Cite changed lines by path and head line number "
        "(side 'old' for deleted lines).\n" + "\n".join(lines)
    )


class DraftError(ValueError):
    pass


def check(raw: dict | str, idx: DiffIndex) -> tuple[GuideDraft, Guide]:
    """Parse a draft (a dict or JSON text) and check it against the diff. Raises ``DraftError`` with what to fix
    when it doesn't match the schema."""
    try:
        draft = (
            GuideDraft.model_validate_json(raw) if isinstance(raw, str) else GuideDraft.model_validate(raw)
        )
    except ValidationError as e:
        problems = "\n".join(
            f"- {'.'.join(str(p) for p in err['loc']) or 'guide'}: {err['msg']}" for err in e.errors()
        )
        raise DraftError(f"The guide doesn't match the schema:\n{problems}") from e
    return draft, validate(draft, idx)
