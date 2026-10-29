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


def _health(backend: str, profile: str, **kw) -> dict:
    return {"ok": True, "backend": backend, "profile": profile, "version": __version__, "ui": True, **kw}


def test_probe_tells_free_diffusion_and_other(fake_server):
    assert probe(_free_port())[0] == "free"
    port = fake_server(_health("claude-code", "claude-code"))
    assert probe(port) == ("diffusion", _health("claude-code", "claude-code"))
    assert probe(fake_server(None))[0] == "other"


def test_reuses_matching_server_and_skips_others(fake_server, tmp_path, monkeypatch):
    other = fake_server(None)
    api = fake_server(_health("api", "auto"))
    cc = fake_server(_health("claude-code", "claude-code"))
    ports = {other: "other", api: "api", cc: "cc"}
    real_probe = probe
    # Walk only our three fakes, in this order, then report everything else as taken.
    order = [other, api, cc]
    monkeypatch.setattr(launcher, "PORT_SPAN", 2)
    monkeypatch.setattr(
        launcher,
        "probe",
        lambda p, timeout=1.0: real_probe(order[p - 1000]) if p - 1000 < 3 else ("other", {}),
    )
    s = find_or_start(1000, tmp_path, backend="claude-code")
    assert (ports[order[s.port - 1000]], s.started) == ("cc", False)
    s = find_or_start(1000, tmp_path)  # no pin: the first Diffusion server found
    assert ports[order[s.port - 1000]] == "api"


def test_skips_servers_without_ui_or_on_another_version(fake_server, tmp_path, monkeypatch):
    dev = fake_server(_health("claude-code", "claude-code", ui=False))  # `make dev`: API only
    old = fake_server(_health("claude-code", "claude-code", version="0.0.1"))
    order = [dev, old]
    monkeypatch.setattr(launcher, "PORT_SPAN", 1)
    real_probe = probe
    monkeypatch.setattr(launcher, "probe", lambda p, timeout=1.0: real_probe(order[p - 1000]))
    with pytest.raises(launcher.LaunchError, match="No free port"):
        find_or_start(1000, tmp_path, backend="claude-code")


def test_starts_when_no_match(tmp_path, monkeypatch):
    monkeypatch.setattr(launcher, "probe", lambda p, timeout=1.0: ("free", {}))
    calls = []
    monkeypatch.setattr(launcher, "start", lambda *a: calls.append(a) or Server(a[0], "codex", "codex", True))
    assert find_or_start(9000, tmp_path, backend="codex").started
    assert calls == [(9000, tmp_path, "codex", None)]


def test_no_free_port(tmp_path, monkeypatch):
    monkeypatch.setattr(launcher, "probe", lambda p, timeout=1.0: ("other", {}))
    with pytest.raises(launcher.LaunchError, match="No free port"):
        find_or_start(9000, tmp_path)


def test_can_open_browser():
    assert not can_open_browser({"SSH_CONNECTION": "1 2 3 4"}, "darwin")
    assert not can_open_browser({}, "linux")
    assert can_open_browser({"DISPLAY": ":0"}, "linux")
    assert can_open_browser({}, "darwin")


def test_review_url_encodes_target():
    url = Server(8787, "claude-code", "claude-code", False).review_url("https://github.com/o/r/pull/3")
    q = parse_qs(urlparse(url).query)
    assert url.startswith("http://127.0.0.1:8787/?pr=") and q["pr"] == ["https://github.com/o/r/pull/3"]


def test_start_runs_a_real_server_without_harness_env(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDECODE", "1")
    port = _free_port()
    s = launcher.start(port, tmp_path, backend="claude-code")
    try:
        assert (s.started, s.backend, s.port) == (True, "claude-code", port)
        assert s.log and s.log.exists() and s.pid
        proc_env = Path(f"/proc/{s.pid}/environ")
        environ = proc_env.read_bytes().split(b"\0") if proc_env.exists() else []
        assert b"CLAUDECODE=1" not in environ
        assert probe(port)[0] == "diffusion"
    finally:
        if s.pid:
            os.killpg(s.pid, signal.SIGTERM)


def test_open_command_prints_link(tmp_path, monkeypatch):
    srv = Server(8790, "claude-code", "claude-code", True, tmp_path / "serve-8790.log", 1)
    seen = {}

    def fake(port, log_dir, backend, profile):
        seen.update(port=port, backend=backend)
        return srv

    monkeypatch.setattr(launcher, "find_or_start", fake)
    r = CliRunner().invoke(
        app, ["open", "https://github.com/o/r/pull/3", "--backend", "claude-code", "--no-browser"]
    )
    assert r.exit_code == 0, r.output
    assert "http://127.0.0.1:8790/?pr=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F3" in r.output
    assert "started in the background" in r.output and "backend claude-code" in r.output
    assert seen == {"port": 8787, "backend": "claude-code"}


def test_open_rejects_a_non_pr_url():
    r = CliRunner().invoke(
        app, ["open", "https://github.com/o/r/pull/x", "--backend", "codex", "--no-browser"]
    )
    assert r.exit_code != 0


def test_open_from_an_agent_pins_its_backend(tmp_path, monkeypatch):
    seen = {}

    def fake(port, log_dir, backend, profile):
        seen.update(backend=backend)
        return Server(8790, backend or "api", "auto", False)

    monkeypatch.setattr(launcher, "find_or_start", fake)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("DIFFUSION_BACKEND", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    monkeypatch.setenv("CLAUDECODE", "1")
    r = CliRunner().invoke(app, ["open", "https://github.com/o/r/pull/3", "--no-browser"])
    assert r.exit_code == 0, r.output
    assert seen == {"backend": "claude-code"}
    monkeypatch.delenv("CLAUDECODE")
    r = CliRunner().invoke(app, ["open", "https://github.com/o/r/pull/3", "--no-browser"])
    assert r.exit_code == 0, r.output
    assert seen == {"backend": None}
