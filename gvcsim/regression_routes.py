"""Routes for the teaching regressions of steps 11–14: the course default model and the workbench's models."""

import logging
import threading
from typing import Any, cast

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.requests import Request

from gvcsim import concurrency
from gvcsim.data_routes import _read_csv
from gvcsim.regression import service, workbench
from gvcsim.regression.contracts import (
    ModelSpecPayload,
    RegressionDesignResponse,
    RegressionRequest,
    RegressionRunResponse,
)
from gvcsim.regression.design import (
    OUTCOMES,
    RegressionDesign,
)
from gvcsim.regression.spec import ModelSpec
from gvcsim.regression.teaching import (
    DISCLAIMER,
    EXCHANGE_RATE_COLUMN,
    X_LAG_COLUMNS,
    VERSION,
    Y_COLUMNS,
    country_exposure_overview,
    group_trends,
)
from gvcsim.steps import STEPS

router = APIRouter()
_LOG = logging.getLogger(__name__)


def _validate_design(
    outcome: str, baseline: str | None = None, spec: ModelSpecPayload | None = None
) -> RegressionDesign:
    if outcome not in OUTCOMES:
        raise HTTPException(status_code=400, detail=f"outcome 必须是 {OUTCOMES}")
    try:
        model = ModelSpec.from_dict(spec.model_dump()) if spec is not None else None
        return RegressionDesign(outcome, teaching=True, baseline=baseline, spec=model)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def _regression_step(outcome: str) -> int:
    return next(cast(int, step["n"]) for step in STEPS if step.get("regression_outcome") == outcome)


def _require_regression_student(request: Request) -> int:
    user = getattr(request.state, "user", None) or {}
    if user.get("role") != "student":
        raise HTTPException(status_code=403, detail="回归学习事件只对当前学生签发")
    account_id = user.get("aid")
    if isinstance(account_id, bool) or not isinstance(account_id, int):
        raise HTTPException(status_code=401, detail="登录已失效，请重新登录。")
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
            # Step 10's year-by-year table: last year's X and the country's exchange-rate change (teaching data v10).
            *(column for column in (X_LAG_COLUMNS[1], EXCHANGE_RATE_COLUMN) if column in panel.columns),
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


# The artifact cache returns the same DataFrame object until the file changes, so the trends computed from
# it are reused instead of recomputed on every step 11–14 mount.
_GROUP_TRENDS_CACHE: list[tuple[Any, dict]] = []
_GROUP_TRENDS_LOCK = threading.Lock()


@router.get("/api/regression/teaching-groups")
async def teaching_groups():
    """Taxed vs untaxed mean change of each simulated Y: what steps 11–14 show before the run."""

    def read() -> dict:
        panel = _read_csv("panel_teaching.csv")
        with _GROUP_TRENDS_LOCK:
            if _GROUP_TRENDS_CACHE and _GROUP_TRENDS_CACHE[0][0] is panel:
                return _GROUP_TRENDS_CACHE[0][1]
        try:
            trends = group_trends(panel)
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        with _GROUP_TRENDS_LOCK:
            _GROUP_TRENDS_CACHE[:] = [(panel, trends)]
        return trends

    return await concurrency.run_sync(read)


@router.get("/api/regression/teaching-countries")
async def teaching_countries():
    """Step 10: every sample country's exposure X in the last year, taxed and untaxed, before any example."""

    def read() -> dict:
        panel = _read_csv("panel_teaching.csv")
        return service._cached_on_panel(service._COUNTRY_OVERVIEW_CACHE, panel, country_exposure_overview)

    return await concurrency.run_sync(read)


@router.get("/api/regression/teaching-overview")
async def teaching_overview():
    """Steps 11–14: every Y's estimate at once, for the bar chart (the same data for every student, computed
    once per release, so it does not count against the per-student run limit)."""

    try:
        release, panel = await concurrency.run_sync(service.read_teaching_panel)

        async def compute() -> dict:
            # Singleflight election precedes CPU admission. Waiting overview
            # requests occupy no CPU slots; each model uses the shared path.
            return await concurrency.run_report_build(service.estimate_overview, panel, release)

        return await service._OVERVIEW_FLIGHTS.get_or_compute(release, compute, cancel_when_unobserved=False)
    except (np.linalg.LinAlgError, FloatingPointError, OverflowError, ValueError) as error:
        _LOG.warning("回归总览计算失败：%s", error)
        raise HTTPException(status_code=409, detail="回归总览暂时无法计算，请稍后重试。") from error


@router.get("/api/regression/design", response_model=RegressionDesignResponse)
def regression_design(
    request: Request,
    outcome: str,
    baseline: str | None = None,
):
    """返回指定 outcome 的方程与面板/个体/聚类等设计信息，不执行估计。"""
    unsupported = sorted(set(request.query_params) - {"outcome", "baseline"})
    if unsupported:
        raise HTTPException(status_code=400, detail=f"不支持的回归设计参数：{'、'.join(unsupported)}")
    design = _validate_design(outcome, baseline)
    return service.design_info(design)


@router.get("/api/regression/options")
def regression_options():
    """The workbench's choices (X lags, controls, fixed effects), the default model, its limits and fixed texts."""
    return workbench.options()


async def regression_run(req: RegressionRequest, request: Request):
    account_id = _require_regression_student(request)
    design = _validate_design(req.outcome, req.baseline, req.spec)
    try:
        release, panel = await concurrency.run_sync(service.read_teaching_panel)
        return await service.shared_run(panel, design, release, account_id)
    except service.RegressionRateLimited as error:
        raise HTTPException(status_code=429, detail=str(error), headers={"Retry-After": error.retry_after}) from error
    except service.MissingTeachingY as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (np.linalg.LinAlgError, FloatingPointError, OverflowError) as e:
        _LOG.warning("回归线性代数计算失败（%s）：%s", req.outcome, e)
        raise HTTPException(
            status_code=400,
            detail="这次回归没能算出结果。请换一个指标或稍后重试；若持续出现，请联系老师。",
        ) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/api/regression/run", response_model=RegressionRunResponse)
async def regression_run_http(req: RegressionRequest, request: Request):
    return await concurrency.for_request(request, lambda: regression_run(req, request))
