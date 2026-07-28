"""跨线程/跨 worker 的 CPU 容量闸门测试。"""

from __future__ import annotations

import multiprocessing
import os
import threading
import time
from pathlib import Path

import anyio
import pytest

from gvcsim import concurrency, config


def _configure(monkeypatch: pytest.MonkeyPatch, runtime_dir: Path, *, cpu: int, queue: int, timeout: float) -> None:
    monkeypatch.setattr(config, "RUNTIME_DIR", runtime_dir)
    monkeypatch.setattr(config, "CPU_CONCURRENCY", cpu)
    monkeypatch.setattr(config, "CPU_QUEUE_SIZE", queue)
    monkeypatch.setattr(config, "CPU_ACQUIRE_TIMEOUT_SECONDS", timeout)
    monkeypatch.setattr(config, "CPU_RETRY_AFTER_SECONDS", 2)
    monkeypatch.setattr(config, "REGRESSION_CPU_PERMITS", 1)
    monkeypatch.setattr(config, "PLACEBO_CPU_PERMITS", min(2, cpu))
    monkeypatch.setattr(config, "REPORT_CPU_PERMITS", min(2, cpu))


def _child_holds_slot(runtime_dir: str, pipe) -> None:
    """multiprocessing target 必须位于模块顶层，才能同时兼容 fork/spawn。"""
    config.RUNTIME_DIR = Path(runtime_dir)
    config.CPU_CONCURRENCY = 1
    config.CPU_QUEUE_SIZE = 2
    config.CPU_ACQUIRE_TIMEOUT_SECONDS = 1.0
    config.CPU_RETRY_AFTER_SECONDS = 1
    config.REGRESSION_CPU_PERMITS = 1
    config.PLACEBO_CPU_PERMITS = 1
    config.REPORT_CPU_PERMITS = 1
    with concurrency.cpu_workload("child"):
        pipe.send("locked")
        pipe.recv()
    pipe.close()


def test_capacity_snapshot_is_read_only_and_does_not_scan_business_locks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _configure(monkeypatch, tmp_path, cpu=3, queue=5, timeout=0.2)
    monkeypatch.setattr(
        concurrency,
        "_try_lock",
        lambda _path: (_ for _ in ()).throw(AssertionError("capacity snapshot must not acquire flock")),
    )
    snapshot = concurrency.capacity_snapshot()
    assert snapshot == {
        "coordination": "cross-process-flock",
        "queue_policy": "fifo",
        "cpu_permits_total": 3,
        "admission_total": 5,
        "acquire_timeout_seconds": 0.2,
    }


def test_admission_queue_is_bounded_without_waiting(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, tmp_path, cpu=1, queue=1, timeout=0.2)

    with concurrency.cpu_workload("first"):
        with pytest.raises(concurrency.CapacityExceeded) as exc:
            with concurrency.cpu_workload("second"):
                pass

    assert exc.value.reason == "queue_full"
    assert exc.value.retry_after == 2


def test_weighted_job_times_out_and_releases_admission(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, tmp_path, cpu=2, queue=3, timeout=0.05)

    with concurrency.cpu_workload("report", permits=2):
        with pytest.raises(concurrency.CapacityExceeded) as exc:
            with concurrency.cpu_workload("regression"):
                pass
        assert exc.value.reason == "wait_timeout"
        remaining_admission = concurrency._try_acquire("admission", 3, 2)
        assert remaining_admission is not None
        remaining_admission.release()


