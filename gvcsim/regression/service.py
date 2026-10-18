"""Shared regression computation, caching and admission for HTTP, reports and offline checks.

This module has no HTTP or route dependencies; adapters translate domain errors.
"""

import json
import threading
from collections import OrderedDict
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

import anyio

from gvcsim import artifacts, concurrency, shocks
from gvcsim import config as app_config
from gvcsim.regression.design import OUTCOMES, RegressionDesign
from gvcsim.regression.panel import run_design_with_benchmark
from gvcsim.regression.spec import DEFAULT_SPEC
from gvcsim.regression.teaching import (
    BASELINES,
    DISCLAIMER,
    VERSION,
    available_baselines,
    first_wave_decomposition,
    model_snapshot,
    variable_catalog,
)
from gvcsim.rate_limit import RateLimitExceeded, SlidingWindowRateLimiter
from gvcsim.singleflight import AsyncSingleFlightCache


class RegressionRateLimited(RuntimeError):
    def __init__(self, message: str, retry_after: str):
        super().__init__(message)
        self.retry_after = retry_after


_RESULT_CACHE: AsyncSingleFlightCache[tuple[str, str, str], dict[str, Any]] = AsyncSingleFlightCache(maxsize=4096)


_OVERVIEW_FLIGHTS: AsyncSingleFlightCache[str, dict[str, Any]] = AsyncSingleFlightCache(maxsize=2)


_RUN_LIMITER = SlidingWindowRateLimiter(app_config.REGRESSION_RUNS_PER_MINUTE)


def clear_result_cache() -> None:
    """Clear completed regression results at process and test boundaries."""
    _RESULT_CACHE.clear()
    _OVERVIEW_FLIGHTS.clear()
    with _RUN_LOCK:
        _RUN_CACHE.clear()
        _DEFAULT_RUN_CACHE.clear()
    with _OVERVIEW_LOCK:
        _COUNTRY_OVERVIEW_CACHE.clear()


def clear_rate_limits() -> None:
    _RUN_LIMITER.clear()


def design_info(design: RegressionDesign, weight_mode: str = shocks.EXPOSURE_MODE_FIXED_PRETREATMENT) -> dict:
    return {
        "outcome": design.outcome,
        "baseline": design.baseline,
        "baseline_label": design.baseline_label,
        "depvar": design.depvar,
        "depvar_label": design.depvar_label,
        "depvar_kind": design.depvar_kind,
        "depvar_unit": design.depvar_unit,
        "granularity": design.granularity,
        "granularity_label": design.granularity_label,
        "shock_type": design.shock_type,
        "shock_type_label": design.shock_type_label,
        "shock_col": design.shock_col,
        "treated_col": design.treated_col,
        "method": design.method,
        "method_label": design.method_label,
        "control_mode": design.control_mode,
        "control_mode_label": design.control_mode_label,
        "interaction": design.interaction,
        "price_mode": design.price_mode,
        "price_mode_label": design.price_mode_label,
        "scenario": design.scenario,
        "scenario_label": design.scenario_label,
        "sample_filter": design.sample_filter,
        "exclude_row": design.exclude_row,
        "controls": list(design.controls),
        "control_labels": design.control_labels,
        "equation": design.equation(),
        "equation_parts": design.equation_parts(),
        "panel_file": design.panel_file,
        "entity": design.entity,
        "cluster": design.cluster,
        "weight_mode": weight_mode,
        "spec": design.spec.to_dict() if design.spec else None,
    }


def _regression_preflight(result: dict[str, Any]) -> dict[str, Any]:
    """把识别风险从脚注提升为每次估计都返回的结构化预检。"""
    support_value = result.get("support")
    support: dict[str, Any] = support_value if isinstance(support_value, dict) else {}
    checks: list[dict[str, str]] = []

    def add(code: str, severity: str, message: str) -> None:
        checks.append({"code": code, "severity": severity, "message": message})

    add("teaching_simulation", "disclosure", DISCLAIMER)
    add(
        "source_calibration",
        "disclosure",
        "Y 基准按首年指标排名校准；网络 Y 未重新构造贸易网络。",
    )
    add("fixed_exposure", "disclosure", "X 使用首年销往美国的出口份额乘加征税率（被加税国家分两批开始加税）。")
    return {
        "status": result.get("status") or "ok",
        "can_infer": result.get("status") in {"ok", "warning"} and not bool(support.get("suppress_inference")),
        "checks": checks,
    }


_COUNTRY_OVERVIEW_CACHE: list[tuple[Any, dict]] = []


_OVERVIEW_LOCK = threading.Lock()


def _cached_on_panel(cache: list[tuple[Any, dict]], panel: Any, build: Any) -> dict:
    """Reuse a result computed from the same cached panel DataFrame (it changes only with the release).
    One build at a time: a class opening the page together waits for the first build instead of repeating it."""
    with _OVERVIEW_LOCK:
        if cache and cache[0][0] is panel:
            return cache[0][1]
        value = build(panel)
        cache[:] = [(panel, value)]
        return value


