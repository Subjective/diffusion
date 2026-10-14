"""HTTP API (localhost only). Guide generation streams progress over SSE."""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from functools import partial
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .agent import DoneEvent, Runner, ToolEvent, make_runner
from .chat_agent import ChatDelta, Question, run_turn
from .config import Config, load_config
from .github import GitHubError
from .guide_agent import GuideDone, GuideError, generate_guide
from .jobs import Emit, Jobs
from .pipeline import Prepared, prepare, target_ref
from .repo import RepoError
from .store import Store

PrepareFn = Callable[[Config, str], Prepared]


@dataclass
class Deps:
    cfg: Config
    runner: Runner
    prepare: PrepareFn
    store: Store
    jobs: Jobs


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


class GuideReq(BaseModel):
    url: str
    force: bool = False


class ChatCreate(BaseModel):
    url: str


class TurnReq(BaseModel):
    url: str
    questions: list[Question]


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
            cfg = load_config()
            _deps.append(Deps(cfg, make_runner(cfg), prepare, Store(cfg.cache_dir), Jobs()))
        return _deps[0]

    _prepared: dict[str, Prepared] = {}
    chat_locks: dict[str, asyncio.Lock] = {}

    async def get_prepared(url: str, refresh: bool = False) -> Prepared:
        try:
            key = target_ref(url).key
        except GitHubError as e:
            raise HTTPException(400, str(e)) from e
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
        cfg = d().cfg
        return {
            "ok": True,
            "profile": cfg.profile,
            "backend": cfg.backend,
            "guide_model": cfg.guide_model,
            "chat_model": cfg.chat_model,
        }

    @app.get("/api/pr")
    async def pr(url: str) -> dict:
        prep = await get_prepared(url, refresh=True)
        cached = d().store.load_guide(prep.meta.ref.key, prep.meta.head_sha)
        return {**prep.to_dict(), "guide": cached}

    @app.post("/api/guide")
    async def guide(req: GuideReq) -> StreamingResponse:
        deps = d()
        prep = await get_prepared(req.url)
        key, sha = prep.meta.ref.key, prep.meta.head_sha
        job_key = f"guide:{key}:{sha}"

        if not req.force and (cached := deps.store.load_guide(key, sha)):

            async def replay():
                yield "guide", cached

            return sse_response(replay())

        if req.force:
            deps.jobs.drop(job_key)
        job = deps.jobs.start(job_key, partial(run_guide, deps, prep))
        return sse_response(job.follow())

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
        guide = deps.store.load_guide(key, prep.meta.head_sha)
        lock = chat_locks.setdefault(chat_id, asyncio.Lock())

        async def events():
            # One turn per chat at a time: a turn resumes the session the previous one produced.
            async with lock:
                chat = deps.store.load_chat(key, chat_id)  # fresh: an earlier turn may have just saved
                record = {
                    "at": time.time(),
                    "head_sha": prep.meta.head_sha,
                    "questions": [q.model_dump() for q in req.questions],
                    "answers": {str(q.n): "" for q in req.questions},
                    "tools": [],
                    "status": "streaming",
                }
                chat["turns"].append(record)
                chat["head_sha"] = prep.meta.head_sha
                chat["updated_at"] = record["at"]
                deps.store.save_chat(key, chat)
                try:
                    async for ev in run_turn(
                        prep, guide, req.questions, deps.runner, deps.cfg.chat_model, chat.get("session_id")
                    ):
                        if isinstance(ev, ChatDelta):
                            record["answers"][str(ev.n)] += ev.text
                            yield "delta", {"n": ev.n, "text": ev.text}
                        elif isinstance(ev, ToolEvent):
                            record["tools"].append(ev.summary)
                            yield "tool", {"name": ev.name, "summary": ev.summary}
                        elif isinstance(ev, DoneEvent):
                            if ev.is_error:
                                raise RuntimeError(ev.result or "agent error")
                            chat["session_id"] = ev.session_id or chat.get("session_id")
                    record["status"] = "done"
                    yield "done", {"ns": [q.n for q in req.questions]}
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


async def run_guide(deps: Deps, prep: Prepared, emit: Emit) -> None:
    t0 = time.monotonic()
    emit("stage", {"stage": "fetch", "status": "done"})
    emit(
        "stage",
        {"stage": "hunks", "status": "done", "files": len(prep.index.files), "hunks": len(prep.index.hunks)},
    )
    emit("stage", {"stage": "explore", "status": "active"})
    done: GuideDone | None = None
    async for ev in generate_guide(
        prep.meta, prep.checkout, prep.index, deps.runner, deps.cfg.guide_model, deps.cfg.max_turns
    ):
        if isinstance(ev, ToolEvent):
            emit("tool", {"name": ev.name, "summary": ev.summary})
        elif isinstance(ev, DoneEvent) and ev.is_error:
            raise GuideError(ev.result or "agent error")
        elif isinstance(ev, GuideDone):
            done = ev
    assert done is not None
    emit("stage", {"stage": "explore", "status": "done"})
    emit("stage", {"stage": "validate", "status": "done"})
    record = {
        **done.guide.model_dump(by_alias=True),
        "meta": {
            "head_sha": prep.meta.head_sha,
            "backend": deps.cfg.backend,
            "model": deps.cfg.guide_model,
            "turns": done.turns,
            "cost_usd": done.cost_usd,
            "attempts": done.attempts,
            "seconds": round(time.monotonic() - t0, 1),
            "created_at": time.time(),
        },
    }
    deps.store.save_guide(prep.meta.ref.key, prep.meta.head_sha, record)
    emit("guide", record)
