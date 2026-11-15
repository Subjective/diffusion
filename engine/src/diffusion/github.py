"""PR metadata from GitHub: the ``gh`` CLI if installed, else the REST API with ``GITHUB_TOKEN``."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import urlsplit

import httpx

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

    def summary(self) -> dict:
        """What the home page shows for this target. A local target's generic "repo: head vs base" title is left
        out, so the guide's label shows instead."""
        generic = self.ref.is_local and self.title.endswith(f"{self.head_ref} vs {self.base_ref}")
        d = {
            k: v
            for k, v in self.to_dict().items()
            if k in ("url", "owner", "repo", "number", "local", "head_ref")
        }
        return {**d, "title": "" if generic else self.title}


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


def _proxy_for(url: str) -> str | None:
    """The proxy the environment sets for ``url`` (``HTTPS_PROXY``, minus ``NO_PROXY`` hosts). httpx ignores
    these variables once it's given its own transport, so we pass the proxy to the transport ourselves."""
    host = urlsplit(url).hostname or ""
    if urllib.request.proxy_bypass(host):
        return None
    return urllib.request.getproxies().get(urlsplit(url).scheme)


def _client(host: str, token: str | None, transport: httpx.BaseTransport | None = None) -> httpx.Client:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "diffusion-review"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return httpx.Client(
        base_url=_api_base(host),
        headers=headers,
        timeout=30,
        # Retries connection failures only.
        transport=transport or httpx.HTTPTransport(retries=2, proxy=_proxy_for(_api_base(host))),
    )


def _get(client: httpx.Client, path: str, token: str | None):
    try:
        r = client.get(path)
    except httpx.TransportError as e:
        raise GitHubError(f"GitHub API unreachable: {e}") from e
    if r.is_error:
        hint = " (private repo? set GITHUB_TOKEN)" if r.status_code in (401, 403, 404) and not token else ""
        raise GitHubError(f"GitHub API {r.status_code} for {r.url}{hint}")
    return r.json()


def _fetch_meta_rest(ref: PRRef, token: str | None, transport: httpx.BaseTransport | None = None) -> PRMeta:
    base = f"/repos/{ref.slug}/pulls/{ref.number}"
    with _client(ref.host, token, transport) as client:
        pr = _get(client, base, token)
        commits = _get(client, f"{base}/commits?per_page=100", token)
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


# ---------- inbox: the signed-in user's open PRs, for the home page ----------

_INBOX_SEARCHES = {
    "review": "is:pr is:open archived:false review-requested:@me",
    "yours": "is:pr is:open archived:false author:@me",
}
_INBOX_QUERY = """
query($review: String!, $yours: String!) {
  viewer { login }
  review: search(query: $review, type: ISSUE, first: 50) { nodes { ...pr } }
  yours: search(query: $yours, type: ISSUE, first: 50) { nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft updatedAt baseRefName headRefName
  repository { nameWithOwner }
  author { login avatarUrl }
  comments { totalCount }
  reviewThreads { totalCount }
  reviewRequests(first: 10) {
    nodes { requestedReviewer { ... on User { login avatarUrl } ... on Team { slug avatarUrl } } }
  }
  latestOpinionatedReviews(first: 10) { nodes { state author { login avatarUrl } } }
  commits(last: 1) {
    nodes { commit { statusCheckRollup {
      state
      contexts(first: 1) { checkRunCountsByState { state count } statusContextCountsByState { state count } }
    } } }
  }
}
"""
_REVIEW_STATES = {"APPROVED": "approved", "CHANGES_REQUESTED": "changes", "COMMENTED": "commented"}
_FAILING = {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}


