"""One in-process limit for CPU-heavy classroom jobs."""

from __future__ import annotations

from collections.abc import Callable
from typing import ParamSpec, TypeVar

import anyio

P = ParamSpec("P")
T = TypeVar("T")
_CPU_LIMITER = anyio.CapacityLimiter(4)


async def run_cpu_bound(function: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    async with _CPU_LIMITER:
        return await anyio.to_thread.run_sync(lambda: function(*args, **kwargs))
