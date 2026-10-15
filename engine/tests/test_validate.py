import pytest

from diffusion.hunks import parse_diff
from diffusion.schema import GuideDraft
from diffusion.validate import feedback, validate


@pytest.fixture
def idx(checkout):
    return parse_diff(checkout.diff())


def hid(idx, path, n=0):
    return [h for h in idx.hunks if h.file == path][n].id


def draft(steps, flow=None, skippable=None):
    return GuideDraft.model_validate(
        {
            "tldr": "t",
            "steps": steps,
            "flow": flow or {"nodes": [], "edges": []},
            "skippable": skippable or [],
        }
    )


def step(*refs, title="S", kind="core"):
    return {"title": title, "kind": kind, "summary": "s", "refs": list(refs)}


def all_code_steps(idx):
    code = [
        "src/auth/session.ts",
        "src/auth/types.ts",
        "src/api/client.ts",
        "tests/session.test.ts",
        "src/legacy.ts",
    ]
    return [step({"hunk": h.id}) for h in idx.hunks if h.file in code]


def test_clean_guide_has_full_coverage(idx):
    g = validate(draft(all_code_steps(idx)), idx)
    assert g.uncovered == []
    assert g.validation.invalid_refs == 0
    assert [s.id for s in g.steps] == list(range(1, len(g.steps) + 1))
    reasons = {s.file: s.reason for s in g.skippable}
    assert reasons == {
        "package-lock.json": "lockfile",
        "docs/guide.md": "rename",
        "assets/logo.png": "binary",
    }
    assert feedback(g) is None


def test_unknown_hunk_dropped(idx):
    s = hid(idx, "src/auth/types.ts")
    g = validate(draft([step({"hunk": "H99"}, {"hunk": s})]), idx)
    assert [r.hunk for r in g.steps[0].refs] == [s]
    assert g.validation.invalid_refs == 1
    assert "unknown hunk 'H99'" in g.validation.issues[0].problem


def test_lowercase_hunk_id_normalised(idx):
    s = hid(idx, "src/auth/types.ts")
    g = validate(draft([step({"hunk": s.lower()})]), idx)
    assert g.steps[0].refs[0].hunk == s


def test_range_clamped_into_hunk(idx):
    h = idx.by_id[hid(idx, "src/auth/types.ts")]
    g = validate(draft([step({"hunk": h.id, "start": h.new_start - 50, "end": h.new_end + 50})]), idx)
    r = g.steps[0].refs[0]
    assert (r.start, r.end) == (h.new_start, h.new_end)
    assert g.validation.clamped_refs == 1


def test_range_outside_hunk_is_invalid(idx):
    h = idx.by_id[hid(idx, "src/auth/types.ts")]
    g = validate(draft([step({"hunk": h.id, "start": 900, "end": 950})]), idx)
    assert g.steps == []
    assert "no steps survived" in (feedback(g) or "")


def test_reversed_range_swapped(idx):
    h = idx.by_id[hid(idx, "src/auth/session.ts")]
    g = validate(draft([step({"hunk": h.id, "start": h.new_start + 2, "end": h.new_start})]), idx)
    r = g.steps[0].refs[0]
    assert (r.start, r.end) == (h.new_start, h.new_start + 2)


def test_deletion_only_hunk_switches_to_old_side(idx):
    h = idx.by_id[hid(idx, "src/legacy.ts")]
    g = validate(draft([step({"hunk": h.id, "start": 1, "end": 1})]), idx)
    r = g.steps[0].refs[0]
    assert r.side == "old" and r.start is None


def test_uncovered_reported_and_skippable_excluded(idx):
    s = hid(idx, "src/auth/types.ts")
    g = validate(draft([step({"hunk": s})]), idx)
    assert s not in g.uncovered
    assert hid(idx, "src/auth/session.ts") in g.uncovered
    assert hid(idx, "package-lock.json") not in g.uncovered


def test_model_skippable_merged(idx):
    t = hid(idx, "tests/session.test.ts")
    g = validate(
        draft(
            [step({"hunk": hid(idx, "src/auth/types.ts")})], skippable=[{"hunks": [t], "reason": "trivial"}]
        ),
        idx,
    )
    assert any(s.reason == "trivial" and s.hunks == [t] for s in g.skippable)
    assert t not in g.uncovered


