import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from gvcsim import auth_routes, regression_routes
from gvcsim.api import app
from gvcsim.rate_limit import RateLimitExceeded, SlidingWindowRateLimiter
from gvcsim.regression.contracts import RegressionRequest
from gvcsim.singleflight import AsyncSingleFlightCache


@pytest.mark.parametrize(
    "kwargs",
    [
        {"limit": 0},
        {"limit": True},
        {"limit": 1, "window_seconds": 0},
        {"limit": 1, "max_keys": 0},
    ],
)
def test_rate_limit_configuration_rejects_nonpositive_or_boolean_values(kwargs):
    with pytest.raises(ValueError, match="positive"):
        SlidingWindowRateLimiter(**kwargs)


def test_sliding_window_is_exact_per_key_and_reports_retry_after():
    now = [100.0]
    limiter = SlidingWindowRateLimiter(2, 10.0, clock=lambda: now[0])

    limiter.check("student")
    limiter.check("student")
    limiter.check("another-student")
    with pytest.raises(RateLimitExceeded) as exc_info:
        limiter.check("student")

    assert exc_info.value.retry_after_header == "10"
    now[0] = 110.001
    limiter.check("student")


def test_sliding_window_bounds_retained_keys_and_can_be_cleared():
    limiter = SlidingWindowRateLimiter(1, max_keys=2)
    limiter.check("first")
    limiter.check("second")
    limiter.check("third")
    assert list(limiter._events) == ["second", "third"]
    limiter.clear()
    assert not limiter._events


def test_login_limit_is_scoped_by_source_and_username(teaching_db, monkeypatch):
    monkeypatch.setattr(auth_routes, "_LOGIN_ACCOUNT_LIMITER", SlidingWindowRateLimiter(2))
    monkeypatch.setattr(auth_routes, "_LOGIN_SOURCE_LIMITER", SlidingWindowRateLimiter(20))
    client = TestClient(app)

    for _ in range(2):
        response = client.post("/api/auth/login", json={"username": "student", "password": "wrong"})
        assert response.status_code == 401
    limited = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})

    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "60"
    assert limited.json()["detail"] == "尝试次数过多，请约 60 秒后再试。"
    assert client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).status_code == 200


@pytest.mark.parametrize(
    ("route", "request_payload", "limiter_name"),
    [
        (regression_routes.regression_run, RegressionRequest(outcome="network"), "_RUN_LIMITER"),
    ],
)
def test_expensive_regression_routes_limit_each_account_before_repeating_work(
    monkeypatch,
    route,
    request_payload,
    limiter_name,
):
    class Uncached:
        async def get_or_compute(self, _key, factory, *, admit, owner):
            admit()
            return await factory()

    class Result:
        def to_dict(self):
            return {"status": "ok", "support": {}}

    async def fake_cpu(function, *_args, **_kwargs):
        if function is regression_routes.run_design_with_benchmark:
            return Result(), {"benchmark_passed": True}
        return {"draws": []}

    monkeypatch.setattr(regression_routes, limiter_name, SlidingWindowRateLimiter(1))
    monkeypatch.setattr(regression_routes, "_RESULT_CACHE", Uncached())
    monkeypatch.setattr(regression_routes.artifacts, "release_identity", lambda: "a" * 32)
    monkeypatch.setattr(regression_routes, "_read_csv", lambda _name: object())
    monkeypatch.setattr(regression_routes.concurrency, "run_cpu_bound", fake_cpu)
    request = SimpleNamespace(state=SimpleNamespace(user={"role": "student", "sub": "student", "aid": 2}))

    assert isinstance(asyncio.run(route(request_payload, request)), dict)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(route(request_payload, request))

    assert exc_info.value.status_code == 429
    assert exc_info.value.headers == {"Retry-After": "60"}


def test_regression_limit_requires_stable_account_identity():
    request = SimpleNamespace(state=SimpleNamespace(user={"role": "student", "sub": "student"}))
    with pytest.raises(HTTPException) as exc_info:
        regression_routes._require_regression_student(request)
    assert exc_info.value.status_code == 401


@pytest.mark.parametrize("operation", ["run"])
def test_exhausted_initiator_does_not_publish_429_to_49_other_students(monkeypatch, operation):
    async def scenario():
        limit = 12
        limiter = SlidingWindowRateLimiter(limit)
        for _ in range(limit):
            limiter.check(1)
        monkeypatch.setattr(regression_routes, "_RUN_LIMITER", limiter)
        monkeypatch.setattr(regression_routes, "_RESULT_CACHE", AsyncSingleFlightCache())
        monkeypatch.setattr(regression_routes.artifacts, "release_identity", lambda: "a" * 32)
        monkeypatch.setattr(regression_routes, "_read_csv", lambda _name: object())
        computations = []

        async def compute(function, *_args, **_kwargs):
            computations.append(function)
            await asyncio.sleep(0.01)
            if operation == "run":
                return SimpleNamespace(to_dict=lambda: {"status": "ok", "support": {}}), {}
            return {"draws": []}

        monkeypatch.setattr(regression_routes.concurrency, "run_cpu_bound", compute)
        route = regression_routes.regression_run
        payload = RegressionRequest(outcome="trade")

        async def call(account_id):
            request = SimpleNamespace(state=SimpleNamespace(user={"role": "student", "aid": account_id}))
            try:
                return await route(payload, request)
            except HTTPException as error:
                return error.status_code

        results = await asyncio.gather(*(call(i) for i in range(1, 51)))
        assert results[0] == 429
        assert all(isinstance(result, dict) for result in results[1:])
        assert len(computations) == 1
        # Even the exhausted student may consume the now-cached result for free.
        assert isinstance(await call(1), dict)

    asyncio.run(scenario())
