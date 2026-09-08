"""Cancellation at ordinary-I/O boundaries must not abandon physical threads."""

import asyncio
import gc
import threading
from types import SimpleNamespace

import anyio
import psycopg
import pytest
from starlette.exceptions import HTTPException
from starlette.requests import Request

from gvcsim import api, concurrency, config, regression_routes
from gvcsim.classroom import routes
from gvcsim.regression.contracts import PlaceboRequest, RegressionRequest
from gvcsim.session import empty_session
from gvcsim.singleflight import AsyncSingleFlightCache


async def until(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0.001)


def student_request(disconnected: asyncio.Event) -> Request:
    async def receive():
        await disconnected.wait()
        return {"type": "http.disconnect"}

    return Request(
        {"type": "http", "state": {"user": {"role": "student", "aid": 1, "sub": "student"}}},
        receive=receive,
    )


@pytest.mark.parametrize("operation", ["run", "placebo"])
def test_regression_disconnect_during_panel_read_keeps_thread_and_cancels_queued_retry(monkeypatch, operation):
    async def scenario():
        limiter = anyio.to_thread.current_default_thread_limiter()
        limiter.total_tokens = 1
        cache = AsyncSingleFlightCache(max_inflight=1)
        monkeypatch.setattr(regression_routes, "_RESULT_CACHE", cache)
        monkeypatch.setattr(regression_routes.artifacts, "release_identity", lambda: "a" * 32)
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        reads, computations = [], []

        def read(_name):
            reads.append(1)
            started.set()
            try:
                assert release.wait(5)
                return object()
            finally:
                finished.set()

        async def compute(function, *_args, **_kwargs):
            computations.append(function)
            if operation == "run":
                return SimpleNamespace(to_dict=lambda: {"status": "ok", "support": {}}), {}
            return {"draws": []}

        monkeypatch.setattr(regression_routes, "_read_csv", read)
        monkeypatch.setattr(regression_routes.concurrency, "run_cpu_bound", compute)
        route = (
            regression_routes.regression_run_http if operation == "run" else regression_routes.regression_placebo_http
        )
        payload = RegressionRequest(outcome="trade") if operation == "run" else PlaceboRequest(outcome="trade")
        disconnected, retry_disconnected = asyncio.Event(), asyncio.Event()
        first = asyncio.create_task(route(payload, student_request(disconnected)))
        retry = None
        try:
            await until(started.is_set)
            disconnected.set()
            with pytest.raises(HTTPException) as leaving:
                await first
            assert leaving.value.status_code == 499
            await until(lambda: cache.inflight_count == 0)
            assert limiter.borrowed_tokens == 1
            assert not finished.is_set()

            retry = asyncio.create_task(route(payload, student_request(retry_disconnected)))
            await until(lambda: limiter.statistics().tasks_waiting == 1)
            retry_disconnected.set()
            with pytest.raises(HTTPException) as queued:
                await retry
            assert queued.value.status_code == 499
            await until(lambda: limiter.statistics().tasks_waiting == 0)
            assert reads == [1]
            assert computations == []
            assert limiter.borrowed_tokens == 1
        finally:
            release.set()
            disconnected.set()
            retry_disconnected.set()
            await asyncio.gather(first, *([retry] if retry is not None else []), return_exceptions=True)
            await until(finished.is_set)
            await concurrency.shutdown()

        assert limiter.borrowed_tokens == 0
        assert computations == []  # A cancelled panel read must not proceed to CPU work.
        assert cache.inflight_count == cache.completed_count == 0
        assert isinstance(await route(payload, student_request(asyncio.Event())), dict)
        assert reads == [1, 1]
        assert len(computations) == 1

    anyio.run(scenario)


def stub_report(monkeypatch):
    monkeypatch.setattr(routes, "_workspace", lambda _username: ({}, None, {"updated_at": "version-1"}))
    monkeypatch.setattr(
        routes.teaching_report,
        "build",
        lambda *_args: SimpleNamespace(markdown="# report", provenance={}, suggested_filename="report.md"),
    )
    monkeypatch.setattr(routes.db, "save_generated_report", lambda *_args: {"state": "draft"})
    monkeypatch.setattr(routes, "_learning_state", lambda *_args, **_kwargs: {"completion": {}})


@pytest.mark.parametrize("phase", ["workspace", "save", "learning"])
def test_report_cancellation_retains_thread_at_each_sync_boundary(monkeypatch, phase):
    async def scenario():
        limiter = anyio.to_thread.current_default_thread_limiter()
        limiter.total_tokens = 1
        stub_report(monkeypatch)
        target, name = {
            "workspace": (routes, "_workspace"),
            "save": (routes.db, "save_generated_report"),
            "learning": (routes, "_learning_state"),
        }[phase]
        original = getattr(target, name)
        started, release, finished = threading.Event(), threading.Event(), threading.Event()

        def held(*args, **kwargs):
            started.set()
            try:
                assert release.wait(5)
                return original(*args, **kwargs)
            finally:
                finished.set()

        monkeypatch.setattr(target, name, held)
        request = asyncio.create_task(routes.generate_report({"sub": "student"}))
        try:
            await until(started.is_set)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert limiter.borrowed_tokens == 1
            assert not finished.is_set()
        finally:
            release.set()
            await asyncio.gather(request, return_exceptions=True)
            await until(finished.is_set)
            await concurrency.shutdown()
        assert limiter.borrowed_tokens == 0

    anyio.run(scenario)


