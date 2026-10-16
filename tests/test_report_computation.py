"""Public report/run outcomes: shared computation, immutable releases and successful billing."""

import asyncio
import copy
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import anyio
import httpx2 as httpx
import numpy as np
import pytest
from fastapi import FastAPI, HTTPException
from test_model_spec import _panel

from gvcsim import concurrency, quizzes, regression_routes as runs, teaching_report
from gvcsim.classroom import records, routes
from gvcsim.rate_limit import RateLimitExceeded, SlidingWindowRateLimiter
from gvcsim.regression.contracts import RegressionRequest
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.model import prepare_design_model
from gvcsim.regression.spec import DEFAULT_SPEC, ModelSpec
from gvcsim.report_common import TeachingReport
from gvcsim.session import empty_session

RELEASE = "a" * 32
SPEC = ModelSpec((0,), (), ("country", "year"))


def request(account=7):
    return SimpleNamespace(state=SimpleNamespace(user={"role": "student", "aid": account}))


@pytest.fixture
def computation(monkeypatch):
    panel = _panel(countries=12)
    monkeypatch.setattr(runs, "read_teaching_panel", lambda: (RELEASE, panel))
    monkeypatch.setattr(runs, "current_release", lambda: RELEASE)
    return panel


def test_queue_failure_returns_run_budget_before_retry(computation, monkeypatch):
    monkeypatch.setattr(runs, "_RUN_LIMITER", SlidingWindowRateLimiter(1))
    original = concurrency.run_cpu_bound

    async def scenario():
        async def unavailable(*_args):
            raise concurrency.WorkUnavailable("work_queue_timeout")

        monkeypatch.setattr(concurrency, "run_cpu_bound", unavailable)
        payload = RegressionRequest(outcome="trade", spec=SPEC.to_dict())
        with pytest.raises(concurrency.WorkUnavailable):
            await runs.regression_run(payload, request())
        monkeypatch.setattr(concurrency, "run_cpu_bound", original)
        result = await runs.regression_run(payload, request())
        assert result["result"]["n_obs"] > 0
        other = RegressionRequest(outcome="trade", spec=DEFAULT_SPEC.to_dict())
        with pytest.raises(HTTPException) as error:
            await runs.regression_run(other, request())
        assert error.value.status_code == 429

    asyncio.run(scenario())


def test_twenty_report_builders_share_page_computation_without_cpu_deadlock(computation, monkeypatch):
    calls = []
    real = runs.run_design_with_benchmark

    def calculate(panel, design):
        calls.append(design)
        time.sleep(0.03)
        return real(panel, design)

    monkeypatch.setattr(runs, "run_design_with_benchmark", calculate)

    async def scenario():
        # Even a single CPU slot must work: renderers never borrow it.
        monkeypatch.setattr(concurrency, "_CPU_LIMITER", anyio.CapacityLimiter(1))
        design = RegressionDesign("trade", teaching=True, spec=SPEC)
        reports = [concurrency.run_report_build(runs.cached_run, computation, design, RELEASE) for _ in range(20)]
        page = runs.regression_run(RegressionRequest(outcome="trade", spec=SPEC.to_dict()), request())
        results = await asyncio.wait_for(asyncio.gather(*reports, page), 10)
        assert all(result is results[0] for result in results)

    asyncio.run(scenario())
    assert len(calls) == 1


def test_report_stops_when_server_cannot_estimate_instead_of_printing_browser_values(tmp_path, monkeypatch):
    from test_teaching_report import _artifacts, _complete
    from gvcsim import config

    # This isolated miniature release has X=0, but its browser fixture claims
    # to have completed a valid run. Server failure must stop report generation.
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    with pytest.raises(teaching_report.ReportGateError, match="先答对") as error:
        teaching_report.build(_complete(), "student")
    assert error.value.missing[0]["title"] == "回归暂时不可用"


