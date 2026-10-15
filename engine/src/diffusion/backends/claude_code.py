"""Backend: Claude Agent SDK (drives the Claude Code CLI as a subprocess).

Uses whatever Claude Code is configured to use (Anthropic API key, Bedrock, Vertex, a gateway, or your
login), plus any profile ``env``. Read-only built-in tools (Read/Grep/Glob) are confined to the repository by a
PreToolUse hook; our custom tools are served in-process over the SDK's MCP bridge.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..agent import (
    AgentRequest,
    DoneEvent,
    Event,
    Runner,
    SandboxError,
    TextEvent,
    ToolEvent,
    ToolSpec,
    summarize_tool,
    within,
)
from ..config import Config

if TYPE_CHECKING:
    from claude_agent_sdk.types import HookContext, HookInput, HookJSONOutput

READ_TOOLS = ["Read", "Grep", "Glob"]
DENY_TOOLS = [
    "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit",
    "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite",
]  # fmt: skip
MCP_SERVER = "diffusion"
PATH_ARGS = ("file_path", "path")


def mcp_name(tool: str) -> str:
    return f"mcp__{MCP_SERVER}__{tool}"


def sandbox_decision(tool_name: str, tool_input: dict, root: Path) -> str | None:
    """Reason to deny a built-in tool call that reaches outside ``root``, or None to allow."""
    if tool_name not in READ_TOOLS:
        return None
    for key in PATH_ARGS:
        if tool_input.get(key):
            try:
                within(root, tool_input[key])
            except SandboxError as e:
                return str(e)
    if tool_name == "Glob" and str(tool_input.get("pattern", "")).startswith(("/", "~", "..")):
        return "glob patterns must be relative to the repository"
    return None


def claude_code_runner(cfg: Config) -> Runner:
    async def run(req: AgentRequest) -> AsyncIterator[Event]:
        from claude_agent_sdk import (
            AssistantMessage,
            ClaudeAgentOptions,
            ClaudeSDKClient,
            HookMatcher,
            ResultMessage,
            StreamEvent,
            TextBlock,
            ToolUseBlock,
            create_sdk_mcp_server,
            tool,
        )

        def wrap(spec: ToolSpec):
            async def handler(args: dict) -> dict:
                try:
                    return {"content": [{"type": "text", "text": await spec.handler(args)}]}
                except Exception as e:  # report to the model rather than crash the session
                    return {"content": [{"type": "text", "text": f"error: {e}"}], "is_error": True}

            return tool(spec.name, spec.description, spec.schema)(handler)

        async def guard(inp: HookInput, _tool_use_id: str | None, _ctx: HookContext) -> HookJSONOutput:
            tool_input: dict[str, Any] = inp.get("tool_input") or {}
            reason = sandbox_decision(inp.get("tool_name", ""), tool_input, req.cwd)
            if reason is None:
                return {}
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }

        mcp = {}
        if req.tools:
            mcp[MCP_SERVER] = create_sdk_mcp_server(MCP_SERVER, tools=[wrap(t) for t in req.tools])
        allowed = READ_TOOLS + [mcp_name(t.name) for t in req.tools]
        opts = ClaudeAgentOptions(
            model=req.model or None,
            system_prompt=req.system_prompt,
            cwd=str(req.cwd),
            tools=allowed,
            allowed_tools=allowed,
            disallowed_tools=DENY_TOOLS,
            permission_mode="dontAsk",
            setting_sources=[],  # don't pick up the user's hooks, CLAUDE.md, or permissions
            mcp_servers=mcp,
            hooks={"PreToolUse": [HookMatcher(matcher="Read|Grep|Glob", hooks=[guard])]},
            max_turns=req.max_turns,
            resume=req.resume,
            include_partial_messages=req.include_partial,
            env={"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", **cfg.env, "ENABLE_TOOL_SEARCH": "false"},
            cli_path=cfg.cli_path,
        )
        async with ClaudeSDKClient(options=opts) as client:
            await client.query(req.prompt)
            async for m in client.receive_response():
                if isinstance(m, StreamEvent):
                    ev = m.event
                    delta = ev.get("delta", {})
                    if ev.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                        yield TextEvent(delta["text"])
                elif isinstance(m, AssistantMessage):
                    for b in m.content:
                        if isinstance(b, ToolUseBlock):
                            yield ToolEvent(b.name, summarize_tool(b.name, b.input))
                        elif isinstance(b, TextBlock) and not req.include_partial:
                            yield TextEvent(b.text)
                elif isinstance(m, ResultMessage):
                    yield DoneEvent(m.num_turns, m.total_cost_usd, m.is_error, m.session_id, m.result)

    return run
