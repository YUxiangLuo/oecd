import asyncio
import gc

import pytest

from gvcsim.singleflight import AsyncSingleFlightCache
from gvcsim.concurrency import WorkUnavailable


def test_singleflight_coalesces_concurrent_calls_and_reuses_success():
    async def scenario():
        cache: AsyncSingleFlightCache[str, object] = AsyncSingleFlightCache(maxsize=2)
        started = asyncio.Event()
        release = asyncio.Event()
        value = object()
        calls = 0

        async def factory():
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return value

        waiters = [asyncio.create_task(cache.get_or_compute("same", factory)) for _ in range(8)]
        await started.wait()
        await asyncio.sleep(0)
        assert calls == 1
        assert cache.inflight_count == 1
        release.set()
        results = await asyncio.gather(*waiters)
        assert all(result is value for result in results)
        assert cache.inflight_count == 0
        assert cache.completed_count == 1
        assert await cache.get_or_compute("same", factory) is value
        assert calls == 1

    asyncio.run(scenario())


def test_singleflight_does_not_cache_failures_and_keeps_shared_work_after_one_waiter_cancels():
    async def scenario():
        cache: AsyncSingleFlightCache[str, str] = AsyncSingleFlightCache()
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def slow_factory():
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return "done"

        cancelled = asyncio.create_task(cache.get_or_compute("work", slow_factory))
        survivor = asyncio.create_task(cache.get_or_compute("work", slow_factory))
        await started.wait()
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        assert cache.inflight_count == 1
        release.set()
        assert await survivor == "done"
        assert calls == 1

        async def fail():
            raise ValueError("retry me")

        with pytest.raises(ValueError, match="retry me"):
            await cache.get_or_compute("failure", fail)
        assert cache.completed_count == 1

        async def recover():
            return "recovered"

        assert await cache.get_or_compute("failure", recover) == "recovered"
        assert cache.completed_count == 2

    asyncio.run(scenario())


def test_singleflight_observes_failure_after_all_waiters_cancel():
    async def scenario():
        cache = AsyncSingleFlightCache()
        started = asyncio.Event()
        release = asyncio.Event()
        errors = []
        loop = asyncio.get_running_loop()
        loop.set_exception_handler(lambda _loop, context: errors.append(context))

        async def fail_later():
            started.set()
            await release.wait()
            raise ValueError("background work failed")

        waiter = asyncio.create_task(cache.get_or_compute("key", fail_later))
        await started.wait()
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        release.set()
        for _ in range(5):
            await asyncio.sleep(0)
        gc.collect()
        assert cache.inflight_count == cache.completed_count == 0
        assert errors == []
        assert await cache.get_or_compute("key", lambda: asyncio.sleep(0, result="retried")) == "retried"

    asyncio.run(scenario())


def test_singleflight_uses_lru_eviction_and_clear():
    async def scenario():
        cache: AsyncSingleFlightCache[str, str] = AsyncSingleFlightCache(maxsize=2)

        async def value(item: str):
            return item

        assert await cache.get_or_compute("a", lambda: value("a")) == "a"
        assert await cache.get_or_compute("b", lambda: value("b")) == "b"
        assert await cache.get_or_compute("a", lambda: value("wrong")) == "a"
        assert await cache.get_or_compute("c", lambda: value("c")) == "c"
        assert await cache.get_or_compute("b", lambda: value("new-b")) == "new-b"
        assert cache.completed_count == 2
        cache.clear()
        assert cache.completed_count == 0

    asyncio.run(scenario())


def test_inflight_capacity_and_owner_limit_do_not_reject_shared_waiters():
    async def scenario():
        cache = AsyncSingleFlightCache(max_inflight=2)
        release = asyncio.Event()
        started = asyncio.Event()

        async def work():
            started.set()
            await release.wait()
            return "ok"

        one = asyncio.create_task(cache.get_or_compute("a", work, owner=1))
        await started.wait()
        with pytest.raises(WorkUnavailable, match="任务较多"):
            await cache.get_or_compute("b", work, owner=1)
        two = asyncio.create_task(cache.get_or_compute("b", work, owner=2))
        await asyncio.sleep(0)
        with pytest.raises(WorkUnavailable):
            await cache.get_or_compute("c", work, owner=3)
        joined = asyncio.create_task(
            cache.get_or_compute("a", work, owner=3, admit=lambda: pytest.fail("join charged"))
        )
        release.set()
        assert await asyncio.gather(one, two, joined) == ["ok", "ok", "ok"]
        assert cache.inflight_count == 0

    asyncio.run(scenario())


def test_cancelled_flight_cannot_remove_or_overwrite_its_immediate_replacement():
    async def scenario():
        cache = AsyncSingleFlightCache()
        started, finish_old = asyncio.Event(), asyncio.Event()

        async def old():
            started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                await finish_old.wait()
                return "old result"

        waiter = asyncio.create_task(cache.get_or_compute("key", old, owner=1))
        await started.wait()
        waiter.cancel()
        await asyncio.gather(waiter, return_exceptions=True)
        assert cache.inflight_count == 0
        assert await cache.get_or_compute("key", lambda: asyncio.sleep(0, result="new result"), owner=1) == "new result"
        finish_old.set()
        for _ in range(4):
            await asyncio.sleep(0)
        assert await cache.get_or_compute("key", lambda: asyncio.sleep(0, result="wrong")) == "new result"

    asyncio.run(scenario())
