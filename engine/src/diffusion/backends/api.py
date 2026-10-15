"""Backend: a Pydantic AI agent over a model API (Anthropic, OpenAI, OpenRouter or any OpenAI-compatible server).

Pydantic AI runs the loop and speaks each provider's wire format. We add the read-only repository tools, the
engine's custom tools, Anthropic prompt caching, and the stop rule: the run ends when the model answers without
calling tools, a terminal tool (e.g. ``submit_guide``) is accepted, or ``max_turns`` requests have been made.
Conversations are stored as JSON so a later request can ``resume`` them (chat follow-ups, guide retries).
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import pydantic_ai
from pydantic_ai import (
    Agent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelResponse,
    PartDeltaEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    Tool,
    ToolFailed,
    ToolReturnPart,
    UsageLimitExceeded,
    UsageLimits,
)
from pydantic_ai.models import Model
from pydantic_ai.settings import ModelSettings

from ..agent import AgentRequest, DoneEvent, Event, Runner, TextEvent, ToolEvent, ToolSpec, summarize_tool
from ..config import Config
from .tools import repo_tools

pydantic_ai.BANNER_ENABLED = False  # our CLI owns its output

ACCEPTED = ("received",)  # terminal tool replies that end the task
MAX_TOKENS = 16000


class SessionStore:
    def __init__(self, root: Path):
        self.root = root

    def load(self, sid: str) -> list[ModelMessage]:
        try:
            return ModelMessagesTypeAdapter.validate_json((self.root / f"{sid}.json").read_bytes())
        except (OSError, ValueError):
            return []

    def save(self, sid: str, messages: list[ModelMessage]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.root / f"{sid}.json.tmp"
        tmp.write_bytes(ModelMessagesTypeAdapter.dump_json(messages))
        tmp.replace(self.root / f"{sid}.json")


def make_model(cfg: Config, name: str, http_client: Any = None) -> tuple[Model, ModelSettings]:
    """The Pydantic AI model for a profile, and the settings every request uses."""
    if cfg.protocol == "anthropic":
        from anthropic import AsyncAnthropic
        from pydantic_ai.models.anthropic import AnthropicModel, AnthropicModelSettings
        from pydantic_ai.providers.anthropic import AnthropicProvider

        kw: dict[str, Any] = {"base_url": cfg.base_url, "default_headers": cfg.headers or None}
        kw["auth_token" if cfg.auth == "bearer" else "api_key"] = cfg.api_key
        client = AsyncAnthropic(**kw, max_retries=3, http_client=http_client)
        # Cache the system prompt, the tools, and the conversation so far. Explicit breakpoints rather than
        # automatic caching, which some Anthropic-compatible gateways don't support.
        settings = AnthropicModelSettings(
            max_tokens=MAX_TOKENS,
            anthropic_cache_instructions=True,
            anthropic_cache_tool_definitions=True,
            anthropic_cache_messages=True,
        )
        return AnthropicModel(name, provider=AnthropicProvider(anthropic_client=client)), settings

    from openai import AsyncOpenAI

    client = AsyncOpenAI(
        base_url=cfg.base_url,
        api_key=cfg.api_key or "none",
        default_headers=cfg.headers or None,
        max_retries=3,
        http_client=http_client,
    )
    settings = ModelSettings(max_tokens=MAX_TOKENS)
    if urlparse(cfg.base_url or "").hostname == "openrouter.ai":
        from pydantic_ai.models.openrouter import OpenRouterModel
        from pydantic_ai.providers.openrouter import OpenRouterProvider

        return OpenRouterModel(name, provider=OpenRouterProvider(openai_client=client)), settings

    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    return OpenAIChatModel(name, provider=OpenAIProvider(openai_client=client)), settings


def _tool(spec: ToolSpec) -> Tool:
    async def call(**args: Any) -> str:
        try:
            return await spec.handler(args)
        except Exception as e:  # report to the model and let it recover
            raise ToolFailed(f"error: {e}") from e

    return Tool.from_schema(call, spec.name, spec.description, spec.schema)


def _cost(responses: list[ModelResponse]) -> float | None:
    """OpenRouter reports the exact cost; otherwise price the usage with genai-prices when the model is known."""
    total = None
    for r in responses:
        cost = (r.provider_details or {}).get("cost")
        if not isinstance(cost, int | float):
            try:
                cost = float(r.cost().total_price)
            except Exception:  # unknown model or gateway
                continue
        total = (total or 0.0) + cost
    return total


def api_runner(
    cfg: Config, model: Model | None = None, sessions: SessionStore | None = None, http_client: Any = None
) -> Runner:
    store = sessions or SessionStore(cfg.cache_dir / "sessions")

    async def run(req: AgentRequest) -> AsyncIterator[Event]:
        specs: list[ToolSpec] = repo_tools(req.cwd) + list(req.tools)
        terminal = {t.name for t in specs if t.terminal}
        llm, settings = (model, None) if model else make_model(cfg, req.model, http_client)
        agent = Agent(llm, instructions=req.system_prompt, tools=[_tool(t) for t in specs], retries=3)
        sid = req.resume or uuid.uuid4().hex[:16]
        history = store.load(req.resume) if req.resume else []
        messages = list(history)
        turns = 0
        error: str | None = None
        final_text = ""

        try:
            async with agent.iter(
                req.prompt,
                message_history=history,
                model_settings=settings,
                usage_limits=UsageLimits(request_limit=req.max_turns),
            ) as agent_run:
                finished = False
                async for node in agent_run:
                    if finished:  # a terminal tool was accepted: keep its results so the session can resume
                        if Agent.is_model_request_node(node):
                            messages = [*messages, node.request]
                        break
                    if Agent.is_model_request_node(node):
                        async with node.stream(agent_run.ctx) as stream:
                            async for ev in stream:
                                if not req.include_partial:
                                    continue
                                if isinstance(ev, PartStartEvent) and isinstance(ev.part, TextPart):
                                    text = ev.part.content
                                elif isinstance(ev, PartDeltaEvent) and isinstance(ev.delta, TextPartDelta):
                                    text = ev.delta.content_delta
                                else:
                                    continue
                                if text:
                                    yield TextEvent(text)
                        turns += 1
                        response = stream.response
                        final_text = "".join(p.content for p in response.parts if isinstance(p, TextPart))
                        if final_text and not req.include_partial:
                            yield TextEvent(final_text)
                    elif Agent.is_call_tools_node(node):
                        async with node.stream(agent_run.ctx) as stream:
                            async for ev in stream:
                                if isinstance(ev, FunctionToolCallEvent):
                                    yield ToolEvent(
                                        ev.part.tool_name,
                                        summarize_tool(ev.part.tool_name, ev.part.args_as_dict()),
                                    )
                                elif isinstance(ev, FunctionToolResultEvent):
                                    r = ev.part
                                    finished |= (
                                        isinstance(r, ToolReturnPart)
                                        and r.outcome == "success"
                                        and r.tool_name in terminal
                                        and str(r.content).startswith(ACCEPTED)
                                    )
                    messages = agent_run.all_messages()
        except UsageLimitExceeded:
            error = f"stopped after {req.max_turns} turns"
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
        finally:
            store.save(sid, messages)

        new = [m for m in messages[len(history) :] if isinstance(m, ModelResponse)]
        yield DoneEvent(turns, _cost(new), error is not None, sid, error or final_text)

    return run
