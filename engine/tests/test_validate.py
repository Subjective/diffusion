import pytest
from pydantic import ValidationError

from diffusion.hunks import parse_diff
from diffusion.schema import GuideDraft
from diffusion.validate import DraftError, check, feedback, in_scope, validate

CODE = [
    "src/auth/session.ts",
    "src/auth/types.ts",
    "src/api/client.ts",
    "tests/session.test.ts",
    "src/legacy.ts",
]


@pytest.fixture
def idx(checkout):
    return parse_diff(checkout.diff())


def hid(idx, path, n=0):
    return [h for h in idx.hunks if h.file == path][n].id


def draft(steps, views=None, skippable=None, **extra):
    return GuideDraft.model_validate(
        {
            "tldr": "t",
            "steps": steps,
            "views": views or [],
            "skippable": skippable or [],
            **extra,
        }
    )


def step(*refs, title="S", kind="core"):
    return {"title": title, "kind": kind, "summary": "s", "refs": list(refs)}


def all_code_steps():
    return [step({"file": f}) for f in CODE]


def test_clean_guide_has_full_coverage(idx):
    g = validate(draft(all_code_steps()), idx)
    assert g.uncovered == []
    assert g.validation.invalid_refs == 0
    assert [s.id for s in g.steps] == list(range(1, len(g.steps) + 1))
    reasons = {s.file: s.reason for s in g.skippable}
    assert reasons == {
        "package-lock.json": "lockfile",
        "docs/guide.md": "rename",
        "assets/logo.png": "binary",
    }
    assert feedback(g, idx) is None


def test_whole_file_ref_maps_to_its_hunks_and_deletions_to_the_old_side(idx):
    g = validate(draft([step({"file": "src/auth/types.ts"}), step({"file": "src/legacy.ts"})]), idx)
    assert [(r.hunk, r.side, r.start) for r in g.steps[0].refs] == [
        (hid(idx, "src/auth/types.ts"), "new", None)
    ]
    assert g.steps[1].refs[0].side == "old"


def test_unknown_file_dropped(idx):
    g = validate(draft([step({"file": "nope.ts", "start": 1}, {"file": "src/auth/types.ts"})]), idx)
    assert [r.hunk for r in g.steps[0].refs] == [hid(idx, "src/auth/types.ts")]
    assert g.validation.invalid_refs == 1
    assert "nope.ts isn't a changed file" in g.validation.issues[0].problem


def test_short_paths_resolve_when_unique(idx):
    g = validate(draft([step({"file": "./auth/types.ts", "start": 2})]), idx)
    assert g.steps[0].refs[0].hunk == hid(idx, "src/auth/types.ts")


def test_range_clamped_into_the_change(idx):
    h = idx.by_id[hid(idx, "src/auth/types.ts")]
    g = validate(draft([step({"file": h.file, "start": h.new_start, "end": h.new_end + 50})]), idx)
    r = g.steps[0].refs[0]
    assert (r.start, r.end) == (h.new_start, h.new_end)
    assert g.validation.clamped_refs == 1 and "clamped" in g.validation.issues[0].problem


def test_range_outside_the_change_is_invalid_and_says_where_changes_are(idx):
    g = validate(draft([step({"file": "src/auth/types.ts", "start": 900, "end": 950})]), idx)
    assert g.steps == []
    fb = feedback(g, idx) or ""
    assert "touches no change; changed ranges: 1–5" in fb and "no steps survived" in fb


def test_reversed_range_swapped(idx):
    g = validate(draft([step({"file": "src/auth/session.ts", "start": 4, "end": 2})]), idx)
    r = g.steps[0].refs[0]
    assert (r.start, r.end) == (2, 4)


def test_old_side_lines(idx):
    g = validate(draft([step({"file": "src/legacy.ts", "start": 1, "side": "old"})]), idx)
    r = g.steps[0].refs[0]
    assert (r.side, r.start, r.end) == ("old", 1, 1)
    g = validate(draft([step({"file": "src/legacy.ts", "start": 1})]), idx)  # nothing on the new side
    assert (
        g.steps == []
        and "(new side) touches no change; changed ranges: none" in g.validation.issues[0].problem
    )


