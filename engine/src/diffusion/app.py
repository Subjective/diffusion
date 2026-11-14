"""HTTP API (localhost only). Guides arrive from ``diffusion submit`` (or a chat answer) as versions in the store;
chat answers stream over SSE."""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__
from .agent import Decision, DoneEvent, Mode, Runner, ThinkingEvent, ToolEvent, ToolFailedEvent, make_runner
from .chat_agent import SHOW_REMINDER, ChatDelta, ChatFocus, ChatSteered, GuideBlock, Question, run_turn
from .commands import session_commands
from .config import FORKABLE, Config, installed_harness, load_config
from .github import GitHubError
from .pipeline import Prepared, prepare, target_ref
from .repo import RepoError
from .store import Store
from .symbols import NAME, SymbolIndex
from .transcripts import find_transcript, merge, rewind_point, session_turns
from .validate import DraftError, check

PrepareFn = Callable[[Config, str], Prepared]
RunnerFor = Callable[[str], Runner]
MAX_FILE_CHARS = 2_000_000


@dataclass
class Deps:
    cfg: Config
    runner_for: RunnerFor  # agent name → its runner
    prepare: PrepareFn
    store: Store


def default_deps(cfg: Config) -> Deps:
    runners: dict[str, Runner] = {}

    def runner_for(harness: str) -> Runner:
        if harness not in runners:
            runners[harness] = make_runner(harness, cfg.cli_path(harness))
        return runners[harness]

    return Deps(cfg, runner_for, prepare, Store(cfg.cache_dir))


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def sse_response(events: AsyncIterator[tuple[str, dict]]) -> StreamingResponse:
    async def body():
        async for ev, data in events:
            yield sse(ev, data)

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class ChatCreate(BaseModel):
    url: str
    # "fork": a read-only branch of the session that wrote the guide. "guide": that session itself, continued.
    kind: Literal["fork", "guide"] = "fork"


GUIDE_CHAT = "guide"  # the id of a target's one guide-session chat


class Rewind(BaseModel):
    uuid: str  # the session's id for the message being edited
    code: bool = False  # also put the files back as they were before it


class TurnReq(BaseModel):
    url: str
    questions: list[Question]
    version: int | None = None  # the guide version on screen
    # The guide chat can run as the session itself (see agent.Mode); forks are always read-only.
    mode: Mode = "read-only"
    # Editing an earlier message: the turn replaces it, and everything after it, in the session.
    rewind: Rewind | None = None


class SteerReq(BaseModel):
    questions: list[Question]


# Harnesses whose running turn takes a message in mid-turn (the rest stop, then send).
STEERABLE = {"claude-code", "codex"}


class Approval(BaseModel):
    id: str
    decision: Decision


class ApprovalAsked:
    """A tool call waiting on the reviewer, surfaced into a turn's event stream."""

    def __init__(self, id: str, tool: str, summary: str, input: dict):
        self.payload = {"id": id, "tool": tool, "summary": summary, "input": _clip(input)}


def _clip(v, n: int = 4000):
    if isinstance(v, str):
        return v if len(v) <= n else v[:n] + "…"
    if isinstance(v, dict):
        return {k: _clip(x, n) for k, x in v.items()}
    if isinstance(v, list):
        return [_clip(x, n) for x in v[:50]]
    return v


async def merged(events: AsyncIterator, side: asyncio.Queue) -> AsyncGenerator:
    """A turn's events, with anything put on ``side`` (approval requests) interleaved as it arrives."""
    it = aiter(events)
    nxt = asyncio.ensure_future(anext(it))
    got = asyncio.ensure_future(side.get())
    try:
        while True:
            done, _ = await asyncio.wait({nxt, got}, return_when=asyncio.FIRST_COMPLETED)
            if got in done:
                yield got.result()
                got = asyncio.ensure_future(side.get())
            if nxt in done:
                try:
                    ev = nxt.result()
                except StopAsyncIteration:
                    return
                yield ev
                nxt = asyncio.ensure_future(anext(it))
    finally:
        for f in (nxt, got):
            f.cancel()
        # Stopped early: close the agent too (its CLI ends with it), rather than leave it to the garbage collector.
        if close := getattr(it, "aclose", None):
            await asyncio.gather(nxt, return_exceptions=True)
            await close()


