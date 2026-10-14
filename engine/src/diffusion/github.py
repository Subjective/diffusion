"""PR metadata from GitHub: the ``gh`` CLI if installed, else the REST API with ``GITHUB_TOKEN``."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass, field

_PR_URL = re.compile(
    r"^(?:https?://)?(?P<host>[^/\s]+)/(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+)/pull/(?P<number>\d+)"
)
_PR_FIELDS = (
    "number,title,body,url,author,baseRefName,headRefName,baseRefOid,headRefOid,"
    "additions,deletions,changedFiles,commits"
)


class GitHubError(RuntimeError):
    pass


@dataclass(frozen=True)
class PRRef:
    host: str
    owner: str
    repo: str
    number: int
    target: str | None = None  # set for non-GitHub targets (local branches); used as the URL

    @property
    def is_local(self) -> bool:
        return self.target is not None

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.repo}"

    @property
    def key(self) -> str:
        return f"{self.owner}-{self.repo}-{self.number}"

    @property
    def url(self) -> str:
        return self.target or f"https://{self.host}/{self.slug}/pull/{self.number}"

    @property
    def clone_url(self) -> str:
        return f"https://{self.host}/{self.slug}.git"


def parse_pr_url(url: str) -> PRRef:
    m = _PR_URL.match(url.strip())
    if not m:
        raise GitHubError(f"Not a PR URL: {url!r} (expected github.com/<owner>/<repo>/pull/<n>)")
    return PRRef(m["host"], m["owner"], m["repo"].removesuffix(".git"), int(m["number"]))


@dataclass
class PRMeta:
    ref: PRRef
    title: str
    body: str
    author: str
    base_ref: str
    head_ref: str
    base_sha: str
    head_sha: str
    additions: int
    deletions: int
    changed_files: int
    commits: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "url": self.ref.url,
            "owner": self.ref.owner,
            "repo": self.ref.repo,
            "number": self.ref.number,
            "local": self.ref.is_local,
            "title": self.title,
            "body": self.body,
            "author": self.author,
            "base_ref": self.base_ref,
            "head_ref": self.head_ref,
            "base_sha": self.base_sha,
            "head_sha": self.head_sha,
            "additions": self.additions,
            "deletions": self.deletions,
            "changed_files": self.changed_files,
            "commits": self.commits,
        }


def meta_from_json(ref: PRRef, data: dict) -> PRMeta:
    return PRMeta(
        ref=ref,
        title=data.get("title") or "",
        body=data.get("body") or "",
        author=(data.get("author") or {}).get("login", ""),
        base_ref=data["baseRefName"],
        head_ref=data["headRefName"],
        base_sha=data["baseRefOid"],
        head_sha=data["headRefOid"],
        additions=data.get("additions", 0),
        deletions=data.get("deletions", 0),
        changed_files=data.get("changedFiles", 0),
        commits=[
            {"sha": c.get("oid", "")[:12], "headline": c.get("messageHeadline", "")}
            for c in data.get("commits") or []
        ],
    )


def fetch_meta(ref: PRRef, gh: str = "gh", token: str | None = None) -> PRMeta:
    if shutil.which(gh) or os.sep in gh:
        return _fetch_meta_gh(ref, gh)
    token = token or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token or ref.host == "github.com":
        return _fetch_meta_rest(ref, token)
    raise GitHubError("Install the GitHub CLI (`gh auth login`) or set GITHUB_TOKEN.")


def _api_base(host: str) -> str:
    return "https://api.github.com" if host == "github.com" else f"https://{host}/api/v3"


def _get(url: str, token: str | None):
    req = urllib.request.Request(
        url, headers={"Accept": "application/vnd.github+json", "User-Agent": "diffusion-review"}
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        hint = " (private repo? set GITHUB_TOKEN)" if e.code in (401, 403, 404) and not token else ""
        raise GitHubError(f"GitHub API {e.code} for {url}{hint}") from e
    except urllib.error.URLError as e:
        raise GitHubError(f"GitHub API unreachable: {e.reason}") from e


def _fetch_meta_rest(ref: PRRef, token: str | None) -> PRMeta:
    base = f"{_api_base(ref.host)}/repos/{ref.slug}/pulls/{ref.number}"
    pr = _get(base, token)
    commits = _get(f"{base}/commits?per_page=100", token)
    return meta_from_json(
        ref,
        {
            "title": pr.get("title"),
            "body": pr.get("body"),
            "author": {"login": (pr.get("user") or {}).get("login", "")},
            "baseRefName": pr["base"]["ref"],
            "headRefName": pr["head"]["ref"],
            "baseRefOid": pr["base"]["sha"],
            "headRefOid": pr["head"]["sha"],
            "additions": pr.get("additions", 0),
            "deletions": pr.get("deletions", 0),
            "changedFiles": pr.get("changed_files", 0),
            "commits": [
                {"oid": c["sha"], "messageHeadline": (c["commit"]["message"] or "").split("\n", 1)[0]}
                for c in commits
            ],
        },
    )


def _fetch_meta_gh(ref: PRRef, gh: str) -> PRMeta:
    cmd = [gh, "pr", "view", str(ref.number), "--repo", f"{ref.host}/{ref.slug}", "--json", _PR_FIELDS]
    try:
        out = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=60).stdout
    except FileNotFoundError as e:
        raise GitHubError("`gh` not found; install the GitHub CLI and run `gh auth login`.") from e
    except subprocess.CalledProcessError as e:
        raise GitHubError(f"gh pr view failed: {e.stderr.strip() or e}") from e
    return meta_from_json(ref, json.loads(out))