def estimate_overview(panel: Any, release: str | None = None) -> dict:
    """The estimate of every Y of every family, as the run endpoint computes it (one bar per Y). Through the run
    cache, so a student's first run of a step's default model reads it instead of computing (and charging) it again.
    `release`: read before the panel was."""
    outcomes: dict[str, list[dict[str, Any]]] = {}
    for outcome in OUTCOMES:
        default_key = BASELINES[outcome][0].key
        items = []
        for baseline in available_baselines(outcome, panel.columns):
            design = RegressionDesign(outcome, teaching=True, baseline=baseline.key)
            info = cached_run(panel, design, release)["result"]
            # The headline of a run is the X terms' cumulative relation (the course model has X and L1.X). With a term
            # dropped there is none, and the other term alone is not shown in its place.
            coef = info.get("cumulative") or {}
            raw_support = info.get("support")
            support = raw_support if isinstance(raw_support, dict) else {}
            items.append(
                {
                    "key": baseline.key,
                    "label": baseline.label,
                    "kind": baseline.kind,
                    "default": baseline.key == default_key,
                    "coef": coef.get("coef"),
                    "ci_low": coef.get("ci_low"),
                    "ci_high": coef.get("ci_high"),
                    "p": coef.get("p"),
                    "status": info.get("status"),
                    "suppress_inference": bool(support.get("suppress_inference")),
                    "depvar_std": info.get("depvar_std"),
                    "depvar_within_std": info.get("depvar_within_std"),
                    "depvar_mean": info.get("depvar_mean"),
                    "n_obs": info.get("n_obs"),
                }
            )
        outcomes[outcome] = items
    return {"version": VERSION, "disclaimer": DISCLAIMER, "outcomes": outcomes}


class MissingTeachingY(ValueError):
    """The teaching panel is missing the requested outcome."""


def _run_key(design: RegressionDesign) -> str:
    # baseline=None and the explicit default key are one design, and so are an omitted spec and the default spec.
    assert design.spec is not None
    return json.dumps(
        {"outcome": design.outcome, "baseline": design.baseline, "spec": design.spec.to_dict()}, sort_keys=True
    )


def _require_y(panel: Any, design: RegressionDesign) -> None:
    if not design.is_default_baseline and design.depvar not in panel.columns:
        raise MissingTeachingY("当前课程数据没有这个指标对应的 Y，请换回本步默认指标")


def _run_payload(design: RegressionDesign, result: Any, benchmark: dict[str, Any]) -> dict[str, Any]:
    result_info = result.to_dict()
    return {
        "design": design_info(design),
        "result": result_info,
        "preflight": _regression_preflight(result_info),
        "benchmark": benchmark,
        "disclaimer": DISCLAIMER,
        "variable_catalog": variable_catalog(design.outcome, design.baseline, design.spec),
        "model_snapshot": model_snapshot(design.outcome, design.baseline, design.spec),
    }


def _with_decomposition(payload: dict[str, Any], design: RegressionDesign, panel: Any) -> dict[str, Any]:
    """The payload plus the first wave's change in Y as the fitted model splits it (the sentence under the
    three-group chart); None when the panel has no waves."""
    result = payload.get("result")
    if not isinstance(result, dict):
        return payload
    coefs = {item["name"]: item["coef"] for item in result.get("coefs", [])}
    return {**payload, "decomposition": first_wave_decomposition(panel, design.depvar, coefs)}


_RUN_CACHE: list[tuple[str, "OrderedDict[str, dict[str, Any]]"]] = []


_DEFAULT_RUN_CACHE: dict[tuple[str, str], dict[str, Any]] = {}


_RUN_LOCK = threading.Lock()


_RUN_CACHE_SIZE = 4096


def read_teaching_panel() -> tuple[str, Any]:
    """Bind the identity and CSV to the same immutable, resolved release root.

    Resolving once prevents a processed symlink swap between metadata and CSV
    reads from tagging the new panel with the previous release's identity.
    """
    root = app_config.PROCESSED_DIR.resolve()
    release = artifacts.release_identity(root)
    panel = artifacts.read_csv_artifact(root / "panel_teaching.csv")
    if artifacts.release_identity(root) != release:
        raise ValueError("课程数据在读取期间发生变化，请重试")
    return release, panel


def current_release() -> str | None:
    try:
        return artifacts.release_identity()
    except (artifacts.ArtifactContractError, OSError, ValueError):
        return None


def _run_cached(key: str, release: str | None = None) -> bool:
    release = release if release is not None else current_release()
    return _cached_payload(key, release) is not None


def _cached_payload(key: str, release: str | None) -> dict[str, Any] | None:
    if release is None:
        return None
    with _RUN_LOCK:
        pinned = _DEFAULT_RUN_CACHE.get((release, key))
        if pinned is not None:
            return pinned
        if not _RUN_CACHE or release is None or _RUN_CACHE[0][0] != release:
            return None
        results = _RUN_CACHE[0][1]
        if key in results:
            results.move_to_end(key)
        return results.get(key)


