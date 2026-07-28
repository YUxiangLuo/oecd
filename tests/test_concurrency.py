"""跨线程/跨 worker 的 CPU 容量闸门测试。"""

from __future__ import annotations

import multiprocessing
import os
from pathlib import Path

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


def test_capacity_snapshot_tracks_active_weighted_lease(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, tmp_path, cpu=3, queue=5, timeout=0.2)

    with concurrency.cpu_workload("placebo", permits=2) as lease:
        snapshot = concurrency.capacity_snapshot()
        assert lease.permits == 2
        assert snapshot["cpu_permits_used"] == 2
        assert snapshot["admission_used"] == 1

    snapshot = concurrency.capacity_snapshot()
    assert snapshot["cpu_permits_used"] == 0
    assert snapshot["admission_used"] == 0


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
        assert concurrency.capacity_snapshot()["admission_used"] == 1


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