def _epoch(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() if iso else 0.0


def _checks(node: dict) -> dict:
    commits = (node.get("commits") or {}).get("nodes") or []
    rollup = (commits[0].get("commit") or {}).get("statusCheckRollup") if commits else None
    if not rollup:
        return {"state": "none", "failing": 0}
    ctx = rollup.get("contexts") or {}
    counts = (ctx.get("checkRunCountsByState") or []) + (ctx.get("statusContextCountsByState") or [])
    failing = sum(c.get("count", 0) for c in counts if c.get("state") in _FAILING)
    state = {"SUCCESS": "success", "FAILURE": "failure", "ERROR": "failure"}.get(
        rollup.get("state"), "pending"
    )
    return {"state": state, "failing": failing}


def _reviewers(node: dict, author: str) -> list[dict]:
    """Who reviewed (their latest approve / request changes / comment) and who is still requested."""
    out: dict[str, dict] = {}
    for r in (node.get("latestOpinionatedReviews") or {}).get("nodes") or []:
        a = r.get("author") or {}
        if a.get("login") and a["login"] != author:
            out[a["login"]] = {
                "login": a["login"],
                "avatar": a.get("avatarUrl", ""),
                "state": _REVIEW_STATES.get(r.get("state"), "commented"),
            }
    for r in (node.get("reviewRequests") or {}).get("nodes") or []:
        who = r.get("requestedReviewer") or {}
        login = who.get("login") or who.get("slug")
        if login:  # a re-request after a review means it's their turn again
            out[login] = {"login": login, "avatar": who.get("avatarUrl", ""), "state": "requested"}
    return list(out.values())


def inbox_pr(node: dict, group: str) -> dict:
    owner, _, repo = (node.get("repository") or {}).get("nameWithOwner", "/").partition("/")
    author = (node.get("author") or {}).get("login", "")
    return {
        "url": node["url"],
        "owner": owner,
        "repo": repo,
        "number": node["number"],
        "title": node.get("title") or "",
        "draft": bool(node.get("isDraft")),
        "group": "drafts" if group == "yours" and node.get("isDraft") else group,
        "author": author,
        "author_avatar": (node.get("author") or {}).get("avatarUrl", ""),
        "base_ref": node.get("baseRefName", ""),
        "head_ref": node.get("headRefName", ""),
        "updated_at": _epoch(node.get("updatedAt", "")),
        "comments": (node.get("comments") or {}).get("totalCount", 0)
        + (node.get("reviewThreads") or {}).get("totalCount", 0),
        "reviewers": _reviewers(node, author),
        "checks": _checks(node),
    }


def link_stacks(prs: list[dict]) -> None:
    """Mark PRs that stack: one whose base branch is another open PR's head branch in the same repo sits on top of
    it. Each PR in a chain of two or more gets ``stack = {"id": <bottom PR's url>, "index": 1-based from the
    bottom, "size": n}``. Only PRs in ``prs`` are seen, so a layer that isn't in the inbox splits the chain."""
    by_head = {(p["owner"], p["repo"], p["head_ref"]): p for p in prs}
    below = {p["url"]: by_head.get((p["owner"], p["repo"], p["base_ref"])) for p in prs}
    above: dict[str, dict] = {}
    for p in prs:
        if (b := below[p["url"]]) and b is not p:
            above.setdefault(b["url"], p)  # the first one wins if two PRs build on the same branch
    for p in prs:
        if below[p["url"]] or p["url"] not in above:
            continue  # not the bottom of a chain
        chain, seen = [p], {p["url"]}
        while (nxt := above.get(chain[-1]["url"])) and nxt["url"] not in seen:
            chain.append(nxt)
            seen.add(nxt["url"])
        for i, q in enumerate(chain, 1):
            q["stack"] = {"id": p["url"], "index": i, "size": len(chain)}


def fetch_inbox(gh: str = "gh") -> dict:
    """The signed-in user's open PRs, from one GraphQL call through ``gh``: review requests first, then their own
    (drafts apart). A PR in both lists shows once, as a review request."""
    if not (shutil.which(gh) or os.sep in gh):
        raise GitHubError("Install the GitHub CLI and run `gh auth login` to see your pull requests.")
    cmd = [gh, "api", "graphql", "-f", f"query={_INBOX_QUERY}"]
    for k, q in _INBOX_SEARCHES.items():
        cmd += ["-f", f"{k}={q}"]
    try:
        out = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=60).stdout
    except subprocess.CalledProcessError as e:
        raise GitHubError(f"gh api graphql failed: {e.stderr.strip() or e}") from e
    except subprocess.TimeoutExpired as e:
        raise GitHubError("GitHub took too long to answer.") from e
    data = json.loads(out).get("data") or {}
    prs: dict[str, dict] = {}
    for group in ("review", "yours"):
        for node in (data.get(group) or {}).get("nodes") or []:
            if node and node.get("url") and node["url"] not in prs:
                prs[node["url"]] = inbox_pr(node, group)
    items = sorted(prs.values(), key=lambda p: p["updated_at"], reverse=True)
    link_stacks(items)
    return {"login": (data.get("viewer") or {}).get("login", ""), "prs": items}


# ---------- one PR's review state: threads, reviewers, checks ----------