def test_default_model_survives_4096_other_models(computation):
    design = RegressionDesign("trade", teaching=True)
    first = runs.cached_run(computation, design, RELEASE)
    for index in range(4097):
        runs._store_payload(f"custom-{index}", {"index": index}, RELEASE)
    assert runs.cached_run(computation.copy(), design, RELEASE) is first
    assert runs._cached_payload("custom-0", RELEASE) is None
    assert runs._cached_payload("custom-1", RELEASE) is not None


def test_panel_read_pins_symlink_target_when_release_switches(tmp_path, monkeypatch):
    old, new = tmp_path / "old", tmp_path / "new"
    old.mkdir()
    new.mkdir()
    link = tmp_path / "processed"
    link.symlink_to(old, target_is_directory=True)
    monkeypatch.setattr(runs.app_config, "PROCESSED_DIR", link)
    roots = []

    def identity(root):
        roots.append(root)
        if len(roots) == 1:
            link.unlink()
            link.symlink_to(new, target_is_directory=True)
        return RELEASE if root == old else "b" * 32

    monkeypatch.setattr(runs.artifacts, "release_identity", identity)
    monkeypatch.setattr(runs.artifacts, "read_csv_artifact", lambda path: path.parent.name)
    assert runs.read_teaching_panel() == (RELEASE, "old")
    assert roots == [old, old]


@pytest.mark.parametrize("value", ["1.0", True, np.bool_(False), np.inf, complex(1, 0)])
def test_vectorized_numeric_validation_still_rejects_non_real_values(value):
    panel = _panel(countries=12)
    panel["teaching_y_trade"] = panel["teaching_y_trade"].astype(object)
    panel.loc[0, "teaching_y_trade"] = value
    with pytest.raises(ValueError, match="真实数值且有限"):
        prepare_design_model(panel, RegressionDesign("trade", teaching=True))


@pytest.mark.parametrize("failure", ["render", "queue", "db", "report409", "session409", "missing", "learning", None])
def test_report_http_charges_only_after_database_success(computation, monkeypatch, failure):
    session = empty_session()
    version = datetime.now(timezone.utc)
    monkeypatch.setattr(routes.quiz_config, "load_bank", quizzes.default_bank)
    monkeypatch.setattr(routes, "_workspace", lambda _: (session, None, {"updated_at": version}))
    monkeypatch.setattr(routes, "check_gate", lambda _, *, quiz_bank: [])
    monkeypatch.setattr(routes.report_workbench, "reported_models", lambda _: [{}])
    design = RegressionDesign("trade", teaching=True, spec=SPEC)
    monkeypatch.setattr(routes.report_workbench, "run_designs", lambda _: [design])
    limiter = SlidingWindowRateLimiter(1)
    monkeypatch.setattr(runs, "_RUN_LIMITER", limiter)

    def build(*_args, quiz_bank):
        if failure == "render":
            raise teaching_report.ReportGateError([{"step": 11, "missing": ["测试"]}])
        if failure == "queue":
            raise concurrency.WorkUnavailable("work_queue_timeout")
        runs.cached_run(computation, design, RELEASE)
        return TeachingReport("# server report", {}, "report.md")

    monkeypatch.setattr(teaching_report, "build", build)

    def save(*_args):
        if failure == "db":
            raise RuntimeError("database write failed")
        if failure == "report409":
            raise records.ReportChanged("changed")
        if failure == "session409":
            raise records.SessionChanged("changed")
        return None if failure == "missing" else {"markdown": "# server report"}

    monkeypatch.setattr(routes.db, "save_generated_report", save)

    def learning_state(*_args, **_kwargs):
        if failure == "learning":
            raise RuntimeError("response bookkeeping failed")
        return {}

    monkeypatch.setattr(routes, "_learning_state", learning_state)
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[routes.require_student] = lambda: {"sub": "student", "aid": 7}

    @app.exception_handler(concurrency.WorkUnavailable)
    async def unavailable(_request, _error):
        from starlette.responses import JSONResponse

        return JSONResponse({"detail": "busy"}, status_code=503)

    async def scenario():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test"
        ) as client:
            response = await client.post("/api/classroom/report/generate", json={})
        expected = {
            "render": 409,
            "queue": 503,
            "db": 500,
            "report409": 409,
            "session409": 409,
            "missing": 404,
            "learning": 500,
            None: 200,
        }
        assert response.status_code == expected[failure]
        if failure is None:
            with pytest.raises(RateLimitExceeded):
                limiter.check(7)
        else:
            limiter.check(7)  # Neither successful rendering nor 409/DB failure charges.
        assert not limiter._pending

    asyncio.run(scenario())


