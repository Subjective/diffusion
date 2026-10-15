"""Backend: the Codex CLI (``codex exec --experimental-json``), using your Codex setup and login.

Codex explores the repository with its own shell tools inside a read-only sandbox. Our custom tools don't
cross the process boundary, so:

- the terminal tool (``submit_guide``) becomes ``--output-schema``: Codex's final message is the structured
  result, which we pass to the tool's handler;
- other tools (``get_hunk``) aren't needed: their data is already in the prompt, which the guide and chat
  prompts include for normal-sized PRs.

Event format follows the official Codex SDK (thread.started, item.*, turn.completed/failed).
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from ..agent import AgentRequest, DoneEvent, Event, Runner, TextEvent, ToolEvent, ToolSpec
from ..config import Config


def strict_schema(schema: dict) -> dict:
    """OpenAI structured outputs need every property required and no extra keys; optional → nullable."""

    def walk(node: Any, is_props: bool = False) -> Any:
        if isinstance(node, list):
            return [walk(x) for x in node]
        if not isinstance(node, dict):
            return node
        if is_props:  # a {name: schema} mapping: keys are property names, never schema keywords
            return {k: walk(v) for k, v in node.items()}
        node = {
            k: walk(v, is_props=(k == "properties")) for k, v in node.items() if k not in ("default", "title")
        }
        if node.get("type") == "object" and "properties" in node:
            req = set(node.get("required", []))
            for k, v in node["properties"].items():
                if k not in req and isinstance(v, dict) and "anyOf" not in v:
                    t = v.get("type")
                    node["properties"][k] = (
                        {**v, "type": [t, "null"]} if isinstance(t, str) else {"anyOf": [v, {"type": "null"}]}
                    )
            node["required"] = list(node["properties"])
            node["additionalProperties"] = False
        return node

    return walk(schema)


def drop_nulls(value: Any) -> Any:
    """Undo strict-mode nullables: ``null`` means "omitted", so let defaults apply."""
    if isinstance(value, dict):
        return {k: drop_nulls(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [drop_nulls(v) for v in value]
    return value


def build_args(cfg: Config, req: AgentRequest, schema_file: str | None) -> list[str]:
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
    if schema_file:
        args += ["--output-schema", schema_file]
    if req.resume:
        args += ["resume", req.resume]
    return args


def summarize_item(item: dict) -> str | None:
    t = item.get("type")
    if t == "command_execution":
        cmd = item.get("command", "")
        return cmd if len(cmd) <= 60 else cmd[:57] + "…"
    if t == "mcp_tool_call":
        return item.get("tool")
    if t == "web_search":
        return f"Search {item.get('query', '')}"
    return None


def compose_prompt(req: AgentRequest, terminal: ToolSpec | None) -> str:
    parts = [req.system_prompt, "", req.prompt] if not req.resume else [req.prompt]
    if terminal:
        parts += [
            "",
            f"When done, reply with only the JSON for `{terminal.name}` ({terminal.description}). It must match the "
            "output schema; the `get_hunk` tool isn't available here, so use the annotated hunks above and your "
            "shell to read files.",
        ]
    return "\n".join(parts)


def codex_runner(cfg: Config) -> Runner:
    exe = cfg.cli_path or "codex"

    async def run(req: AgentRequest) -> AsyncIterator[Event]:
        terminal = next((t for t in req.tools if t.terminal), None)
        schema_file = None
        if terminal:
            fd, schema_file = tempfile.mkstemp(suffix=".json", prefix="diffusion-schema-")
            with os.fdopen(fd, "w") as fh:
                json.dump(strict_schema(terminal.schema), fh)

        env = {**os.environ, **cfg.env}
        proc = await asyncio.create_subprocess_exec(
            exe, *build_args(cfg, req, schema_file),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=env, limit=16 * 1024 * 1024,
        )  # fmt: skip
        assert proc.stdin and proc.stdout and proc.stderr
        proc.stdin.write(compose_prompt(req, terminal).encode())
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
                        if not terminal:
                            yield TextEvent(last_text + "\n")
            code = await proc.wait()
            stderr = (await stderr_task).decode(errors="replace").strip()
            if code != 0 and not error:
                error = stderr.splitlines()[-1] if stderr else f"codex exited with {code}"
            if terminal and not error:
                try:
                    reply = await terminal.handler(drop_nulls(json.loads(_strip_fences(last_text))))
                    if not reply.startswith("received"):
                        error = f"{terminal.name}: {reply}"
                except ValueError as e:
                    error = f"final message was not valid JSON: {e}"
        finally:
            if proc.returncode is None:
                proc.kill()
            if schema_file:
                Path(schema_file).unlink(missing_ok=True)
        yield DoneEvent(max(turns, 1), None, error is not None, thread_id, error or last_text)

    return run


def _strip_fences(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else ""
        t = t.rsplit("```", 1)[0]
    return t