_PR_QUERY = """
query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      author { login }
      mergeable baseRefName headRefOid
      reviewRequests(first: 20) {
        nodes { requestedReviewer { ... on User { login avatarUrl } ... on Team { slug avatarUrl } } }
      }
      latestOpinionatedReviews(first: 20) { nodes { state author { login avatarUrl } } }
      commits(last: 1) {
        nodes { commit { statusCheckRollup {
          state
          contexts(first: 100) { nodes {
            __typename
            ... on CheckRun {
              name conclusion status detailsUrl
              annotations(first: 20) {
                nodes { path message title annotationLevel location { start { line } end { line } } }
              }
            }
            ... on StatusContext { context state targetUrl }
          } }
        } } }
      }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line startLine diffSide startDiffSide subjectType
          comments(first: 50) {
            nodes { id body createdAt url author { __typename login avatarUrl } }
          }
        }
      }
    }
  }
}
"""
_CHECK_STATE = {
    "SUCCESS": "success",
    "NEUTRAL": "success",
    "SKIPPED": "skipped",
    "FAILURE": "failure",
    "ERROR": "failure",
    "TIMED_OUT": "failure",
    "CANCELLED": "failure",
    "ACTION_REQUIRED": "failure",
    "STARTUP_FAILURE": "failure",
    "STALE": "skipped",
}


def _check_list(node: dict) -> list[dict]:
    commits = (node.get("commits") or {}).get("nodes") or []
    rollup = (commits[0].get("commit") or {}).get("statusCheckRollup") if commits else None
    out = []
    for c in ((rollup or {}).get("contexts") or {}).get("nodes") or []:
        if c.get("__typename") == "CheckRun":
            done = c.get("status") == "COMPLETED"
            state = _CHECK_STATE.get(c.get("conclusion") or "", "pending") if done else "pending"
            notes = [
                {
                    "path": a.get("path", ""),
                    "start": ((a.get("location") or {}).get("start") or {}).get("line"),
                    "end": ((a.get("location") or {}).get("end") or {}).get("line"),
                    "message": a.get("message") or "",
                    "title": a.get("title") or "",
                }
                for a in ((c.get("annotations") or {}).get("nodes") or [])
                if a and a.get("annotationLevel") == "FAILURE" and a.get("path")
            ]
            check = {"name": c.get("name", ""), "state": state, "url": c.get("detailsUrl") or ""}
            out.append({**check, "annotations": notes} if notes else check)
        elif c.get("__typename") == "StatusContext":
            s = c.get("state")
            state = {"SUCCESS": "success", "PENDING": "pending", "EXPECTED": "pending"}.get(s, "failure")
            out.append({"name": c.get("context", ""), "state": state, "url": c.get("targetUrl") or ""})
    order = {"failure": 0, "pending": 1, "success": 2, "skipped": 3}
    return sorted(out, key=lambda c: (order[c["state"]], c["name"].lower()))


def _thread(t: dict) -> dict:
    comments = [
        {
            "id": c["id"],
            "author": (c.get("author") or {}).get("login") or "ghost",
            "avatar": (c.get("author") or {}).get("avatarUrl", ""),
            "bot": (c.get("author") or {}).get("__typename") == "Bot",
            "body": c.get("body") or "",
            "created_at": _epoch(c.get("createdAt", "")),
            "url": c.get("url", ""),
        }
        for c in (t.get("comments") or {}).get("nodes") or []
    ]
    line = t.get("line")
    return {
        "id": t["id"],
        "path": t.get("path", ""),
        "side": "old" if t.get("diffSide") == "LEFT" else "new",
        "start": t.get("startLine") or line,
        "end": line,
        "file_level": t.get("subjectType") == "FILE",
        "resolved": bool(t.get("isResolved")),
        "outdated": bool(t.get("isOutdated")) or (line is None and t.get("subjectType") != "FILE"),
        "comments": comments,
    }


def pr_review_state(data: dict) -> dict:
    pr = ((data.get("repository") or {}).get("pullRequest")) or {}
    author = (pr.get("author") or {}).get("login", "")
    checks = _check_list(pr)
    failing = sum(c["state"] == "failure" for c in checks)
    pending = any(c["state"] == "pending" for c in checks)
    state = "none" if not checks else "failure" if failing else "pending" if pending else "success"
    threads = [_thread(t) for t in (pr.get("reviewThreads") or {}).get("nodes") or [] if t]
    return {
        "viewer": (data.get("viewer") or {}).get("login", ""),
        "author": author,
        "head_sha": pr.get("headRefOid", ""),
        "base_ref": pr.get("baseRefName", ""),
        # MERGEABLE, CONFLICTING, or UNKNOWN while GitHub works it out
        "mergeable": (pr.get("mergeable") or "UNKNOWN").lower(),
        "reviewers": _reviewers(pr, author),
        "checks": {"state": state, "failing": failing, "list": checks},
        "threads": [t for t in threads if t["comments"]],
    }


