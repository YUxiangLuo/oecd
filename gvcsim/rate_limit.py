"""Bounded process-local sliding-window request limits.

The production service deliberately runs one Uvicorn worker, so a small
in-process limiter gives deterministic per-account protection without adding a
second persistence system. Nginx and Uvicorn still provide the outer connection
and body-size boundaries; this module protects password hashing and expensive
teaching computations after a request reaches the application.
"""

from __future__ import annotations

import math
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Callable, Hashable


class RateLimitExceeded(RuntimeError):
    def __init__(self, retry_after_seconds: float):
        self.retry_after_seconds = max(float(retry_after_seconds), 0.001)
        super().__init__("request rate limit exceeded")

    @property
    def retry_after_header(self) -> str:
        return str(max(1, math.ceil(self.retry_after_seconds)))


class SlidingWindowRateLimiter:
    """Thread-safe exact sliding window with bounded key retention."""

    def __init__(
        self,
        limit: int,
        window_seconds: float = 60.0,
        *,
        max_keys: int = 4096,
        clock: Callable[[], float] = time.monotonic,
    ):
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise ValueError("rate limit must be a positive integer")
        if window_seconds <= 0 or max_keys <= 0:
            raise ValueError("rate-limit window and max_keys must be positive")
        self.limit = limit
        self.window_seconds = float(window_seconds)
        self.max_keys = max_keys
        self._clock = clock
        self._events: OrderedDict[Hashable, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def check(self, key: Hashable, count: int = 1) -> None:
        """Record ``count`` events for ``key`` at once, or none of them when they do not all fit in the window."""
        if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= self.limit:
            raise ValueError("rate-limit count must be between 1 and the limit")
        now = float(self._clock())
        cutoff = now - self.window_seconds
        with self._lock:
            events = self._events.pop(key, deque())
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) + count > self.limit:
                self._events[key] = events
                # Room for `count` events once the oldest (len + count − limit) of them have left the window.
                raise RateLimitExceeded(events[len(events) + count - self.limit - 1] + self.window_seconds - now)
            events.extend([now] * count)
            self._events[key] = events
            while len(self._events) > self.max_keys:
                self._events.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._events.clear()
