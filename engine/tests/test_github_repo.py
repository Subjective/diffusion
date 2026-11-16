import json
import stat

import httpx
import pytest

from diffusion.github import (
    GitHubError,
    PRRef,
    _fetch_meta_rest,
    fetch_inbox,
    fetch_meta,
    fetch_review_state,
    inbox_pr,
    link_stacks,
    parse_pr_url,
    pr_review_state,
    review_payload,
    write_review,
)
from diffusion.repo import RepoCache


@pytest.mark.parametrize(
    "url",
    [
        "https://github.com/acme/web-app/pull/482",
        "github.com/acme/web-app/pull/482/files",
        "http://github.com/acme/web-app/pull/482#discussion_r1",
    ],
)
def test_parse_pr_url(url):
    ref = parse_pr_url(url)
    assert ref == PRRef("github.com", "acme", "web-app", 482)
    assert ref.key == "acme-web-app-482"
    assert ref.url == "https://github.com/acme/web-app/pull/482"


@pytest.mark.parametrize("url", ["", "github.com/acme/web-app", "https://github.com/o/r/issues/3"])
def test_parse_pr_url_rejects(url):
    with pytest.raises(GitHubError):
        parse_pr_url(url)


def test_fetch_meta_uses_gh(tmp_path):
    payload = {
        "number": 482,
        "title": "Add refresh",
        "body": None,
        "author": {"login": "jy"},
        "baseRefName": "main",
        "headRefName": "feat",
        "baseRefOid": "a" * 40,
        "headRefOid": "b" * 40,
        "additions": 71,
        "deletions": 5,
        "changedFiles": 6,
        "commits": [{"oid": "c" * 40, "messageHeadline": "wip"}],
    }
    fake = tmp_path / "gh"
    fake.write_text(f"#!/bin/sh\necho \"$@\" > {tmp_path}/args\ncat <<'EOF'\n{json.dumps(payload)}\nEOF\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)

    meta = fetch_meta(PRRef("github.com", "acme", "web-app", 482), gh=str(fake))
    assert (meta.title, meta.body, meta.author, meta.head_sha) == ("Add refresh", "", "jy", "b" * 40)
    assert meta.commits == [{"sha": "c" * 12, "headline": "wip"}]
    assert "--repo github.com/acme/web-app" in (tmp_path / "args").read_text()


def test_checkout_creates_worktree_at_head(checkout, upstream):
    assert checkout.head_sha == upstream.head_sha
    assert checkout.merge_base == upstream.base_sha
    assert "refreshTokens" in (checkout.worktree / "src/api/client.ts").read_text()
    assert not (checkout.worktree / "src/legacy.ts").exists()


def test_diff_is_against_merge_base(checkout):
    diff = checkout.diff()
    assert "+  expiresAt: number;" in diff
    assert "rename from docs/notes.md" in diff
    assert "deleted file mode" in diff


def test_checkout_is_idempotent_and_reuses_clone(upstream, tmp_path):
    ref = PRRef("github.com", "acme", "web", upstream.number)
    cache = RepoCache(tmp_path / "c", remote_override=upstream.url)
    a = cache.checkout(ref, "main", upstream.base_sha, upstream.head_sha)
    b = cache.checkout(ref, "main", upstream.base_sha, upstream.head_sha)
    assert a == b
    assert (cache.bare_path(ref) / "HEAD").exists()


def test_file_at_head(checkout):
    assert checkout.file_at_head("src/auth/types.ts").count("expiresAt") == 1
    assert checkout.file_at_head("src/legacy.ts") is None


def _api(routes: dict[str, httpx.Response], seen: list[httpx.Request]) -> httpx.MockTransport:
    def handle(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return routes.get(req.url.path) or httpx.Response(404)

    return httpx.MockTransport(handle)


def test_rest_fetch_meta():
    pr = {
        "title": "Add refresh",
        "body": None,
        "user": {"login": "jy"},
        "base": {"ref": "main", "sha": "b" * 40},
        "head": {"ref": "feature", "sha": "h" * 40},
        "additions": 3,
        "deletions": 1,
        "changed_files": 2,
    }
    commits = [{"sha": "c" * 40, "commit": {"message": "Refresh tokens\n\nDetails"}}]
    seen: list[httpx.Request] = []
    api = _api(
        {
            "/api/v3/repos/acme/web/pulls/7": httpx.Response(200, json=pr),
            "/api/v3/repos/acme/web/pulls/7/commits": httpx.Response(200, json=commits),
        },
        seen,
    )
    meta = _fetch_meta_rest(PRRef("ghe.acme.dev", "acme", "web", 7), "tok", api)
    assert (meta.title, meta.body, meta.author, meta.head_ref, meta.changed_files) == (
        "Add refresh",
        "",
        "jy",
        "feature",
        2,
    )
    assert meta.commits == [{"sha": "c" * 12, "headline": "Refresh tokens"}]
    assert seen[0].url.host == "ghe.acme.dev"
    assert seen[0].headers["Authorization"] == "Bearer tok"
    assert seen[1].url.params["per_page"] == "100"


def test_rest_errors_hint_at_token_when_unauthenticated():
    api = _api({}, [])
    with pytest.raises(GitHubError, match=r"404 .*set GITHUB_TOKEN"):
        _fetch_meta_rest(PRRef("github.com", "acme", "web", 7), None, api)


def test_rest_unreachable():
    def fail(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=req)

    with pytest.raises(GitHubError, match="unreachable"):
        _fetch_meta_rest(PRRef("github.com", "acme", "web", 7), None, httpx.MockTransport(fail))


def test_rest_client_uses_the_environment_proxy(monkeypatch):
    from diffusion.github import _proxy_for

    for var in ("HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"):
        monkeypatch.delenv(var, raising=False)
    assert _proxy_for("https://api.github.com") is None
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.corp:3128")
    assert _proxy_for("https://api.github.com") == "http://proxy.corp:3128"
    monkeypatch.setenv("NO_PROXY", "api.github.com")
    assert _proxy_for("https://api.github.com") is None


def _node(n, *, head="feat", base="main", draft=False, repo="acme/web", **extra):
    return {
        "number": n,
        "title": f"PR {n}",
        "url": f"https://github.com/{repo}/pull/{n}",
        "isDraft": draft,
        "updatedAt": f"2026-11-{10 + n % 10:02d}T12:00:00Z",
        "baseRefName": base,
        "headRefName": head,
        "repository": {"nameWithOwner": repo},
        "author": {"login": "sam", "avatarUrl": "https://a/sam"},
        "comments": {"totalCount": 1},
        "reviewThreads": {"totalCount": 2},
        **extra,
    }


def test_inbox_pr_reads_reviews_requests_and_checks():
    node = _node(
        42,
        latestOpinionatedReviews={
            "nodes": [
                {"state": "APPROVED", "author": {"login": "lm", "avatarUrl": "https://a/lm"}},
                {"state": "CHANGES_REQUESTED", "author": {"login": "pk", "avatarUrl": "https://a/pk"}},
                {
                    "state": "COMMENTED",
                    "author": {"login": "sam", "avatarUrl": "https://a/sam"},
                },  # the author
            ]
        },
        reviewRequests={
            "nodes": [
                {"requestedReviewer": {"login": "pk", "avatarUrl": "https://a/pk"}},
                {"requestedReviewer": {"slug": "core", "avatarUrl": "https://a/core"}},
            ]
        },  # fmt: skip
        commits={
            "nodes": [
                {
                    "commit": {
                        "statusCheckRollup": {
                            "state": "FAILURE",
                            "contexts": {
                                "checkRunCountsByState": [
                                    {"state": "SUCCESS", "count": 4},
                                    {"state": "FAILURE", "count": 1},
                                ],
                                "statusContextCountsByState": [{"state": "ERROR", "count": 1}],
                            },
                        }
                    }
                }
            ]
        },  # fmt: skip
    )
    pr = inbox_pr(node, "review")
    assert (pr["owner"], pr["repo"], pr["number"], pr["group"], pr["comments"]) == (
        "acme",
        "web",
        42,
        "review",
        3,
    )
    # pk was re-requested after asking for changes, so it's their turn again; the author's own review is left out
    assert [(r["login"], r["state"]) for r in pr["reviewers"]] == [
        ("lm", "approved"),
        ("pk", "requested"),
        ("core", "requested"),
    ]
    assert pr["checks"] == {"state": "failure", "failing": 2}
    assert inbox_pr(_node(1), "yours")["checks"] == {"state": "none", "failing": 0}
    assert inbox_pr(_node(1, draft=True), "yours")["group"] == "drafts"


def test_link_stacks_chains_prs_on_each_others_branches():
    prs = [
        inbox_pr(_node(48, head="stream", base="parallel"), "yours"),
        inbox_pr(_node(41, head="decision", base="main"), "yours"),
        inbox_pr(_node(42, head="parallel", base="decision"), "review"),
        inbox_pr(_node(50, head="other", base="main"), "yours"),
        inbox_pr(_node(51, head="decision", base="parallel", repo="acme/api"), "yours"),  # another repo
    ]
    link_stacks(prs)
    by = {p["number"]: p.get("stack") for p in prs}
    bottom = "https://github.com/acme/web/pull/41"
    assert by[41] == {"id": bottom, "index": 1, "size": 3}
    assert by[42] == {"id": bottom, "index": 2, "size": 3}
    assert by[48] == {"id": bottom, "index": 3, "size": 3}
    assert by[50] is None and by[51] is None


def test_fetch_inbox_uses_gh_graphql(tmp_path):
    payload = {
        "data": {
            "viewer": {"login": "jy"},
            "review": {"nodes": [_node(42), {}]},  # non-PR search hits come back empty
            "yours": {"nodes": [_node(42), _node(44), _node(47, draft=True)]},
        }
    }
    fake = tmp_path / "gh"
    fake.write_text(f"#!/bin/sh\necho \"$@\" > {tmp_path}/args\ncat <<'EOF'\n{json.dumps(payload)}\nEOF\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    out = fetch_inbox(gh=str(fake))
    assert out["login"] == "jy"
    assert [(p["number"], p["group"]) for p in out["prs"]] == [(47, "drafts"), (44, "yours"), (42, "review")]
    args = (tmp_path / "args").read_text()
    assert "api graphql" in args and "review-requested:@me" in args


def test_fetch_inbox_without_gh():
    with pytest.raises(GitHubError, match="gh auth login"):
        fetch_inbox(gh="definitely-not-gh")


def _review_payload():
    comment = lambda i, who, typ="User": {  # noqa: E731
        "id": f"c{i}",
        "body": f"note {i}",
        "createdAt": "2026-11-15T10:00:00Z",
        "url": f"https://github.com/acme/web/pull/42#discussion_r{i}",
        "author": {"__typename": typ, "login": who, "avatarUrl": f"https://a/{who}"},
    }
    return {
        "viewer": {"login": "jy"},
        "repository": {
            "pullRequest": {
                "author": {"login": "sam"},
                "reviewRequests": {"nodes": []},
                "latestOpinionatedReviews": {
                    "nodes": [{"state": "APPROVED", "author": {"login": "lm", "avatarUrl": "https://a/lm"}}]
                },
                "commits": {
                    "nodes": [
                        {
                            "commit": {
                                "statusCheckRollup": {
                                    "state": "FAILURE",
                                    "contexts": {
                                        "nodes": [
                                            {
                                                "__typename": "CheckRun",
                                                "name": "lint",
                                                "status": "COMPLETED",
                                                "conclusion": "SUCCESS",
                                                "detailsUrl": "https://ci/lint",
                                            },
                                            {
                                                "__typename": "CheckRun",
                                                "name": "test",
                                                "status": "COMPLETED",
                                                "conclusion": "FAILURE",
                                                "detailsUrl": "https://ci/test",
                                            },
                                            {
                                                "__typename": "CheckRun",
                                                "name": "build",
                                                "status": "IN_PROGRESS",
                                                "conclusion": None,
                                            },
                                            {
                                                "__typename": "StatusContext",
                                                "context": "deploy",
                                                "state": "SUCCESS",
                                                "targetUrl": None,
                                            },
                                        ]
                                    },
                                }
                            }
                        }
                    ]
                },  # fmt: skip
                "reviewThreads": {
                    "nodes": [
                        {
                            "id": "T1",
                            "isResolved": False,
                            "isOutdated": False,
                            "path": "src/a.rs",
                            "line": 53,
                            "startLine": 41,
                            "diffSide": "RIGHT",
                            "subjectType": "LINE",
                            "comments": {"nodes": [comment(1, "pk"), comment(2, "sam")]},
                        },
                        {
                            "id": "T2",
                            "isResolved": True,
                            "isOutdated": False,
                            "path": "src/a.rs",
                            "line": 7,
                            "startLine": None,
                            "diffSide": "LEFT",
                            "subjectType": "LINE",
                            "comments": {"nodes": [comment(3, "claude", "Bot")]},
                        },
                        {
                            "id": "T3",
                            "isResolved": False,
                            "isOutdated": False,
                            "path": "src/b.rs",
                            "line": None,
                            "startLine": None,
                            "diffSide": "RIGHT",
                            "subjectType": "FILE",
                            "comments": {"nodes": [comment(4, "sam")]},
                        },
                        {
                            "id": "T4",
                            "isResolved": False,
                            "isOutdated": True,
                            "path": "src/b.rs",
                            "line": None,
                            "startLine": None,
                            "diffSide": "RIGHT",
                            "subjectType": "LINE",
                            "comments": {"nodes": [comment(5, "pk")]},
                        },
                    ]
                },  # fmt: skip
            }
        },
    }


def test_pr_review_state_reads_threads_checks_and_reviewers():
    st = pr_review_state(_review_payload())
    assert st["viewer"] == "jy"
    assert [(r["login"], r["state"]) for r in st["reviewers"]] == [("lm", "approved")]
    assert st["checks"]["state"] == "failure" and st["checks"]["failing"] == 1
    assert [(c["name"], c["state"]) for c in st["checks"]["list"]] == [
        ("test", "failure"),
        ("build", "pending"),
        ("deploy", "success"),
        ("lint", "success"),
    ]
    t1, t2, t3, t4 = st["threads"]
    assert (t1["path"], t1["side"], t1["start"], t1["end"], t1["resolved"]) == (
        "src/a.rs",
        "new",
        41,
        53,
        False,
    )
    assert [c["author"] for c in t1["comments"]] == ["pk", "sam"]
    assert (t2["side"], t2["start"], t2["end"], t2["resolved"], t2["comments"][0]["bot"]) == (
        "old",
        7,
        7,
        True,
        True,
    )
    assert t3["file_level"] and not t3["outdated"]
    assert t4["outdated"] and not t4["file_level"]


def test_fetch_review_state_passes_the_pr_to_gh(tmp_path):
    fake = tmp_path / "gh"
    fake.write_text(
        f"#!/bin/sh\necho \"$@\" > {tmp_path}/args\ncat <<'EOF'\n{json.dumps({'data': _review_payload()})}\nEOF\n"
    )
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    st = fetch_review_state(PRRef("github.com", "acme", "web", 42), gh=str(fake))
    assert len(st["threads"]) == 4
    args = (tmp_path / "args").read_text()
    assert "owner=acme" in args and "repo=web" in args and "number=42" in args


def test_review_payload_puts_comments_on_their_side_and_range():
    body = review_payload(
        {
            "event": "request_changes",
            "body": "A few things",
            "commit": "abc",
            "comments": [
                {"path": "a.rs", "side": "new", "start": 41, "end": 53, "body": "range"},
                {"path": "a.rs", "side": "old", "start": 7, "end": 7, "body": "one old line"},
                {
                    "path": "b.rs",
                    "side": "new",
                    "start": None,
                    "end": None,
                    "file_level": True,
                    "body": "file",
                },
            ],
        }
    )
    assert (
        body["event"] == "REQUEST_CHANGES" and body["commit_id"] == "abc" and body["body"] == "A few things"
    )
    assert body["comments"] == [
        {
            "path": "a.rs",
            "body": "range",
            "side": "RIGHT",
            "line": 53,
            "start_line": 41,
            "start_side": "RIGHT",
        },
        {"path": "a.rs", "body": "one old line", "side": "LEFT", "line": 7},
        {"path": "b.rs", "body": "file", "side": "RIGHT", "subject_type": "file"},
    ]
    assert "comments" not in review_payload({"event": "approve"})


def test_write_review_sends_reviews_by_rest_and_the_rest_by_graphql(tmp_path):
    fake = tmp_path / "gh"
    fake.write_text(
        f'#!/bin/sh\necho "$@" >> {tmp_path}/args\ncat >> {tmp_path}/stdin\necho \'{{"data": {{}}}}\'\n'
    )
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    ref = PRRef("github.com", "acme", "web", 42)
    write_review(ref, {"kind": "submit", "event": "comment", "body": "hi", "comments": []}, gh=str(fake))
    write_review(ref, {"kind": "reply", "thread": "T1", "body": "thanks"}, gh=str(fake))
    write_review(ref, {"kind": "resolve", "thread": "T1"}, gh=str(fake))
    write_review(ref, {"kind": "edit", "comment": "C1", "body": "fixed"}, gh=str(fake))
    calls = (tmp_path / "args").read_text().split("api ")[1:]  # queries span lines
    assert "--method POST repos/acme/web/pulls/42/reviews --input -" in calls[0]
    assert (tmp_path / "stdin").read_text().startswith('{"event": "COMMENT", "body": "hi"}')
    assert (
        "addPullRequestReviewThreadReply" in calls[1]
        and "thread=T1" in calls[1]
        and "body=thanks" in calls[1]
    )
    assert "resolveReviewThread" in calls[2]
    assert "updatePullRequestReviewComment" in calls[3] and "comment=C1" in calls[3]


def test_write_review_surfaces_githubs_message(tmp_path):
    fake = tmp_path / "gh"
    fake.write_text('#!/bin/sh\necho \'{"message": "Can not approve your own pull request"}\'\nexit 1\n')
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    with pytest.raises(GitHubError, match="Can not approve your own"):
        write_review(
            PRRef("github.com", "acme", "web", 42), {"kind": "submit", "event": "approve"}, gh=str(fake)
        )


def test_pr_review_state_reads_the_conversation():
    data = _review_payload()
    who = {"__typename": "User", "login": "pk", "avatarUrl": "https://a/pk"}
    data["repository"]["pullRequest"] |= {
        "id": "PR_1",
        "timelineItems": {
            "nodes": [
                {"__typename": "PullRequestCommit", "commit": {"oid": "abc", "messageHeadline": "Start",
                 "committedDate": "2026-11-15T09:00:00Z", "author": {"name": "Sam", "user": None}}},
                {"__typename": "PullRequestReview", "id": "R1", "state": "CHANGES_REQUESTED", "body": "One thing",
                 "submittedAt": "2026-11-15T10:00:00Z", "url": "u", "author": who},
                {"__typename": "PullRequestReview", "id": "R2", "state": "PENDING", "body": "", "author": who},
                {"__typename": "IssueComment", "id": "C1", "body": "Thanks", "createdAt": "2026-11-15T11:00:00Z",
                 "url": "u2", "author": {**who, "__typename": "Bot", "login": "ci-bot"}},
            ]
        },
    }  # fmt: skip
    st = pr_review_state(data)
    assert st["id"] == "PR_1"
    assert [(t["kind"], t["author"], t.get("state")) for t in st["timeline"]] == [
        ("commit", "Sam", None),
        ("review", "pk", "changes"),
        ("comment", "ci-bot", None),
    ]
    assert st["timeline"][2]["bot"] and st["timeline"][0]["body"] == "Start"


def test_deleting_a_comment_thats_already_gone_is_done(tmp_path):
    fake = tmp_path / "gh"
    fake.write_text(
        '#!/bin/sh\necho \'{"errors": [{"message": "Could not resolve to a node with the global id of '
        "X.\"}]}'\nexit 1\n"
    )
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    ref = PRRef("github.com", "acme", "web", 42)
    write_review(ref, {"kind": "delete", "comment": "C1"}, gh=str(fake))
    with pytest.raises(GitHubError, match="Could not resolve"):
        write_review(ref, {"kind": "edit", "comment": "C1", "body": "x"}, gh=str(fake))
