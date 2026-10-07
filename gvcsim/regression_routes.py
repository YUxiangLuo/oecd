"""Routes for the fixed teaching TWFE regression."""

from typing import Any, cast

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.requests import Request

from gvcsim import artifacts, concurrency, shocks
from gvcsim import config as app_config
from gvcsim.data_routes import _read_csv
from gvcsim.regression.contracts import (
    RegressionDesignResponse,
    RegressionRequest,
    RegressionRunResponse,
)
from gvcsim.regression.design import (
    OUTCOMES,
    RegressionDesign,
)
from gvcsim.regression.panel import run_design_with_benchmark
from gvcsim.regression.teaching import (
    DISCLAIMER,
    VERSION,
    Y_COLUMNS,
    group_trends,
    model_snapshot,
    variable_catalog,
)
from gvcsim.rate_limit import RateLimitExceeded, SlidingWindowRateLimiter
from gvcsim.singleflight import AsyncSingleFlightCache
from gvcsim.steps import STEPS

router = APIRouter()
_RESULT_CACHE: AsyncSingleFlightCache[tuple[str, str, str], dict[str, Any]] = AsyncSingleFlightCache(maxsize=64)
_RUN_LIMITER = SlidingWindowRateLimiter(app_config.REGRESSION_RUNS_PER_MINUTE)


def clear_result_cache() -> None:
    """Clear completed regression results at process and test boundaries."""
    _RESULT_CACHE.clear()


def clear_rate_limits() -> None:
    _RUN_LIMITER.clear()


def _limit_expensive_request(limiter: SlidingWindowRateLimiter, account_id: int, label: str) -> None:
    try:
        limiter.check(account_id)
    except RateLimitExceeded as error:
        raise HTTPException(
            status_code=429,
            detail=f"{label}请求过于频繁，请约 {error.retry_after_header} 秒后重试",
            headers={"Retry-After": error.retry_after_header},
        ) from error


def _validate_design(outcome: str, baseline: str | None = None) -> RegressionDesign:
    if outcome not in OUTCOMES:
        raise HTTPException(status_code=400, detail=f"outcome 必须是 {OUTCOMES}")
    try:
        return RegressionDesign(outcome, teaching=True, baseline=baseline)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def _design_info(design: RegressionDesign, weight_mode: str = shocks.EXPOSURE_MODE_FIXED_PRETREATMENT) -> dict:
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
    add("fixed_exposure", "disclosure", "X 使用首年销往美国的出口份额乘课程税率路径。")
    return {
        "status": result.get("status") or "ok",
        "can_infer": result.get("status") in {"ok", "warning"} and not bool(support.get("suppress_inference")),
        "checks": checks,
    }


def _regression_step(outcome: str) -> int:
    return next(cast(int, step["n"]) for step in STEPS if step.get("regression_outcome") == outcome)


def _require_regression_student(request: Request) -> int:
    user = getattr(request.state, "user", None) or {}
    if user.get("role") != "student":
        raise HTTPException(status_code=403, detail="回归学习事件只对当前学生签发")
    account_id = user.get("aid")
    if isinstance(account_id, bool) or not isinstance(account_id, int):
        raise HTTPException(status_code=401, detail="令牌缺少稳定账号标识")
    return account_id


@router.get("/api/regression/teaching-panel")
async def teaching_panel(
    country: str = "",
    countries: str = "",
    industry: str = "",
    year: int | None = None,
    limit: int = Query(60, ge=1, le=200),
):
    def read() -> dict:
        panel = _read_csv("panel_teaching.csv")
        years = sorted(int(value) for value in panel.year.unique())
        if year is not None and year not in years:
            raise HTTPException(status_code=422, detail="年份不在当前教学面板中")
        requested_countries = [value.strip() for value in countries.split(",") if value.strip()]
        if len(requested_countries) > 2 or len(set(requested_countries)) != len(requested_countries):
            raise HTTPException(status_code=422, detail="教学趋势最多选择两个不同国家")
        if country and requested_countries:
            raise HTTPException(status_code=422, detail="country 与 countries 不能同时使用")
        if country:
            panel = panel.loc[panel.country.eq(country)]
        elif requested_countries:
            panel = panel.loc[panel.country.isin(requested_countries)]
        if industry:
            panel = panel.loc[panel.industry.eq(industry)]
        if year is not None:
            panel = panel.loc[panel.year.eq(year)]
        columns = [
            "country",
            "industry",
            "year",
            "teaching_export_share_w",
            "teaching_tariff_rate_tau",
            "teaching_tariff_exposure",
            *Y_COLUMNS.values(),
        ]
        return {
            "version": VERSION,
            "disclaimer": DISCLAIMER,
            "years": years,
            "total": len(panel),
            "rows": panel.sort_values(["country", "industry", "year"])[columns].head(limit).to_dict("records"),
        }

    return await concurrency.run_sync(read)


@router.get("/api/regression/teaching-groups")
async def teaching_groups():
    """Taxed vs untaxed mean change of each simulated Y: what steps 11–14 show before the run."""

    def read() -> dict:
        try:
            return group_trends(_read_csv("panel_teaching.csv"))
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    return await concurrency.run_sync(read)


@router.get("/api/regression/design", response_model=RegressionDesignResponse)
def regression_design(
    request: Request,
    outcome: str,
    baseline: str | None = None,
):
    """返回指定 outcome 的方程与面板/个体/聚类等设计信息，不执行估计。"""
    if "step" in request.query_params:
        raise HTTPException(status_code=422, detail="旧 step 参数已删除，请使用 outcome")
    unsupported = sorted(set(request.query_params) - {"outcome", "baseline"})
    if unsupported:
        raise HTTPException(status_code=400, detail=f"不支持的回归设计参数：{'、'.join(unsupported)}")
    design = _validate_design(outcome, baseline)
    return _design_info(design)


async def regression_run(req: RegressionRequest, request: Request):
    account_id = _require_regression_student(request)
    design = _validate_design(req.outcome, req.baseline)
    # baseline=None and the explicit default key are the same design; cache them as one.
    canonical = RegressionRequest(outcome=design.outcome, baseline=design.baseline)
    key = (artifacts.release_identity(), "run", canonical.model_dump_json())

    async def compute() -> dict[str, Any]:
        panel = await concurrency.run_sync(_read_csv, "panel_teaching.csv")
        if not design.is_default_baseline and design.depvar not in panel.columns:
            raise HTTPException(status_code=409, detail="当前数据发布没有这个指标对应的 Y，请换回默认指标")
        result, benchmark = await concurrency.run_cpu_bound(run_design_with_benchmark, panel, design)
        result_info = result.to_dict()
        return {
            "design": _design_info(design),
            "result": result_info,
            "preflight": _regression_preflight(result_info),
            "benchmark": benchmark,
            "disclaimer": DISCLAIMER,
            "variable_catalog": variable_catalog(req.outcome, design.baseline),
            "model_snapshot": model_snapshot(req.outcome, design.baseline),
        }

    try:
        return await _RESULT_CACHE.get_or_compute(
            key,
            compute,
            owner=account_id,
            admit=lambda: _limit_expensive_request(_RUN_LIMITER, account_id, "回归计算"),
        )
    except (np.linalg.LinAlgError, FloatingPointError, OverflowError) as e:
        raise HTTPException(status_code=400, detail="回归线性代数计算失败；请检查样本方差、重复键与设计自由度") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/api/regression/run", response_model=RegressionRunResponse)
async def regression_run_http(req: RegressionRequest, request: Request):
    return await concurrency.for_request(request, lambda: regression_run(req, request))
