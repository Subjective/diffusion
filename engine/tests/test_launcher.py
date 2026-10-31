import json
import os
import signal
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from typer.testing import CliRunner

from diffusion import __version__, launcher
from diffusion.cli import app
from diffusion.launcher import Server, can_open_browser, find_or_start, probe


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def fake_server():
    """Start an HTTP server on a free port answering /api/health with ``body`` (``None``: a 404)."""
    servers = []

    def make(body: dict | None) -> int:
        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                data = json.dumps(body).encode() if body is not None else b"nope"
                self.send_response(200 if body is not None else 404)
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format, *args):
                pass

        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        servers.append(srv)
        return srv.server_address[1]

    yield make
    for s in servers:
        s.shutdown()


def _health(**kw) -> dict:
    return {"ok": True, "app": "diffusion", "version": __version__, "ui": True, **kw}


def test_probe_tells_free_diffusion_and_other(fake_server):
    assert probe(_free_port())[0] == "free"
    port = fake_server(_health())
    assert probe(port) == ("diffusion", _health())
    assert probe(fake_server({"ok": True}))[0] == "other"  # some other app's health check
    assert probe(fake_server(None))[0] == "other"


def test_reuses_matching_server_and_skips_others(fake_server, tmp_path, monkeypatch):
    other = fake_server(None)
    dev = fake_server(_health(ui=False))  # `make dev`: API only
    old = fake_server(_health(version="0.0.1"))
    good = fake_server(_health())
    order = [other, dev, old, good]
    real_probe = probe
    monkeypatch.setattr(launcher, "PORT_SPAN", 3)
    monkeypatch.setattr(launcher, "probe", lambda p, timeout=1.0: real_probe(order[p - 1000]))
    s = find_or_start(1000, tmp_path)
    assert (s.port, s.started) == (1003, False)
    monkeypatch.setattr(launcher, "PORT_SPAN", 2)
    with pytest.raises(launcher.LaunchError, match="No free port"):
        find_or_start(1000, tmp_path)


def test_starts_when_no_match(tmp_path, monkeypatch):
    monkeypatch.setattr(launcher, "probe", lambda p, timeout=1.0: ("free", {}))
    calls = []
    monkeypatch.setattr(launcher, "start", lambda *a: calls.append(a) or Server(a[0], True))
    assert find_or_start(9000, tmp_path).started
    assert calls == [(9000, tmp_path)]


def test_no_free_port(tmp_path, monkeypatch):
    monkeypatch.setattr(launcher, "probe", lambda p, timeout=1.0: ("other", {}))
    with pytest.raises(launcher.LaunchError, match="No free port"):
        find_or_start(9000, tmp_path)


def test_can_open_browser():
    assert not can_open_browser({"SSH_CONNECTION": "1 2 3 4"}, "darwin")
    assert not can_open_browser({}, "linux")
    assert can_open_browser({"DISPLAY": ":0"}, "linux")
    assert can_open_browser({}, "darwin")


def test_review_url_encodes_target_and_version():
    url = Server(8787, False).review_url("https://github.com/o/r/pull/3")
    q = parse_qs(urlparse(url).query)
    assert url.startswith("http://127.0.0.1:8787/?pr=") and q["pr"] == ["https://github.com/o/r/pull/3"]
    assert parse_qs(urlparse(Server(8787, False).review_url("x", 4)).query)["v"] == ["4"]


