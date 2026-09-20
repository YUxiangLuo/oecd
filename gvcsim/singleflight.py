"""Small process-local async cache that coalesces identical in-flight work."""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Hashable
from dataclasses import dataclass
from typing import Generic, TypeVar

from gvcsim.concurrency import WorkUnavailable

K = TypeVar("K", bound=Hashable)
V = TypeVar("V")


@dataclass
class _Flight(Generic[V]):
    task: asyncio.Task[V]
    owner: Hashable | None = None
    waiters: int = 0


class AsyncSingleFlightCache(Generic[K, V]):
    """Share one task per key and retain a bounded number of successful results.

    The application deliberately runs one Uvicorn worker, so route handlers for a
    process share one event loop. Dictionary operations before the first await are
    therefore sufficient to elect exactly one task without a cross-thread lock.
    Failed computations are never cached, and cancelling one waiting request does
    not cancel work that another student is still awaiting. Factories must protect
    synchronous work with concurrency.run_sync/run_cpu_bound: the last waiter may
    cancel the factory task, but must not abandon its physical worker thread.
    """

    def __init__(self, maxsize: int = 64, *, max_inflight: int = 64):
        if maxsize <= 0 or max_inflight <= 0:
            raise ValueError("cache limits must be positive")
        self._maxsize = maxsize
        self._max_inflight = max_inflight
        self._values: OrderedDict[K, V] = OrderedDict()
        self._inflight: dict[K, _Flight[V]] = {}
        self._owners: dict[Hashable, _Flight[V]] = {}

    def _forget(self, key: K, flight: _Flight[V]) -> None:
        if self._inflight.get(key) is flight:
            self._inflight.pop(key)
        if flight.owner is not None and self._owners.get(flight.owner) is flight:
            self._owners.pop(flight.owner)

    async def get_or_compute(
        self,
        key: K,
        factory: Callable[[], Awaitable[V]],
        *,
        admit: Callable[[], None] | None = None,
        owner: Hashable | None = None,
        cache_success: bool = True,
    ) -> V:
        try:
            value = self._values.pop(key)
        except KeyError:
            pass
        else:
            self._values[key] = value
            return value

        flight = self._inflight.get(key)
        if flight is None:
            if len(self._inflight) >= self._max_inflight:
                raise WorkUnavailable()
            if owner is not None and owner in self._owners:
                raise WorkUnavailable("account_work_inflight")
            # Admission is synchronous and happens BEFORE publishing the flight.
            # A rejected account cannot publish its 429 to unrelated students.
            if admit is not None:
                admit()
            task = asyncio.create_task(self._compute(key, factory, cache_success=cache_success))
            flight = _Flight(task, owner)
            self._inflight[key] = flight
            if owner is not None:
                self._owners[owner] = flight

            def finished(completed: asyncio.Task[V]) -> None:
                self._forget(key, flight)
                if not completed.cancelled():
                    completed.exception()

            task.add_done_callback(finished)
        flight.waiters += 1
        try:
            return await asyncio.shield(flight.task)
        finally:
            flight.waiters -= 1
            if flight.waiters == 0 and not flight.task.done():
                flight.task.cancel()
                self._forget(key, flight)

    async def _compute(self, key: K, factory: Callable[[], Awaitable[V]], *, cache_success: bool) -> V:
        value = await factory()
        flight = self._inflight.get(key)
        if not cache_success or flight is None or flight.task is not asyncio.current_task() or not flight.waiters:
            return value
        self._values[key] = value
        self._values.move_to_end(key)
        while len(self._values) > self._maxsize:
            self._values.popitem(last=False)
        return value

    def clear(self) -> None:
        """Drop completed values; already running work remains valid for its waiters."""
        self._values.clear()

    async def aclose(self) -> None:
        tasks = [flight.task for flight in self._inflight.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.clear()

    @property
    def completed_count(self) -> int:
        return len(self._values)

    @property
    def inflight_count(self) -> int:
        return len(self._inflight)
