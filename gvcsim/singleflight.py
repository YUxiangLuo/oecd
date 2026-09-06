"""Small process-local async cache that coalesces identical in-flight work."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Hashable
from typing import Generic, TypeVar

K = TypeVar("K", bound=Hashable)
V = TypeVar("V")


class AsyncSingleFlightCache(Generic[K, V]):
    """Share one task per key and retain a bounded number of successful results.

    The application deliberately runs one Uvicorn worker, so route handlers for a
    process share one event loop. Dictionary operations before the first await are
    therefore sufficient to elect exactly one task without a cross-thread lock.
    Failed computations are never cached, and cancelling one waiting request does
    not cancel work that another student is still awaiting.
    """

    def __init__(self, maxsize: int = 64):
        if maxsize <= 0:
            raise ValueError("maxsize must be positive")
        self._maxsize = maxsize
        self._values: OrderedDict[K, V] = OrderedDict()
        self._inflight: dict[K, asyncio.Task[V]] = {}

    async def get_or_compute(self, key: K, factory: Callable[[], Awaitable[V]]) -> V:
        try:
            value = self._values.pop(key)
        except KeyError:
            pass
        else:
            self._values[key] = value
            return value

        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._compute(key, factory))
            # Work survives waiter cancellation. Observe a later failure even if
            # nobody remains to await it; active waiters still receive the exception.
            task.add_done_callback(lambda completed: None if completed.cancelled() else completed.exception())
            self._inflight[key] = task
        return await asyncio.shield(task)

    async def _compute(self, key: K, factory: Callable[[], Awaitable[V]]) -> V:
        try:
            value = await factory()
        except BaseException:
            self._inflight.pop(key, None)
            raise
        self._inflight.pop(key, None)
        self._values[key] = value
        self._values.move_to_end(key)
        while len(self._values) > self._maxsize:
            self._values.popitem(last=False)
        return value

    def clear(self) -> None:
        """Drop completed values; already running work remains valid for its waiters."""
        self._values.clear()

    @property
    def completed_count(self) -> int:
        return len(self._values)

    @property
    def inflight_count(self) -> int:
        return len(self._inflight)
