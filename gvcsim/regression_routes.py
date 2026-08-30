"""Regression design, estimation, and entity-permutation routes."""

from typing import Any, cast

import anyio
import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from fastapi.requests import Request

from gvcsim import artifacts, concurrency, shocks
from gvcsim import config as app_config
from gvcsim.data_routes import _read_csv
from gvcsim.regression.contracts import (
    PlaceboRequest,
    PlaceboResponse,
    RegressionDesignResponse,
    RegressionOptionsResponse,
    RegressionRequest,
    RegressionRunResponse,
)
from gvcsim.regression.design import (
    CONTROL_MODE_LABELS,
    CONTROL_MODE_NONE,
    CONTROL_MODES,
    GRANULARITIES,
    GRANULARITY_COUNTRY_INDUSTRY,
    GRANULARITY_LABELS,
    METHOD_DID,
    METHOD_EVENT_STUDY,
    METHOD_LABELS,
    METHODS,
    OUTCOME_DEPVARS,
    OUTCOME_GRANULARITIES,
    OUTCOMES,
    PRICE_MODE_LABELS,
    PRICE_MODE_NOMINAL,
    PRICE_MODES,
    SCENARIO_LABELS,
    SCENARIOS,
    SHOCK_TYPES,
    RegressionDesign,
    validate_outcome_granularity,
)
from gvcsim.regression.panel import placebo_did_distribution, run_design_with_benchmark
from gvcsim.rate_limit import RateLimitExceeded, SlidingWindowRateLimiter
from gvcsim.shocks import SHOCK_LABELS, SHOCK_TARIFF
from gvcsim.singleflight import AsyncSingleFlightCache
from gvcsim.steps import STEPS

router = APIRouter()
_RESULT_CACHE: AsyncSingleFlightCache[tuple[str, str, str], dict[str, Any]] = AsyncSingleFlightCache(maxsize=64)
_RUN_LIMITER = SlidingWindowRateLimiter(app_config.REGRESSION_RUNS_PER_MINUTE)
_PLACEBO_LIMITER = SlidingWindowRateLimiter(app_config.PLACEBO_RUNS_PER_MINUTE)


def clear_result_cache() -> None:
    """Clear completed regression results at process and test boundaries."""
    _RESULT_CACHE.clear()


def clear_rate_limits() -> None:
    _RUN_LIMITER.clear()
    _PLACEBO_LIMITER.clear()


def _limit_expensive_request(limiter: SlidingWindowRateLimiter, account_id: int, label: str) -> None:
    try:
        limiter.check(account_id)
    except RateLimitExceeded as error:
        raise HTTPException(
            status_code=429,
            detail=f"{label}请求过于频繁，请稍后重试",
            headers={"Retry-After": error.retry_after_header},
        ) from error


@router.get("/api/regression/options", response_model=RegressionOptionsResponse)
def regression_options():
    # 键与文案一起下发:界面渲染 labels,请求回传 keys。
    # 前端不再自备一份中文映射,改文案也不会变成破坏性 API 变更。
    return {
        "granularities": GRANULARITIES,
        "granularity_labels": GRANULARITY_LABELS,
        "granularities_by_outcome": OUTCOME_GRANULARITIES,
        "shock_types": SHOCK_TYPES,
        "shock_type_labels": SHOCK_LABELS,
        "methods": METHODS,
        "method_labels": METHOD_LABELS,
        "control_modes": [CONTROL_MODE_NONE],
        "control_mode_labels": CONTROL_MODE_LABELS,
        "price_modes": PRICE_MODES,
        "price_mode_labels": PRICE_MODE_LABELS,
        "scenarios": SCENARIOS,
        "scenario_labels": SCENARIO_LABELS,
        "weight_modes": list(shocks.EXPOSURE_MODES),
        "weight_mode_labels": {
            shocks.EXPOSURE_MODE_FIXED_PRETREATMENT: "首次处理前固定权重（主口径）",
            shocks.EXPOSURE_MODE_CONTEMPORANEOUS: "当期贸易权重（稳健性）",
        },
        "method_constraints": {
            "cohort_aware_methods": [METHOD_DID, METHOD_EVENT_STUDY],
            "controls_publicly_disabled": True,
            "cohort_aware_interaction_supported": False,
        },
        "outcomes": {key: value[1] for key, value in OUTCOME_DEPVARS.items()},
    }


