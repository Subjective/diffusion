"""Backend: Claude Agent SDK (drives the Claude Code CLI as a subprocess).

Uses whatever Claude Code is configured to use (Anthropic API key, Bedrock, Vertex, a gateway, or your
login). Read-only built-in tools (Read/Grep/Glob) are confined to the repository by a
PreToolUse hook; our custom tools are served in-process over the SDK's MCP bridge.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..agent import (
    AgentRequest,
    DoneEvent,
    Event,
    Runner,
    SandboxError,
    SteeredEvent,
    TextEvent,
    ThinkingEvent,
    ToolEvent,
    ToolFailedEvent,
    ToolSpec,
    summarize_tool,
    within,
)

if TYPE_CHECKING:
    from claude_agent_sdk.types import HookContext, HookInput, HookJSONOutput

READ_TOOLS = ["Read", "Grep", "Glob"]
DENY_TOOLS = [
    "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit",
    "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite",
]  # fmt: skip
EDIT_TOOLS = ("Edit", "MultiEdit", "Write", "NotebookEdit")
MCP_SERVER = "diffusion"
PATH_ARGS = ("file_path", "path")


def mcp_name(tool: str) -> str:
    return f"mcp__{MCP_SERVER}__{tool}"


def tool_names_note(tools: list[ToolSpec]) -> str:
    """Prompts name engine tools plainly (`show_code`); here they're namespaced, and models sometimes call the
    plain name, fail, and give up. Spell out the mapping."""
    if not tools:
        return ""
    names = ", ".join(f"`{t.name}` is `{mcp_name(t.name)}`" for t in tools)
    return f"\n\nTool names: {names}."


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


def user_text(content: Any) -> str | None:
    """A user message's text, as it was sent (a string, or text blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [getattr(b, "text", None) for b in content]
        if parts and all(isinstance(p, str) for p in parts):
            return "".join(parts)  # type: ignore[arg-type]
    return None


