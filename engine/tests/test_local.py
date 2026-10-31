import subprocess

import pytest
from sample import build_sample_repo

from diffusion.config import Config
from diffusion.pipeline import WORKTREE, is_local, local_target, prepare, target_ref
from diffusion.repo import RepoError


@pytest.fixture
def sample(tmp_path):
    repo = tmp_path / "sample"
    build_sample_repo(repo)
    return repo


def cfg(tmp_path):
    return Config(cache_dir=tmp_path / "c")


def test_target_identity(sample):
    t = local_target(sample, "main", "feature")
    assert is_local(t) and t == f"local:{sample.resolve()}#main..feature"
    ref = target_ref(t)
    assert ref.is_local and ref.url == t and ref.key.startswith("local-sample-")
    assert target_ref(t).key == ref.key != target_ref(local_target(sample, "main", "other")).key
    assert not target_ref("https://github.com/acme/web/pull/1").is_local


def test_prepare_local_branch(sample, tmp_path):
    prep = prepare(cfg(tmp_path), local_target(sample, "main", "feature"))
    m = prep.meta
    assert (m.base_ref, m.head_ref, m.title) == ("main", "feature", "Add automatic token refresh")
    assert {f.path for f in prep.index.files} >= {"src/auth/session.ts", "docs/guide.md"}
    assert prep.checkout.worktree.exists() and (prep.checkout.worktree / "src/api/client.ts").exists()
    d = prep.to_dict()
    assert d["pr"]["local"] is True and d["pr"]["url"].startswith("local:")


def test_prepare_local_defaults_to_current_branch_and_main(sample, tmp_path):
    subprocess.run(["git", "checkout", "-q", "feature"], cwd=sample, check=True)
    prep = prepare(cfg(tmp_path), local_target(sample / "src"))  # subdirectory resolves to repo root
    assert prep.meta.base_ref == "main" and prep.meta.head_ref == "feature"
    assert (
        prep.meta.head_sha
        == subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=sample, capture_output=True, text=True
        ).stdout.strip()
    )


def test_prepare_local_errors(tmp_path):
    with pytest.raises(RepoError):
        prepare(cfg(tmp_path), local_target(tmp_path / "missing"))
    plain = tmp_path / "plain"
    plain.mkdir()
    with pytest.raises(RepoError):
        prepare(cfg(tmp_path), local_target(plain))


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def test_uncommitted_changes_are_a_snapshot(sample, tmp_path):
    git(sample, "checkout", "-q", "feature")
    (sample / "src/auth/session.ts").write_text((sample / "src/auth/session.ts").read_text() + "// wip\n")
    (sample / "NEW.md").write_text("new\n")
    status = git(sample, "status", "--porcelain")
    target = local_target(sample, "main", WORKTREE)

    prep = prepare(cfg(tmp_path), target, fresh=True)
    assert prep.meta.head_ref == "feature (uncommitted)"
    assert "NEW.md" in {f.path for f in prep.index.files}
    assert (prep.checkout.worktree / "NEW.md").exists()
    assert prep.meta.head_sha != git(sample, "rev-parse", "HEAD")
    assert git(sample, "status", "--porcelain") == status  # the user's index and files are untouched
    assert all(c["sha"] != prep.meta.head_sha[:12] for c in prep.to_dict()["pr"]["commits"])

    # unchanged: the same snapshot (so its guide versions carry over); without fresh, the saved one is reused
    assert prepare(cfg(tmp_path), target, fresh=True).meta.head_sha == prep.meta.head_sha
    (sample / "NEW.md").write_text("changed\n")
    assert prepare(cfg(tmp_path), target).meta.head_sha == prep.meta.head_sha
    assert prepare(cfg(tmp_path), target, fresh=True).meta.head_sha != prep.meta.head_sha
