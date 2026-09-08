"""Real thread, cancellation and bounded-admission regression tests."""

import asyncio
import threading

import anyio
import pytest
from starlette.exceptions import HTTPException
from starlette.requests import Request

from gvcsim import concurrency
from gvcsim.singleflight import AsyncSingleFlightCache


async def until(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0.001)


def test_last_waiter_cancellation_removes_queued_work_and_keeps_real_running_limit(monkeypatch):
    async def scenario():
        monkeypatch.setattr(concurrency, "_CPU_LIMITER", anyio.CapacityLimiter(1))
        monkeypatch.setattr(concurrency, "_CPU_ADMISSION", anyio.CapacityLimiter(3))
        release = threading.Event()
        started = threading.Event()
        called = []

        def held():
            started.set()
            assert release.wait(5)

        running = asyncio.create_task(concurrency.run_cpu_bound(held))
        await until(started.is_set)
        cache = AsyncSingleFlightCache()
        queued = asyncio.create_task(
            cache.get_or_compute("queued", lambda: concurrency.run_cpu_bound(called.append, 1))
        )
        await until(lambda: concurrency._CPU_LIMITER.statistics().tasks_waiting == 1)
        queued.cancel()
        await asyncio.gather(queued, return_exceptions=True)
        await until(lambda: concurrency._CPU_LIMITER.statistics().tasks_waiting == 0)
        assert cache.inflight_count == 0
        running.cancel()
        await asyncio.gather(running, return_exceptions=True)
        # An uncooperative thread must retain both its physical slot and admission.
        assert concurrency._CPU_LIMITER.borrowed_tokens == 1
        assert concurrency._CPU_ADMISSION.borrowed_tokens == 1
        followup = asyncio.create_task(concurrency.run_cpu_bound(called.append, 2))
        try:
            await until(lambda: concurrency._CPU_LIMITER.statistics().tasks_waiting == 1)
            assert called == []
        finally:
            release.set()
        await followup
        await concurrency.shutdown()
        assert called == [2]
        assert concurrency._CPU_ADMISSION.borrowed_tokens == 0

    anyio.run(scenario)


def test_job_queue_is_bounded_and_has_a_deadline(monkeypatch):
    async def scenario():
        monkeypatch.setattr(concurrency, "_CPU_LIMITER", anyio.CapacityLimiter(1))
        monkeypatch.setattr(concurrency, "_CPU_ADMISSION", anyio.CapacityLimiter(2))
        monkeypatch.setattr(concurrency, "QUEUE_TIMEOUT_SECONDS", 0.05)
        started, release = threading.Event(), threading.Event()

        def held():
            started.set()
            assert release.wait(5)

        first = asyncio.create_task(concurrency.run_cpu_bound(held))
        await until(started.is_set)
        second = asyncio.create_task(concurrency.run_cpu_bound(lambda: pytest.fail("expired job ran")))
        await until(lambda: concurrency._CPU_ADMISSION.borrowed_tokens == 2)
        try:
            with pytest.raises(concurrency.WorkUnavailable) as full:
                await concurrency.run_cpu_bound(lambda: pytest.fail("overflow job ran"))
            assert full.value.code == "work_queue_full"
            with pytest.raises(concurrency.WorkUnavailable) as expired:
                await second
            assert expired.value.code == "work_queue_timeout"
        finally:
            release.set()
            await first
        assert await concurrency.run_cpu_bound(lambda: "recovered") == "recovered"

    anyio.run(scenario)


def test_raw_reads_cannot_borrow_auth_and_save_threads(monkeypatch):
    async def scenario():
        monkeypatch.setattr(concurrency, "_RAW_LIMITER", anyio.CapacityLimiter(2))
        monkeypatch.setattr(concurrency, "_RAW_THREADS", anyio.CapacityLimiter(2))
        anyio.to_thread.current_default_thread_limiter().total_tokens = 1
        release = threading.Event()
        started = []

        def read():
            started.append(1)
            assert release.wait(5)

        readers = [asyncio.create_task(concurrency.run_raw_io(read)) for _ in range(50)]
        try:
            await until(lambda: len(started) == 2)
            assert await asyncio.wait_for(anyio.to_thread.run_sync(lambda: "saved"), 1) == "saved"
            assert anyio.to_thread.current_default_thread_limiter().borrowed_tokens == 0
        finally:
            release.set()
            await asyncio.gather(*readers)

    anyio.run(scenario)


def test_disconnect_cancels_one_request_without_cancelling_other_student():
    async def scenario():
        disconnected = asyncio.Event()
        release = asyncio.Event()
        started = asyncio.Event()
        cache = AsyncSingleFlightCache()

        async def receive():
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async def work():
            started.set()
            await release.wait()
            return "shared result"

        async def run():
            return await cache.get_or_compute("same", work)

        request = Request({"type": "http"}, receive=receive)
        leaving = asyncio.create_task(concurrency.for_request(request, run))
        staying = asyncio.create_task(run())
        await started.wait()
        disconnected.set()
        with pytest.raises(HTTPException) as error:
            await leaving
        assert error.value.status_code == 499
        assert cache.inflight_count == 1
        release.set()
        assert await staying == "shared result"

    anyio.run(scenario)


def test_compute_deadline_responds_without_releasing_a_running_thread(monkeypatch):
    async def scenario():
        monkeypatch.setattr(concurrency, "_CPU_LIMITER", anyio.CapacityLimiter(1))
        monkeypatch.setattr(concurrency, "QUEUE_TIMEOUT_SECONDS", 0.02)
        monkeypatch.setattr(concurrency, "WORK_TIMEOUT_SECONDS", 0.02)
        release = threading.Event()
        try:
            with pytest.raises(concurrency.WorkUnavailable) as error:
                await concurrency.run_cpu_bound(lambda: release.wait(5))
            assert error.value.code == "work_deadline_exceeded"
            assert concurrency._CPU_LIMITER.borrowed_tokens == 1
        finally:
            release.set()
            await concurrency.shutdown()
        assert concurrency._CPU_LIMITER.borrowed_tokens == 0

    anyio.run(scenario)