@pytest.mark.parametrize("phase", ["workspace", "build"])
def test_report_disconnect_during_preparation_never_saves(monkeypatch, phase):
    async def scenario():
        stub_report(monkeypatch)
        started, release = threading.Event(), threading.Event()
        target, name = (routes, "_workspace") if phase == "workspace" else (routes.teaching_report, "build")
        original = getattr(target, name)
        saves = []

        def held(*args):
            started.set()
            assert release.wait(5)
            return original(*args)

        monkeypatch.setattr(target, name, held)
        monkeypatch.setattr(routes.db, "save_generated_report", lambda *args: saves.append(args))
        disconnected = asyncio.Event()
        request = asyncio.create_task(routes.generate_report_http(student_request(disconnected), {"sub": "student"}))
        try:
            await until(started.is_set)
            disconnected.set()
            with pytest.raises(HTTPException) as leaving:
                await request
            assert leaving.value.status_code == 499
        finally:
            release.set()
            disconnected.set()
            await asyncio.gather(request, return_exceptions=True)
            await concurrency.shutdown()
        assert saves == []

    anyio.run(scenario)


def test_report_disconnect_does_not_cancel_the_commit_phase(monkeypatch):
    async def scenario():
        stub_report(monkeypatch)
        started, release = threading.Event(), threading.Event()

        def save(*args):
            assert args[-1] == "version-1"
            started.set()
            assert release.wait(5)
            return {"state": "draft"}

        monkeypatch.setattr(routes.db, "save_generated_report", save)
        disconnected = asyncio.Event()
        request = asyncio.create_task(routes.generate_report_http(student_request(disconnected), {"sub": "student"}))
        try:
            await until(started.is_set)
            disconnected.set()
            # A lost response must not turn the still-running commit into a
            # cancelled/untracked request, even though computation is cancellable.
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(request), 0.05)
            release.set()
            response = await request
            assert response["report"] == {"state": "draft", "suggested_filename": "report.md"}
            assert response["completion"] == {}
        finally:
            release.set()
            await asyncio.gather(request, return_exceptions=True)
            await concurrency.shutdown()

    anyio.run(scenario)


@pytest.mark.parametrize("fail_after_cancel", [False, True])
def test_sync_io_admission_queue_cancellation_and_shutdown(monkeypatch, fail_after_cancel):
    async def scenario():
        limiter = anyio.to_thread.current_default_thread_limiter()
        limiter.total_tokens = 1
        admission = anyio.CapacityLimiter(2)
        monkeypatch.setattr(concurrency, "_SYNC_ADMISSION", admission)
        started, release = threading.Event(), threading.Event()
        errors, queued_calls = [], []
        asyncio.get_running_loop().set_exception_handler(lambda _loop, context: errors.append(context))

        def held():
            started.set()
            assert release.wait(5)
            if fail_after_cancel:
                raise ValueError("late I/O failure")
            return "done"

        first = asyncio.create_task(concurrency.run_sync(held))
        queued = stopping = None
        try:
            await until(started.is_set)
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first
            assert limiter.borrowed_tokens == admission.borrowed_tokens == 1
            assert len(concurrency._sync_workers) == 1

            queued = asyncio.create_task(concurrency.run_sync(queued_calls.append, "obsolete"))
            await until(lambda: limiter.statistics().tasks_waiting == 1)
            with pytest.raises(concurrency.WorkUnavailable) as full:
                await concurrency.run_sync(lambda: pytest.fail("overflow I/O ran"))
            assert full.value.code == "work_queue_full"
            queued.cancel()
            with pytest.raises(asyncio.CancelledError):
                await queued
            await until(lambda: admission.borrowed_tokens == 1)
            assert limiter.statistics().tasks_waiting == 0

            stopping = asyncio.create_task(concurrency.shutdown())
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(stopping), 0.05)
            assert limiter.borrowed_tokens == admission.borrowed_tokens == 1
        finally:
            release.set()
            if queued is not None:
                queued.cancel()
            await asyncio.gather(first, *([queued] if queued is not None else []), return_exceptions=True)
            if stopping is not None:
                await stopping
            await concurrency.shutdown()

        assert queued_calls == []
        assert not concurrency._sync_workers
        assert limiter.borrowed_tokens == admission.borrowed_tokens == 0
        gc.collect()
        assert errors == []
        assert await concurrency.run_sync(lambda left, *, right: left + right, 2, right=3) == 5

    anyio.run(scenario)