def fetch_review_state(ref: PRRef, gh: str = "gh") -> dict:
    """Review threads (with every comment), reviewers and checks for one PR, in one GraphQL call through ``gh``."""
    if not (shutil.which(gh) or os.sep in gh):
        raise GitHubError("Install the GitHub CLI and run `gh auth login` to see review comments.")
    data = _graphql(gh, ref.host, _PR_QUERY, owner=ref.owner, repo=ref.repo, number=ref.number)
    return pr_review_state(data)


def _gh(cmd: list[str], stdin: str | None = None) -> str:
    try:
        return subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=60, input=stdin).stdout
    except subprocess.CalledProcessError as e:
        raise GitHubError(f"GitHub said: {_gh_error(e.stdout, e.stderr)}") from e
    except subprocess.TimeoutExpired as e:
        raise GitHubError("GitHub took too long to answer.") from e


def _gh_error(out: str, err: str) -> str:
    try:
        body = json.loads(out)
        msgs = [m.get("message", "") for m in body.get("errors") or [] if isinstance(m, dict)]
        return "; ".join(m for m in msgs if m) or body.get("message") or err.strip()
    except (ValueError, AttributeError):
        return err.strip() or out.strip()


def _graphql(gh: str, host: str, query: str, **variables: str | int | bool) -> dict:
    """One GraphQL call through ``gh``. Strings go as -f, numbers and booleans as -F (typed)."""
    cmd = [gh, "api", "graphql", "--hostname", host, "-f", f"query={query}"]
    for k, v in variables.items():
        cmd += ["-f", f"{k}={v}"] if isinstance(v, str) else ["-F", f"{k}={str(v).lower()}"]
    out = json.loads(_gh(cmd) or "{}")
    if out.get("errors"):
        raise GitHubError(f"GitHub said: {_gh_error(json.dumps(out), '')}")
    return out.get("data") or {}


# ---------- writing: reviews, replies, resolving, editing your comments ----------

_MUTATIONS = {
    "reply": """mutation($thread: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { id } }
    }""",
    "resolve": """mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { id } } }""",
    "unresolve": """mutation($thread: ID!) { unresolveReviewThread(input: {threadId: $thread}) { thread { id } } }""",
    "edit": """mutation($comment: ID!, $body: String!) {
      updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $comment, body: $body}) { pullRequestReviewComment { id } }
    }""",
    "delete": """mutation($comment: ID!) { deletePullRequestReviewComment(input: {id: $comment}) { clientMutationId } }""",
}
_EVENTS = {"comment": "COMMENT", "approve": "APPROVE", "request_changes": "REQUEST_CHANGES"}


def review_payload(action: dict) -> dict:
    """The REST body for submitting a review: its verdict, summary and line comments (each on one side, over one
    line or a range). ``commit`` pins the comments to the head they were written against."""
    comments = []
    for c in action.get("comments") or []:
        side = "LEFT" if c.get("side") == "old" else "RIGHT"
        one = {"path": c["path"], "body": c["body"], "side": side}
        if c.get("file_level"):
            one["subject_type"] = "file"
        else:
            one["line"] = c["end"]
            if c.get("start") and c["start"] != c["end"]:
                one |= {"start_line": c["start"], "start_side": side}
        comments.append(one)
    body = {"event": _EVENTS[action.get("event", "comment")], "body": action.get("body") or ""}
    if action.get("commit"):
        body["commit_id"] = action["commit"]
    return body | ({"comments": comments} if comments else {})


def write_review(ref: PRRef, action: dict, gh: str = "gh") -> None:
    """Do one thing on the PR as the signed-in user: ``submit`` a review (with pending comments), ``reply`` to a
    thread, ``resolve``/``unresolve`` one, or ``edit``/``delete`` one of your comments."""
    if not (shutil.which(gh) or os.sep in gh):
        raise GitHubError("Install the GitHub CLI and run `gh auth login` to comment.")
    kind = action.get("kind")
    if kind == "submit":
        path = f"repos/{ref.owner}/{ref.repo}/pulls/{ref.number}/reviews"
        cmd = [gh, "api", "--hostname", ref.host, "--method", "POST", path, "--input", "-"]
        _gh(cmd, json.dumps(review_payload(action)))
    elif kind in ("reply", "resolve", "unresolve"):
        extra = {"body": action["body"]} if kind == "reply" else {}
        _graphql(gh, ref.host, _MUTATIONS[kind], thread=action["thread"], **extra)
    elif kind in ("edit", "delete"):
        extra = {"body": action["body"]} if kind == "edit" else {}
        _graphql(gh, ref.host, _MUTATIONS[kind], comment=action["comment"], **extra)
    else:
        raise GitHubError(f"Unknown review action: {kind}")
