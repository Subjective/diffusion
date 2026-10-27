"""``diffusion open``: reuse a running ``diffusion serve`` or start one in the background, then point the
browser at a target. It returns as soon as the server answers, so an agent harness's slash command doesn't
hang on it.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import quote

import httpx

PORT_SPAN = 20  # ports tried after the first one
START_TIMEOUT = 60.0
# Set by a parent Claude Code session for its children. A detached server is not part of that session, and
# the `claude` it launches for the claude-code backend must not look nested in it. Provider settings such as
# CLAUDE_CODE_USE_BEDROCK are kept, so the backend reaches models the same way the harness does.
HARNESS_ENV = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SSE_PORT")

PortState = Literal["free", "diffusion", "other"]


class LaunchError(RuntimeError):
    pass


@dataclass(frozen=True)
class Server:
    port: int
    backend: str
    profile: str
    started: bool
    log: Path | None = None
    pid: int | None = None

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def review_url(self, target: str) -> str:
        return f"{self.base_url}/?pr={quote(target, safe='')}"


def probe(port: int, timeout: float = 1.0) -> tuple[PortState, dict]:
    """What's on ``127.0.0.1:port``: nothing, a Diffusion server (with its ``/api/health``), or something else."""
    try:
        r = httpx.get(f"http://127.0.0.1:{port}/api/health", timeout=timeout)
        data = r.json() if r.status_code == 200 else {}
        if isinstance(data, dict) and data.get("ok") and "backend" in data:
            return "diffusion", data
        return "other", {}
    except httpx.ConnectError:
        return ("free", {}) if _bindable(port) else ("other", {})
    except (httpx.HTTPError, ValueError):
        return "other", {}


def _bindable(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _matches(health: dict, backend: str | None, profile: str | None) -> bool:
    return (backend is None or health.get("backend") == backend) and (
        profile is None or health.get("profile") == profile
    )


def find_or_start(
    first_port: int, log_dir: Path, backend: str | None = None, profile: str | None = None
) -> Server:
    """Reuse a Diffusion server on ``first_port``..+``PORT_SPAN`` running the same backend/profile, else start
    one on the first free port. A server on another backend is left alone, never reused."""
    free: int | None = None
    for port in range(first_port, first_port + PORT_SPAN + 1):
        state, health = probe(port)
        if state == "diffusion" and _matches(health, backend, profile):
            return Server(port, health["backend"], health.get("profile", ""), started=False)
        if state == "free" and free is None:
            free = port
    if free is None:
        raise LaunchError(f"No free port in {first_port}-{first_port + PORT_SPAN}; pass --port.")
    return start(free, log_dir, backend, profile)


def start(port: int, log_dir: Path, backend: str | None = None, profile: str | None = None) -> Server:
    cmd = [sys.executable, "-m", "diffusion.cli", "serve", "--port", str(port)]
    if backend:
        cmd += ["--backend", backend]
    if profile:
        cmd += ["--profile", profile]
    env = {k: v for k, v in os.environ.items() if k not in HARNESS_ENV}
    log_dir.mkdir(parents=True, exist_ok=True)
    log = log_dir / f"serve-{port}.log"
    with open(log, "w") as fh:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=fh,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
        )
    deadline = time.monotonic() + START_TIMEOUT
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            tail = log.read_text(errors="replace").strip().splitlines()[-15:]
            raise LaunchError("The Diffusion server exited on startup:\n" + "\n".join(tail))
        state, health = probe(port, timeout=0.5)
        if state == "diffusion":
            return Server(port, health["backend"], health.get("profile", ""), True, log, proc.pid)
        time.sleep(0.25)
    proc.terminate()
    raise LaunchError(
        f"The Diffusion server didn't answer on port {port} within {START_TIMEOUT:.0f}s; see {log}"
    )


def can_open_browser(environ: dict[str, str] | None = None, platform: str = sys.platform) -> bool:
    """False over SSH or on a Linux box with no display, where opening a browser would fail or open remotely."""
    env = os.environ if environ is None else environ
    if env.get("SSH_CONNECTION") or env.get("SSH_TTY"):
        return False
    if platform.startswith("linux"):
        return bool(env.get("DISPLAY") or env.get("WAYLAND_DISPLAY"))
    return True