def test_start_runs_a_real_server_without_harness_env(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("CODEX_THREAD_ID", "t")
    port = _free_port()
    s = launcher.start(port, tmp_path)
    try:
        assert (s.started, s.port) == (True, port)
        assert s.log and s.log.exists() and s.pid
        proc_env = Path(f"/proc/{s.pid}/environ")
        environ = proc_env.read_bytes().split(b"\0") if proc_env.exists() else []
        assert b"CLAUDECODE=1" not in environ and b"CODEX_THREAD_ID=t" not in environ
        assert probe(port)[0] == "diffusion"
    finally:
        if s.pid:
            os.killpg(s.pid, signal.SIGTERM)


# ---------- the CLI ----------


@pytest.fixture
def sample_repo(tmp_path, monkeypatch):
    from sample import build_sample_repo

    repo = tmp_path / "sample"
    build_sample_repo(repo)
    monkeypatch.setenv("DIFFUSION_CACHE_DIR", str(tmp_path / "cache"))
    opened = []

    def fake(port, log_dir):
        opened.append(port)
        return Server(8790, True, tmp_path / "serve-8790.log", 1)

    monkeypatch.setattr(launcher, "find_or_start", fake)
    return repo


def guide_json(**kw) -> str:
    files = [
        "src/auth/session.ts",
        "src/auth/types.ts",
        "src/api/client.ts",
        "tests/session.test.ts",
        "src/legacy.ts",
    ]
    steps = [{"title": f, "kind": "core", "summary": "s", "refs": [{"file": f}]} for f in files]
    return json.dumps({"tldr": "t", "steps": steps, **kw})


def test_open_without_a_guide_says_so_and_prints_link(sample_repo):
    r = CliRunner().invoke(
        app, ["open", str(sample_repo), "--base", "main", "--head", "feature", "--no-browser"]
    )
    assert r.exit_code == 0, r.output
    assert "No guide yet" in r.output and "http://127.0.0.1:8790/?pr=local%3A" in r.output
    assert "started in the background" in r.output


def test_submit_saves_versions_and_open_points_at_the_latest_draft(sample_repo, tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_THREAD_ID", "th_5")
    for var in ("CLAUDECODE", "CURSOR_AGENT", "CURSOR_TRACE_ID"):
        monkeypatch.delenv(var, raising=False)
    g = tmp_path / "guide.json"
    g.write_text(guide_json(label="First"))
    args = ["submit", str(g), str(sample_repo), "--base", "main", "--head", "feature", "--no-browser"]
    r = CliRunner().invoke(app, args)
    assert r.exit_code == 0, r.output
    assert "Saved version 1" in r.output and "&v=1" in r.output
    r = CliRunner().invoke(app, [args[0], "-", *args[2:]], input=guide_json(label="Second"))  # stdin
    assert r.exit_code == 0, r.output
    assert "Saved version 2" in r.output

    from diffusion.config import load_config
    from diffusion.pipeline import local_target, prepare
    from diffusion.store import Store

    prep = prepare(load_config(), local_target(sample_repo, "main", "feature"))
    store = Store(load_config().cache_dir)
    latest = store.load_guide(prep.meta.ref.key, prep.meta.head_sha)
    assert latest and latest["label"] == "Second" and latest["meta"]["harness"] == "codex"
    assert latest["meta"]["session"] == "th_5" and latest["meta"]["source"] == "agent"

    r = CliRunner().invoke(
        app, ["open", str(sample_repo), "--base", "main", "--head", "feature", "--no-browser"]
    )
    assert "Latest guide: version 2, draft at" in r.output and "2.draft.json" in r.output


def test_submit_rejects_refs_that_miss_the_diff(sample_repo, tmp_path):
    g = tmp_path / "guide.json"
    bad = json.loads(guide_json())
    bad["steps"][0]["refs"] = [{"file": "src/auth/session.ts", "start": 900}]
    g.write_text(json.dumps(bad))
    args = ["submit", str(g), str(sample_repo), "--base", "main", "--head", "feature", "--no-browser"]
    r = CliRunner().invoke(app, args)
    assert r.exit_code == 1
    assert (
        "touches no change" in r.output
        and "src/auth/session.ts:1–25" in r.output
        and "Nothing saved" in r.output
    )
    r = CliRunner().invoke(app, [*args, "--allow-issues"])
    assert r.exit_code == 0 and "Saved version 1" in r.output
    g.write_text("{not json")
    r = CliRunner().invoke(app, args)
    assert r.exit_code == 1 and "doesn't match the schema" in r.output


def test_open_rejects_a_bad_target():
    assert CliRunner().invoke(app, ["open", "https://github.com/o/r/pull/x", "--no-browser"]).exit_code != 0
    assert CliRunner().invoke(app, ["open", "/no/such/dir", "--no-browser"]).exit_code != 0


def test_schema_command_prints_the_draft_schema():
    r = CliRunner().invoke(app, ["schema"])
    assert r.exit_code == 0 and json.loads(r.output)["title"] == "GuideDraft"