def test_uncovered_reported_and_skippable_excluded(idx):
    g = validate(draft([step({"file": "src/auth/types.ts"})]), idx)
    assert hid(idx, "src/auth/types.ts") not in g.uncovered
    assert hid(idx, "src/auth/session.ts") in g.uncovered
    assert hid(idx, "package-lock.json") not in g.uncovered
    assert "src/auth/session.ts:1–25" in (feedback(g, idx) or "")


def test_scope_limits_coverage(idx):
    scope = {"files": ["src/auth/"], "note": "auth only"}
    g = validate(draft([step({"file": "src/auth/types.ts"})], scope=scope), idx)
    assert g.uncovered == [hid(idx, "src/auth/session.ts")]
    g = validate(
        draft([step({"file": "src/auth/types.ts"}, {"file": "src/auth/session.ts"})], scope=scope), idx
    )
    assert g.uncovered == [] and g.scope and g.scope.note == "auth only"
    # refs outside the scope are still fine: context from elsewhere in the diff
    g = validate(
        draft([step({"file": "src/auth/types.ts"}, {"file": "src/api/client.ts"})], scope=scope), idx
    )
    assert g.validation.invalid_refs == 0


def test_in_scope():
    from diffusion.schema import Scope

    assert in_scope("a/b.ts", None) and in_scope("a/b.ts", Scope())
    s = Scope(files=["src/*.ts", "lib", "x.py"])
    assert in_scope("src/a.ts", s) and in_scope("lib/deep/b.go", s) and in_scope("x.py", s)
    assert not in_scope("library/a", s) and not in_scope("y.py", s)


def test_agent_skippable_merged(idx):
    g = validate(
        draft(
            [step({"file": "src/auth/types.ts"})],
            skippable=[{"file": "tests/session.test.ts", "reason": "trivial"}],
        ),
        idx,
    )
    t = hid(idx, "tests/session.test.ts")
    assert any(s.reason == "trivial" and s.hunks == [t] for s in g.skippable)
    assert t not in g.uncovered


def test_views_mapped_onto_the_diff_and_steps_renumbered(idx):
    good = {"file": "src/auth/types.ts"}
    view = {
        "title": "Overview",
        "blocks": [
            {"id": "auth", "label": "auth/", "kind": "region"},
            {"id": "a", "label": "a()", "parent": "auth", "step": 2, "refs": [good]},
            {"id": "b", "label": "b()", "parent": "a", "step": 3, "refs": [{"file": "nope.ts"}]},
            {"id": "a", "label": "again"},
            {"id": "ctx", "label": "login()"},
        ],
        "arrows": [{"from": "a", "to": "b", "label": "calls"}, {"from": "a", "to": "gone", "kind": "error"}],
        "scenes": [
            {"title": "One", "text": "t", "blocks": ["a", "gone"], "step": 2},
            {"title": "Gone", "text": "t", "blocks": ["gone"]},
        ],
    }
    g = validate(draft([step({"file": "nope.ts"}), step(good), step({**good, "start": 1})], [view]), idx)
    (v,) = g.views
    assert [(b.id, b.parent, b.step, len(b.refs)) for b in v.blocks] == [
        ("auth", None, None, 0),
        ("a", "auth", 1, 1),
        ("b", None, 2, 0),  # its parent isn't a region; its ref misses the diff (reported, block kept)
        ("ctx", None, None, 0),  # unchanged code, shown as context
    ]
    assert [(a.source, a.target) for a in v.arrows] == [("a", "b")]
    assert [(s.title, s.blocks, s.step) for s in v.scenes] == [("One", ["a"], 1)]
    problems = " ".join(f"{i.where}: {i.problem}" for i in g.validation.issues)
    for bit in (
        "duplicate id",
        "isn't a region",
        "1 arrows name a missing block",
        "scene 1: names a missing",
    ):
        assert bit in problems
    assert g.model_dump(by_alias=True)["views"][0]["arrows"][0] == {
        "from": "a",
        "to": "b",
        "label": "calls",
        "kind": "call",
    }


