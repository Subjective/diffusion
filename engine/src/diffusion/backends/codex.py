"""Backend: the Codex CLI (``codex exec --experimental-json``), using your Codex setup and login.

Codex explores the repository with its own shell tools inside a read-only sandbox. Our custom tools
(``get_hunk``, ``show_code``) don't cross the process boundary; the chat prompt carries the hunk table, and
Codex reads the rest with its shell.

Event format follows the official Codex SDK (thread.started, item.*, turn.completed/failed).
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from ..agent import AgentRequest, DoneEvent, Event, Runner, TextEvent, ThinkingEvent, ToolEvent, ran


def build_args(req: AgentRequest) -> list[str]:
    args = [
        "exec",
        "--experimental-json",
        "--sandbox",
        "read-only",
        "--cd",
        str(req.cwd),
        "--skip-git-repo-check",
    ]
    args += ["--config", 'approval_policy="never"', "--config", 'web_search="disabled"']
    if req.model:
        args += ["--model", req.model]
    if req.resume:
        args += ["fork" if req.fork else "resume", req.resume]
    return args


def summarize_item(item: dict) -> str | None:
    t = item.get("type")
    if t == "command_execution":
        return ran(item.get("command", ""))
    if t == "mcp_tool_call":
        return item.get("tool")
    if t == "web_search":
        return f"Search {item.get('query', '')}"
    return None


def compose_prompt(req: AgentRequest) -> str:
    # A resumed session already has the system prompt; a forked one is someone else's session and doesn't.
    return f"{req.system_prompt}\n\n{req.prompt}" if not req.resume or req.fork else req.prompt


def codex_runner(cli_path: str | None = None) -> Runner:
    exe = cli_path or "codex"

    async def run(req: AgentRequest) -> AsyncIterator[Event]:
        proc = await asyncio.create_subprocess_exec(
            exe, *build_args(req),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=16 * 1024 * 1024,
        )  # fmt: skip
        assert proc.stdin and proc.stdout and proc.stderr
        proc.stdin.write(compose_prompt(req).encode())
        await proc.stdin.drain()
        proc.stdin.close()

        thread_id = req.resume
        turns, last_text, error = 0, "", None
        stderr_task = asyncio.create_task(proc.stderr.read())
        try:
            async for raw in proc.stdout:
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                kind = ev.get("type")
                if kind == "thread.started":
                    thread_id = ev.get("thread_id") or thread_id
                elif kind == "turn.completed":
                    turns += 1
                elif kind == "turn.failed":
                    error = (ev.get("error") or {}).get("message") or "turn failed"
                elif kind == "error":
                    error = ev.get("message") or "codex error"
                elif kind in ("item.started", "item.completed"):
                    item = ev.get("item") or {}
                    if kind == "item.started" and (s := summarize_item(item)):
                        yield ToolEvent(item.get("type", "tool"), s)
                    elif kind == "item.completed" and item.get("type") == "agent_message":
                        last_text = item.get("text", "")
                        yield TextEvent(last_text + "\n")
                    elif kind == "item.completed" and item.get("type") == "reasoning" and item.get("text"):
                        yield ThinkingEvent(item["text"] + "\n")
            code = await proc.wait()
            stderr = (await stderr_task).decode(errors="replace").strip()
            if code != 0 and not error:
                error = stderr.splitlines()[-1] if stderr else f"codex exited with {code}"
        finally:
            if proc.returncode is None:
                proc.kill()
        yield DoneEvent(max(turns, 1), None, error is not None, thread_id, error or last_text)

    return run