def test_flow_nodes_remapped_and_dangling_dropped(idx):
    good, bad = hid(idx, "src/auth/types.ts"), "H99"
    flow = {
        "nodes": [
            {"id": "a", "label": "a()", "step": 2},
            {"id": "b", "label": "b()", "step": 3},
            {"id": "x", "label": "x()", "step": 1},
        ],
        "edges": [{"from": "a", "to": "b"}, {"from": "a", "to": "x", "kind": "error"}],
    }
    g = validate(
        draft([step({"hunk": bad}), step({"hunk": good}), step({"hunk": good, "start": 1})], flow), idx
    )
    assert [s.id for s in g.steps] == [1, 2]
    assert [(n.id, n.step) for n in g.flow.nodes] == [("a", 1), ("b", 2)]
    assert [(e.source, e.target) for e in g.flow.edges] == [("a", "b")]


def test_feedback_lists_issues_and_uncovered(idx):
    s = hid(idx, "src/auth/types.ts")
    g = validate(draft([step({"hunk": "H99"}, {"hunk": s})]), idx)
    fb = feedback(g) or ""
    assert "unknown hunk 'H99'" in fb
    assert "uncovered hunks" in fb and g.uncovered[0] in fb


def test_edge_alias_serialises_as_from_to(idx):
    g = validate(
        draft(
            all_code_steps(idx),
            {"nodes": [{"id": "a", "label": "a", "step": 1}, {"id": "b", "label": "b", "step": 2}],
             "edges": [{"from": "a", "to": "b"}]},
        ),
        idx,
    )  # fmt: skip
    assert g.model_dump(by_alias=True)["flow"]["edges"][0] == {
        "from": "a",
        "to": "b",
        "label": None,
        "kind": "normal",
    }


def test_substeps_validated_and_folded_into_step(idx):
    h = idx.by_id[hid(idx, "src/auth/session.ts")]
    t = hid(idx, "src/auth/types.ts")
    first = {"hunk": h.id, "start": h.new_start, "end": h.new_start + 1}
    last = {"hunk": h.id, "start": h.new_end, "end": h.new_end}
    subs = [
        {"title": "Schedule", "summary": "a", "refs": [first]},
        {"title": "Split logic", "summary": "b", "refs": [{"hunk": t}, last]},
        {"title": "Bogus", "summary": "c", "refs": [{"hunk": "H99"}]},
    ]
    nodes = [
        {"id": "a", "label": "a", "step": 1, "substep": 2},
        {"id": "b", "label": "b", "step": 1, "substep": 3},
    ]
    d = draft(
        [{"title": "Refresh", "kind": "core", "summary": "s", "refs": [], "substeps": subs}],
        flow={"nodes": nodes},
    )
    g = validate(d, idx)
    (s,) = g.steps
    assert [x.id for x in s.substeps] == [1, 2] and [x.title for x in s.substeps] == [
        "Schedule",
        "Split logic",
    ]
    assert len(s.substeps[1].refs) == 2  # multi-location substep
    assert {r.hunk for r in s.refs} == {h.id, t}  # step refs = union of substeps
    assert [(n.id, n.substep) for n in g.flow.nodes] == [
        ("a", 2),
        ("b", None),
    ]  # dropped substep → step-level
    assert any("substep dropped" in i.problem for i in g.validation.issues)


def test_coarse_refs_counted(idx):
    big = max(idx.hunks, key=lambda x: len(x.lines))
    g = validate(draft([step({"hunk": big.id})]), idx)
    assert g.validation.coarse_refs == (1 if len(big.lines) > 25 else 0)


def test_note_refs_validated(idx):
    t = hid(idx, "src/auth/types.ts")
    d = GuideDraft.model_validate(
        {
            "tldr": "t",
            "steps": [step({"hunk": t})],
            "context": [
                {"icon": "risk", "text": "a", "refs": [{"hunk": t}, {"hunk": "H99"}]},
                {"icon": "fact", "text": "b"},
            ],
        }
    )
    g = validate(d, idx)
    assert [r.hunk for r in g.context[0].refs] == [t] and g.context[1].refs == []
