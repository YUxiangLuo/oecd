import asyncio

import pytest

from gvcsim.singleflight import AsyncSingleFlightCache


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
