"""A Codex app server (``codex app-server``): JSON-RPC over stdio, one process per turn.

What ``codex exec`` can't do, the app server can: take a message into the running turn (``turn/steer``), stop a
turn cleanly (``turn/interrupt``), and list the session's skills (``skills/list``).
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
from pathlib import Path
from typing import Any

PROTOCOL_LIMIT = 16 * 1024 * 1024


class AppServerError(RuntimeError):
    pass


class AppServer:
    """A running ``codex app-server``: ``request`` sends a call and waits for its answer; notifications go to
    ``notes``. Requests the server makes of us (approvals, which our approval policy shouldn't produce) are
    declined, so nothing waits on them."""

    def __init__(self, exe: str, cwd: Path | None = None, args: list[str] | None = None):
        self.exe, self.cwd, self.args = exe, cwd, args or []
        self.notes: asyncio.Queue[dict] = asyncio.Queue()
        self._ids = itertools.count(1)
        self._waiting: dict[int, asyncio.Future] = {}
        self._proc: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task | None = None
        self._stderr = b""

    async def __aenter__(self) -> AppServer:
        self._proc = await asyncio.create_subprocess_exec(
            self.exe, "app-server", *self.args,
            cwd=str(self.cwd) if self.cwd else None,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=PROTOCOL_LIMIT,
        )  # fmt: skip
        self._reader = asyncio.create_task(self._read())
        await self.request(
            "initialize",
            {
                "clientInfo": {"name": "diffusion", "title": "Diffusion", "version": "1"},
                "capabilities": {"experimentalApi": True, "requestAttestation": False},
            },
        )
        await self._send({"method": "initialized"})
        return self

    async def __aexit__(self, *exc: object) -> None:
        proc = self._proc
        if self._reader:
            self._reader.cancel()
        if proc and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                if proc.stdin:
                    proc.stdin.close()
                proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), 3)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()

    async def _send(self, msg: dict) -> None:
        assert self._proc and self._proc.stdin
        self._proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self._proc.stdin.drain()

    async def request(self, method: str, params: dict[str, Any]) -> dict:
        rid = next(self._ids)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._waiting[rid] = fut
        await self._send({"id": rid, "method": method, "params": params})
        return await fut

    async def _read(self) -> None:
        assert self._proc and self._proc.stdout and self._proc.stderr
        err = asyncio.create_task(self._proc.stderr.read())
        try:
            async for raw in self._proc.stdout:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if "method" in msg and "id" in msg:  # the server asks us something
                    await self._send({"id": msg["id"], "error": {"code": -32601, "message": "not supported"}})
                elif "method" in msg:
                    await self.notes.put(msg)
                elif (fut := self._waiting.pop(msg.get("id"), None)) and not fut.done():
                    if "error" in msg:
                        fut.set_exception(
                            AppServerError((msg["error"] or {}).get("message") or "codex error")
                        )
                    else:
                        fut.set_result(msg.get("result") or {})
        finally:
            self._stderr = await err if err.done() else b""
            why = self._stderr.decode(errors="replace").strip().splitlines()
            gone = AppServerError(why[-1] if why else "the Codex app server exited")
            for fut in self._waiting.values():
                if not fut.done():
                    fut.set_exception(gone)
            self._waiting.clear()
            await self.notes.put({"method": "_exited", "params": {"message": str(gone)}})


def text_input(text: str) -> dict:
    return {"type": "text", "text": text, "text_elements": []}


async def list_skills(exe: str, cwd: Path | None) -> list[dict]:
    """The skills Codex has for a session in ``cwd``: its own, the user's, the repository's and plugins'."""
    async with AppServer(exe, cwd) as srv:
        res = await srv.request("skills/list", {"cwds": [str(cwd)] if cwd else []})
    out = []
    for entry in res.get("data") or []:
        for s in entry.get("skills") or []:
            if s.get("enabled", True) and s.get("name"):
                out.append(
                    {"name": s["name"], "description": s.get("description") or "", "path": s.get("path")}
                )
    return out
