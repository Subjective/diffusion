"""In-process background jobs with replayable event logs.

A guide job runs once per (PR, head SHA). Any number of SSE clients can attach; each receives every event from
the start, so a page reload mid-generation reattaches cleanly.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

Emit = Callable[[str, dict], None]


@dataclass
class Job:
    key: str
    events: list[tuple[str, dict]] = field(default_factory=list)
    done: bool = False
    task: asyncio.Task | None = None
    _cond: asyncio.Condition = field(default_factory=asyncio.Condition)

    def emit(self, event: str, data: dict) -> None:
        self.events.append((event, data))
        asyncio.get_running_loop().create_task(self._notify())

    async def _notify(self) -> None:
        async with self._cond:
            self._cond.notify_all()

    async def finish(self) -> None:
        self.done = True
        await self._notify()

    async def follow(self) -> AsyncIterator[tuple[str, dict]]:
        i = 0
        while True:
            while i < len(self.events):
                yield self.events[i]
                i += 1
            if self.done:
                return
            seen = i
            async with self._cond:
                await self._cond.wait_for(lambda seen=seen: self.done or seen < len(self.events))


class Jobs:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}

    def get(self, key: str) -> Job | None:
        return self._jobs.get(key)

    def drop(self, key: str) -> None:
        """Forget a finished job so the next ``start`` runs fresh."""
        job = self._jobs.get(key)
        if job and job.done:
            del self._jobs[key]

    def start(self, key: str, work: Callable[[Emit], Awaitable[Any]]) -> Job:
        """Return the running/finished job for ``key``, or start one. Failed jobs are restarted."""
        job = self._jobs.get(key)
        if job and not (job.done and job.events and job.events[-1][0] == "error"):
            return job
        job = Job(key)
        self._jobs[key] = job

        async def runner() -> None:
            try:
                await work(job.emit)
            except Exception as e:
                job.emit("error", {"message": str(e) or type(e).__name__})
            finally:
                await job.finish()

        job.task = asyncio.get_running_loop().create_task(runner())
        return job