class Stop:
    """Put on a running turn's side queue: the reviewer stopped it."""


def chat_summary(c: dict) -> dict:
    qs = [q for t in c.get("turns", []) for q in t["questions"]]
    return {
        "id": c["id"],
        "title": qs[0]["text"][:80] if qs else "",
        "questions": len(qs),
        "anchored": sum(1 for q in qs if q.get("anchor")),
        "created_at": c["created_at"],
        "updated_at": c["updated_at"],
        "head_sha": c.get("head_sha"),
        "kind": c.get("kind", "fork"),
        "harness": c.get("harness"),
    }


def create_app(deps: Deps | None = None) -> FastAPI:
    app = FastAPI(title="diffusion")
    _deps: list[Deps] = [deps] if deps else []

    def d() -> Deps:
        if not _deps:
            _deps.append(default_deps(load_config()))
        return _deps[0]

    _prepared: dict[str, Prepared] = {}
    _latest_seen: dict[str, str | None] = {}
    chat_locks: dict[str, asyncio.Lock] = {}
    approvals: dict[str, asyncio.Future[Decision]] = {}  # tool calls waiting on the reviewer, by id
    app.state.approvals = approvals
    running: dict[str, asyncio.Queue] = {}  # a running turn's side queue, by chat: Stop goes there
    steering: dict[str, asyncio.Queue] = {}  # a running turn's inbox for messages sent into it, by chat
    symbols: dict[Path, SymbolIndex] = {}
    trees: dict[tuple[Path, str], frozenset[str]] = {}
    symbol_locks: dict[Path, asyncio.Lock] = {}

    async def get_prepared(url: str, refresh: bool = False) -> Prepared:
        try:
            key = target_ref(url).key
        except GitHubError as e:
            raise HTTPException(400, str(e)) from e
        # A guide arrived for a new head (a new push, or a new snapshot of uncommitted work). Refresh once per
        # change: after a push with no new guide yet, the latest guide stays on the old head.
        latest = d().store.latest_head(key)
        if latest != _latest_seen.get(key):
            _latest_seen[key] = latest
            if latest and key in _prepared and _prepared[key].meta.head_sha != latest:
                refresh = True
        if refresh or key not in _prepared:
            try:
                _prepared[key] = await asyncio.to_thread(d().prepare, d().cfg, url)
            except (GitHubError, RepoError) as e:
                raise HTTPException(502, str(e)) from e
            except FileNotFoundError as e:
                raise HTTPException(400, str(e)) from e
        return _prepared[key]

    @app.get("/api/health")
    async def health() -> dict:
        return {"ok": True, "app": "diffusion", "version": __version__, "ui": dist is not None}

    @app.get("/api/targets")
    async def targets() -> list[dict]:
        """Everything reviewed so far, for the home page."""
        return d().store.list_targets()

    def versions(prep: Prepared) -> list[dict]:
        return d().store.list_guides(prep.meta.ref.key, prep.meta.head_sha)

    @app.get("/api/pr")
    async def pr(url: str, v: int | None = None) -> dict:
        prep = await get_prepared(url, refresh=True)
        guide = d().store.load_guide(prep.meta.ref.key, prep.meta.head_sha, v)
        return {**prep.to_dict(), "guide": guide, "versions": versions(prep)}

    @app.get("/api/guides")
    async def guides(url: str) -> dict:
        """The versions there are for the target's current head, cheap enough to poll for new ones."""
        prep = await get_prepared(url)
        return {"head_sha": prep.meta.head_sha, "versions": versions(prep)}

    @app.get("/api/guide")
    async def guide(url: str, v: int) -> dict:
        prep = await get_prepared(url)
        g = d().store.load_guide(prep.meta.ref.key, prep.meta.head_sha, v)
        if g is None:
            raise HTTPException(404, f"no version {v}")
        return g

    async def tracked(prep: Prepared) -> frozenset[str]:
        key = (prep.checkout.worktree, prep.meta.head_sha)
        if key not in trees:
            trees[key] = frozenset(await asyncio.to_thread(prep.checkout.files_at_head))
        return trees[key]

    @app.get("/api/tree")
    async def tree(url: str) -> dict:
        """Every file at the PR head, for the file navigator's all-files view."""
        prep = await get_prepared(url)
        return {"files": sorted(await tracked(prep))}

    @app.get("/api/file")
    async def file(url: str, path: str) -> dict:
        """A file at the PR head: a changed one, to show lines around its hunks, or any other, to open in a tab."""
        prep = await get_prepared(url)
        if path not in {f.path for f in prep.index.files} and path not in await tracked(prep):
            raise HTTPException(404, f"{path} isn't in this repository")
        try:
            text = await asyncio.to_thread(prep.checkout.file_at_head, path)
        except UnicodeDecodeError as e:
            raise HTTPException(415, f"{path} isn't text") from e
        if text is None:
            raise HTTPException(404, f"{path} doesn't exist at the head commit")
        if len(text) > MAX_FILE_CHARS:
            raise HTTPException(413, f"{path} is too large to show in full")
        return {"path": path, "text": text}

    async def symbol_index(url: str) -> SymbolIndex:
        root = (await get_prepared(url)).checkout.worktree
        async with symbol_locks.setdefault(root, asyncio.Lock()):
            if root not in symbols:
                symbols[root] = await asyncio.to_thread(SymbolIndex, root)
        return symbols[root]

    @app.get("/api/definition")
    async def definition(url: str, symbol: str, path: str) -> dict:
        """Where `symbol` is defined at the PR head, nearest to `path` first, with each definition's source."""
        if not NAME.match(symbol):
            raise HTTPException(400, "Not a name")
        index = await symbol_index(url)
        found = index.lookup(symbol, path)
        return {
            "symbol": symbol,
            "matches": [
                {"path": m.path, "line": m.line, "end": m.end, "text": index.snippet(m)} for m in found
            ],
        }

    @app.get("/api/references")
    async def references(url: str, symbol: str, path: str) -> dict:
        """Lines at the PR head that use `symbol`, nearest to `path` first."""
        if not NAME.match(symbol):
            raise HTTPException(400, "Not a name")
        index = await symbol_index(url)
        found = await asyncio.to_thread(index.references, symbol, path)
        return {"symbol": symbol, "matches": [asdict(r) for r in found]}

    @app.get("/api/around")
    async def around(url: str, path: str, line: int, end: int = 0) -> dict:
        """A definition or reference in its file, with a few lines either side, for the peek's preview."""
        index = await symbol_index(url)
        try:
            first, text = await asyncio.to_thread(index.around, path, line, max(end, line), 6)
        except (KeyError, OSError) as e:
            raise HTTPException(404, f"{path} isn't indexed") from e
        return {"path": path, "first": first, "text": text}

    # ---------- chats ----------

    def pr_key(url: str) -> str:
        try:
            return target_ref(url).key
        except GitHubError as e:
            raise HTTPException(400, str(e)) from e

    @app.get("/api/chats")
    async def list_chats(url: str) -> list[dict]:
        return [chat_summary(c) for c in d().store.list_chats(pr_key(url)) if c.get("turns")]

    def new_chat(key: str, kind: str) -> dict:
        if kind == "guide" and (found := d().store.load_chat(key, GUIDE_CHAT)):
            return found
        now = time.time()
        chat = {
            "id": GUIDE_CHAT if kind == "guide" else uuid.uuid4().hex[:12],
            "kind": kind,
            "created_at": now,
            "updated_at": now,
            "session_id": None,
            "turns": [],
        }
        d().store.save_chat(key, chat)
        return chat

    @app.post("/api/chats")
    async def create_chat(req: ChatCreate) -> dict:
        return new_chat(pr_key(req.url), req.kind)

    @app.get("/api/chats/{chat_id}")
    async def get_chat(chat_id: str, url: str) -> dict:
        key = pr_key(url)
        chat = d().store.load_chat(key, chat_id)
        if chat_id == GUIDE_CHAT:
            return await guide_chat(
                url, chat or {"id": GUIDE_CHAT, "kind": "guide", "session_id": None, "turns": []}
            )
        if not chat:
            raise HTTPException(404, "chat not found")
        return chat

    async def guide_chat(url: str, chat: dict) -> dict:
        """The guide chat as the session itself has it: the transcript is the history, so the conversation that
        wrote the guide shows up, and so does anything said to that session in the terminal since."""
        prep = await get_prepared(url)
        guide = d().store.load_guide(pr_key(url), prep.meta.head_sha) or {}
        meta = guide.get("meta") or {}
        harness = chat.get("harness") or meta.get("harness")
        session = chat.get("session_id") if chat.get("from_session") == meta.get("session") else None
        session = session or meta.get("session")
        if not (harness and session):
            return {**chat, "harness": harness}
        found = await asyncio.to_thread(session_turns, harness, session)
        reminder = SHOW_REMINDER.strip()
        # Diffusion's turns end with its reminder, except commands, which go as typed.
        sent = {
            q["text"].strip()
            for t in chat.get("turns") or []
            for q in t["questions"]
            if q["text"].startswith("/")
        }
        turns = merge(
            found,
            chat.get("turns") or [],
            lambda text: text.rstrip().endswith(reminder) or text.strip() in sent,
        )
        return {**chat, "harness": harness, "turns": turns}

    @app.get("/api/commands")
    async def commands(url: str) -> dict:
        """What the guide session can run from the / menu, as its harness has it."""
        prep = await get_prepared(url)
        meta = (d().store.load_guide(pr_key(url), prep.meta.head_sha) or {}).get("meta") or {}
        harness = meta.get("harness")
        if not harness or not meta.get("session"):
            return {"harness": harness, "commands": []}
        try:
            cmds = await session_commands(harness, _dir(meta.get("cwd")), d().cfg.cli_path(harness))
        except Exception:  # no CLI, or it wouldn't start: the menu is just empty
            cmds = []
        return {"harness": harness, "commands": cmds}

    @app.post("/api/chats/{chat_id}/steer")
    async def steer(chat_id: str, req: SteerReq) -> dict:
        """Send questions into the running turn; ok is False when there's none, or it can't take them (then the
        client stops it and sends them as the next turn)."""
        inbox = steering.get(chat_id)
        if inbox is None or not req.questions:
            return {"ok": False}
        accepted: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        await inbox.put((req.questions, accepted))
        try:
            return {"ok": await asyncio.wait_for(accepted, 10)}
        except TimeoutError:
            return {"ok": False}

    @app.post("/api/chats/{chat_id}/stop")
    async def stop(chat_id: str) -> dict:
        side = running.get(chat_id)
        if side is None:
            return {"ok": False}
        await side.put(Stop())
        return {"ok": True}

    @app.post("/api/chats/{chat_id}/approve")
    async def approve(chat_id: str, req: Approval) -> dict:
        f = approvals.get(req.id)
        if not f or f.done():
            raise HTTPException(404, "nothing is waiting on that")
        f.set_result(req.decision)
        return {"ok": True}

    @app.post("/api/chats/{chat_id}/turn")
    async def turn(chat_id: str, req: TurnReq) -> StreamingResponse:
        deps = d()
        key = pr_key(req.url)
        # The guide chat is shown before anything is asked in it (its history is the session's transcript), so
        # its first turn is what stores it.
        chat = new_chat(key, "guide") if chat_id == GUIDE_CHAT else deps.store.load_chat(key, chat_id)
        if not chat:
            raise HTTPException(404, "chat not found")
        if not req.questions:
            raise HTTPException(400, "no questions")
        if len({q.n for q in req.questions}) != len(req.questions):
            raise HTTPException(400, "duplicate question numbers")
        prep = await get_prepared(req.url)
        sha = prep.meta.head_sha
        guide = deps.store.load_guide(key, sha, req.version)
        if guide and guide.get("version"):
            guide = {**guide, "draft": deps.store.load_draft(key, sha, guide["version"])}
        lock = chat_locks.setdefault(chat_id, asyncio.Lock())

        async def events():
            # One turn per chat at a time: a turn resumes the session the previous one produced.
            async with lock:
                chat = deps.store.load_chat(key, chat_id)  # fresh: an earlier turn may have just saved
                if chat is None:  # deleted while this turn waited for the lock
                    yield "error", {"message": "chat not found"}
                    return
                meta = (guide or {}).get("meta") or {}
                harness = chat.get("harness") or meta.get("harness") or installed_harness(dict(os.environ))
                chat["harness"] = harness = harness or "claude-code"  # the SDK bundles Claude Code
                resume_at = restore = None
                if req.rewind:
                    # Edit an earlier message, as Claude Code's rewind does: the session picks up from just before
                    # it, and it and what followed drop out (of the session, and of this chat's own record).
                    if harness != "claude-code":
                        yield "error", {"message": "Editing a sent message needs a Claude Code session."}
                        return
                    resume = _sessions(chat, meta, harness)[0][0]
                    path = find_transcript(harness, resume) if resume else None
                    resume_at = rewind_point(path, req.rewind.uuid) if path else None
                    if not resume_at:
                        yield "error", {"message": "That message can't be edited (it's the first, or gone)."}
                        return
                    restore = req.rewind.uuid if req.rewind.code else None
                    at = next((i for i, t in enumerate(chat["turns"]) if t.get("uuid") == req.rewind.uuid), None)
                    if at is not None:
                        del chat["turns"][at:]
                record = {
                    "at": time.time(),
                    "head_sha": sha,
                    "questions": [q.model_dump() for q in req.questions],
                    "answers": {str(q.n): "" for q in req.questions},
                    "tools": [],
                    "trace": [],  # what the agent did, in order: {"think": text} and {"tool": summary}
                    "shows": [],
                    "status": "streaming",
                }
                chat["turns"].append(record)
                chat["head_sha"] = sha
                chat["updated_at"] = record["at"]
                deps.store.save_chat(key, chat)
                block = GuideBlock()
                mode: Mode = req.mode if chat.get("kind") == "guide" else "read-only"
                side: asyncio.Queue = asyncio.Queue()
                mine: list[str] = []

                async def ask(tool: str, summary: str, tool_input: dict) -> Decision:
                    aid = uuid.uuid4().hex[:12]
                    f: asyncio.Future[Decision] = asyncio.get_running_loop().create_future()
                    approvals[aid] = f
                    mine.append(aid)
                    await side.put(ApprovalAsked(aid, tool, summary, tool_input))
                    try:
                        return await f
                    finally:
                        approvals.pop(aid, None)

                running[chat_id] = side
                inbox: asyncio.Queue | None = asyncio.Queue() if harness in STEERABLE else None
                if inbox:
                    steering[chat_id] = inbox
                try:
                    for resume, fork, cwd in _sessions(chat, meta, harness):
                        said = False
                        # The guide's own session, joined for the first time, hasn't seen the chat's instructions.
                        adopt = bool(resume) and not fork and resume != chat.get("session_id")
                        try:
                            async for ev in (evs := merged(run_turn(
                                prep, guide, req.questions, deps.runner_for(harness), deps.cfg.chat_model(harness),
                                resume, fork=fork, adopt=adopt, cwd=cwd, block=block, mode=mode, approve=ask,
                                harness=harness if chat.get("kind") == "guide" else "", steer=inbox,
                                resume_at=resume_at, restore_files=restore,
                            ), side)):  # fmt: skip
                                if isinstance(ev, Stop):
                                    await evs.aclose()
                                    record["stopped"] = True
                                    break
                                if isinstance(ev, ApprovalAsked):
                                    yield "approval", ev.payload
                                elif isinstance(ev, ChatSteered):
                                    said = True
                                    k = record["steers"] = record.get("steers", 0) + 1
                                    record["trace"].append({"steered": k})  # where its own work starts
                                    for q in ev.questions:  # shown as a turn of their own
                                        record["questions"].append({**q.model_dump(), "steered": k})
                                        record["answers"][str(q.n)] = ""
                                    yield "steered", {"ns": [q.n for q in ev.questions]}
                                elif isinstance(ev, ChatDelta):
                                    said = True
                                    record["answers"][str(ev.n)] += ev.text
                                    yield "delta", {"n": ev.n, "text": ev.text}
                                elif isinstance(ev, ChatFocus):
                                    record["shows"].append(ev.to_dict())
                                    yield "focus", ev.to_dict()
                                elif isinstance(ev, ThinkingEvent):
                                    said = True
                                    trace = record["trace"]
                                    if trace and "think" in trace[-1]:
                                        trace[-1]["think"] += ev.text
                                    else:
                                        trace.append({"think": ev.text})
                                    yield "thinking", {"text": ev.text}
                                elif isinstance(ev, ToolEvent):
                                    said = True
                                    record["tools"].append(ev.summary)
                                    record["trace"].append(
                                        {"tool": ev.summary, **({"id": ev.id} if ev.id else {})}
                                    )
                                    yield "tool", {"name": ev.name, "summary": ev.summary, "id": ev.id}
                                elif isinstance(ev, ToolFailedEvent):
                                    for t in record["trace"]:
                                        if t.get("id") == ev.id:
                                            t["failed"] = True
                                    yield "tool_failed", {"id": ev.id}
                                elif isinstance(ev, DoneEvent):
                                    if ev.is_error:
                                        raise RuntimeError(ev.result or "agent error")
                                    chat["session_id"] = ev.session_id or chat.get("session_id")
                                    if ev.prompt_id:
                                        record["uuid"] = ev.prompt_id
                                    chat["cwd"] = str(cwd) if cwd else None
                                    if chat.get("kind") == "guide":
                                        chat["from_session"] = meta.get("session")
                            break
                        except Exception:
                            if said or not fork:
                                raise
                            # The guide's session couldn't be forked (moved, deleted): start a fresh one.
                    if block.found is not None:
                        n, note = save_chat_guide(deps, prep, block.found, meta, chat)
                        if n:
                            record["guide_version"] = n
                            yield "guide", {"n": record["questions"][-1]["n"], "version": n}
                        else:
                            record["answers"][str(record["questions"][-1]["n"])] += note
                            yield "delta", {"n": record["questions"][-1]["n"], "text": note}
                    record["status"] = "done"
                    record["seconds"] = round(time.time() - record["at"], 1)
                    yield (
                        "done",
                        {
                            "ns": [q["n"] for q in record["questions"]],
                            "seconds": record["seconds"],
                            **({"stopped": True} if record.get("stopped") else {}),
                            **({"uuid": record["uuid"]} if record.get("uuid") else {}),
                        },
                    )
                except Exception as e:  # surface to the client; keep partial answers
                    record["status"] = "error"
                    record["error"] = str(e) or type(e).__name__
                    yield "error", {"message": record["error"]}
                finally:
                    if running.get(chat_id) is side:
                        del running[chat_id]
                    if inbox and steering.get(chat_id) is inbox:
                        del steering[chat_id]
                    while inbox and not inbox.empty():  # sent as the turn ended: the client sends them next
                        if not (f := inbox.get_nowait()[1]).done():
                            f.set_result(False)
                    for aid in mine:  # the reviewer left: nothing waits forever
                        if (f := approvals.pop(aid, None)) and not f.done():
                            f.set_result("deny")
                    chat["updated_at"] = time.time()
                    deps.store.save_chat(key, chat)

        return sse_response(events())

    dist = _web_dist()
    if dist:
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            f = dist / path
            if path and f.is_file():
                return FileResponse(f)
            return FileResponse(dist / "index.html")

    return app