def test_view_without_boxes_dropped(idx):
    view = {"title": "Empty", "blocks": [{"id": "r", "label": "r", "kind": "region"}]}
    g = validate(draft(all_code_steps(), [view]), idx)
    assert g.views == []
    assert any("view dropped" in i.problem for i in g.validation.issues)


def test_substeps_validated_and_folded_into_step(idx):
    f = "src/auth/session.ts"
    subs = [
        {"title": "Schedule", "summary": "a", "refs": [{"file": f, "start": 1, "end": 2}]},
        {
            "title": "Split logic",
            "summary": "b",
            "refs": [{"file": "src/auth/types.ts"}, {"file": f, "start": 25}],
        },
        {"title": "Bogus", "summary": "c", "refs": [{"file": "nope.ts"}]},
    ]
    d = draft([{"title": "Refresh", "kind": "core", "summary": "s", "refs": [], "substeps": subs}])
    g = validate(d, idx)
    (s,) = g.steps
    assert [x.id for x in s.substeps] == [1, 2] and [x.title for x in s.substeps] == [
        "Schedule",
        "Split logic",
    ]
    assert len(s.substeps[1].refs) == 2  # multi-location substep
    assert {r.hunk for r in s.refs} == {
        hid(idx, f),
        hid(idx, "src/auth/types.ts"),
    }  # step refs = union of substeps
    assert any("substep dropped" in i.problem for i in g.validation.issues)


def test_coarse_refs_counted(idx):
    g = validate(draft([step({"file": "src/auth/session.ts"})]), idx)
    assert g.validation.coarse_refs == 0  # 25 lines isn't over the limit
    g = validate(draft([step({"file": "src/auth/session.ts", "start": 1, "end": 25})]), idx)
    assert g.validation.coarse_refs == 0


def test_comment_refs_validated(idx):
    t = {"file": "src/auth/types.ts"}
    d = draft(
        [step(t)],
        comments=[
            {"title": "A", "text": "a", "tone": "bug", "refs": [t, {"file": "nope.ts"}]},
            {"title": "B", "text": "b", "refs": [{"file": "nope.ts"}]},
            {"title": "C", "text": "c", "refs": [t]},
        ],
    )
    g = validate(d, idx)
    # a comment whose refs all miss the diff is dropped; the rest are renumbered
    assert [(c.id, c.title, c.tone) for c in g.comments] == [(1, "A", "bug"), (2, "C", "note")]
    assert [r.hunk for r in g.comments[0].refs] == [hid(idx, "src/auth/types.ts")]


def test_comments_need_refs():
    with pytest.raises(ValidationError):
        draft([step({"file": "src/auth/types.ts"})], comments=[{"title": "A", "text": "a", "refs": []}])


def test_check_parses_text_and_explains_schema_errors(idx):
    _, g = check(
        '{"tldr": "t", "steps": [{"title": "A", "kind": "core", "summary": "s", "refs": [{"file": "src/auth/types.ts"}]}]}',
        idx,
    )
    assert len(g.steps) == 1
    with pytest.raises(DraftError) as e:
        check({"tldr": "t", "steps": [{"title": "A", "refs": [{"hunk": "H1"}]}]}, idx)
    assert "steps.0.refs.0.file: Field required" in str(e.value)


def test_plugin_schema_is_current():
    """The skill ships the draft schema; regenerate it with `diffusion schema > .../schema.json`."""
    import json
    from pathlib import Path

    shipped = Path(__file__).parents[2] / "plugins/diffusion/skills/review/schema.json"
    assert json.loads(shipped.read_text()) == GuideDraft.model_json_schema(by_alias=True)
