"""Bounded classroom work, independent raw reads, and disconnect cancellation."""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import ParamSpec, TypeVar

import anyio
from starlette.exceptions import HTTPException
from starlette.requests import Request

P = ParamSpec("P")
T = TypeVar("T")
_CPU_LIMITER = anyio.CapacityLimiter(4)
_CPU_ADMISSION = anyio.CapacityLimiter(64)
_RAW_LIMITER = anyio.CapacityLimiter(2)
_RAW_THREADS = anyio.CapacityLimiter(2)
_RAW_ADMISSION = anyio.CapacityLimiter(64)
_SYNC_ADMISSION = anyio.CapacityLimiter(64)
_REPORT_THREADS = anyio.CapacityLimiter(32)
_REPORT_SLOTS = anyio.CapacityLimiter(32)
_REPORT_ADMISSION = anyio.CapacityLimiter(32)
QUEUE_TIMEOUT_SECONDS = 15.0
WORK_TIMEOUT_SECONDS = 90.0


class WorkUnavailable(RuntimeError):
    def __init__(self, code: str = "work_queue_full"):
        self.code = code
        super().__init__("当前计算或数据读取任务较多，请稍候再试；实验记录仍可保存。")


@dataclass(eq=False)
class _Work:
    cancelled: threading.Event = field(default_factory=threading.Event)
    started: bool = False
    deadline: float = float("inf")


_CURRENT_WORK: ContextVar[_Work | None] = ContextVar("gvcsim_work", default=None)
_workers: dict[asyncio.Task, _Work] = {}
_sync_workers: dict[asyncio.Task, anyio.CancelScope] = {}


def check_cancelled() -> None:
    """Cooperative checkpoint; offline computations have no request deadline."""
    work = _CURRENT_WORK.get()
    if work is not None and (work.cancelled.is_set() or time.monotonic() >= work.deadline):
        raise WorkUnavailable("work_cancelled_or_expired")


async def _run_limited(
    function: Callable[[], T],
    limiter: anyio.CapacityLimiter,
    admission: anyio.CapacityLimiter,
    thread_limiter: anyio.CapacityLimiter | None = None,
) -> T:
    work = _Work()
    try:
        admission.acquire_on_behalf_of_nowait(work)
    except anyio.WouldBlock as error:
        raise WorkUnavailable() from error

    def invoke() -> T:
        token = _CURRENT_WORK.set(work)
        try:
            check_cancelled()
            value = function()
            check_cancelled()
            return value
        finally:
            _CURRENT_WORK.reset(token)

    async def execute() -> T:
        try:
            async with asyncio.timeout(QUEUE_TIMEOUT_SECONDS):
                await limiter.acquire()
        except TimeoutError as error:
            raise WorkUnavailable("work_queue_timeout") from error
        try:
            # From here on, never cancel this task: native asyncio cancellation
            # can abandon an AnyIO thread and release its token before it stops.
            work.started = True
            work.deadline = time.monotonic() + WORK_TIMEOUT_SECONDS
            return await anyio.to_thread.run_sync(invoke, limiter=thread_limiter)
        finally:
            limiter.release()

    worker = asyncio.create_task(execute())
    _workers[worker] = work

    def finished(task: asyncio.Task) -> None:
        _workers.pop(task, None)
        admission.release_on_behalf_of(work)
        if not task.cancelled():
            task.exception()  # Observe failures even after the caller has left.

    worker.add_done_callback(finished)
    try:
        async with asyncio.timeout(QUEUE_TIMEOUT_SECONDS + WORK_TIMEOUT_SECONDS):
            return await asyncio.shield(worker)
    except (asyncio.CancelledError, TimeoutError) as error:
        work.cancelled.set()
        if not work.started:
            worker.cancel()
        if isinstance(error, TimeoutError):
            raise WorkUnavailable("work_deadline_exceeded") from error
        raise


async def run_cpu_bound(function: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    return await _run_limited(lambda: function(*args, **kwargs), _CPU_LIMITER, _CPU_ADMISSION)


async def run_raw_io(function: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    # Raw readers never borrow the default thread tokens used by auth and saves.
    return await _run_limited(lambda: function(*args, **kwargs), _RAW_LIMITER, _RAW_ADMISSION, _RAW_THREADS)


async def run_report_build(function: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    # Renderers wait on per-model async singleflight. They must borrow neither
    # CPU slots nor the default threads needed to execute those models and saves.
    return await _run_limited(lambda: function(*args, **kwargs), _REPORT_SLOTS, _REPORT_ADMISSION, _REPORT_THREADS)


async def run_sync(function: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    """Track ordinary synchronous I/O without abandoning its default thread token.

    Cancel the AnyIO scope, never the worker task: queued calls can leave the
    default thread queue, while run_sync's shield protects an already dispatched
    call until it really finishes. This also closes the dispatch/start race that
    a flag set inside the thread cannot safely detect. Running transactions get
    no artificial work deadline; their existing database semantics still apply.
    """
    scope = anyio.CancelScope()
    admission = _SYNC_ADMISSION
    try:
        admission.acquire_on_behalf_of_nowait(scope)
    except anyio.WouldBlock as error:
        raise WorkUnavailable() from error

    async def execute() -> T:
        with scope:
            return await anyio.to_thread.run_sync(lambda: function(*args, **kwargs))
        raise WorkUnavailable("work_cancelled")

    worker = asyncio.create_task(execute())
    _sync_workers[worker] = scope

    def finished(task: asyncio.Task) -> None:
        _sync_workers.pop(task, None)
        admission.release_on_behalf_of(scope)
        if not task.cancelled():
            task.exception()

    worker.add_done_callback(finished)
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        scope.cancel()
        raise


async def for_request(request: Request, operation: Callable[[], Awaitable[T]]) -> T:
    """Cancel this waiter on disconnect, after FastAPI has parsed its body.

    Apply only to reads/computation. Database mutations keep their existing
    commit/optimistic-concurrency semantics when a response is lost.
    """

    async def disconnected() -> None:
        while (await request.receive())["type"] != "http.disconnect":
            pass

    async def run_operation() -> T:
        return await operation()

    waiter = asyncio.create_task(run_operation())
    monitor = asyncio.create_task(disconnected())
    try:
        done, _ = await asyncio.wait((waiter, monitor), return_when=asyncio.FIRST_COMPLETED)
        if waiter in done:
            return await waiter
        await monitor  # Do not disguise a receive failure as a normal disconnect.
        raise HTTPException(status_code=499, detail="请求已取消")
    finally:
        monitor.cancel()
        if not waiter.done():
            waiter.cancel()
        await asyncio.gather(waiter, monitor, return_exceptions=True)


async def shutdown() -> None:
    workers = list(_workers.items())
    sync_workers = list(_sync_workers.items())
    for task, work in workers:
        work.cancelled.set()
        if not work.started:
            task.cancel()
    for _task, scope in sync_workers:
        scope.cancel()
    # In particular, drain detached database work before lifespan closes its pool.
    await asyncio.gather(*(task for task, _ in [*workers, *sync_workers]), return_exceptions=True)