def _validate_design(
    outcome: str,
    granularity: str,
    shock_type: str,
    method: str,
    control_mode: str = CONTROL_MODE_NONE,
    interaction: bool = False,
    price_mode: str = PRICE_MODE_NOMINAL,
    scenario: str = "clean",
    exclude_row: bool = True,
) -> RegressionDesign:
    if outcome not in OUTCOMES:
        raise HTTPException(status_code=400, detail=f"outcome 必须是 {OUTCOMES}")
    if granularity not in GRANULARITIES:
        raise HTTPException(status_code=400, detail=f"granularity 必须是 {GRANULARITIES}")
    try:
        validate_outcome_granularity(outcome, granularity)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if shock_type not in SHOCK_TYPES:
        raise HTTPException(status_code=400, detail=f"shock_type 必须是 {SHOCK_TYPES}")
    if method not in METHODS:
        raise HTTPException(status_code=400, detail=f"method 必须是 {METHODS}")
    if control_mode not in CONTROL_MODES:
        raise HTTPException(status_code=400, detail=f"control_mode 必须是 {CONTROL_MODES}")
    if control_mode != CONTROL_MODE_NONE:
        raise HTTPException(
            status_code=400,
            detail="公开主回归禁止加入同期 ICIO 派生量或模拟宏观量；它们可能是处理后变量，只保留为数据构造教学材料",
        )
    if method in {METHOD_DID, METHOD_EVENT_STUDY} and interaction:
        raise HTTPException(status_code=400, detail="cohort-aware DID/事件研究当前只发布无交互主结果")
    if price_mode not in PRICE_MODES:
        raise HTTPException(status_code=400, detail=f"price_mode 必须是 {PRICE_MODES}")
    if control_mode == CONTROL_MODE_NONE and price_mode != PRICE_MODE_NOMINAL:
        raise HTTPException(status_code=400, detail="未加入金额控制变量时只能使用 nominal 口径")
    if scenario not in SCENARIOS:
        raise HTTPException(status_code=400, detail=f"scenario 必须是 {SCENARIOS}")
    return RegressionDesign(
        outcome=outcome,
        granularity=granularity,
        shock_type=shock_type,
        method=method,
        control_mode=control_mode,
        interaction=interaction,
        price_mode=price_mode,
        scenario=scenario,
        exclude_row=exclude_row,
    )