def test_sync_io_cancellation_between_dispatch_and_function_entry(monkeypatch):
    async def scenario():
        limiter = anyio.to_thread.current_default_thread_limiter()
        limiter.total_tokens = 1
        original = anyio.to_thread.run_sync
        dispatched, release = threading.Event(), threading.Event()
        calls = []

        async def delayed_entry(function):
            def invoke():
                dispatched.set()
                assert release.wait(5)
                return function()

            return await original(invoke)

        monkeypatch.setattr(anyio.to_thread, "run_sync", delayed_entry)
        request = asyncio.create_task(concurrency.run_sync(calls.append, "finished"))
        try:
            await until(dispatched.is_set)
            assert calls == []
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert limiter.borrowed_tokens == 1
        finally:
            release.set()
            await asyncio.gather(request, return_exceptions=True)
            await concurrency.shutdown()
        assert calls == ["finished"]
        assert limiter.borrowed_tokens == 0

    anyio.run(scenario)


def test_sync_io_shared_reader_survives_one_waiter_leaving():
    async def scenario():
        cache = AsyncSingleFlightCache()
        started, release = threading.Event(), threading.Event()
        calls = []

        def read():
            calls.append(1)
            started.set()
            assert release.wait(5)
            return "shared panel"

        async def compute():
            return await concurrency.run_sync(read)

        leaving = asyncio.create_task(cache.get_or_compute("panel", compute))
        staying = asyncio.create_task(cache.get_or_compute("panel", compute))
        try:
            await until(started.is_set)
            leaving.cancel()
            with pytest.raises(asyncio.CancelledError):
                await leaving
            assert cache.inflight_count == 1
            release.set()
            assert await staying == "shared panel"
            assert cache.completed_count == 1
            assert calls == [1]
        finally:
            release.set()
            await asyncio.gather(leaving, staying, return_exceptions=True)
            await concurrency.shutdown()

    anyio.run(scenario)


def test_sync_io_failure_propagates_without_leaking_admission(monkeypatch):
    async def scenario():
        admission = anyio.CapacityLimiter(1)
        monkeypatch.setattr(concurrency, "_SYNC_ADMISSION", admission)

        def fail():
            raise ValueError("read failed")

        with pytest.raises(ValueError, match="read failed"):
            await concurrency.run_sync(fail)
        assert not concurrency._sync_workers
        assert admission.borrowed_tokens == 0
        assert await concurrency.run_sync(lambda: "recovered") == "recovered"

    anyio.run(scenario)


def test_lifespan_drains_detached_io_before_closing_database_pool(monkeypatch):
    async def scenario():
        started, release, closed = threading.Event(), threading.Event(), threading.Event()
        monkeypatch.setattr(api.classroom_db, "startup", lambda: None)
        monkeypatch.setattr(api.classroom_db, "shutdown", closed.set)
        monkeypatch.setattr(api, "validate_startup_data", lambda: None)

        def held():
            started.set()
            assert release.wait(5)
            assert not closed.is_set()

        lifespan = api.lifespan(api.app)
        await lifespan.__aenter__()
        request = asyncio.create_task(concurrency.run_sync(held))
        stopping = None
        try:
            await until(started.is_set)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            stopping = asyncio.create_task(lifespan.__aexit__(None, None, None))
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(stopping), 0.05)
            assert not closed.is_set()
        finally:
            release.set()
            await asyncio.gather(request, return_exceptions=True)
            if stopping is None:
                await lifespan.__aexit__(None, None, None)
            else:
                await stopping
        assert closed.is_set()
        assert not concurrency._sync_workers

    anyio.run(scenario)


def test_report_disconnect_during_real_row_lock_preserves_transaction(teaching_db, monkeypatch):
    db = teaching_db
    saved = db.save_session("student", empty_session())
    assert saved is not None
    monkeypatch.setattr(
        routes.teaching_report,
        "build",
        lambda *_args: SimpleNamespace(
            markdown="# committed after disconnect", provenance={}, suggested_filename="r.md"
        ),
    )
    # This test exercises the real transaction, not release-dependent report gates.
    monkeypatch.setattr(routes, "_learning_state", lambda *_args, **_kwargs: {"completion": {}})
    original = db.save_generated_report
    started = threading.Event()

    def save(*args):
        assert args[-1] == saved["updated_at"]
        started.set()
        return original(*args)

    monkeypatch.setattr(db, "save_generated_report", save)
    with psycopg.connect(config.PG_DSN) as locker:
        locker.execute("SELECT updated_at FROM experiment_sessions FOR UPDATE")

        async def scenario():
            disconnected = asyncio.Event()
            request = asyncio.create_task(
                routes.generate_report_http(student_request(disconnected), {"sub": "student"})
            )
            try:
                await until(started.is_set)
                disconnected.set()
                with pytest.raises(TimeoutError):
                    await asyncio.wait_for(asyncio.shield(request), 0.05)
                locker.commit()
                response = await request
                assert response["report"]["markdown"] == "# committed after disconnect"
                assert response["report"]["state"] == "draft"
            finally:
                locker.rollback()
                await asyncio.gather(request, return_exceptions=True)
                await concurrency.shutdown()

        anyio.run(scenario)
    assert db.latest_report("student")["markdown"] == "# committed after disconnect"