def test_later_light_job_cannot_bypass_waiting_weighted_job(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """持续轻任务能插队的旧实现会在 blocker 释放前先运行 light。"""
    _configure(monkeypatch, tmp_path, cpu=2, queue=4, timeout=1.5)
    blocker = concurrency._try_acquire("cpu", 2, 1)
    assert blocker is not None

    heavy_entered = threading.Event()
    release_heavy = threading.Event()
    light_entered = threading.Event()
    errors: list[BaseException] = []
    order: list[str] = []

    def heavy() -> None:
        try:
            with concurrency.cpu_workload("report", permits=2):
                order.append("heavy")
                heavy_entered.set()
                assert release_heavy.wait(timeout=1)
        except BaseException as error:
            errors.append(error)

    def light() -> None:
        try:
            with concurrency.cpu_workload("regression"):
                order.append("light")
                light_entered.set()
        except BaseException as error:
            errors.append(error)

    heavy_thread = threading.Thread(target=heavy)
    light_thread = threading.Thread(target=light)
    try:
        heavy_thread.start()
        deadline = time.monotonic() + 0.5
        while len(concurrency._queue_ticket_paths()) != 1 and time.monotonic() < deadline:
            time.sleep(0.005)
        assert len(concurrency._queue_ticket_paths()) == 1

        light_thread.start()
        deadline = time.monotonic() + 0.5
        while len(concurrency._queue_ticket_paths()) != 2 and time.monotonic() < deadline:
            time.sleep(0.005)
        assert len(concurrency._queue_ticket_paths()) == 2

        # 还有一个空闲 CPU 槽，但后来的轻任务不能越过需要两个槽的队首。
        assert not light_entered.wait(timeout=0.1)
        blocker.release()
        blocker = None
        assert heavy_entered.wait(timeout=0.7)
        assert not light_entered.is_set()
        assert order == ["heavy"]
        release_heavy.set()
        assert light_entered.wait(timeout=0.7)
    finally:
        release_heavy.set()
        if blocker is not None:
            blocker.release()
        heavy_thread.join(timeout=2)
        light_thread.join(timeout=2)

    assert not heavy_thread.is_alive()
    assert not light_thread.is_alive()
    assert errors == []
    assert order == ["heavy", "light"]


def test_abandoned_queue_ticket_is_removed_after_worker_crash(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, tmp_path, cpu=2, queue=4, timeout=0.2)
    abandoned = concurrency._try_create_queue_ticket()
    assert abandoned is not None and abandoned.descriptor is not None
    descriptor = abandoned.descriptor
    abandoned.descriptor = None
    concurrency._LockSet([descriptor]).release()
    assert abandoned.path.exists()

    successor = concurrency._try_create_queue_ticket()
    assert successor is not None
    try:
        assert concurrency._try_is_queue_head(successor) is True
        assert not abandoned.path.exists()
    finally:
        successor.release()


def test_async_queue_wait_does_not_borrow_default_thread_token(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, tmp_path, cpu=1, queue=2, timeout=0.5)

    async def scenario() -> None:
        default_limiter = anyio.to_thread.current_default_thread_limiter()
        previous_tokens = default_limiter.total_tokens
        blocker = concurrency._try_acquire("cpu", 1, 1)
        assert blocker is not None

        async def queued_workload() -> None:
            async with concurrency.async_cpu_workload("queued"):
                pass

        try:
            default_limiter.total_tokens = 1
            async with anyio.create_task_group() as tasks:
                tasks.start_soon(queued_workload)
                with anyio.fail_after(0.3):
                    while len(concurrency._queue_ticket_paths()) != 1:
                        await anyio.sleep(0.005)

                # 排队任务已经在等待 CPU 槽；默认线程池仍应能立即承接鉴权/DB 等工作。
                with anyio.fail_after(0.3):
                    assert await anyio.to_thread.run_sync(lambda: "available") == "available"
                blocker.release()
                blocker = None
        finally:
            if blocker is not None:
                blocker.release()
            default_limiter.total_tokens = previous_tokens

    anyio.run(scenario)


def test_cpu_computation_uses_a_limiter_separate_from_sync_endpoints(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _configure(monkeypatch, tmp_path, cpu=1, queue=2, timeout=0.2)

    async def scenario() -> None:
        default_limiter = anyio.to_thread.current_default_thread_limiter()
        previous_tokens = default_limiter.total_tokens
        try:
            default_limiter.total_tokens = 0
            with anyio.fail_after(0.3):
                assert await concurrency.run_cpu_bound(lambda: "computed") == "computed"
        finally:
            default_limiter.total_tokens = previous_tokens

    anyio.run(scenario)


def test_slot_scan_releases_partial_lease_when_later_lock_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _configure(monkeypatch, tmp_path, cpu=2, queue=3, timeout=0.2)
    original_try_lock = concurrency._try_lock
    acquired: list[int] = []
    calls = 0

    def fail_after_first_lock(path: Path) -> int | None:
        nonlocal calls
        calls += 1
        if calls == 1:
            descriptor = original_try_lock(path)
            assert descriptor is not None
            acquired.append(descriptor)
            return descriptor
        raise OSError("simulated descriptor exhaustion")

    monkeypatch.setattr(concurrency, "_try_lock", fail_after_first_lock)
    with pytest.raises(OSError, match="descriptor exhaustion"):
        concurrency._try_acquire("partial-failure", 2, 2)

    assert len(acquired) == 1
    with pytest.raises(OSError):
        os.fstat(acquired[0])


@pytest.mark.skipif(not hasattr(multiprocessing, "get_context"), reason="multiprocessing unavailable")
def test_cpu_slot_is_shared_across_worker_processes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, tmp_path, cpu=1, queue=2, timeout=0.08)
    context = multiprocessing.get_context("spawn")
    parent_pipe, child_pipe = context.Pipe()
    process = context.Process(target=_child_holds_slot, args=(str(tmp_path), child_pipe))
    process.start()
    try:
        assert parent_pipe.recv() == "locked"
        with pytest.raises(concurrency.CapacityExceeded) as exc:
            with concurrency.cpu_workload("parent"):
                pass
        assert exc.value.reason == "wait_timeout"
    finally:
        parent_pipe.send("release")
        process.join(timeout=3)
        if process.is_alive():
            process.terminate()
            process.join(timeout=3)
    assert process.exitcode == 0