def _web_dist() -> Path | None:
    """Built UI: $DIFFUSION_WEB_DIST, the copy bundled in the package, or web/dist in a source checkout."""
    env = os.environ.get("DIFFUSION_WEB_DIST")
    here = Path(__file__).resolve()
    candidates = [Path(env)] if env else []
    candidates += [here.parent / "web", here.parents[3] / "web" / "dist"]
    return next((d for d in candidates if (d / "index.html").is_file()), None)


def _sessions(chat: dict, meta: dict, harness: str) -> list[tuple[str | None, bool, Path | None]]:
    """Sessions a turn can run in, in order. A fork: its own session; else a fork of the session that wrote the
    guide (Claude Code finds a session by the directory it ran in), falling back to a fresh one. The guide chat: the
    session that wrote the guide, continued, and nothing else (a fresh session would quietly be a different chat)."""
    guide_cwd = _dir(meta.get("cwd")) if harness == "claude-code" else None
    if chat.get("kind") == "guide":
        if not (meta.get("session") and harness in FORKABLE):
            raise RuntimeError("The guide's session can't be continued here; start a new chat instead.")
        # Keep going where this chat left off, unless the guide has since been written by another session. It runs
        # where the session ran, so its edits land in the reviewer's checkout, not Diffusion's cached one.
        if chat.get("session_id") and chat.get("from_session") == meta["session"]:
            return [(chat["session_id"], False, _dir(chat.get("cwd")) or _dir(meta.get("cwd")))]
        return [(meta["session"], False, _dir(meta.get("cwd")))]
    if chat.get("session_id"):
        return [(chat["session_id"], False, _dir(chat.get("cwd")))]
    out: list[tuple[str | None, bool, Path | None]] = []
    if meta.get("session") and harness in FORKABLE:
        out.append((meta["session"], True, guide_cwd))
    return [*out, (None, False, None)]


def _dir(path: str | None) -> Path | None:
    return Path(path) if path and Path(path).is_dir() else None


def save_chat_guide(deps: Deps, prep: Prepared, raw: str, meta: dict, chat: dict) -> tuple[int | None, str]:
    """Store a guide a chat answer ended with as a new version: (its number, ""), or (None, why it wasn't)."""
    try:
        draft, g = check(raw, prep.index)
    except DraftError:
        return None, "\n\n_The updated guide didn't match the guide format, so it wasn't saved._"
    if not g.steps:
        return None, "\n\n_None of the updated guide's refs matched the diff, so it wasn't saved._"
    record = {
        **g.model_dump(by_alias=True),
        "label": g.label or "Edited in chat",
        "meta": {
            **{k: meta.get(k) for k in ("harness", "session", "cwd")},
            "head_sha": prep.meta.head_sha,
            "source": "chat",
            "chat": chat["id"],
            "created_at": time.time(),
        },
    }
    n = deps.store.save_guide(
        prep.meta.ref.key, prep.meta.head_sha, record, draft.model_dump(by_alias=True), prep.meta.summary()
    )
    return n, ""