def test_report_body_ignores_self_consistent_browser_numbers(tmp_path, monkeypatch):
    from test_teaching_report import _artifacts, _complete, _sign_run
    from gvcsim import config
    from gvcsim.report_build import build

    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    panel = _panel(countries=12)
    for outcome in ("production", "length", "network"):
        panel[f"teaching_y_{outcome}"] = panel.teaching_y_trade
    monkeypatch.setattr(runs, "read_teaching_panel", lambda: (runs.artifacts.release_identity(tmp_path), panel))
    monkeypatch.setattr(runs, "_estimate_overview", lambda *_args: None)
    session = _complete()
    browser = session["steps"]["11"]["data"]["run"]
    for coef in browser["result"]["coefs"]:
        coef["coef"] *= 17
    _sign_run(browser)
    saved_result = copy.deepcopy(browser["result"])
    report = build(session, "student")
    server = runs.cached_run(panel, RegressionDesign("trade", teaching=True), runs.artifacts.release_identity(tmp_path))
    result = next(item["result"] for item in report.provenance["runs"] if item["step"] == 11)
    assert result == server["result"] and result != saved_result
    assert session["steps"]["11"]["data"]["run"]["result"] == saved_result


def test_report_reserves_before_work_caps_charge_and_shared_retry_is_free(computation, monkeypatch):
    import itertools

    designs = [
        RegressionDesign("trade", teaching=True, spec=ModelSpec(lags, (), effects))
        for lags, effects in itertools.product(
            ((0,), (0, 1), (0, 2), (0, 1, 2)),
            ((), ("year",), ("country",), ("industry",), ("country", "year"), ("country_industry", "year")),
        )
    ]
    session = empty_session()
    monkeypatch.setattr(routes.quiz_config, "load_bank", quizzes.default_bank)
    monkeypatch.setattr(routes, "_workspace", lambda _: (session, None, {"updated_at": datetime.now(timezone.utc)}))
    monkeypatch.setattr(routes, "check_gate", lambda _, *, quiz_bank: [])
    monkeypatch.setattr(routes.report_workbench, "reported_models", lambda _: [{}])
    monkeypatch.setattr(routes.report_workbench, "run_designs", lambda _: designs)
    monkeypatch.setattr(routes, "_learning_state", lambda *_args, **_kwargs: {})
    limiter = SlidingWindowRateLimiter(20)
    monkeypatch.setattr(runs, "_RUN_LIMITER", limiter)
    builds, saves = [], []

    def build(*_args, quiz_bank):
        builds.append(1)
        # Admission includes all pending reservations before any calculation.
        with pytest.raises(RateLimitExceeded):
            limiter.check(7)
        for design in designs:
            runs.cached_run(computation, design, RELEASE)
        return TeachingReport("# complete", {}, "report.md")

    monkeypatch.setattr(teaching_report, "build", build)
    monkeypatch.setattr(
        routes.db, "save_generated_report", lambda *_args: saves.append(1) or {"markdown": "# complete"}
    )

    async def scenario():
        user = {"sub": "student", "aid": 7}
        first, duplicate = await asyncio.gather(routes.generate_report(user), routes.generate_report(user))
        assert first is duplicate and len(builds) == len(saves) == 1
        assert len(limiter._events[7]) == 20  # 24 computations, one report's cap.
        await routes.generate_report(user)  # Cache retry works at an exhausted budget.
        assert len(limiter._events[7]) == 20 and len(saves) == 2

    asyncio.run(scenario())


