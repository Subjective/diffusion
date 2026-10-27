import json
import stat

import httpx
import pytest

from diffusion.github import GitHubError, PRRef, _fetch_meta_rest, fetch_meta, parse_pr_url
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
