"""HTTP API (localhost only). Guides arrive from ``diffusion submit`` (or a chat answer) as versions in the store;
chat answers stream over SSE."""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__
from .agent import DoneEvent, Runner, ThinkingEvent, ToolEvent, make_runner
from .chat_agent import ChatDelta, ChatFocus, GuideBlock, Question, run_turn
from .config import FORKABLE, Config, installed_harness, load_config
from .github import GitHubError
from .pipeline import Prepared, prepare, target_ref
from .repo import RepoError
from .store import Store
from .symbols import NAME, SymbolIndex
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


class TurnReq(BaseModel):
    url: str
    questions: list[Question]
    version: int | None = None  # the guide version on screen


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
    }


def create_app(deps: Deps | None = None) -> FastAPI:
    app = FastAPI(title="diffusion")
    _deps: list[Deps] = [deps] if deps else []

    def d() -> Deps:
        if not _deps:
            _deps.append(default_deps(load_config()))
        return _deps[0]

    _prepared: dict[str, Prepared] = {}
    chat_locks: dict[str, asyncio.Lock] = {}
    symbols: dict[Path, SymbolIndex] = {}
    symbol_locks: dict[Path, asyncio.Lock] = {}

    async def get_prepared(url: str, refresh: bool = False) -> Prepared:
        try:
            key = target_ref(url).key
        except GitHubError as e:
            raise HTTPException(400, str(e)) from e
        latest = d().store.latest_head(key)
        if latest and key in _prepared and _prepared[key].meta.head_sha != latest:
            refresh = (
                True  # a guide arrived for a newer head (a new push, or a new snapshot of uncommitted work)
            )
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

    @app.get("/api/file")
    async def file(url: str, path: str) -> dict:
        """A changed file at the PR head, so the diff can show lines around and between hunks."""
        prep = await get_prepared(url)
        if path not in {f.path for f in prep.index.files}:
            raise HTTPException(404, f"{path} isn't in this diff")
        try:
            text = await asyncio.to_thread(prep.checkout.file_at_head, path)
        except UnicodeDecodeError as e:
            raise HTTPException(415, f"{path} isn't text") from e
        if text is None:
            raise HTTPException(404, f"{path} doesn't exist at the head commit")
        if len(text) > MAX_FILE_CHARS:
            raise HTTPException(413, f"{path} is too large to show in full")
        return {"path": path, "text": text}

    @app.get("/api/definition")
    async def definition(url: str, symbol: str, path: str) -> dict:
        """Where `symbol` is defined at the PR head, nearest to `path` first, with each definition's source."""
        if not NAME.match(symbol):
            raise HTTPException(400, "Not a name")
        prep = await get_prepared(url)
        root = prep.checkout.worktree
        async with symbol_locks.setdefault(root, asyncio.Lock()):
            if root not in symbols:
                symbols[root] = await asyncio.to_thread(SymbolIndex, root)
        index = symbols[root]
        found = index.lookup(symbol, path)
        return {
            "symbol": symbol,
            "matches": [
                {"path": m.path, "line": m.line, "end": m.end, "text": index.snippet(m)} for m in found
            ],
        }

    # ---------- chats ----------

    def pr_key(url: str) -> str:
        try:
            return target_ref(url).key
        except GitHubError as e:
            raise HTTPException(400, str(e)) from e

    @app.get("/api/chats")
    async def list_chats(url: str) -> list[dict]:
        return [chat_summary(c) for c in d().store.list_chats(pr_key(url)) if c.get("turns")]

    @app.post("/api/chats")
    async def create_chat(req: ChatCreate) -> dict:
        now = time.time()
        chat = {
            "id": uuid.uuid4().hex[:12],
            "created_at": now,
            "updated_at": now,
            "session_id": None,
            "turns": [],
        }
        d().store.save_chat(pr_key(req.url), chat)
        return chat

    @app.get("/api/chats/{chat_id}")
    async def get_chat(chat_id: str, url: str) -> dict:
        chat = d().store.load_chat(pr_key(url), chat_id)
        if not chat:
            raise HTTPException(404, "chat not found")
        return chat

    @app.post("/api/chats/{chat_id}/turn")
    async def turn(chat_id: str, req: TurnReq) -> StreamingResponse:
        deps = d()
        key = pr_key(req.url)
        chat = deps.store.load_chat(key, chat_id)
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
                record = {
                    "at": time.time(),
                    "head_sha": sha,
                    "questions": [q.model_dump() for q in req.questions],
                    "answers": {str(q.n): "" for q in req.questions},
                    "tools": [],
                    "thinking": "",
                    "shows": [],
                    "status": "streaming",
                }
                chat["turns"].append(record)
                chat["head_sha"] = sha
                chat["updated_at"] = record["at"]
                deps.store.save_chat(key, chat)
                meta = (guide or {}).get("meta") or {}
                harness = chat.get("harness") or meta.get("harness") or installed_harness(dict(os.environ))
                chat["harness"] = harness = harness or "claude-code"  # the SDK bundles Claude Code
                block = GuideBlock()
                try:
                    for resume, fork, cwd in _sessions(chat, meta, harness):
                        said = False
                        try:
                            async for ev in run_turn(
                                prep, guide, req.questions, deps.runner_for(harness), deps.cfg.chat_model(harness),
                                resume, fork=fork, cwd=cwd, block=block,
                            ):  # fmt: skip
                                if isinstance(ev, ChatDelta):
                                    said = True
                                    record["answers"][str(ev.n)] += ev.text
                                    yield "delta", {"n": ev.n, "text": ev.text}
                                elif isinstance(ev, ChatFocus):
                                    record["shows"].append(ev.to_dict())
                                    yield "focus", ev.to_dict()
                                elif isinstance(ev, ThinkingEvent):
                                    said = True
                                    record["thinking"] += ev.text
                                    yield "thinking", {"text": ev.text}
                                elif isinstance(ev, ToolEvent):
                                    said = True
                                    record["tools"].append(ev.summary)
                                    yield "tool", {"name": ev.name, "summary": ev.summary}
                                elif isinstance(ev, DoneEvent):
                                    if ev.is_error:
                                        raise RuntimeError(ev.result or "agent error")
                                    chat["session_id"] = ev.session_id or chat.get("session_id")
                                    chat["cwd"] = str(cwd) if cwd else None
                            break
                        except Exception:
                            if said or not fork:
                                raise
                            # The guide's session couldn't be forked (moved, deleted): start a fresh one.
                    if block.found is not None:
                        n, note = save_chat_guide(deps, prep, block.found, meta, chat)
                        if n:
                            record["guide_version"] = n
                            yield "guide", {"n": req.questions[-1].n, "version": n}
                        else:
                            record["answers"][str(req.questions[-1].n)] += note
                            yield "delta", {"n": req.questions[-1].n, "text": note}
                    record["status"] = "done"
                    record["seconds"] = round(time.time() - record["at"], 1)
                    yield "done", {"ns": [q.n for q in req.questions], "seconds": record["seconds"]}
                except Exception as e:  # surface to the client; keep partial answers
                    record["status"] = "error"
                    record["error"] = str(e) or type(e).__name__
                    yield "error", {"message": record["error"]}
                finally:
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
    """Sessions a turn can run in, in order: the chat's own; else a fork of the session that wrote the guide
    (Claude Code finds a session by the directory it ran in), falling back to a fresh one."""
    if chat.get("session_id"):
        return [(chat["session_id"], False, _dir(chat.get("cwd")))]
    out: list[tuple[str | None, bool, Path | None]] = []
    if meta.get("session") and harness in FORKABLE:
        out.append((meta["session"], True, _dir(meta.get("cwd")) if harness == "claude-code" else None))
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
    n = deps.store.save_guide(prep.meta.ref.key, prep.meta.head_sha, record, draft.model_dump(by_alias=True))
    return n, ""
