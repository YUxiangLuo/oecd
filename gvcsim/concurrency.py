"""跨 Uvicorn worker 的有界 CPU 工作负载调度。

回归、安慰剂和报告复估会释放 GIL 并调用 NumPy/SciPy；如果 100 个请求同时
进入，操作系统会让每个任务都变慢并显著放大内存峰值。本模块使用 Linux
``flock`` 实现进程崩溃自动释放的全机共享槽：

1. admission 槽限制运行中 + 等待中的请求总数，拒绝无界排队；
2. cpu 槽限制真正同时计算的任务数，支持较重任务占多个 permit；
3. 等待有明确超时，调用方映射为带 ``Retry-After`` 的 429。

锁文件只保存互斥状态，不保存学生数据。部署时所有 worker 必须共享同一个
``GVCSIM_RUNTIME_DIR``（systemd 模板使用 ``/run/gvcsim``）。
"""

from __future__ import annotations

import fcntl
import os
import random
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from gvcsim import config


class CapacityExceeded(RuntimeError):
    """服务器负载队列已满或等待计算槽超时。"""

    def __init__(self, workload: str, reason: str, retry_after: int):
        self.workload = workload
        self.reason = reason
        self.retry_after = max(1, retry_after)
        message = "实验计算队列已满，请稍后重试" if reason == "queue_full" else "等待实验计算资源超时，请稍后重试"
        super().__init__(message)


@dataclass(frozen=True)
class WorkloadLease:
    workload: str
    permits: int
    waited_seconds: float


@dataclass
class _LockSet:
    descriptors: list[int]

    def release(self) -> None:
        for descriptor in reversed(self.descriptors):
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)
        self.descriptors.clear()


def _runtime_dir() -> Path:
    directory = config.RUNTIME_DIR
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not directory.is_dir():
        raise RuntimeError(f"并发运行目录不可用:{directory}")
    return directory


def _slot_paths(namespace: str, size: int) -> list[Path]:
    directory = _runtime_dir()
    return [directory / f"{namespace}.slot.{index:04d}" for index in range(size)]


def _try_lock(path: Path) -> int | None:
    flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return descriptor
    except BlockingIOError:
        os.close(descriptor)
        return None
    except BaseException:
        os.close(descriptor)
        raise


def _try_acquire(namespace: str, size: int, permits: int) -> _LockSet | None:
    paths = _slot_paths(namespace, size)
    # 每个线程从不同位置开始扫描，避免所有 worker 永远争抢 slot 0。
    start = (os.getpid() * 31 + threading.get_ident()) % size
    held: list[int] = []
    for offset in range(size):
        descriptor = _try_lock(paths[(start + offset) % size])
        if descriptor is not None:
            held.append(descriptor)
            if len(held) == permits:
                return _LockSet(held)
    _LockSet(held).release()
    return None


@contextmanager
def cpu_workload(workload: str, *, permits: int = 1) -> Iterator[WorkloadLease]:
    """取得一个有界计算租约；同机所有 API worker 共享容量。

    admission 槽不等待：已达到队列上限就立即拒绝。进入队列后等待 cpu permit，
    超时会释放 admission 槽，浏览器可按 ``Retry-After`` 重试。
    """
    config.validate_capacity_config()
    if permits <= 0 or permits > config.CPU_CONCURRENCY:
        raise ValueError(f"permits 必须在 1..{config.CPU_CONCURRENCY} 之间")

    admission = _try_acquire("admission", config.CPU_QUEUE_SIZE, 1)
    if admission is None:
        raise CapacityExceeded(workload, "queue_full", config.CPU_RETRY_AFTER_SECONDS)

    compute: _LockSet | None = None
    started = time.monotonic()
    deadline = started + config.CPU_ACQUIRE_TIMEOUT_SECONDS
    try:
        while compute is None:
            compute = _try_acquire("cpu", config.CPU_CONCURRENCY, permits)
            if compute is not None:
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CapacityExceeded(workload, "wait_timeout", config.CPU_RETRY_AFTER_SECONDS)
            time.sleep(min(remaining, 0.02 + random.random() * 0.03))
        yield WorkloadLease(
            workload=workload,
            permits=permits,
            waited_seconds=max(0.0, time.monotonic() - started),
        )
    finally:
        if compute is not None:
            compute.release()
        admission.release()


def _locked_count(namespace: str, size: int) -> int:
    locked = 0
    for path in _slot_paths(namespace, size):
        descriptor = _try_lock(path)
        if descriptor is None:
            locked += 1
        else:
            _LockSet([descriptor]).release()
    return locked


def capacity_snapshot() -> dict[str, int | float | str]:
    """返回不含用户数据的近似瞬时容量，供 readiness/运维观测。"""
    config.validate_capacity_config()
    return {
        "coordination": "cross-process-flock",
        "cpu_permits_total": config.CPU_CONCURRENCY,
        "cpu_permits_used": _locked_count("cpu", config.CPU_CONCURRENCY),
        "admission_total": config.CPU_QUEUE_SIZE,
        "admission_used": _locked_count("admission", config.CPU_QUEUE_SIZE),
        "acquire_timeout_seconds": config.CPU_ACQUIRE_TIMEOUT_SECONDS,
    }
