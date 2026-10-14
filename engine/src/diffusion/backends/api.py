"""Backend: our own agent loop over a model API (Anthropic Messages or OpenAI-compatible).

The loop sends the conversation and tools, runs any tool calls (read-only repo tools confined to the
repository, plus the engine's custom tools), and repeats until the model stops calling tools, a terminal tool
(e.g. ``submit_guide``) is accepted, or ``max_turns`` is reached. Conversations are stored as JSON so a later
request can ``resume`` them (chat follow-ups, guide retries).
"""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

from ..agent import AgentRequest, DoneEvent, Event, Runner, TextEvent, ToolEvent, ToolSpec, summarize_tool
from ..config import Config
from .providers import Completion, Provider, TextDelta, Usage, make_provider
from .tools import repo_tools

ACCEPTED = ("received",)  # terminal tool replies that end the task


class SessionStore:
    def __init__(self, root: Path):
        self.root = root

    def load(self, sid: str) -> list[dict]:
        try:
            return json.loads((self.root / f"{sid}.json").read_text())["messages"]
        except (OSError, ValueError, KeyError):
            return []

    def save(self, sid: str, messages: list[dict]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.root / f"{sid}.json.tmp"
        tmp.write_text(json.dumps({"messages": messages, "updated_at": time.time()}, ensure_ascii=False))
        tmp.replace(self.root / f"{sid}.json")


def api_runner(cfg: Config, provider: Provider | None = None, sessions: SessionStore | None = None) -> Runner:
    prov = provider or make_provider(cfg)
    store = sessions or SessionStore(cfg.cache_dir / "sessions")

    async def run(req: AgentRequest) -> AsyncIterator[Event]:
        tools: list[ToolSpec] = repo_tools(req.cwd) + list(req.tools)
        by_name = {t.name: t for t in tools}
        sid = req.resume or uuid.uuid4().hex[:16]
        messages = (store.load(req.resume) if req.resume else []) + [{"role": "user", "content": req.prompt}]
        usage = Usage()
        turns = 0
        error: str | None = None
        final_text = ""

        try:
            while turns < req.max_turns:
                turns += 1
                done: Completion | None = None
                async for ev in prov.stream(req.system_prompt, messages, tools, req.model):
                    if isinstance(ev, TextDelta):
                        if req.include_partial:
                            yield TextEvent(ev.text)
                    else:
                        done = ev
                assert done is not None
                usage.add(done.usage)
                if done.text and not req.include_partial:
                    yield TextEvent(done.text)
                calls = [{"id": c.id, "name": c.name, "args": c.args} for c in done.tool_calls]
                messages.append({"role": "assistant", "content": done.text, "tool_calls": calls})
                final_text = done.text
                if not done.tool_calls:
                    break

                results, finished = [], False
                for c in done.tool_calls:
                    yield ToolEvent(c.name, summarize_tool(c.name, c.args))
                    spec = by_name.get(c.name)
                    if spec is None:
                        results.append(
                            {"id": c.id, "content": f"error: unknown tool {c.name!r}", "is_error": True}
                        )
                        continue
                    try:
                        out = await spec.handler(c.args)
                        results.append({"id": c.id, "content": out, "is_error": False})
                        finished |= spec.terminal and out.startswith(ACCEPTED)
                    except Exception as e:  # report to the model and let it recover
                        results.append({"id": c.id, "content": f"error: {e}", "is_error": True})
                messages.append({"role": "tool", "results": results})
                if finished:
                    break
            else:
                error = f"stopped after {req.max_turns} turns"
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
        finally:
            store.save(sid, messages)

        yield DoneEvent(turns, usage.cost_usd, error is not None, sid, error or final_text)

    return run