def _design_info(design: RegressionDesign, weight_mode: str = shocks.EXPOSURE_MODE_FIXED_PRETREATMENT) -> dict:
    return {
        "outcome": design.outcome,
        "depvar": design.depvar,
        "depvar_label": design.depvar_label,
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


def _validate_weight_mode(design: RegressionDesign, weight_mode: str) -> None:
    if weight_mode not in shocks.EXPOSURE_MODES:
        raise HTTPException(status_code=400, detail=f"weight_mode 必须是 {shocks.EXPOSURE_MODES}")
    if weight_mode == shocks.EXPOSURE_MODE_CONTEMPORANEOUS and design.shock_type != SHOCK_TARIFF:
        raise HTTPException(status_code=400, detail="当期贸易权重稳健性只适用于 tariff 冲击")


def _panel_for_weight_mode(panel: pd.DataFrame, design: RegressionDesign, weight_mode: str) -> pd.DataFrame:
    _validate_weight_mode(design, weight_mode)
    if weight_mode == shocks.EXPOSURE_MODE_FIXED_PRETREATMENT:
        return panel
    required = {"tariff_shock_contemporaneous", "treated_contemporaneous"}
    if not required.issubset(panel.columns):
        raise HTTPException(status_code=409, detail="当前产物没有当期权重稳健性列，请重建 schema 3 产物")
    out = panel.copy()
    out[design.shock_col] = out["tariff_shock_contemporaneous"]
    out[design.treated_col] = out["treated_contemporaneous"]
    return out


def _regression_preflight(design: RegressionDesign, result: dict[str, Any], weight_mode: str) -> dict[str, Any]:
    """把识别风险从脚注提升为每次估计都返回的结构化预检。"""
    support_value = result.get("support")
    support: dict[str, Any] = support_value if isinstance(support_value, dict) else {}
    checks: list[dict[str, str]] = []

    def add(code: str, severity: str, message: str) -> None:
        checks.append({"code": code, "severity": severity, "message": message})

    if support.get("untreated_clusters") == 0 and support.get("treated_clusters", 0) > 0:
        untreated_entities = int(support.get("untreated_entities") or 0)
        if untreated_entities > 0:
            add(
                "no_fully_untreated_cluster",
                "warning",
                f"没有整个聚类始终未暴露，但仍有 {untreated_entities} 个未暴露实体；cohort-time ATT 只使用从未处理或截至比较期尚未处理的实体作对照，聚类 jackknife 仍依赖足够的独立国家聚类。",
            )
        else:
            add(
                "no_never_treated_entity",
                "warning",
                "没有从未处理实体；cohort-time ATT 只能使用尚未处理 cohort 作对照，最后处理期可能不可估计。",
            )
    if support.get("reversal_entities"):
        add(
            "treatment_reversal",
            "fatal" if result.get("status") == "invalid_design" else "warning",
            f"检测到 {len(support['reversal_entities'])} 个处理撤销实体；吸收型 DID/事件研究可能误编码撤销后的年份。",
        )
    add(
        "gvc_interference",
        "warning",
        (
            "全球投入产出结果存在单位间干扰：政策可能经投入链和贸易转移改变未直接处理对象；"
            "no-interference/SUTVA 不能自动成立。网络中心性还会因任一节点边变化而联动。"
        ),
    )
    add(
        "covid_overlap",
        "warning",
        "2018–2020 政策窗口与 COVID-19 重叠；年份固定效应只能吸收共同年份冲击，不能吸收国家×行业异质疫情冲击。",
    )
    add(
        "treatment_weighting",
        "disclosure" if weight_mode == shocks.EXPOSURE_MODE_FIXED_PRETREATMENT else "warning",
        (
            "本次使用首次处理前固定贸易权重，避免处理后贸易结构反向决定 treatment。"
            if weight_mode == shocks.EXPOSURE_MODE_FIXED_PRETREATMENT
            else "本次使用当期贸易权重，仅作稳健性；该权重可能已受政策影响，不能替代固定处理前主口径。"
        ),
    )
    return {
        "status": result.get("status") or "ok",
        "can_infer": not bool(support.get("suppress_inference")),
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


@router.get("/api/regression/design", response_model=RegressionDesignResponse)
def regression_design(
    request: Request,
    outcome: str,
    granularity: str = GRANULARITY_COUNTRY_INDUSTRY,
    shock_type: str = SHOCK_TARIFF,
    method: str = METHOD_DID,
    control_mode: str = CONTROL_MODE_NONE,
    interaction: bool = False,
    price_mode: str = PRICE_MODE_NOMINAL,
    scenario: str = "clean",
    exclude_row: bool = True,
    weight_mode: str = shocks.EXPOSURE_MODE_FIXED_PRETREATMENT,
):
    """返回指定 outcome 的方程与面板/个体/聚类等设计信息，不执行估计。"""
    if "step" in request.query_params:
        raise HTTPException(status_code=422, detail="旧 step 参数已删除，请使用 outcome")
    design = _validate_design(
        outcome,
        granularity,
        shock_type,
        method,
        control_mode,
        interaction,
        price_mode,
        scenario,
        exclude_row,
    )
    _validate_weight_mode(design, weight_mode)
    return _design_info(design, weight_mode)


@router.post("/api/regression/run", response_model=RegressionRunResponse)
async def regression_run(req: RegressionRequest, request: Request):
    account_id = _require_regression_student(request)
    design = _validate_design(
        req.outcome,
        req.granularity,
        req.shock_type,
        req.method,
        req.control_mode,
        req.interaction,
        req.price_mode,
        req.scenario,
        req.exclude_row,
    )
    key = (artifacts.release_identity(), "run", req.model_dump_json())

    async def compute() -> dict[str, Any]:
        # Charge only a real cache miss. Identical concurrent requests share this
        # factory through single-flight, and completed cache hits consume no CPU.
        _limit_expensive_request(_RUN_LIMITER, account_id, "回归计算")
        panel = await anyio.to_thread.run_sync(
            lambda: _panel_for_weight_mode(_read_csv(design.panel_file), design, req.weight_mode)
        )
        result, benchmark = await concurrency.run_cpu_bound(run_design_with_benchmark, panel, design)
        result_info = result.to_dict()
        return {
            "design": _design_info(design, req.weight_mode),
            "result": result_info,
            "preflight": _regression_preflight(design, result_info, req.weight_mode),
            "benchmark": benchmark,
            "disclaimer": "冲击变量为拟真演示面板(全经济体覆盖、行业异质),结果仅用于验证系统链路",
        }

    try:
        return await _RESULT_CACHE.get_or_compute(key, compute)
    except (np.linalg.LinAlgError, FloatingPointError, OverflowError) as e:
        raise HTTPException(status_code=400, detail="回归线性代数计算失败；请检查样本方差、重复键与设计自由度") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/api/regression/placebo", response_model=PlaceboResponse)
async def regression_placebo(req: PlaceboRequest, request: Request):
    account_id = _require_regression_student(request)
    design = _validate_design(
        req.outcome,
        req.granularity,
        req.shock_type,
        req.method,
        req.control_mode,
        req.interaction,
        req.price_mode,
        req.scenario,
        req.exclude_row,
    )
    key = (artifacts.release_identity(), "placebo", req.model_dump_json())

    async def compute() -> dict[str, Any]:
        _limit_expensive_request(_PLACEBO_LIMITER, account_id, "置换检验")
        panel = await anyio.to_thread.run_sync(
            lambda: _panel_for_weight_mode(_read_csv(design.panel_file), design, req.weight_mode)
        )
        placebo = await concurrency.run_cpu_bound(
            placebo_did_distribution,
            panel,
            design,
            n_draws=req.n_draws,
            seed=req.seed,
        )
        return {
            "design": _design_info(design, req.weight_mode),
            "placebo": placebo,
            "disclaimer": "实体置换仅用于描述性敏感性比较；它没有复现真实政策分配机制，尾部占比不是校准 p 值或因果证据",
        }

    try:
        return await _RESULT_CACHE.get_or_compute(key, compute)
    except (np.linalg.LinAlgError, FloatingPointError, OverflowError) as e:
        raise HTTPException(status_code=400, detail="回归线性代数计算失败；请检查样本方差、重复键与设计自由度") from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