def test_database_conflict_does_not_bill_rendered_report(teaching_db, computation, monkeypatch):
    """Use the disposable test DB's real optimistic save, not a save stub."""
    from test_route_adapters import _authenticated_client

    session = empty_session()
    teaching_db.save_session("student", session)
    design = RegressionDesign("trade", teaching=True, spec=SPEC)
    monkeypatch.setattr(routes, "check_gate", lambda _, *, quiz_bank: [])
    monkeypatch.setattr(routes.report_workbench, "reported_models", lambda _: [{}])
    monkeypatch.setattr(routes.report_workbench, "run_designs", lambda _: [design])
    monkeypatch.setattr(routes, "_learning_state", lambda *_args, **_kwargs: {})
    limiter = SlidingWindowRateLimiter(20)
    monkeypatch.setattr(runs, "_RUN_LIMITER", limiter)

    def build(*_args, quiz_bank):
        runs.cached_run(computation, design, RELEASE)
        return TeachingReport("# stored", {}, "report.md")

    monkeypatch.setattr(teaching_report, "build", build)
    client = _authenticated_client(teaching_db, "student")
    assert client.post("/api/classroom/report/generate", json={}).status_code == 200
    events = sum(map(len, limiter._events.values()))
    runs.clear_result_cache()  # Force recalculation before a real stale-report 409.
    response = client.post("/api/classroom/report/generate", json={})
    assert response.status_code == 409 and response.json()["detail"]["code"] == "report_changed"
    assert sum(map(len, limiter._events.values())) == events == 1
    assert not limiter._pending


def test_cancelled_page_retry_rejoins_work_and_charges_once(computation, monkeypatch):
    limiter = SlidingWindowRateLimiter(1)
    monkeypatch.setattr(runs, "_RUN_LIMITER", limiter)
    calls = []

    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()

        async def calculate(*_args):
            calls.append(1)
            started.set()
            await release.wait()
            return SimpleNamespace(to_dict=lambda: {"status": "ok", "support": {}}), {}

        monkeypatch.setattr(concurrency, "run_cpu_bound", calculate)
        payload = RegressionRequest(outcome="trade", spec=SPEC.to_dict())
        original = asyncio.create_task(runs.regression_run(payload, request()))
        await started.wait()
        original.cancel()
        with pytest.raises(asyncio.CancelledError):
            await original
        retry = asyncio.create_task(runs.regression_run(payload, request()))
        await asyncio.sleep(0.02)
        release.set()
        assert (await retry)["result"]["status"] == "ok"
        assert len(calls) == len(limiter._events[7]) == 1
        assert not limiter._pending

    asyncio.run(scenario())


def test_cold_overview_waiters_never_borrow_model_cpu_slots(computation, monkeypatch):
    import threading

    started, release = threading.Event(), threading.Event()
    calls = []
    real = runs.run_design_with_benchmark

    def calculate(panel, design):
        calls.append(design)
        started.set()
        assert release.wait(5)
        return real(panel, design)

    monkeypatch.setattr(runs, "run_design_with_benchmark", calculate)
    monkeypatch.setattr(
        runs,
        "_estimate_overview",
        lambda panel, identity: runs.cached_run(panel, RegressionDesign("trade", teaching=True), identity),
    )

    async def scenario():
        limiter = anyio.CapacityLimiter(4)
        monkeypatch.setattr(concurrency, "_CPU_LIMITER", limiter)
        waiters = [asyncio.create_task(runs.teaching_overview()) for _ in range(4)]
        for _ in range(100):
            if started.is_set():
                break
            await asyncio.sleep(0.01)
        assert started.is_set()
        assert limiter.borrowed_tokens == 1
        release.set()
        results = await asyncio.gather(*waiters)
        assert all(result is results[0] for result in results)

    asyncio.run(scenario())
    assert len(calls) == 1
