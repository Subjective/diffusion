"""Deterministic preparation shared by the CLI and the API: target → worktree → hunk index.

A *target* is a GitHub PR URL, or a local branch written ``local:<repo path>#<base>..<head>`` (base and head
optional), so the same guide/chat pipeline works without GitHub.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

from .classify import classify
from .config import Config
from .github import PRMeta, PRRef, fetch_meta, parse_pr_url
from .hunks import DiffIndex, parse_diff
from .repo import Checkout, RepoCache, RepoError, git

LOCAL = re.compile(r"^local:(?P<path>[^#]+?)(?:#(?P<base>[^.]*?)(?:\.\.(?P<head>.*))?)?$")


@dataclass
class Prepared:
    meta: PRMeta
    checkout: Checkout
    index: DiffIndex

    def to_dict(self) -> dict:
        files = []
        for f, d in zip(self.index.files, self.index.to_dict()["files"], strict=True):
            files.append({**d, "skip": classify(f)})
        return {"pr": self.meta.to_dict(), "files": files}


def local_target(repo: str | Path, base: str | None = None, head: str | None = None) -> str:
    return f"local:{Path(repo).expanduser().resolve()}#{base or ''}..{head or ''}"


def is_local(target: str) -> bool:
    return bool(LOCAL.match(target.strip()))


def target_ref(target: str) -> PRRef:
    """Identity for a target. GitHub PRs parse their URL; local targets hash path + branches for cache keys."""
    target = target.strip()
    m = LOCAL.match(target)
    if not m:
        return parse_pr_url(target)
    path = Path(m["path"]).expanduser()
    digest = hashlib.sha1(target.encode()).hexdigest()[:8]
    return PRRef("local", "local", f"{path.name}-{digest}", 0, target=target)


def default_base(repo: Path) -> str:
    for cand in ("origin/HEAD", "origin/main", "origin/master", "main", "master"):
        try:
            git("rev-parse", "--verify", "--quiet", f"{cand}^{{commit}}", cwd=repo)
            return cand
        except RepoError:
            continue
    raise RepoError("Couldn't find a base branch (tried origin/HEAD, main, master); pass one explicitly.")


def prepare_local(cfg: Config, target: str) -> Prepared:
    m = LOCAL.match(target.strip())
    assert m
    path = Path(m["path"]).expanduser()
    if not path.is_dir():
        raise RepoError(f"{path}: not a directory")
    repo = Path(git("rev-parse", "--show-toplevel", cwd=path).strip())
    base = m["base"] or default_base(repo)
    head = m["head"] or "HEAD"
    head_sha = git("rev-parse", f"{head}^{{commit}}", cwd=repo).strip()
    base_sha = git("rev-parse", f"{base}^{{commit}}", cwd=repo).strip()
    merge_base = git("merge-base", base_sha, head_sha, cwd=repo).strip()
    log = git("log", "--format=%H%x09%an%x09%s", f"{merge_base}..{head_sha}", cwd=repo).strip().splitlines()
    rows = [ln.split("\t", 2) for ln in log if ln.count("\t") >= 2]
    commits = [{"sha": sha[:12], "headline": subject} for sha, _, subject in rows]
    head_name = git("rev-parse", "--abbrev-ref", "HEAD", cwd=repo).strip() if head == "HEAD" else head
    ref = target_ref(target)

    wt = cfg.cache_dir / "worktrees" / f"{ref.key}-{head_sha[:12]}"
    if not (wt / ".git").exists():
        git("worktree", "prune", cwd=repo)
        git("worktree", "add", "--detach", "--force", str(wt), head_sha, cwd=repo)
    co = Checkout(worktree=wt, base_sha=base_sha, head_sha=head_sha, merge_base=merge_base)
    index = parse_diff(co.diff())
    meta = PRMeta(
        ref=ref,
        title=commits[0]["headline"] if len(commits) == 1 else f"{repo.name}: {head_name} vs {base}",
        body="\n".join(f"- {c['headline']}" for c in reversed(commits)),
        author=rows[0][1] if rows else "",
        base_ref=base,
        head_ref=head_name,
        base_sha=base_sha,
        head_sha=head_sha,
        additions=sum(f.additions for f in index.files),
        deletions=sum(f.deletions for f in index.files),
        changed_files=len(index.files),
        commits=commits,
    )
    return Prepared(meta, co, index)


def prepare(
    cfg: Config, target: str, meta: PRMeta | None = None, remote_override: str | None = None
) -> Prepared:
    if is_local(target):
        return prepare_local(cfg, target)
    ref = parse_pr_url(target)
    meta = meta or fetch_meta(ref)
    co = RepoCache(cfg.cache_dir, remote_override).checkout(ref, meta.base_ref, meta.base_sha, meta.head_sha)
    return Prepared(meta, co, parse_diff(co.diff()))
