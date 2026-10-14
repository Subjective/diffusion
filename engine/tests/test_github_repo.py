import json
import stat

import pytest

from diffusion.github import GitHubError, PRRef, fetch_meta, parse_pr_url
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
