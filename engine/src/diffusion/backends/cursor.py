"""Backend: the Cursor CLI (``cursor-agent -p --output-format stream-json``), using your Cursor setup and login.

Cursor explores the repository with its own tools in read-only ask mode. Like Codex, our custom tools don't
cross the process boundary.

Event format follows Cursor's stream-json output (system/init, assistant, tool_call started/completed, result).
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from ..agent import AgentRequest, DoneEvent, Event, Runner, TextEvent, ThinkingEvent, ToolEvent


def build_args(req: AgentRequest, prompt: str) -> list[str]:
    args = ["-p", "--output-format", "stream-json", "--mode", "ask", "--trust", "--workspace", str(req.cwd)]
    if req.model:
        args += ["--model", req.model]
    if req.resume:
        args += ["--resume", req.resume]
    return [*args, prompt]


def summarize_call(call: dict) -> tuple[str, str] | None:
    """``{"readToolCall": {"args": {...}}}`` → ("read", "Read a.py")."""
    if not call:
        return None
    key, body = next(iter(call.items()))
    name = key.removesuffix("ToolCall")
    args: dict[str, Any] = (body or {}).get("args") or {}
    if args.get("command"):
        cmd = " ".join(str(args["command"]).split())
        return name, cmd if len(cmd) <= 60 else cmd[:57] + "…"
    if args.get("path"):
        return name, f"{name.capitalize()} {Path(str(args['path'])).name}"
    if args.get("pattern") or args.get("globPattern"):
        return name, f"{name.capitalize()} {args.get('pattern') or args.get('globPattern')}"
    return name, name


def compose_prompt(req: AgentRequest) -> str:
    return f"{req.system_prompt}\n\n{req.prompt}" if not req.resume else req.prompt


def cursor_runner(cli_path: str | None = None) -> Runner:
    exe = cli_path or "cursor-agent"

    async def run(req: AgentRequest) -> AsyncIterator[Event]:
        proc = await asyncio.create_subprocess_exec(
            exe, *build_args(req, compose_prompt(req)),
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=16 * 1024 * 1024,
        )  # fmt: skip
        assert proc.stdout and proc.stderr

        session_id = req.resume
        last_text, result, error = "", None, None
        stderr_task = asyncio.create_task(proc.stderr.read())
        try:
            async for raw in proc.stdout:
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                session_id = ev.get("session_id") or session_id
                kind = ev.get("type")
                if kind == "assistant":
                    content = (ev.get("message") or {}).get("content") or []
                    text = "".join(c.get("text", "") for c in content if c.get("type") == "text")
                    if text:
                        last_text = text
                        yield TextEvent(text + "\n")
                elif kind == "thinking" and ev.get("subtype") == "delta" and ev.get("text"):
                    yield ThinkingEvent(ev["text"])
                elif kind == "thinking" and ev.get("subtype") == "completed":
                    yield ThinkingEvent("\n")
                elif kind == "tool_call" and ev.get("subtype") == "started":
                    if s := summarize_call(ev.get("tool_call") or {}):
                        yield ToolEvent(*s)
                elif kind == "result":
                    result = ev.get("result")
                    if ev.get("is_error") or ev.get("subtype") not in (None, "success"):
                        error = result or ev.get("subtype") or "cursor-agent failed"
            code = await proc.wait()
            stderr = (await stderr_task).decode(errors="replace").strip()
            if code != 0 and not error:
                error = stderr.splitlines()[-1] if stderr else f"cursor-agent exited with {code}"
        finally:
            if proc.returncode is None:
                proc.kill()
        yield DoneEvent(1, None, error is not None, session_id, error or result or last_text)

    return run
