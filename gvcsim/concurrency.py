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
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import ParamSpec, TypeVar

import anyio

from gvcsim import config

P = ParamSpec("P")
T = TypeVar("T")


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
        # 即使某个 unlock/close 失败，也必须继续处理其余 descriptor；close 本身
        # 会释放 flock，所以优先保证不会因一个坏 fd 逐步蚕食全机容量。
        descriptors = list(reversed(self.descriptors))
        self.descriptors.clear()
        first_error: BaseException | None = None
        for descriptor in descriptors:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            except BaseException as error:
                first_error = first_error or error
            try:
                os.close(descriptor)
            except BaseException as error:
                first_error = first_error or error
        if first_error is not None:
            raise first_error


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
    try:
        for offset in range(size):
            descriptor = _try_lock(paths[(start + offset) % size])
            if descriptor is not None:
                held.append(descriptor)
                if len(held) == permits:
                    return _LockSet(held)
    except BaseException as error:
        try:
            _LockSet(held).release()
        except BaseException as cleanup_error:
            error.add_note(f"释放部分容量租约时又发生异常：{cleanup_error}")
        raise
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
        try:
            if compute is not None:
                compute.release()
        finally:
            # compute 清理异常也不能跳过 admission，否则队列容量会永久缩小。
            admission.release()


@asynccontextmanager
async def async_cpu_workload(workload: str, *, permits: int = 1) -> AsyncIterator[WorkloadLease]:
    """异步等待全机计算租约，不在排队期间占用 AnyIO 默认线程令牌。"""
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
            await anyio.sleep(min(remaining, 0.02 + random.random() * 0.03))
        yield WorkloadLease(
            workload=workload,
            permits=permits,
            waited_seconds=max(0.0, time.monotonic() - started),
        )
    finally:
        try:
            if compute is not None:
                compute.release()
        finally:
            admission.release()


_compute_thread_limiter: anyio.CapacityLimiter | None = None


def _compute_limiter() -> anyio.CapacityLimiter:
    """返回与默认同步端点线程池隔离的本 worker 计算限流器。"""
    global _compute_thread_limiter
    expected_tokens = config.CPU_CONCURRENCY
    limiter = _compute_thread_limiter
    if limiter is None or limiter.total_tokens != expected_tokens:
        if limiter is not None and limiter.borrowed_tokens:
            raise RuntimeError("计算线程限流器仍有在途任务，不能在线修改容量")
        limiter = anyio.CapacityLimiter(expected_tokens)
        _compute_thread_limiter = limiter
    return limiter


async def run_cpu_bound(function: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    """在独立线程预算中运行已经取得全机 permit 的同步计算。"""
    if kwargs:
        from functools import partial

        call = partial(function, *args, **kwargs)
        return await anyio.to_thread.run_sync(call, abandon_on_cancel=False, limiter=_compute_limiter())
    return await anyio.to_thread.run_sync(
        function,
        *args,
        abandon_on_cancel=False,
        limiter=_compute_limiter(),
    )


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