def _store_payload(key: str, payload: dict[str, Any], release: str | None = None, *, pinned: bool = False) -> None:
    """Keep a run; `release` is the one read before its panel was (by default, now). Without one, nothing is kept."""
    release = release if release is not None else current_release()
    if release is None:
        return
    with _RUN_LOCK:
        if pinned:
            _DEFAULT_RUN_CACHE[(release, key)] = payload
            # Retain the current and immediately previous release, including
            # its in-flight readers, but not every release ever published.
            releases = list(dict.fromkeys(identity for identity, _ in _DEFAULT_RUN_CACHE))
            for identity in releases[:-2]:
                for old in list(_DEFAULT_RUN_CACHE):
                    if old[0] == identity:
                        del _DEFAULT_RUN_CACHE[old]
            return
        if not _RUN_CACHE or _RUN_CACHE[0][0] != release:
            _RUN_CACHE[:] = [(release, OrderedDict())]
        results = _RUN_CACHE[0][1]
        results[key] = payload
        results.move_to_end(key)
        while len(results) > _RUN_CACHE_SIZE:
            results.popitem(last=False)


@dataclass
class ReportBilling:
    token: object
    eligible: set[str]
    computed: set[str] = field(default_factory=set)


REPORT_BILLING: ContextVar[ReportBilling | None] = ContextVar("report_billing", default=None)


def charge_report_runs(account_id: Any, designs: list[RegressionDesign]) -> ReportBilling | None:
    """Reserve admission before rendering; only successful, owned work is billed
    after the report's database save. Cached/shared work and failed reports are
    free, and one report commits at most 20 events.
    """
    if isinstance(account_id, bool) or not isinstance(account_id, int):
        return None
    release = current_release()
    eligible = {key for key in map(_run_key, designs) if not _run_cached(key, release)}
    missing = len(eligible)
    if not missing:
        return None
    try:
        return ReportBilling(_RUN_LIMITER.reserve(account_id, min(missing, 20, _RUN_LIMITER.limit)), eligible)
    except RateLimitExceeded as error:
        raise RegressionRateLimited(
            (
                f"生成报告要重新计算你记入报告的 {missing} 个模型，本分钟的计算次数已用完；"
                f"请约 {error.retry_after_header} 秒后再生成。"
            ),
            retry_after=error.retry_after_header,
        ) from error


def cached_run(panel: Any, design: RegressionDesign, release: str | None = None) -> dict[str, Any]:
    """Read the shared 4096-entry LRU (default specs are pinned separately).

    Application worker threads bridge to the same async singleflight/CPU path
    as the page. Offline callers compute synchronously. The caller must bind
    panel and release together with read_teaching_panel.
    """
    concurrency.check_cancelled()
    release = release if release is not None else current_release()
    key = _run_key(design)
    cached = _cached_payload(key, release)
    if cached is not None:
        return cached
    try:
        anyio.from_thread.check_cancelled()
    except RuntimeError:
        # Offline/test callers have no application loop or admission budget.
        pass
    else:
        return anyio.from_thread.run(shared_run, panel, design, release, None)
    _require_y(panel, design)
    payload = _with_decomposition(_run_payload(design, *run_design_with_benchmark(panel, design)), design, panel)
    _store_payload(key, payload, release, pinned=design.spec == DEFAULT_SPEC)
    return payload


def finish_report_runs(billing: ReportBilling | None, *, success: bool) -> None:
    if billing is not None:
        _RUN_LIMITER.finish(billing.token, success=success, count=len(billing.computed))


async def shared_run(panel: Any, design: RegressionDesign, release: str | None, account_id: int | None) -> dict:
    """The one model computation path for pages, report body and appendix."""
    run_key = _run_key(design)
    cached = _cached_payload(run_key, release)
    if cached is not None:
        return cached
    reservation = None
    billing = REPORT_BILLING.get() if account_id is None else None

    def admit() -> None:
        nonlocal reservation
        if account_id is not None:
            try:
                reservation = _RUN_LIMITER.reserve(account_id)
            except RateLimitExceeded as error:
                raise RegressionRateLimited(
                    f"计算次数过多，请约 {error.retry_after_header} 秒后再试。",
                    retry_after=error.retry_after_header,
                ) from error

    async def compute() -> dict:
        success = False
        try:
            _require_y(panel, design)
            result, benchmark = await concurrency.run_cpu_bound(run_design_with_benchmark, panel, design)
            payload = _with_decomposition(_run_payload(design, result, benchmark), design, panel)
            _store_payload(run_key, payload, release, pinned=design.spec == DEFAULT_SPEC)
            if billing is not None and run_key in billing.eligible:
                billing.computed.add(run_key)
            success = True
            return payload
        finally:
            if reservation is not None:
                _RUN_LIMITER.finish(reservation, success=success)

    return await _RESULT_CACHE.get_or_compute(
        (release or "", "run", run_key),
        compute,
        owner=account_id,
        admit=admit,
        cache_success=False,
        cancel_when_unobserved=False,
    )


async def shutdown() -> None:
    await _OVERVIEW_FLIGHTS.aclose()
    await _RESULT_CACHE.aclose()
    clear_result_cache()
    clear_rate_limits()
