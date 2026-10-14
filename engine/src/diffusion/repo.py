"""Local git state for a PR: a cached bare clone plus a detached worktree at the PR head.

The diff is computed locally against the merge base so it always matches the worktree the agent explores,
and isn't subject to GitHub's diff size limits.
"""

from __future__ import annotations

import fcntl
import subprocess
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from .github import PRRef


class RepoError(RuntimeError):
    pass


def git(*args: str, cwd: Path | None = None, timeout: int = 600) -> str:
    try:
        return subprocess.run(
            ["git", *args], cwd=cwd, check=True, capture_output=True, text=True, timeout=timeout
        ).stdout
    except subprocess.CalledProcessError as e:
        raise RepoError(f"git {' '.join(args[:3])} failed: {e.stderr.strip()}") from e


@contextmanager
def _locked(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


@dataclass(frozen=True)
class Checkout:
    worktree: Path
    base_sha: str
    head_sha: str
    merge_base: str

    def diff(self) -> str:
        return git(
            "diff", "--no-color", "--no-ext-diff", "-M", "--src-prefix=a/", "--dst-prefix=b/",
            f"{self.merge_base}..{self.head_sha}", cwd=self.worktree,
        )  # fmt: skip

    def file_at_head(self, path: str) -> str | None:
        try:
            return git("show", f"{self.head_sha}:{path}", cwd=self.worktree)
        except RepoError:
            return None


class RepoCache:
    """``<cache>/repos/<owner>/<repo>.git`` bare clones; ``<cache>/worktrees/<key>-<sha12>`` checkouts."""

    def __init__(self, cache_dir: Path, remote_override: str | None = None):
        self.root = cache_dir
        self.remote_override = remote_override

    def bare_path(self, ref: PRRef) -> Path:
        return self.root / "repos" / ref.owner / f"{ref.repo}.git"

    def _ensure_bare(self, ref: PRRef) -> Path:
        bare = self.bare_path(ref)
        remote = self.remote_override or ref.clone_url
        if not (bare / "HEAD").exists():
            bare.parent.mkdir(parents=True, exist_ok=True)
            git("clone", "--bare", "--filter=blob:none", "--no-tags", remote, str(bare))
        return bare

    def checkout(self, ref: PRRef, base_ref: str, base_sha: str, head_sha: str) -> Checkout:
        with _locked(self.root / "locks" / f"{ref.owner}-{ref.repo}.lock"):
            bare = self._ensure_bare(ref)
            if not _has_commit(bare, head_sha) or not _has_commit(bare, base_sha):
                git(
                    "fetch", "--no-tags", "--filter=blob:none", "origin",
                    f"+refs/heads/{base_ref}:refs/remotes/origin/{base_ref}",
                    f"+refs/pull/{ref.number}/head:refs/pull/{ref.number}/head",
                    cwd=bare,
                )  # fmt: skip
            for sha in (head_sha, base_sha):
                if not _has_commit(bare, sha):
                    raise RepoError(f"commit {sha[:12]} not found after fetch")
            merge_base = git("merge-base", base_sha, head_sha, cwd=bare).strip()

            wt = self.root / "worktrees" / f"{ref.key}-{head_sha[:12]}"
            if not (wt / ".git").exists():
                git("worktree", "prune", cwd=bare)
                git("worktree", "add", "--detach", "--force", str(wt), head_sha, cwd=bare)
            return Checkout(worktree=wt, base_sha=base_sha, head_sha=head_sha, merge_base=merge_base)


def _has_commit(bare: Path, sha: str) -> bool:
    try:
        git("cat-file", "-e", f"{sha}^{{commit}}", cwd=bare)
        return True
    except RepoError:
        return False
