"""Model API adapters for the ``api`` backend.

Both adapters speak one neutral message format and stream back text deltas plus the final assistant message:

    {"role": "user", "content": "..."}
    {"role": "assistant", "content": "...", "tool_calls": [{"id", "name", "args"}]}
    {"role": "tool", "results": [{"id", "content", "is_error"}]}
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol, cast

from ..agent import ToolSpec
from ..config import Config

if TYPE_CHECKING:
    from anthropic.types import MessageParam, ToolUnionParam


@dataclass
class ToolCall:
    id: str
    name: str
    args: dict


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost_usd: float | None = None

    def add(self, o: Usage) -> None:
        self.input_tokens += o.input_tokens
        self.output_tokens += o.output_tokens
        self.cache_read_tokens += o.cache_read_tokens
        self.cache_write_tokens += o.cache_write_tokens
        if o.cost_usd is not None:
            self.cost_usd = (self.cost_usd or 0.0) + o.cost_usd


@dataclass
class TextDelta:
    text: str


@dataclass
class Completion:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)
    stop: str = ""


class Provider(Protocol):
    def stream(
        self, system: str, messages: list[dict], tools: list[ToolSpec], model: str
    ) -> AsyncIterator[TextDelta | Completion]: ...


def _parse_args(raw: str | dict | None) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        v = json.loads(raw or "{}")
        return v if isinstance(v, dict) else {"value": v}
    except ValueError:
        return {"_raw": raw}


# ---------- Anthropic Messages API ----------


class AnthropicProvider:
    def __init__(self, cfg: Config, max_tokens: int = 16000):
        import anthropic

        kw: dict[str, Any] = {
            "base_url": cfg.base_url,
            "default_headers": cfg.headers or None,
            "max_retries": 3,
        }
        kw["auth_token" if cfg.auth == "bearer" else "api_key"] = cfg.api_key
        self.client = anthropic.AsyncAnthropic(**kw)
        self.max_tokens = max_tokens

    @staticmethod
    def to_wire(messages: list[dict]) -> list[dict]:
        out: list[dict] = []
        for m in messages:
            if m["role"] == "user":
                out.append({"role": "user", "content": [{"type": "text", "text": m["content"]}]})
            elif m["role"] == "assistant":
                blocks: list[dict] = [{"type": "text", "text": m["content"]}] if m.get("content") else []
                blocks += [
                    {"type": "tool_use", "id": c["id"], "name": c["name"], "input": c["args"]}
                    for c in m.get("tool_calls", [])
                ]
                out.append({"role": "assistant", "content": blocks or [{"type": "text", "text": "…"}]})
            else:
                out.append({"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": r["id"], "content": r["content"], "is_error": r.get("is_error", False)}
                    for r in m["results"]
                ]})  # fmt: skip
        # The API wants alternating roles: merge consecutive same-role messages (e.g. a resumed chat that
        # stopped after tool results, followed by a new user message).
        merged: list[dict] = []
        for m in out:
            if merged and merged[-1]["role"] == m["role"]:
                merged[-1] = {"role": m["role"], "content": merged[-1]["content"] + m["content"]}
            else:
                merged.append(m)
        out = merged
        # Cache the conversation prefix: mark the last block of the final message.
        if out and out[-1]["content"]:
            out[-1]["content"][-1] = {**out[-1]["content"][-1], "cache_control": {"type": "ephemeral"}}
        return out

    async def stream(self, system, messages, tools, model):
        from anthropic import omit

        wire_tools = [{"name": t.name, "description": t.description, "input_schema": t.schema} for t in tools]
        if wire_tools:
            wire_tools[-1] = {**wire_tools[-1], "cache_control": {"type": "ephemeral"}}
        async with self.client.messages.stream(
            model=model,
            max_tokens=self.max_tokens,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            # to_wire builds plain dicts (simple to test and merge); they match the SDK's TypedDict params,
            # whose 15-member block unions would make the builder far noisier to annotate.
            messages=cast("list[MessageParam]", self.to_wire(messages)),
            tools=cast("list[ToolUnionParam]", wire_tools) if wire_tools else omit,
        ) as s:
            async for ev in s:
                if ev.type == "content_block_delta" and ev.delta.type == "text_delta":
                    yield TextDelta(ev.delta.text)
            msg = await s.get_final_message()
        text = "".join(b.text for b in msg.content if b.type == "text")
        calls = [ToolCall(b.id, b.name, dict(b.input or {})) for b in msg.content if b.type == "tool_use"]
        u = msg.usage
        yield Completion(
            text,
            calls,
            Usage(
                u.input_tokens or 0,
                u.output_tokens or 0,
                getattr(u, "cache_read_input_tokens", 0) or 0,
                getattr(u, "cache_creation_input_tokens", 0) or 0,
            ),
            msg.stop_reason or "",
        )


# ---------- OpenAI-compatible Chat Completions ----------


class OpenAIProvider:
    """OpenAI, OpenRouter, Gemini (OpenAI endpoint), Ollama, vLLM, LiteLLM and other compatible gateways."""

    def __init__(self, cfg: Config, max_tokens: int = 16000):
        import openai

        self.client = openai.AsyncOpenAI(
            base_url=cfg.base_url,
            api_key=cfg.api_key or "none",
            default_headers=cfg.headers or None,
            max_retries=3,
        )
        self.max_tokens = max_tokens

    @staticmethod
    def to_wire(system: str, messages: list[dict]) -> list[dict]:
        out: list[dict] = [{"role": "system", "content": system}]
        for m in messages:
            if m["role"] == "user":
                out.append({"role": "user", "content": m["content"]})
            elif m["role"] == "assistant":
                msg: dict[str, Any] = {"role": "assistant", "content": m.get("content") or None}
                if m.get("tool_calls"):
                    msg["tool_calls"] = [
                        {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c["args"])}}
                        for c in m["tool_calls"]
                    ]  # fmt: skip
                out.append(msg)
            else:
                out += [
                    {"role": "tool", "tool_call_id": r["id"], "content": r["content"]} for r in m["results"]
                ]
        return out

    async def stream(self, system, messages, tools, model):
        wire_tools = [
            {
                "type": "function",
                "function": {"name": t.name, "description": t.description, "parameters": t.schema},
            }
            for t in tools
        ]
        kw: dict[str, Any] = {"model": model, "messages": self.to_wire(system, messages), "stream": True}
        kw["stream_options"] = {"include_usage": True}
        kw["max_completion_tokens"] = self.max_tokens
        if wire_tools:
            kw["tools"] = wire_tools
        try:
            stream = await self.client.chat.completions.create(**kw)
        except Exception as e:  # some servers reject max_completion_tokens / stream_options
            if "max_completion_tokens" not in str(e) and "stream_options" not in str(e):
                raise
            kw.pop("stream_options", None)
            kw["max_tokens"] = kw.pop("max_completion_tokens")
            stream = await self.client.chat.completions.create(**kw)

        text: list[str] = []
        calls: dict[int, dict] = {}
        usage = Usage()
        stop = ""
        async for chunk in stream:
            if getattr(chunk, "usage", None):
                u = chunk.usage
                details = getattr(u, "prompt_tokens_details", None)
                cached = getattr(details, "cached_tokens", 0) or 0
                usage = Usage(u.prompt_tokens or 0, u.completion_tokens or 0, cached)
                cost = getattr(u, "cost", None)  # OpenRouter reports cost in usage
                usage.cost_usd = float(cost) if isinstance(cost, int | float) else None
            for choice in chunk.choices or []:
                d = choice.delta
                if getattr(d, "content", None):
                    text.append(d.content)
                    yield TextDelta(d.content)
                for tc in getattr(d, "tool_calls", None) or []:
                    slot = calls.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                    slot["id"] = tc.id or slot["id"]
                    if tc.function:
                        slot["name"] += tc.function.name or ""
                        slot["args"] += tc.function.arguments or ""
                stop = choice.finish_reason or stop
        tool_calls = [
            ToolCall(c["id"] or f"call_{i}", c["name"], _parse_args(c["args"]))
            for i, c in sorted(calls.items())
        ]
        yield Completion("".join(text), tool_calls, usage, stop)


def make_provider(cfg: Config) -> Provider:
    return AnthropicProvider(cfg) if cfg.protocol == "anthropic" else OpenAIProvider(cfg)