def claude_code_runner(cli_path: str | None = None) -> Runner:
    async def run(req: AgentRequest) -> AsyncIterator[Event]:
        from claude_agent_sdk import (
            AssistantMessage,
            ClaudeAgentOptions,
            ClaudeSDKClient,
            HookMatcher,
            PermissionResultAllow,
            PermissionResultDeny,
            ResultMessage,
            StreamEvent,
            TextBlock,
            ThinkingBlock,
            ToolResultBlock,
            ToolUseBlock,
            UserMessage,
            create_sdk_mcp_server,
            tool,
        )
        from claude_agent_sdk.types import PermissionRuleValue, PermissionUpdate

        def always(name: str, tool_input: dict) -> PermissionUpdate:
            """'Allow for this session': edits switch the session to accepting edits, as the terminal's option
            does; anything else allows that exact call (a command, say) from now on."""
            if name in EDIT_TOOLS:
                return PermissionUpdate(type="setMode", mode="acceptEdits", destination="session")
            rule = str(tool_input.get("command") or "") if name == "Bash" else None
            return PermissionUpdate(
                type="addRules",
                rules=[PermissionRuleValue(tool_name=name, rule_content=rule or None)],
                behavior="allow",
                destination="session",
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
        common: dict[str, Any] = dict(
            model=req.model or None,
            cwd=str(req.cwd),
            mcp_servers=mcp,
            max_turns=req.max_turns,
            resume=req.resume,
            fork_session=req.fork,
            resume_session_at=req.resume_at,
            thinking={"type": "adaptive", "display": "summarized"},  # the model decides; we get readable text
            include_partial_messages=req.include_partial,
            cli_path=cli_path,
            # Echo the user messages the session takes in, so we see when a steered one reaches the model.
            extra_args={"replay-user-messages": None},
        )
        if req.native:
            # The session as it runs in the terminal: Claude Code's own prompt, tools, settings, CLAUDE.md and
            # permission rules. What those don't already allow is put to the reviewer.
            async def can_use(name: str, tool_input: dict, _ctx: Any):
                said = (
                    await req.approve(name, summarize_tool(name, tool_input), tool_input)
                    if req.approve
                    else "deny"
                )
                if said == "deny":
                    return PermissionResultDeny(message="The reviewer declined this.")
                if name == "ExitPlanMode":
                    # Approving the plan leaves plan mode, as in the terminal: to asking before edits, or (approve
                    # and auto-accept) to accepting them.
                    mode = "acceptEdits" if said == "always" else "default"
                    return PermissionResultAllow(
                        updated_permissions=[
                            PermissionUpdate(type="setMode", mode=mode, destination="session")
                        ]
                    )
                if said == "always":
                    return PermissionResultAllow(updated_permissions=[always(name, tool_input)])
                return PermissionResultAllow()

            opts = ClaudeAgentOptions(
                **common,
                system_prompt={
                    "type": "preset",
                    "preset": "claude_code",
                    "append": req.system_prompt + tool_names_note(req.tools),
                    "snapshot": False,  # carry the chat's instructions on resume, not just the first request
                },
                allowed_tools=[mcp_name(t.name) for t in req.tools],
                permission_mode="default" if req.mode == "read-only" else req.mode,
                can_use_tool=can_use,
                setting_sources=["user", "project", "local"],
                enable_file_checkpointing=True,  # so an edited message can put the code back too
            )
        else:
            opts = ClaudeAgentOptions(
                **common,
                system_prompt=req.system_prompt + tool_names_note(req.tools),
                tools=allowed,
                allowed_tools=allowed,
                disallowed_tools=DENY_TOOLS,
                permission_mode="dontAsk",
                setting_sources=[],  # don't pick up the user's hooks, CLAUDE.md, or permissions
                hooks={"PreToolUse": [HookMatcher(matcher="Read|Grep|Glob", hooks=[guard])]},
                env={"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "ENABLE_TOOL_SEARCH": "false"},
            )
        async with ClaudeSDKClient(options=opts) as client:
            if req.restore_files:
                try:
                    await client.rewind_files(req.restore_files)
                except Exception as e:
                    raise RuntimeError(f"Couldn't put the code back: {e}") from e
            await client.query(req.prompt)
            prompt_id: str | None = None
            # Steering: a message sent mid-turn goes into the running session, which takes it in at its next step
            # (as the terminal does). If the turn ends first, the session runs it as one more turn, which we wait
            # for too, so the run ends only once every steered message has been answered.
            steered: list[str] = []  # sent on, not yet taken in
            over = False

            async def take_steers(inbox: asyncio.Queue[tuple[str, asyncio.Future[bool]]]) -> None:
                while True:
                    text, accepted = await inbox.get()
                    if over:
                        accepted.set_result(False)
                        continue
                    steered.append(text)
                    await client.query(text)
                    if not accepted.done():
                        accepted.set_result(True)

            pump = asyncio.create_task(take_steers(req.steer)) if req.steer else None
            turns, last = 0, None
            try:
                async for m in client.receive_messages():
                    if isinstance(m, StreamEvent):
                        ev = m.event
                        delta = ev.get("delta", {})
                        if ev.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                            yield TextEvent(delta["text"])
                        elif (
                            ev.get("type") == "content_block_delta" and delta.get("type") == "thinking_delta"
                        ):
                            yield ThinkingEvent(delta["thinking"])
                    elif isinstance(m, AssistantMessage):
                        for b in m.content:
                            if isinstance(b, ToolUseBlock):
                                yield ToolEvent(b.name, summarize_tool(b.name, b.input), b.id)
                            elif isinstance(b, TextBlock) and not req.include_partial:
                                yield TextEvent(b.text)
                            elif isinstance(b, ThinkingBlock) and b.thinking and not req.include_partial:
                                yield ThinkingEvent(b.thinking + "\n")
                    elif isinstance(m, UserMessage):
                        if isinstance(m.content, list):
                            for b in m.content:
                                if isinstance(b, ToolResultBlock) and b.is_error:
                                    yield ToolFailedEvent(b.tool_use_id)
                        text = user_text(m.content)
                        if text in steered:
                            steered.remove(text)
                            yield SteeredEvent(text)
                        elif text == req.prompt and prompt_id is None:
                            prompt_id = m.uuid
                    elif isinstance(m, ResultMessage):
                        turns += m.num_turns
                        last = m
                        if m.is_error or not steered:
                            over = True
                            break
            finally:
                over = True
                if pump:
                    pump.cancel()
                    while req.steer and not req.steer.empty():
                        req.steer.get_nowait()[1].set_result(False)
            if last:
                yield DoneEvent(
                    turns,
                    last.total_cost_usd,
                    last.is_error,
                    last.session_id,
                    last.result,
                    prompt_id=prompt_id,
                )

    return run
