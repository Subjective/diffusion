"""Backend: Codex, through its app server (``codex app-server``), using your Codex setup and login.

Codex explores the repository with its own shell tools inside its sandbox. Our custom tools (``get_hunk``,
``show_code``) don't cross the process boundary; the chat prompt carries the hunk table, and Codex reads the rest
with its shell. The app server, unlike ``codex exec``, takes messages into a running turn (Steer) and names the
skill a ``$skill`` prompt asks for.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from pathlib import Path

from ..agent import (
    AgentRequest,
    DoneEvent,
    Event,
    Runner,
    SteeredEvent,
    TextEvent,
    ThinkingEvent,
    ToolEvent,
    ToolFailedEvent,
    ran,
)
from .codex_app import AppServer, AppServerError, text_input

# A mode is a sandbox and whether to ask past it. Manual reads and asks before edits and commands that write; Accept
# edits writes in the workspace and asks before going past it; Auto writes in the workspace and never asks; Plan (and
# a chat that can't ask) only reads.
CODEX_SANDBOX = {"acceptEdits": "workspace-write", "auto": "workspace-write"}
ASKS = {"default", "acceptEdits"}
# The reviewer's answers in Codex's words.
CODEX_DECISION = {"allow": "accept", "always": "acceptForSession", "deny": "decline"}


def thread_params(req: AgentRequest) -> dict:
    """How the thread runs: in the repository, in the mode's sandbox, asking the reviewer where the mode does (and
    someone is there to answer), without web search."""
    p: dict = {
        "cwd": str(req.cwd),
        "sandbox": CODEX_SANDBOX.get(req.mode, "read-only"),
        "approvalPolicy": "on-request" if req.approve and req.mode in ASKS else "never",
        "config": {"web_search": "disabled"},
    }
    if req.model:
        p["model"] = req.model
    return p


def summarize_item(item: dict) -> str | None:
    t = item.get("type")
    if t == "commandExecution":
        return ran(item.get("command", ""))
    if t == "mcpToolCall":
        return item.get("tool")
    if t == "webSearch":
        return f"Search {item.get('query', '')}"
    if t == "fileChange":
        paths = [c.get("path", "") for c in item.get("changes") or []]
        return f"Edit {', '.join(Path(p).name for p in paths)}" if paths else "Edit"
    return None


def approval_ask(method: str, params: dict, items: dict[str, dict]) -> tuple[str, str, dict] | None:
    """A Codex approval request as the chat's ask: (tool, summary, input), shaped like Claude Code's so the same card
    shows it. ``items``: what the turn has started, by id (a file change's edits arrive with its item)."""
    item = items.get(str(params.get("itemId"))) or {}
    if method == "item/commandExecution/requestApproval":
        cmd = str(params.get("command") or item.get("command") or "")
        return (
            "Bash",
            ran(cmd),
            {"command": cmd, **({"reason": params["reason"]} if params.get("reason") else {})},
        )
    if method == "item/fileChange/requestApproval":
        changes = item.get("changes") or []
        path = str((changes[0] if changes else {}).get("path") or params.get("grantRoot") or "")
        diff = "\n".join(str(c.get("diff") or "") for c in changes)
        return "Edit", f"Edit {Path(path).name}" if path else "Edit", {"file_path": path, "diff": diff}
    return None


def user_text(item: dict) -> str:
    return "".join(c.get("text", "") for c in item.get("content") or [] if c.get("type") == "text")


def user_texts(turn: dict) -> set[str]:
    """What the person said in a finished turn, as far as its payload has it. A payload without its items counts
    everything as said (it can't show otherwise, and sending a message twice is worse than once)."""
    if (turn.get("itemsView") or "full") != "full":
        return _ALL
    return {user_text(i) for i in turn.get("items") or [] if i.get("type") == "userMessage"}


class _All(set):
    def __contains__(self, _: object) -> bool:
        return True


_ALL = _All()


def failed_item(item: dict) -> bool:
    return item.get("status") in ("failed", "declined") or (
        item.get("type") == "commandExecution" and item.get("exitCode") not in (None, 0)
    )


async def skill_inputs(srv: AppServer, req: AgentRequest, prompt: str) -> list[dict]:
    """The prompt as Codex input; one that opens with a ``$skill`` also names the skill, as Codex's own composer
    does, so the session loads it."""
    out = [text_input(prompt)]
    head = prompt.split(maxsplit=1)[0] if prompt.startswith("$") else ""
    if len(head) > 1:
        try:
            res = await srv.request("skills/list", {"cwds": [str(req.cwd)]})
        except AppServerError:
            return out
        for entry in res.get("data") or []:
            for sk in entry.get("skills") or []:
                if sk.get("name") == head[1:] and sk.get("path"):
                    return [*out, {"type": "skill", "name": sk["name"], "path": sk["path"]}]
    return out


def compose_prompt(req: AgentRequest) -> str:
    # A resumed session already has the system prompt; a forked one is someone else's session and doesn't.
    return f"{req.system_prompt}\n\n{req.prompt}" if not req.resume or req.fork or req.adopt else req.prompt


def codex_runner(cli_path: str | None = None) -> Runner:
    exe = cli_path or "codex"

    async def run(req: AgentRequest) -> AsyncIterator[Event]:
        thread_id, turns, error, last_text = req.resume, 0, None, ""

        async def on_request(method: str, params: dict) -> dict | None:
            ask = approval_ask(method, params, srv.items)
            if ask is None or not req.approve:
                return None
            return {"decision": CODEX_DECISION[await req.approve(*ask)]}

        async with AppServer(exe, req.cwd, on_request=on_request) as srv:
            try:
                params = thread_params(req)
                if req.resume and req.fork:
                    res = await srv.request("thread/fork", {"threadId": req.resume, **params})
                elif req.resume:
                    res = await srv.request("thread/resume", {"threadId": req.resume, **params})
                else:
                    res = await srv.request("thread/start", params)
                thread_id = (res.get("thread") or {}).get("id") or thread_id
                if req.resume_at and not req.fork:
                    # Editing an earlier message: drop that turn and every later one (the conversation only).
                    await srv.request("thread/revert", {"threadId": thread_id, "beforeTurnId": req.resume_at})
                turn = await srv.request(
                    "turn/start",
                    {"threadId": thread_id, "input": await skill_inputs(srv, req, compose_prompt(req))},
                )
            except AppServerError as e:
                yield DoneEvent(1, None, True, thread_id, str(e))
                return
            turn_id = first_turn = (turn.get("turn") or {}).get("id")
            steered: list[str] = []  # sent into the turn, not yet seen in it
            over = False

            async def take_steers(inbox: asyncio.Queue[tuple[str, asyncio.Future[bool]]]) -> None:
                while True:
                    text, accepted = await inbox.get()
                    ok = False
                    if not over:
                        steered.append(text)
                        try:
                            await srv.request(
                                "turn/steer",
                                {
                                    "threadId": thread_id,
                                    "expectedTurnId": turn_id,
                                    "input": [text_input(text)],
                                },
                            )
                            ok = True
                        except AppServerError:  # the turn ended first, unless it was taken in as the next one
                            ok = text not in steered
                            if not ok:
                                steered.remove(text)
                    if not accepted.done():
                        accepted.set_result(ok)

            pump = asyncio.create_task(take_steers(req.steer)) if req.steer else None
            ended = False  # the turn finished on its own (not stopped from here)
            try:
                while True:
                    note = await srv.notes.get()
                    method, p = note.get("method"), note.get("params") or {}
                    if method == "_exited":
                        error = error or p.get("message")
                        ended = True
                        break
                    if p.get("turnId") not in (None, turn_id):
                        continue
                    item = p.get("item") or {}
                    if method == "item/agentMessage/delta":
                        last_text += p.get("delta", "")
                        yield TextEvent(p.get("delta", ""))
                    elif method == "item/reasoning/summaryTextDelta":
                        yield ThinkingEvent(p.get("delta", ""))
                    elif method == "item/reasoning/summaryPartAdded":
                        yield ThinkingEvent("\n\n")
                    elif method == "item/started" and (s := summarize_item(item)):
                        yield ToolEvent(item.get("type", "tool"), s, item.get("id"))
                    elif method in ("item/started", "item/completed") and item.get("type") == "userMessage":
                        if (text := user_text(item)) in steered:
                            steered.remove(text)
                            yield SteeredEvent(text)
                    elif method == "item/completed" and item.get("type") == "agentMessage":
                        last_text = item.get("text") or last_text
                        yield TextEvent("\n\n")
                    elif method == "item/completed" and summarize_item(item) and failed_item(item):
                        yield ToolFailedEvent(item.get("id", ""))
                    elif method == "error" and not p.get("willRetry"):
                        error = (p.get("error") or {}).get("message") or "codex error"
                    elif method == "turn/completed":
                        t = p.get("turn") or {}
                        turns += 1
                        if t.get("status") == "failed":
                            error = error or (t.get("error") or {}).get("message") or "turn failed"
                        # A steered message the turn took in, though we didn't see it arrive.
                        for text in [x for x in steered if x in user_texts(t)]:
                            steered.remove(text)
                            yield SteeredEvent(text)
                        if error or not steered:
                            ended = True
                            break
                        # Steered as the turn ended, before it got to it: answer it as one more turn.
                        late, steered[:] = list(steered), []
                        try:
                            nxt = await srv.request(
                                "turn/start",
                                {"threadId": thread_id, "input": [text_input(x) for x in late]},
                            )
                        except AppServerError as e:
                            error, ended = str(e), True
                            break
                        turn_id = (nxt.get("turn") or {}).get("id")
                        # A turn of its own, so it can be edited (reverted to) like any other message.
                        for i, text in enumerate(late):
                            yield SteeredEvent(text, turn_id if i == 0 else None)
            finally:
                over = True
                if pump:
                    pump.cancel()
                    while req.steer and not req.steer.empty():
                        req.steer.get_nowait()[1].set_result(False)
                if not ended and thread_id and turn_id:
                    # Stopped (the run was closed early): end the turn in the session too, not just here.
                    with contextlib.suppress(Exception):
                        await asyncio.wait_for(
                            srv.request("turn/interrupt", {"threadId": thread_id, "turnId": turn_id}), 3
                        )
        yield DoneEvent(max(turns, 1), None, error is not None, thread_id, error or last_text, first_turn)

    return run
