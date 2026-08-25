"""Generate the step-16 report from the saved experiment session."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast

from gvcsim import evidence, quizzes
from gvcsim.artifacts import (
    NETWORK_ALGORITHM,
    ArtifactContractError,
    dataset_metadata,
    validate_release_cached,
)
from gvcsim.config import COURSE_RELEASE, processed_years
from gvcsim.data.citations import report_source_disclosures, report_source_label
from gvcsim.data.controls import CONTROL_LABELS
from gvcsim.regression.design import (
    CONTROL_MODE_LABELS,
    GRANULARITY_LABELS,
    METHOD_LABELS,
    PRICE_MODE_LABELS,
)
from gvcsim.regression.validity import MIN_TREATED_CLUSTERS
from gvcsim.session import SESSION_VERSION
from gvcsim.shocks import SHOCK_LABELS
from gvcsim.steps import STEPS

REFLECTION_TEXT_LIMIT = 2400
_GLOBAL_PRETREND_SUPPRESSION_COPY = "整体设计门禁已抑制统计推断，因此未执行冲击前联合检验；不能据此判断冲击前趋势。"
_SAFE_UNAVAILABLE_PRETREND_REASONS = {
    "no_pre_terms",
    "no_supported_pre_terms",
    "insufficient_cluster_df",
    "singular_covariance",
    "global_inference_suppressed",
}
GATE_STEPS = tuple(step for step in sorted(evidence.STEP_LABS) if evidence.STEP_LABS[step] != "rep")
_STEP_TITLES = {cast(int, item["n"]): cast(str, item["title"]) for item in STEPS}
_STEP_OUTCOMES = {
    cast(int, item["n"]): cast(str, item["regression_outcome"]) for item in STEPS if item.get("regression_outcome")
}
_OUTCOME_UNITS = {
    "trade": "份额原始单位（乘以 100 后按百分点解释）",
    "production": "份额原始单位（乘以 100 后按百分点解释）",
    "length": "生产环节长度单位",
    "network": "介数中心性原始单位；跨指标比较时另参考样本标准差单位",
}
_STATUS_LABELS = {
    "ok": "可报告",
    "warning": "需谨慎解释",
    "insufficient": "处理支持度不足",
    "invalid_design": "设计无效",
    "unknown": "未记录设计状态",
}
_SCENARIO_LABELS = {
    "clean": "基准教学面板",
    "noisy": "测量误差教学面板",
    "confounded": "前趋势混杂教学面板",
}
_OUTCOME_INTERPRETATIONS = {
    "trade": {
        "negative": "结果与外国增加值依赖下降一致，但不能单独证明供应链已经回流。",
        "positive": "结果与外国增加值依赖上升一致，但仍需检查识别假设和其他共同变化。",
    },
    "production": {
        "negative": "SVA 中复杂 GVC 增加值份额降低；这是构成占比变化，不能单凭该比例判断生产规模扩张/收缩。",
        "positive": "SVA 中复杂 GVC 增加值份额提高；这是构成占比变化，不能单凭该比例判断生产规模扩张/收缩。",
    },
    "length": {
        "negative": "结果与跨境生产链缩短一致，可能对应回流、近岸化或其他调整。",
        "positive": "结果与跨境生产链延长一致，但不能单靠该估计判断企业策略。",
    },
    "network": {
        "negative": "结果与拓扑中介位置下降一致，但不能单独证明发生脱钩。",
        "positive": "结果与拓扑中介位置增强一致，但可能同时受到网络重组影响。",
    },
}
_REFLECTION_MIN_LENGTHS = {
    "research_question": 12,
    "evidence_interpretation": 40,
    "limitations": 30,
}


class ReportGateError(RuntimeError):
    def __init__(self, missing: list[dict[str, Any]]):
        self.missing = missing
        super().__init__("实验报告需要先完成理解检查、关键实验操作与原创分析")


@dataclass
class TeachingReport:
    markdown: str
    provenance: dict[str, Any]
    suggested_filename: str


def _step_data(session: dict[str, Any], step: int) -> dict[str, Any]:
    record = session.get("steps", {}).get(str(step))
    data = record.get("data") if isinstance(record, dict) else None
    return data if isinstance(data, dict) else {}


def check_gate(session: dict[str, Any], **_unused: Any) -> list[dict[str, Any]]:
    blocked = []
    for step in GATE_STEPS:
        result = evidence.evaluate_step(step, session)
        if not result.complete:
            blocked.append({"step": step, "title": _STEP_TITLES.get(step, ""), "missing": result.missing})

    observation = _step_data(session, 1).get("observation")
    has_observation = isinstance(observation, dict) and all(
        observation.get(key) not in (None, "") for key in ("row", "column", "value")
    )
    if not has_observation:
        blocked.append(
            {
                "step": 1,
                "title": _STEP_TITLES.get(1, ""),
                "missing": ["请在 ICIO 表中点击并记录一个具体单元格"],
            }
        )

    has_comparison = False
    for step in range(3, 11):
        data = _step_data(session, step)
        compared = {str(item) for item in _list_values(data.get("compared")) if str(item).strip()}
        observations = [
            item
            for item in _list_values(data.get("observations"))
            if isinstance(item, dict)
            and item.get("entity", item.get("country")) not in (None, "")
            and item.get("value") not in (None, "")
        ]
        if len(compared) >= 2 or len(observations) >= 2:
            has_comparison = True
            break
    if not has_comparison:
        blocked.append(
            {
                "step": 7,
                "title": "指标对比探索",
                "missing": ["请在步骤 3–10 中保存至少两个比较对象或两条指标观测"],
            }
        )

    qualified_steps = {run["step"] for run in _gate_qualified_runs(session)}
    for step in sorted(_STEP_OUTCOMES):
        if step in qualified_steps:
            continue
        blocked.append(
            {
                "step": step,
                "title": _STEP_TITLES.get(step, ""),
                "missing": ["请在本步运行并保存一次可报告的估计（默认关税冲击即可）"],
            }
        )

    reflection = _step_data(session, 16)
    reflection_missing = []
    for key, label in (
        ("research_question", "研究问题"),
        ("evidence_interpretation", "证据解释"),
        ("limitations", "局限与反思"),
    ):
        minimum = _REFLECTION_MIN_LENGTHS[key]
        value = reflection.get(key)
        if not isinstance(value, str) or len(" ".join(value.split())) < minimum:
            reflection_missing.append(f"请用自己的话填写{label}（至少 {minimum} 个字符）")
        if isinstance(value, str) and len(value) > REFLECTION_TEXT_LIMIT:
            reflection_missing.append(f"{label}不能超过 {REFLECTION_TEXT_LIMIT} 个字符")
    if reflection_missing:
        blocked.append({"step": 16, "title": "原创分析与反思", "missing": reflection_missing})
    return blocked


def _safe(value: Any, limit: int = 240) -> str:
    rendered = " ".join(str(value).split()).replace("|", "¦").replace("`", "ʼ")
    return rendered[:limit]


def _number(value: Any, *, p_value: bool = False) -> str:
    """Format report numbers for reading, while keeping full values in provenance."""
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
        return "—"
    numeric = float(value)
    if p_value and 0 < numeric < 0.0001:
        return "<0.0001"
    return f"{numeric:.4g}"


def _count(value: Any) -> str:
    if isinstance(value, int) and not isinstance(value, bool):
        return f"{value:,}"
    if isinstance(value, float) and value.is_integer():
        return f"{int(value):,}"
    return _number(value)


def _signed(value: float, digits: int) -> str:
    return f"{value:+.{digits}f}"


def _setting_value(key: str, value: Any) -> str:
    mappings = {
        "granularity": GRANULARITY_LABELS,
        "shock_type": SHOCK_LABELS,
        "method": METHOD_LABELS,
        "control_mode": CONTROL_MODE_LABELS,
        "price_mode": PRICE_MODE_LABELS,
        "scenario": _SCENARIO_LABELS,
    }
    mapping = mappings.get(key, {})
    return _safe(mapping.get(str(value), value))


def _coefficient_label(name: Any, design: dict[str, Any]) -> str:
    raw = str(name)
    raw_labels = design.get("control_labels")
    labels = cast(dict[str, Any], raw_labels) if isinstance(raw_labels, dict) else {}
    if raw in labels:
        return _safe(labels[raw])
    if raw in CONTROL_LABELS:
        return CONTROL_LABELS[raw]
    if raw in {"treated×post", "sanction_treated×post", "export_control_treated×post"}:
        return "处理后相对变化（处理组 × 处理后）"
    if raw == "tariff_shock":
        return "关税冲击强度"
    if raw == "sanction_shock":
        return "制裁冲击强度"
    if raw == "export_control_shock":
        return "出口管制冲击强度"
    if raw.startswith("k="):
        return f"相对处理时期 {raw}"
    if "×base_gvc" in raw:
        base = raw.replace("×base_gvc", "")
        return f"{_coefficient_label(base, design)} × 处理前 GVC"
    if raw in {"policy", "policy_term"}:
        return "政策处理项"
    return _safe(raw)


def _primary_coefficient(design: dict[str, Any], result: dict[str, Any]) -> dict[str, Any] | None:
    controls = {str(item) for item in _list_values(design.get("controls"))}
    candidates = [
        item
        for item in _list_values(result.get("coefs"))
        if isinstance(item, dict) and str(item.get("name")) not in controls and "×base_gvc" not in str(item.get("name"))
    ]
    if design.get("method") == "event_study":
        return next((item for item in candidates if item.get("name") == "k=0"), None) or next(
            (item for item in candidates if str(item.get("name", "")).startswith("k=+")), None
        )
    return candidates[0] if candidates else None


def _event_support_term(event_time: int) -> str:
    return "k=0" if event_time == 0 else f"k={event_time:+d}"


def _nonnegative_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _valid_event_support(result: dict[str, Any], interaction: bool = False) -> dict[str, Any] | None:
    """Semantically validate saved REG-01 payloads before report inference consumes them."""
    raw_support = result.get("event_support")
    if not isinstance(raw_support, dict):
        return None
    periods = raw_support.get("periods")
    cluster = raw_support.get("cluster")
    base_k = raw_support.get("base_k")
    reference_term = raw_support.get("reference_term")
    threshold = raw_support.get("min_contributing_clusters")
    if (
        raw_support.get("policy") != "teaching_min_contributing_clusters_per_event_period"
        or raw_support.get("policy_is_statistical_theorem") is not False
        or not isinstance(cluster, str)
        or not cluster.strip()
        or not isinstance(base_k, int)
        or isinstance(base_k, bool)
        or base_k >= 0
        or not isinstance(reference_term, str)
        or reference_term != _event_support_term(base_k)
        or not isinstance(threshold, int)
        or isinstance(threshold, bool)
        or threshold != MIN_TREATED_CLUSTERS
        or not isinstance(periods, list)
        or not periods
    ):
        return None

    terms: set[str] = set()
    event_times: set[int] = set()
    typed_periods: list[dict[str, Any]] = []
    for raw_period in periods:
        if not isinstance(raw_period, dict):
            return None
        period = raw_period
        term = period.get("term")
        event_time = period.get("event_time")
        cohorts = period.get("cohorts")
        reasons = period.get("reasons")
        reason_codes = period.get("reason_codes")
        if (
            not isinstance(term, str)
            or term in terms
            or not isinstance(event_time, int)
            or isinstance(event_time, bool)
            or event_time in event_times
            or term != _event_support_term(event_time)
            or not isinstance(period.get("is_reference"), bool)
            or not isinstance(period.get("estimated"), bool)
            or not _nonnegative_int(period.get("contributing_rows"))
            or not _nonnegative_int(period.get("contributing_entities"))
            or not _nonnegative_int(period.get("contributing_clusters"))
            or period["contributing_clusters"] > period["contributing_entities"]
            or period["contributing_entities"] > period["contributing_rows"]
            or not isinstance(cohorts, dict)
            or any(
                not isinstance(year, str) or not _nonnegative_int(count) or count == 0
                for year, count in cohorts.items()
            )
            or sum(cohorts.values()) != period["contributing_entities"]
            or not isinstance(period.get("period_supported"), bool)
            or not isinstance(period.get("inference_supported"), bool)
            or not isinstance(period.get("suppress_inference"), bool)
            or not isinstance(reason_codes, list)
            or any(not isinstance(reason, str) for reason in reason_codes)
            or not isinstance(reasons, list)
            or any(not isinstance(reason, str) for reason in reasons)
        ):
            return None
        terms.add(term)
        event_times.add(event_time)
        typed_periods.append(period)

    references = [period for period in typed_periods if period["is_reference"] is True]
    if len(references) != 1:
        return None
    reference = references[0]
    if reference["term"] != reference_term or reference["event_time"] != base_k or reference["estimated"] is not False:
        return None
    reference_supported = reference["contributing_clusters"] >= MIN_TREATED_CLUSTERS
    for period in typed_periods:
        is_reference = period["term"] == reference_term
        period_supported = period["contributing_clusters"] >= MIN_TREATED_CLUSTERS
        inference_supported = period_supported and reference_supported
        if (
            period["is_reference"] is not is_reference
            or period["estimated"] is not (not is_reference)
            or period["period_supported"] is not period_supported
            or period["inference_supported"] is not inference_supported
            or period["suppress_inference"] is not (not inference_supported)
        ):
            return None

    event_coefficient_names = [
        str(coefficient.get("name", ""))
        for coefficient in _list_values(result.get("coefs"))
        if isinstance(coefficient, dict) and str(coefficient.get("name", "")).startswith("k=")
    ]
    main_result_terms = {name for name in event_coefficient_names if not name.endswith("×base_gvc")}
    interaction_result_terms = {
        name.replace("×base_gvc", "") for name in event_coefficient_names if name.endswith("×base_gvc")
    }
    estimated_terms = {period["term"] for period in typed_periods if period["estimated"] is True}
    complete = main_result_terms == estimated_terms and (
        interaction_result_terms == estimated_terms
        if interaction
        else not interaction_result_terms or interaction_result_terms == estimated_terms
    )
    return raw_support if complete else None


def _event_period(result: dict[str, Any], term: str, interaction: bool = False) -> dict[str, Any] | None:
    event_support = _valid_event_support(result, interaction)
    if event_support is None:
        return None
    main_term = term.replace("×base_gvc", "")
    return next(
        (
            period
            for period in cast(list[Any], event_support["periods"])
            if isinstance(period, dict) and period.get("term") == main_term
        ),
        None,
    )


def _event_period_limit(design: dict[str, Any], result: dict[str, Any], term: str) -> str | None:
    if design.get("method") != "event_study" or not term.startswith("k="):
        return None
    period = _event_period(result, term, design.get("interaction") is True)
    if period is None:
        return "逐事件期处理支持度未知：旧结果缺少或损坏 REG-01 支持契约，p 值、置信区间和方向性结论不可用。"
    if period.get("inference_supported") is True:
        return None
    reasons = " ".join(_safe(reason) for reason in _list_values(period.get("reasons")))
    return reasons or "该事件期处理聚类支持不足，逐期统计推断已抑制。"


def _primary_event_limit(
    design: dict[str, Any], result: dict[str, Any], coefficient: dict[str, Any] | None = None
) -> str | None:
    if design.get("method") != "event_study":
        return None
    chosen = coefficient or _primary_coefficient(design, result)
    if chosen is None:
        return "当前事件研究没有可解读的处理后政策系数。"
    return _event_period_limit(design, result, str(chosen.get("name", "")))


def _effective_status(result: dict[str, Any]) -> str:
    """Use the most severe persisted status instead of letting a stale `ok` mask a gate."""
    raw_support = result.get("support")
    support: dict[str, Any] = raw_support if isinstance(raw_support, dict) else {}
    statuses = [result.get("status"), support.get("status")]
    for status in ("invalid_design", "insufficient", "warning", "ok"):
        if status in statuses:
            return status
    return "unknown"


def _global_inference_suppressed(result: dict[str, Any]) -> bool:
    raw_support = result.get("support")
    support: dict[str, Any] = raw_support if isinstance(raw_support, dict) else {}
    return support.get("suppress_inference") is True or _effective_status(result) in {"insufficient", "invalid_design"}


def _natural_effect(
    outcome: str, design: dict[str, Any], result: dict[str, Any], coefficient: dict[str, Any]
) -> tuple[str, str, str]:
    increment = 0.01 if design.get("method") == "twfe_intensity" else 1.0
    effect = float(coefficient["coef"]) * increment
    ci_low, ci_high = coefficient.get("ci_low"), coefficient.get("ci_high")
    ci = (
        (float(ci_low), float(ci_high))
        if not _global_inference_suppressed(result)
        and _event_period_limit(design, result, str(coefficient.get("name", ""))) is None
        and _event_pretrend_contract_limit(design, result) is None
        and isinstance(ci_low, (int, float))
        and isinstance(ci_high, (int, float))
        else None
    )
    if design.get("method") == "twfe_intensity":
        effect_label = "冲击强度每增加 1 个百分点"
    elif design.get("method") == "event_study":
        name = str(coefficient.get("name", ""))
        effect_label = "冲击当期变化（k=0）" if name == "k=0" else f"冲击后变化（{name or '所选时期'}）"
    else:
        effect_label = "处理后相对变化"
    if design.get("interaction"):
        effect_label += "（处理前 GVC 样本均值处）"
    if outcome in {"trade", "production"}:
        effect_text = f"{_signed(effect * 100, 2)} 个百分点"
        interval = (
            f"[{_signed(ci[0] * increment * 100, 2)}, {_signed(ci[1] * increment * 100, 2)}] 个百分点" if ci else "—"
        )
    elif outcome == "network":
        sd = result.get("depvar_std")
        relative = effect / float(sd) if isinstance(sd, (int, float)) and float(sd) > 0 else None
        effect_text = f"{_signed(effect, 2)} 个中心性原始单位"
        if relative is not None:
            effect_text += f"（约 {_signed(relative, 2)} 个样本标准差）"
        interval = f"[{_signed(ci[0] * increment, 2)}, {_signed(ci[1] * increment, 2)}] 个原始单位" if ci else "—"
    else:
        effect_text = f"{_signed(effect, 3)} 个长度单位"
        interval = f"[{_signed(ci[0] * increment, 3)}, {_signed(ci[1] * increment, 3)}] 个长度单位" if ci else "—"
    return effect_label, effect_text, interval


def _event_pretrend_is_safe(
    result: dict[str, Any],
    pretrend: dict[str, Any],
    expected_scope: str = "main",
    interaction: bool = False,
) -> bool:
    """Reject saved pretrend inference unless its scope exhaustively matches event support."""
    raw_scope = pretrend.get("scope")
    scope = expected_scope
    if raw_scope != expected_scope:
        return False
    interpretation = pretrend.get("interpretation")
    if (
        _valid_event_support(result, interaction) is None
        or not isinstance(interpretation, str)
        or not interpretation.strip()
    ):
        return False
    terms = pretrend.get("terms")
    if not isinstance(terms, list) or any(not isinstance(term, str) for term in terms) or len(set(terms)) != len(terms):
        return False
    if "excluded_terms" not in pretrend:
        return False
    excluded_terms = pretrend.get("excluded_terms", [])
    if not isinstance(excluded_terms, list):
        return False

    def term_is_in_scope(term: Any) -> bool:
        return (
            isinstance(term, str)
            and term.startswith("k=-")
            and (
                scope == "joint"
                or (scope == "interaction" and term.endswith("×base_gvc"))
                or (scope == "main" and not term.endswith("×base_gvc"))
            )
        )

    if any(
        not isinstance(item, dict)
        or not term_is_in_scope(item.get("term"))
        or not isinstance(item.get("reasons"), list)
        or not item["reasons"]
        or any(not isinstance(reason, str) or not reason.strip() for reason in item["reasons"])
        for item in excluded_terms
    ):
        return False
    excluded_names = [item["term"] for item in excluded_terms]
    if len(excluded_names) != len(set(excluded_names)) or set(excluded_names) & set(terms):
        return False
    support = _valid_event_support(result, interaction)
    assert support is not None
    main_terms = [
        period["term"]
        for period in cast(list[dict[str, Any]], support["periods"])
        if period["estimated"] is True and period["event_time"] < 0
    ]
    interaction_terms = [f"{term}×base_gvc" for term in main_terms]
    scoped_terms = (
        main_terms
        if scope == "main"
        else interaction_terms
        if scope == "interaction"
        else [*main_terms, *interaction_terms]
    )
    supported_terms = {
        term
        for term in scoped_terms
        if (_event_period(result, term, interaction) or {}).get("inference_supported") is True
    }
    unsupported_terms = set(scoped_terms) - supported_terms
    reason = pretrend.get("reason")
    expected_terms = (
        set()
        if reason in {"global_inference_suppressed", "no_supported_pre_terms", "no_pre_terms"}
        else supported_terms
    )
    expected_excluded = set(scoped_terms) if reason == "global_inference_suppressed" else unsupported_terms
    if set(terms) != expected_terms or len(terms) != len(expected_terms) or set(excluded_names) != expected_excluded:
        return False
    if pretrend.get("reason") != "global_inference_suppressed" and any(
        (_event_period(result, term, interaction) or {}).get("inference_supported") is not False
        for term in excluded_names
    ):
        return False
    for term in terms:
        period = _event_period(result, term, interaction)
        if (
            not term_is_in_scope(term)
            or period is None
            or period.get("estimated") is not True
            or not isinstance(period.get("event_time"), int)
            or period["event_time"] >= 0
            or period.get("inference_supported") is not True
        ):
            return False
    available = pretrend.get("available")
    if not isinstance(available, bool):
        return False
    if not available:
        df_num = pretrend.get("df_num")
        df_denom = pretrend.get("df_denom")
        reason = pretrend.get("reason")
        q = len(terms)
        reason_semantics = (
            not scoped_terms
            if reason == "no_pre_terms"
            else bool(scoped_terms) and not supported_terms
            if reason == "no_supported_pre_terms"
            else q > df_denom
            if reason == "insufficient_cluster_df" and isinstance(df_denom, int)
            else q > 0 and q <= df_denom
            if reason == "singular_covariance" and isinstance(df_denom, int)
            # Globally suppressed diagnostics are descriptive only. A qualification validator
            # must never accept that reason without the actual whole-run gate, which is checked
            # before this function and already makes the result unqualified.
            else False
        )
        return (
            isinstance(reason, str)
            and reason in _SAFE_UNAVAILABLE_PRETREND_REASONS
            and reason_semantics
            and pretrend.get("statistic") is None
            and pretrend.get("p") is None
            and isinstance(df_num, int)
            and not isinstance(df_num, bool)
            and df_num == len(terms)
            and isinstance(df_denom, int)
            and not isinstance(df_denom, bool)
            and df_denom >= 0
        )
    statistic = pretrend.get("statistic")
    p_value = pretrend.get("p")
    return (
        pretrend.get("reason") is None
        and bool(terms)
        and isinstance(statistic, (int, float))
        and not isinstance(statistic, bool)
        and math.isfinite(float(statistic))
        and isinstance(p_value, (int, float))
        and not isinstance(p_value, bool)
        and math.isfinite(float(p_value))
        and 0 <= float(p_value) <= 1
        and float(statistic) >= 0
        and isinstance(pretrend.get("df_num"), int)
        and not isinstance(pretrend.get("df_num"), bool)
        and pretrend["df_num"] == len(terms)
        and isinstance(pretrend.get("df_denom"), int)
        and not isinstance(pretrend.get("df_denom"), bool)
        and pretrend["df_denom"] > 0
        and len(terms) <= pretrend["df_denom"]
    )


def _main_pretrend_contract_is_safe(result: dict[str, Any]) -> bool:
    diagnostics = result.get("diagnostics")
    if not isinstance(diagnostics, dict) or not isinstance(diagnostics.get("pretrend"), dict):
        return False
    main = diagnostics["pretrend"]
    if not _event_pretrend_is_safe(result, main, "main", False):
        return False
    if "pretrend_tests" not in diagnostics:
        return True
    tests = diagnostics.get("pretrend_tests")
    return (
        isinstance(tests, dict)
        and set(tests) == {"main"}
        and isinstance(tests.get("main"), dict)
        and _event_pretrend_is_safe(result, tests["main"], "main", False)
        and main == tests["main"]
    )


def _interaction_pretrend_scopes_are_safe(result: dict[str, Any]) -> bool:
    diagnostics = result.get("diagnostics")
    if not isinstance(diagnostics, dict):
        return False
    legacy = diagnostics.get("pretrend")
    tests = diagnostics.get("pretrend_tests")
    if not isinstance(legacy, dict) or not isinstance(tests, dict):
        return False
    if set(tests) != {"main", "interaction", "joint"}:
        return False
    if any(
        not isinstance(tests[scope], dict) or not _event_pretrend_is_safe(result, tests[scope], scope, True)
        for scope in ("main", "interaction", "joint")
    ):
        return False
    main, interaction, joint = tests["main"], tests["interaction"], tests["joint"]
    combined_terms = set(main["terms"]) | set(interaction["terms"])
    combined_excluded = {item["term"] for item in [*main["excluded_terms"], *interaction["excluded_terms"]]}
    if set(joint["terms"]) != combined_terms or {item["term"] for item in joint["excluded_terms"]} != combined_excluded:
        return False
    return legacy == joint


def _event_pretrend_contract_limit(design: dict[str, Any] | None, result: dict[str, Any]) -> str | None:
    if not design or design.get("method") != "event_study":
        return None
    safe = (
        _interaction_pretrend_scopes_are_safe(result)
        if design.get("interaction") is True
        else _main_pretrend_contract_is_safe(result)
    )
    if safe:
        return None
    scope = "主效应、交互效应与联合" if design.get("interaction") is True else "主效应"
    return f"{scope}冲击前诊断缺失、不完整或已损坏；已有区间仅作描述，方向性推断已关闭。"


def _failed_pretrend(result: dict[str, Any], design: dict[str, Any] | None = None) -> str | None:
    if _global_inference_suppressed(result):
        return None
    contract_limit = _event_pretrend_contract_limit(design, result)
    if contract_limit is not None:
        return contract_limit
    raw_diagnostics = result.get("diagnostics")
    diagnostics: dict[str, Any] = raw_diagnostics if isinstance(raw_diagnostics, dict) else {}
    raw_pretrend = diagnostics.get("pretrend")
    if not isinstance(raw_pretrend, dict) or raw_pretrend.get("available") is not True:
        return None
    pretrend: dict[str, Any] = raw_pretrend
    if (
        design
        and design.get("method") == "event_study"
        and not _event_pretrend_is_safe(
            result,
            pretrend,
            "joint" if design.get("interaction") is True else "main",
            design.get("interaction") is True,
        )
    ):
        return None
    p_value = pretrend.get("p")
    if (
        not isinstance(p_value, (int, float))
        or isinstance(p_value, bool)
        or not math.isfinite(float(p_value))
        or float(p_value) >= 0.05
    ):
        return None
    interpretation = _safe(pretrend.get("interpretation") or "检测到明显的冲击前差异")
    return f"冲击前趋势联合检验 p={_number(p_value, p_value=True)}；{interpretation}"


def _evidence_reading(
    outcome: str, coefficient: dict[str, Any], suppressed: bool, failed_pretrend: str | None
) -> tuple[str, str]:
    if suppressed:
        return "不可作方向判断", "统计推断已被抑制；点估计只是计算输出，不能据此判断上升或下降。"
    if failed_pretrend:
        coef = float(coefficient["coef"])
        direction = "正向" if coef > 0 else "负向" if coef < 0 else "接近零"
        return (
            "冲击前趋势存在明显差异",
            f"当前模型得到{direction}点估计，但冲击前已经存在明显差异；只能描述该数值，不能把它解释为冲击后的方向性变化证据。",
        )
    ci_low, ci_high = coefficient.get("ci_low"), coefficient.get("ci_high")
    if not isinstance(ci_low, (int, float)) or not isinstance(ci_high, (int, float)):
        return "证据不足", "置信区间未记录，不能确定估计方向。"
    if ci_high < 0:
        return "发现负向变化证据", _OUTCOME_INTERPRETATIONS[outcome]["negative"]
    if ci_low > 0:
        return "发现正向变化证据", _OUTCOME_INTERPRETATIONS[outcome]["positive"]
    return "证据不足，无法判断方向", "95% 置信区间跨过 0；这不等于“没有效应”，而是当前证据不足以确定方向。"


def _summary_design_limit(
    status: str, support: dict[str, Any], reasons: list[Any], failed_pretrend: str | None
) -> str | None:
    if status in {"insufficient", "invalid_design"} and reasons:
        return _safe(reasons[0], 360)
    if failed_pretrend:
        return failed_pretrend
    untreated_clusters = support.get("untreated_clusters")
    if untreated_clusters == 0:
        treated_clusters = _count(support.get("treated_clusters"))
        untreated_entities = _count(support.get("untreated_entities"))
        return (
            f"估计样本中没有完全未暴露的对照聚类：{treated_clusters} 个聚类都至少包含一个暴露实体；"
            f"仍有 {untreated_entities} 个未暴露实体（可能包括冻结 cohort 中仅保留冲击前行的实体），"
            "聚类层面的共同冲击识别仍更依赖模型设定。"
        )
    reversal_share = support.get("reversal_share")
    if isinstance(reversal_share, (int, float)) and reversal_share > 0:
        return (
            f"约 {float(reversal_share) * 100:.2f}% 的处理后个体—年发生处理撤销；"
            "吸收型编码仍把撤销后的观测记为已处理，解释时需说明这一偏离。"
        )
    if status == "warning" and reasons:
        return _safe(reasons[0], 360)
    return None


def _run_fingerprint(design: dict[str, Any], result: dict[str, Any]) -> str:
    """Return exact deterministic JSON identity for saved-run deduplication.

    A coarse estimand/first-coefficient key can let a distinct latest run shadow
    the valid qualified snapshot that follows it. Include every persisted design/result
    field so only genuinely identical snapshots deduplicate.
    """
    return json.dumps(
        {"design": design, "result": result},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _parse_saved_run(raw: Any, outcome: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    if not isinstance(raw, dict):
        return None
    design, result = raw.get("design"), raw.get("result")
    if not isinstance(design, dict) or not isinstance(result, dict) or design.get("outcome") != outcome:
        return None
    coefs = result.get("coefs")
    if not isinstance(coefs, list) or not any(
        isinstance(coef, dict)
        and isinstance(coef.get("name"), str)
        and isinstance(coef.get("coef"), (int, float))
        and not isinstance(coef.get("coef"), bool)
        and math.isfinite(float(coef["coef"]))
        for coef in coefs
    ):
        return None
    return design, result


def _saved_runs(session: dict[str, Any]) -> list[dict[str, Any]]:
    """Use stored design/result objects directly; malformed optional runs are ignored.

    Each step shows the latest ``run`` and may also keep ``qualified_run`` so a later
    insufficient estimate does not erase the only inferential result for the report gate.
    """
    runs: list[dict[str, Any]] = []
    for step, outcome in sorted(_STEP_OUTCOMES.items()):
        data = _step_data(session, step)
        seen: set[str] = set()
        for key in ("run", "qualified_run"):
            parsed = _parse_saved_run(data.get(key), outcome)
            if parsed is None:
                continue
            design, result = parsed
            fingerprint = _run_fingerprint(design, result)
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            runs.append({"step": step, "outcome": outcome, "design": design, "result": result})
    return runs


def _result_is_qualified(result: dict[str, Any], design: dict[str, Any] | None = None) -> bool:
    if not isinstance(design, dict):
        return False
    raw_support = result.get("support")
    support: dict[str, Any] = raw_support if isinstance(raw_support, dict) else {}
    allowed_statuses = {"ok", "warning"}
    result_status, support_status = result.get("status"), support.get("status")
    statuses = [status for status in (result_status, support_status) if status is not None]
    if not statuses or any(not isinstance(status, str) or status not in allowed_statuses for status in statuses):
        return False
    if result_status is not None and support_status is not None and result_status != support_status:
        return False
    if support.get("suppress_inference") is True:
        return False
    if _event_pretrend_contract_limit(design, result) is not None:
        return False
    return not design or _primary_event_limit(design, result) is None


def _gate_qualified_runs(session: dict[str, Any]) -> list[dict[str, Any]]:
    """Return saved runs whose server result remains eligible for inference."""
    return [run for run in _saved_runs(session) if _result_is_qualified(run["result"], run["design"])]


def _reflection_value(value: Any) -> str:
    """Keep accepted student prose byte-for-byte instead of normalizing Markdown."""
    return value if isinstance(value, str) else "—"


def _reflection_section(session: dict[str, Any]) -> list[str]:
    reflection = _step_data(session, 16)
    return [
        "## 学生原创分析与反思",
        "",
        "### 研究问题",
        "",
        _reflection_value(reflection.get("research_question")),
        "",
        "### 证据解释",
        "",
        _reflection_value(reflection.get("evidence_interpretation")),
        "",
        "### 局限与反思",
        "",
        _reflection_value(reflection.get("limitations")),
        "",
    ]


def _quiz_sections(session: dict[str, Any]) -> list[str]:
    lines = ["## 理解检查摘要", ""]
    for step in GATE_STEPS:
        selected = quizzes.selected_answers(step, _step_data(session, step).get("quiz"))
        lines.extend((f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}", ""))
        for item in selected:
            lines.append(f"- {_safe(item['question'])}：{_safe(item['answer'])}")
        lines.append("")
    return lines


def _list_values(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _experiment_sections(session: dict[str, Any]) -> list[str]:
    """Render only snapshots produced by explicit student interactions."""
    lines = [
        "## 保存的实验快照",
        "",
        "以下内容来自会话中实际保存的切片、筛选和观察；未操作的默认视图不会被写成学生发现。",
        "",
    ]
    captured = False

    db = _step_data(session, 1)
    raw_slice = db.get("slice")
    browse_slice: dict[str, Any] | None = raw_slice if isinstance(raw_slice, dict) else None
    raw_observation = db.get("observation")
    observation: dict[str, Any] | None = raw_observation if isinstance(raw_observation, dict) else None
    source_slice = (
        observation
        if observation is not None
        and observation.get("year") not in (None, "")
        and observation.get("table") not in (None, "")
        else browse_slice
    )
    if source_slice or observation:
        captured = True
        lines.extend(("### 步骤 1 · OECD ICIO 数据浏览", ""))
        if source_slice:
            selection = "；".join(
                f"{label}={_safe(source_slice.get(key, '—'))}"
                for key, label in (
                    ("year", "年份"),
                    ("table", "表"),
                    ("row_country", "供给国"),
                    ("row_sector", "供给行业"),
                    ("col_country", "使用/需求国"),
                    ("col_sector", "使用行业/最终需求"),
                )
                if source_slice.get(key) not in (None, "")
            )
            lines.append(f"- 保存的切片：{selection or '—'}")
        if observation:
            observation_value = observation.get("value", "—")
            lines.append(
                f"- 记录的单元格：{_safe(observation.get('row', '—'))} × "
                f"{_safe(observation.get('column', '—'))} = {_number(observation_value) if isinstance(observation_value, (int, float)) else _safe(observation_value)}"
            )
        lines.append("")

    for step in range(3, 11):
        data = _step_data(session, step)
        compared = _list_values(data.get("compared"))
        observations = [item for item in _list_values(data.get("observations")) if isinstance(item, dict)]
        has_snapshot = any(
            data.get(key) not in (None, "", []) for key in ("year", "country", "chart", "drill", "metric")
        ) or bool(compared or observations)
        if not has_snapshot:
            continue
        captured = True
        lines.extend((f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}", ""))
        context = []
        for key, label in (("year", "年份"), ("country", "国家"), ("chart", "图表视角"), ("drill", "下钻")):
            if data.get(key) not in (None, ""):
                context.append(f"{label}={_safe(data[key])}")
        if context:
            lines.append(f"- 保存的视图：{'；'.join(context)}")
        if compared:
            lines.append(f"- 主动比较：{'、'.join(_safe(item) for item in compared)}")
        if observations:
            lines.extend(
                (f"- 记录指标：`{_safe(data.get('metric', '—'))}`", "", "| 实体 | 年份 | 数值 |", "|---|---:|---:|")
            )
            for item in observations:
                observation_value = item.get("value", "—")
                lines.append(
                    f"| {_safe(item.get('entity', item.get('country', '—')))} | "
                    f"{_safe(item.get('year', '—'))} | "
                    f"{_number(observation_value) if isinstance(observation_value, (int, float)) else _safe(observation_value)} |"
                )
        lines.append("")

    shock = _step_data(session, 11)
    viewed_types = _list_values(shock.get("viewed_shock_types"))
    viewed_events = _list_values(shock.get("viewed_events"))
    selected_event = shock.get("selected_event_key")
    if viewed_types or viewed_events or selected_event:
        captured = True
        lines.extend(("### 步骤 11 · 贸易政策冲击数据接入", ""))
        if viewed_types:
            lines.append(f"- 查看过的冲击类型：{'、'.join(_safe(item) for item in viewed_types)}")
        if viewed_events:
            lines.append(f"- 查看过的政策事件：{'、'.join(_safe(item) for item in viewed_events)}")
        if selected_event:
            lines.append(f"- 最后选择的事件：{_safe(selected_event)}（仅用于探索定位，不限定下游回归样本）")
        lines.extend(
            (
                "- 下游回归口径：按所选冲击类型汇总该类型全部已编码事件的国家×行业暴露，不把单个事件选择当作回归筛选。",
                "",
            )
        )

    if not captured:
        lines.extend(("- 未保存额外实验快照。", ""))
    return lines


def _qualified_by_step(runs: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    chosen: dict[int, dict[str, Any]] = {}
    for run in runs:
        if _result_is_qualified(run["result"], run["design"]) and run["step"] not in chosen:
            chosen[run["step"]] = run
    return chosen


def _comparison_table(runs: list[dict[str, Any]]) -> list[str]:
    qualified = _qualified_by_step(runs)
    lines = [
        "### 四类指标并读",
        "",
        "这四步分别估计贸易流、生产、长度和网络四类指标。"
        "下表列出各步实际保存的可报告结果；系数因量纲和估计对象不同，不能直接比大小。",
        "",
        "| 步骤 | 指标 | 冲击 | 比较方式 | 估计对象与相对变化 | 95% 区间 | 证据判断 |",
        "|---|---|---|---|---|---|---|",
    ]
    designs = []
    for step, outcome in sorted(_STEP_OUTCOMES.items()):
        run = qualified.get(step)
        if run is None:
            lines.append(f"| {step} | {_safe(_STEP_TITLES.get(step, outcome))} | — | — | — | — | 未保存可报告估计 |")
            continue
        design, result = run["design"], run["result"]
        designs.append(
            (
                design.get("shock_type"),
                design.get("method"),
                bool(design.get("interaction")),
                design.get("control_mode"),
                design.get("scenario"),
            )
        )
        coefficient = _primary_coefficient(design, result)
        if coefficient is None or not isinstance(coefficient.get("coef"), (int, float)):
            lines.append(
                f"| {step} | {_safe(design.get('depvar_label', outcome))} | "
                f"{_setting_value('shock_type', design.get('shock_type'))} | "
                f"{_setting_value('method', design.get('method'))} | — | — | 无可读政策系数 |"
            )
            continue
        effect_label, effect, interval = _natural_effect(outcome, design, result, coefficient)
        period_limit = _primary_event_limit(design, result, coefficient)
        diagnostic_limit = _event_pretrend_contract_limit(design, result)
        suppressed = _global_inference_suppressed(result) or period_limit is not None or diagnostic_limit is not None
        evidence, _interpretation = _evidence_reading(
            outcome, coefficient, suppressed, _failed_pretrend(result, design)
        )
        lines.append(
            f"| {step} | {_safe(design.get('depvar_label', outcome))} | "
            f"{_setting_value('shock_type', design.get('shock_type'))} | "
            f"{_setting_value('method', design.get('method'))} | {_safe(effect_label)}：{effect} | {interval} | {evidence} |"
        )
    lines.append("")
    if len({item for item in designs}) > 1:
        lines.extend(
            (
                "- **读表注意：** 上表各行的冲击、比较方式或控制设定并不相同，只能并列查看，不能当成同一个系数比较。",
                "",
            )
        )
    return lines


def _evidence_summary(runs: list[dict[str, Any]]) -> list[str]:
    lines = [
        "## 关键证据摘要",
        "",
        "本节把保存的主要估计翻译成课堂中的单位和证据判断。完整方程、全部控制项与诊断保留在后面的技术附录。",
        "",
        *_comparison_table(runs),
    ]
    if not runs:
        lines.extend(("- 未保存可展示的回归结果。", ""))
        return lines
    qualified = _qualified_by_step(runs)
    for run in runs:
        step, outcome = run["step"], run["outcome"]
        design, result = run["design"], run["result"]
        support = result.get("support") if isinstance(result.get("support"), dict) else {}
        status = _effective_status(result)
        primary = _primary_coefficient(design, result)
        period_limit = _primary_event_limit(design, result, primary)
        diagnostic_limit = _event_pretrend_contract_limit(design, result)
        suppressed = _global_inference_suppressed(result) or period_limit is not None or diagnostic_limit is not None
        used_in_table = qualified.get(step) is run
        marker = (
            "（对照表采用）"
            if used_in_table
            else ("（探索结果，未列入对照表）" if not _result_is_qualified(result, design) else "")
        )
        coefficient = primary
        lines.extend((f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}{marker}", ""))
        if coefficient is None or not isinstance(coefficient.get("coef"), (int, float)):
            lines.extend(("- 当前设定没有可解读的主要政策系数。", ""))
            continue
        effect_label, effect, interval = _natural_effect(outcome, design, result, coefficient)
        failed_pretrend = _failed_pretrend(result, design)
        evidence, interpretation = _evidence_reading(outcome, coefficient, suppressed, failed_pretrend)
        setting = " · ".join(
            _setting_value(key, design.get(key))
            for key in ("shock_type", "method", "granularity", "control_mode", "scenario")
            if design.get(key) not in (None, "")
        )
        lines.extend(
            (
                "| 项目 | 学生可读结果 |",
                "|---|---|",
                f"| 研究对象 | {_safe(design.get('depvar_label', outcome))} |",
                f"| 保存的模型 | {setting or '—'} |",
                f"| {effect_label} | **{effect}** |",
                f"| 95% 置信区间 | {interval} |",
                f"| 证据判断 | **{evidence}** |",
                f"| 设计状态 | {_STATUS_LABELS.get(status, _STATUS_LABELS['unknown'])} |",
                "",
                f"- **可以支持的表述：** {interpretation}",
                "- **不能支持的表述：** 本结果不能自动证明拟真政策冲击导致了现实中的 GVC 变化。",
            )
        )
        reasons = [*_list_values(result.get("status_reasons")), *_list_values(support.get("reasons"))]
        design_limit = (
            period_limit or diagnostic_limit or _summary_design_limit(status, support, reasons, failed_pretrend)
        )
        if design_limit:
            lines.append(f"- **最重要的设计限制：** {design_limit}")
        lines.append("")
    return lines


def _run_sections(runs: list[dict[str, Any]]) -> list[str]:
    lines = [
        "## 技术附录：保存的回归结果",
        "",
        "以下结果来自会话中保存的服务端运行，不在报告生成时重新估计。同一步可能有最近一次探索和一份可报告快照。表格数值为便于阅读做了四位有效数字的显示舍入；完整原始值仍保留在报告溯源数据中。",
        "",
    ]
    grouped: dict[int, list[dict[str, Any]]] = {step: [] for step in _STEP_OUTCOMES}
    for run in runs:
        grouped.setdefault(run["step"], []).append(run)
    for step in sorted(_STEP_OUTCOMES):
        step_runs = grouped.get(step) or []
        if not step_runs:
            lines.append(f"- 步骤 {step} · {_STEP_TITLES.get(step, '')}：未记录。")
            continue
        for index, run in enumerate(step_runs):
            design, result = run["design"], run["result"]
            support = result.get("support") if isinstance(result.get("support"), dict) else {}
            status = _effective_status(result)
            reasons = [*_list_values(result.get("status_reasons")), *_list_values(support.get("reasons"))]
            reasons = list(dict.fromkeys(_safe(reason) for reason in reasons))
            globally_suppressed = _global_inference_suppressed(result)
            diagnostic_limit = _event_pretrend_contract_limit(design, result)
            suppressed = globally_suppressed or diagnostic_limit is not None
            heading = f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}"
            if len(step_runs) > 1:
                heading += f"（保存 {index + 1}/{len(step_runs)}）"
            lines.extend(
                (
                    heading,
                    "",
                    f"- 因变量：{_safe(design.get('depvar_label', run['outcome']))}",
                    f"- 结果量纲：{_OUTCOME_UNITS.get(run['outcome'], '原始单位')}",
                    f"- 方程：`{_safe(design.get('equation', '—'))}`",
                    f"- 设计状态：{_STATUS_LABELS.get(str(status), _STATUS_LABELS['unknown'])}；观测数：{_count(result.get('n_obs'))}",
                )
            )
            setting_bits = [
                f"{label}={_setting_value(key, design[key])}"
                for key, label in (
                    ("granularity", "粒度"),
                    ("shock_type", "冲击类型"),
                    ("method", "方法"),
                    ("control_mode", "控制变量"),
                    ("price_mode", "价格口径"),
                    ("scenario", "教学场景"),
                )
                if design.get(key) not in (None, "")
            ]
            if setting_bits:
                lines.append(f"- 保存的设定：{'；'.join(setting_bits)}")
            if reasons:
                lines.append("- 主要设计限制：")
                lines.extend(f"  - {reason}" for reason in reasons)
            if support:
                support_bits = []
                for key, label in (
                    ("treated_entities", "处理个体"),
                    ("treated_clusters", "处理聚类"),
                    ("untreated_entities", "估计样本内未暴露个体"),
                    ("untreated_clusters", "估计样本内完全未暴露聚类"),
                    ("reversal_share", "处理撤销行占比"),
                ):
                    if support.get(key) is not None:
                        value = support[key]
                        rendered = (
                            f"{float(value) * 100:.2f}%"
                            if key == "reversal_share" and isinstance(value, (int, float))
                            else _count(value)
                        )
                        support_bits.append(f"{label}={rendered}")
                if support_bits:
                    lines.append(f"- 处理支持：{'；'.join(support_bits)}")
            if suppressed:
                lines.append(
                    "- **统计推断已抑制**：下表点估计仅说明计算输出；不得把缺失的 p 值或置信区间解释为无效应，也不得据此形成方向性结论。"
                )
            if diagnostic_limit is not None:
                lines.append(f"- **冲击前诊断未知/已抑制**：{diagnostic_limit}")
            lines.extend(("", "| 变量 | 点估计 | 标准误 | 95% 置信区间 | p 值 |", "|---|---:|---:|---:|---:|"))
            for coefficient in result.get("coefs", []):
                if isinstance(coefficient, dict):
                    local_limit = _event_period_limit(design, result, str(coefficient.get("name", "")))
                    ci_low, ci_high = coefficient.get("ci_low"), coefficient.get("ci_high")
                    interval = (
                        "逐期支持不足/未知，已抑制"
                        if local_limit is not None
                        else (
                            "已抑制"
                            if suppressed
                            else (
                                f"[{_number(ci_low)}, {_number(ci_high)}]"
                                if ci_low is not None and ci_high is not None
                                else "—"
                            )
                        )
                    )
                    p_raw = coefficient.get("p")
                    p_value = (
                        "逐期支持不足/未知，已抑制"
                        if local_limit is not None
                        else "已抑制"
                        if suppressed
                        else _number(p_raw, p_value=True)
                    )
                    lines.append(
                        f"| {_coefficient_label(coefficient.get('name', '—'), design)} | {_number(coefficient.get('coef'))} | "
                        f"{_number(coefficient.get('se'))} | {interval} | {p_value} |"
                    )
            marginal_effects = [item for item in _list_values(result.get("marginal_effects")) if isinstance(item, dict)]
            if marginal_effects:
                lines.extend(
                    (
                        "",
                        "交互模型边际效应（主效应与交互项的线性组合）：",
                        "",
                        "| 政策项 | 处理前 GVC 水平 | 边际效应 | 95% 置信区间 | p 值 |",
                        "|---|---|---:|---:|---:|",
                    )
                )
                for item in marginal_effects:
                    local_limit = _event_period_limit(design, result, str(item.get("policy_term", "")))
                    ci_low, ci_high = item.get("ci_low"), item.get("ci_high")
                    interval = (
                        "逐期支持不足/未知，已抑制"
                        if local_limit is not None
                        else (
                            "已抑制"
                            if suppressed
                            else (
                                f"[{_number(ci_low)}, {_number(ci_high)}]"
                                if ci_low is not None and ci_high is not None
                                else "—"
                            )
                        )
                    )
                    p_raw = item.get("p")
                    p_value = (
                        "逐期支持不足/未知，已抑制"
                        if local_limit is not None
                        else "已抑制"
                        if suppressed
                        else _number(p_raw, p_value=True)
                    )
                    lines.append(
                        f"| {_coefficient_label(item.get('policy_term', '—'), design)} | {_safe(item.get('label', '—'))} | "
                        f"{_number(item.get('effect'))} | {interval} | {p_value} |"
                    )
            diagnostics = result.get("diagnostics") if isinstance(result.get("diagnostics"), dict) else {}
            pretrend = diagnostics.get("pretrend") if isinstance(diagnostics.get("pretrend"), dict) else None
            interaction_scopes_valid = design.get("interaction") is True and _interaction_pretrend_scopes_are_safe(
                result
            )
            if interaction_scopes_valid:
                tests = cast(dict[str, dict[str, Any]], diagnostics["pretrend_tests"])
                pretrend_items = [
                    ("主效应", tests["main"]),
                    ("交互效应", tests["interaction"]),
                    ("联合", tests["joint"]),
                ]
            else:
                pretrend_items = [("联合", pretrend)] if pretrend else []
            if (
                design.get("interaction") is True
                and pretrend
                and pretrend.get("reason") != "global_inference_suppressed"
                and not interaction_scopes_valid
                and not suppressed
            ):
                lines.append(
                    "- 冲击前趋势联合检验：不可评估；交互诊断 scope 集缺失或损坏，既有检验值与解释不用于教学推断。"
                )
            else:
                for scope_label, scoped_pretrend in pretrend_items:
                    prefix = f"冲击前趋势检验（{scope_label}）"
                    if globally_suppressed:
                        lines.append(f"- {prefix}：不可评估；{_GLOBAL_PRETREND_SUPPRESSION_COPY}")
                    elif scoped_pretrend.get("reason") == "global_inference_suppressed":
                        lines.append(
                            f"- {prefix}：不可评估；诊断已损坏或状态未知：诊断声称整体推断已抑制，"
                            "但结果状态与处理支持并未触发整体门禁；不得采用该诊断的统计量或解释。"
                        )
                    elif design.get("method") == "event_study" and not _event_pretrend_is_safe(
                        result,
                        scoped_pretrend,
                        str(scoped_pretrend.get("scope") or "main"),
                        design.get("interaction") is True,
                    ):
                        lines.append(
                            f"- {prefix}：不可评估；旧结果缺少逐事件期支持契约、"
                            "支持不足期被错误纳入，或诊断契约已损坏，既有检验值与解释不用于教学推断。"
                        )
                    elif scoped_pretrend.get("available"):
                        lines.append(
                            f"- {prefix}：F={_number(scoped_pretrend.get('statistic'))}，"
                            f"p={_number(scoped_pretrend.get('p'), p_value=True)}；"
                            f"{_safe(scoped_pretrend.get('interpretation', ''))}"
                        )
                    else:
                        lines.append(
                            f"- {prefix}：不可评估；"
                            f"{_safe(scoped_pretrend.get('interpretation') or scoped_pretrend.get('reason') or '未提供原因')}"
                        )
            if not pretrend_items and design.get("method") == "event_study":
                copy = (
                    _GLOBAL_PRETREND_SUPPRESSION_COPY
                    if globally_suppressed
                    else (diagnostic_limit or "冲击前诊断缺失，方向性推断已关闭。")
                )
                lines.append(f"- 冲击前趋势联合检验：不可评估；{copy}")
            notes = [_safe(note) for note in _list_values(result.get("notes"))]
            if notes:
                lines.extend(("", "方法与限制："))
                lines.extend(f"- {note}" for note in notes)
            lines.append("")
    return lines


def _qc_release_summary(qc: Any) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "requires_disclosure": False,
        "override": False,
        "fatal": [],
        "warning": [],
        "disclosure": [],
    }

    def visit(value: Any) -> None:
        if not isinstance(value, dict):
            return
        summary["requires_disclosure"] = summary["requires_disclosure"] or value.get("requires_disclosure") is True
        summary["override"] = summary["override"] or value.get("override") is True
        for severity in ("fatal", "warning", "disclosure"):
            names = value.get(severity)
            if isinstance(names, list):
                summary[severity].extend(str(name) for name in names)
        for child in value.values():
            visit(child)

    visit(qc)
    for severity in ("fatal", "warning", "disclosure"):
        summary[severity] = list(dict.fromkeys(summary[severity]))
    summary["requires_disclosure"] = bool(
        summary["requires_disclosure"]
        or summary["override"]
        or summary["fatal"]
        or summary["warning"]
        or summary["disclosure"]
    )
    return summary


def _qc_disclosure_section(summary: dict[str, Any]) -> list[str]:
    if not summary["requires_disclosure"]:
        return []
    lines = ["## 数据质量披露", ""]
    if summary["override"]:
        lines.append("- 本数据版本包含经显式 override 接受的 fatal QC 项，仅可按教学边界使用。")
    for key, label in (("fatal", "Fatal"), ("warning", "Warning"), ("disclosure", "Disclosure")):
        if summary[key]:
            lines.append(f"- {label}：{'、'.join(summary[key])}")
    lines.append("")
    return lines


def build(session: dict[str, Any], student: str, *_unused: Any, **_unused_kw: Any) -> TeachingReport:
    blocked = check_gate(session)
    if blocked:
        raise ReportGateError(blocked)
    years = processed_years()
    if not years:
        raise ReportGateError([{"step": 0, "title": "数据不可用", "missing": ["尚未生成固定数据产物"]}])
    runs = _saved_runs(session)
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    fingerprint = hashlib.sha256(json.dumps(session, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]
    try:
        validate_release_cached()
        metadata = dataset_metadata()
    except (ArtifactContractError, OSError, ValueError, TypeError, RuntimeError) as error:
        raise ReportGateError(
            [{"step": 0, "title": "数据不可用", "missing": ["数据发布质检 contract 未通过验证"]}]
        ) from error
    raw_data_sources = metadata.get("data_sources")
    data_sources: dict[str, Any] = raw_data_sources if isinstance(raw_data_sources, dict) else {}
    raw_qc_metadata = metadata.get("qc")
    qc_metadata: dict[str, Any] = raw_qc_metadata if isinstance(raw_qc_metadata, dict) else {}
    qc_summary = _qc_release_summary(qc_metadata)
    network_algorithm = str(metadata.get("network_algorithm") or NETWORK_ALGORITHM)
    provenance = {
        "generated_at": generated_at,
        "release_id": metadata.get("release_id"),
        "years": years,
        "session_version": SESSION_VERSION,
        "quiz_version": quizzes.QUIZ_VERSION,
        "course_release": COURSE_RELEASE,
        "session_fingerprint": fingerprint,
        "runs": [
            {
                "step": run["step"],
                "outcome": run["outcome"],
                "design": run["design"],
                "result": run["result"],
            }
            for run in runs
        ],
        "algorithm": "WWZ five-category aggregation plus OECD TLS extension; WWYZ indicators; unweighted path centralities; saved classroom regression output",
        "network_algorithm": network_algorithm,
        "data_sources": data_sources,
        "indicator_data_source": data_sources.get("ci_synthetic_icio") or data_sources.get("oecd_icio"),
        "simulated_macro_controls": data_sources.get("simulated_macro_controls"),
        "qc": qc_metadata,
    }
    source = report_source_label(data_sources)
    lines = [
        "# GVC 指标与政策冲击：教学实验记录",
        "",
        f"学生：{_safe(student)}",
        "",
        f"> 数据覆盖 {years[0]}–{years[-1]}，指标来源：{_safe(source)}。政策冲击为基于公开事件手工编码的拟真教学面板，不能用于研究结论。",
        "",
        "> 步骤 12–15 分别估计贸易流、生产、长度和网络四类指标。系数因量纲和估计对象不同不能比大小，但可以并读方向和区间是否过 0。",
        "",
        "> 本报告汇总描述性探索和已保存的教学估计，不证明政策冲击导致了 GVC 变化。因果解释至少依赖冲击外生性、趋势可比性、无同期混杂、处理定义与模型相容，以及处理效应异质性得到妥善处理。",
        "",
        *_reflection_section(session),
        *_evidence_summary(runs),
        *_quiz_sections(session),
        *_experiment_sections(session),
        *_run_sections(runs),
        *_qc_disclosure_section(qc_summary),
        "## 数据与方法说明",
        "",
        "- 指标算法：WWZ 16 个明细项归并为五类，另加由 OECD ICIO TLS 账户计算的 taxsub 扩展项以匹配含税毛出口；taxsub 不是 WWZ 原文分类。生产分解与生产长度采用 WWYZ 口径。",
        "- 网络算法：保留有向正流量边；加权度使用流量权重，介数、距离和特征向量中心性按有向无权网络计算。",
        "- 无权路径口径把每条正流量边视为同样长度，因此高介数表示拓扑上的最短路径中介位置，不自动等于经济规模大、关键瓶颈或不可替代。",
        "- 网络解释顺序：先以加权度观察经济流量规模，再把无权介数作为拓扑基准并比较排序。当前报告没有边阈值敏感性分析，微小正边是否改变最短路径与排序尚未检验。",
        "- 冲击口径：界面中的单个事件用于定位和理解；回归按冲击类型使用该类型全部已编码事件汇总形成的暴露面板。",
        "- 回归结果来自学生会话中保存的服务端运行，不在报告生成时复算。",
        f"- 生成时间：{generated_at}；会话摘要：`{fingerprint}`。",
        "",
        *report_source_disclosures(data_sources),
        "",
    ]
    markdown = "\n".join(lines)
    provenance["content_sha256"] = hashlib.sha256(markdown.encode()).hexdigest()
    return TeachingReport(markdown, provenance, f"gvc_experiment_report_{fingerprint}.md")
