"""Shared fixtures: the built-in sample repo, exposed as an upstream with a PR head ref."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest
from sample import build_sample_repo

DIFFUSION_ENV = ("DIFFUSION_CACHE_DIR", "DIFFUSION_CLI", "DIFFUSION_CHAT_MODEL")


@dataclass
class Upstream:
    path: Path
    base_sha: str
    head_sha: str
    number: int = 7

    @property
    def url(self) -> str:
        return f"file://{self.path}"


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch, request):
    """Tests never see the developer's real caches (live tests keep the real environment)."""
    if request.node.get_closest_marker("live"):
        return
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    for var in DIFFUSION_ENV:
        monkeypatch.delenv(var, raising=False)


@pytest.fixture(scope="session")
def upstream(tmp_path_factory) -> Upstream:
    root = tmp_path_factory.mktemp("upstream")
    base_sha, head_sha = build_sample_repo(root)
    subprocess.run(["git", "update-ref", "refs/pull/7/head", head_sha], cwd=root, check=True)
    return Upstream(root, base_sha, head_sha)


@pytest.fixture
def checkout(upstream, tmp_path):
    from diffusion.github import PRRef
    from diffusion.repo import RepoCache

    ref = PRRef("github.com", "acme", "web", upstream.number)
    return RepoCache(tmp_path / "cache", remote_override=upstream.url).checkout(
        ref, "main", upstream.base_sha, upstream.head_sha
    )
