"""课堂混合任务的调度边界：CPU 排队不占满普通请求，报告 I/O 不阻塞事件循环。"""

import asyncio
import threading
from types import SimpleNamespace

import anyio

from gvcsim import concurrency
from gvcsim.classroom import routes
from gvcsim.singleflight import AsyncSingleFlightCache


def test_report_database_and_learning_state_run_outside_event_loop(monkeypatch):
    async def scenario():
        loop_thread = threading.get_ident()
        observed = []

        def check(label):
            observed.append(label)
            assert threading.get_ident() != loop_thread, f"{label} blocked the event loop"

        def workspace(username):
            check("workspace")
            return {}, None, {"updated_at": "version-1"}

        def build(session, name):
            check("build")
            return SimpleNamespace(markdown="# report", provenance={}, suggested_filename="report.md")

        def save(*args):
            check("save")
            assert args[-1] == "version-1"
            return {"state": "draft"}

        def learning(*args, **kwargs):
            check("learning")
            return {"completion": {}}

        monkeypatch.setattr(routes, "_workspace", workspace)
        monkeypatch.setattr(routes.teaching_report, "build", build)
        monkeypatch.setattr(routes.db, "save_generated_report", save)
        monkeypatch.setattr(routes, "_learning_state", learning)
        response = await routes.generate_report({"sub": "student"})
        assert response["report"]["state"] == "draft"
        assert observed == ["workspace", "build", "save", "learning"]

    anyio.run(scenario)


def test_duplicate_report_requests_share_one_build_but_later_request_rebuilds(monkeypatch):
    async def scenario():
        started = asyncio.Event()
        release = asyncio.Event()
        builds = 0

        def workspace(_username):
            return {}, None, {"updated_at": "version-1"}

        async def run_cpu_bound(_function, *_args):
            nonlocal builds
            builds += 1
            started.set()
            await release.wait()
            return SimpleNamespace(markdown="# report", provenance={}, suggested_filename="report.md")

        async def run_sync(function, *args):
            return function(*args)

        monkeypatch.setattr(routes, "_REPORT_FLIGHTS", AsyncSingleFlightCache())
        monkeypatch.setattr(routes, "_workspace", workspace)
        monkeypatch.setattr(routes.concurrency, "run_cpu_bound", run_cpu_bound)
        monkeypatch.setattr(routes.concurrency, "run_sync", run_sync)
        monkeypatch.setattr(routes.db, "save_generated_report", lambda *_args: {"state": "draft"})
        monkeypatch.setattr(routes, "_learning_state", lambda *_args, **_kwargs: {"completion": {}})
        user = {"sub": "student", "rid": "release", "aid": 1}

        requests = [asyncio.create_task(routes.generate_report(user)) for _ in range(50)]
        await started.wait()
        await asyncio.sleep(0)
        assert builds == 1
        release.set()
        assert len(await asyncio.gather(*requests)) == 50
        assert routes._REPORT_FLIGHTS.inflight_count == routes._REPORT_FLIGHTS.completed_count == 0

        await routes.generate_report(user)
        assert builds == 2

    anyio.run(scenario)


def test_mixed_cpu_jobs_are_bounded_and_coalesced_without_starving_saves(monkeypatch):
    async def scenario():
        monkeypatch.setattr(concurrency, "_CPU_LIMITER", anyio.CapacityLimiter(4))
        limiter = anyio.to_thread.current_default_thread_limiter()
        limiter.total_tokens = 8
        cache = AsyncSingleFlightCache()
        release = threading.Event()
        lock = threading.Lock()
        saturated = asyncio.Event()
        loop = asyncio.get_running_loop()
        active = peak = 0
        calls = []

        def work(key):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
                calls.append(key)
                if active == 4:
                    loop.call_soon_threadsafe(saturated.set)
            try:
                assert release.wait(5), "test failed to release CPU jobs"
                return key
            finally:
                with lock:
                    active -= 1

        async def compute(key):
            return await cache.get_or_compute(key, lambda: concurrency.run_cpu_bound(work, key))

        keys = ["run:trade", "run:length", "placebo:1", "report:1", "run:network", "placebo:2", "report:2"]
        tasks = [asyncio.create_task(compute(key)) for key in [*keys, *keys[:3]]]
        try:
            await asyncio.wait_for(saturated.wait(), 3)
            # 模拟普通会话保存的同步 I/O；CPU 队列仍被阻塞时，它必须能获得线程。
            saved = await asyncio.wait_for(anyio.to_thread.run_sync(lambda: "session-saved"), 1)
            assert saved == "session-saved"
            assert len(calls) == 4
            assert not any(task.done() for task in tasks)
        finally:
            release.set()
            results = await asyncio.gather(*tasks)
        assert results == [*keys, *keys[:3]]
        assert peak == 4 and active == 0
        assert sorted(calls) == sorted(keys)
        assert cache.inflight_count == 0
        assert cache.completed_count == len(keys)

    anyio.run(scenario)
