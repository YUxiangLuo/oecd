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
        self._pending: dict[object, tuple[Hashable, int]] = {}
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
            pending = sum(amount for account, amount in self._pending.values() if account == key)
            if len(events) + pending + count > self.limit:
                self._events[key] = events
                # Room for `count` events once the oldest (len + count − limit) of them have left the window.
                raise RateLimitExceeded(
                    events[min(len(events) - 1, len(events) + pending + count - self.limit - 1)]
                    + self.window_seconds
                    - now
                    if events
                    else self.window_seconds
                )
            events.extend([now] * count)
            self._events[key] = events
            while len(self._events) > self.max_keys:
                self._events.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._events.clear()
            self._pending.clear()

    def reserve(self, key: Hashable, count: int = 1) -> object:
        """Admit before work without charging it; commit only after success.

        Reservations participate in admission, so concurrent work cannot exceed
        the budget or discover a 429 after it has already succeeded.
        """
        if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= self.limit:
            raise ValueError("rate-limit count must be between 1 and the limit")
        now = float(self._clock())
        with self._lock:
            events = self._events.get(key, deque())
            while events and events[0] <= now - self.window_seconds:
                events.popleft()
            pending = sum(amount for account, amount in self._pending.values() if account == key)
            if len(events) + pending + count > self.limit:
                raise RateLimitExceeded(events[0] + self.window_seconds - now if events else self.window_seconds)
            token = object()
            self._pending[token] = (key, count)
            return token

    def finish(self, token: object, *, success: bool, count: int | None = None) -> None:
        """Idempotently commit a reservation, or return all of its capacity."""
        with self._lock:
            reservation = self._pending.pop(token, None)
            if reservation is None or not success:
                return
            key, reserved = reservation
            charged = reserved if count is None else min(reserved, max(0, count))
            self._events.setdefault(key, deque()).extend([float(self._clock())] * charged)
            self._events.move_to_end(key)
            while len(self._events) > self.max_keys:
                self._events.popitem(last=False)
