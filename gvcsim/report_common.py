from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, cast

from gvcsim import evidence
from gvcsim.indicator_schema import INDICATOR_SCHEMA
from gvcsim.regression.design import CONTROL_MODE_LABELS, GRANULARITY_LABELS, METHOD_LABELS, PRICE_MODE_LABELS
from gvcsim.regression.teaching import X_COLUMN
from gvcsim.steps import STEPS

REFLECTION_TEXT_LIMIT = 2400
GATE_STEPS = tuple(step for step in sorted(evidence.STEP_LABS) if evidence.STEP_LABS[step] != "rep")
_STEP_TITLES = {cast(int, item["n"]): cast(str, item["title"]) for item in STEPS}
_STEP_OUTCOMES = {
    cast(int, item["n"]): cast(str, item["regression_outcome"]) for item in STEPS if item.get("regression_outcome")
}
_OUTCOME_UNITS = {
    "trade": "份额原始单位（乘以 100 后按百分点解释）",
    "production": "份额原始单位（乘以 100 后按百分点解释）",
    "length": "生产环节长度单位",
    "network": "全正边二值介数原始单位（探索性拓扑基准）；跨指标比较时另参考样本标准差单位",
}
_STUDENT_METRIC_LABELS = {
    **{key: value["label"] for key, value in cast(dict[str, dict[str, Any]], INDICATOR_SCHEMA["fields"]).items()},
    "FVA_share": "外国增加值项占比",
    "3b_VA_GVC_C_share": "复杂 GVC 生产份额",
    "1_VA_D_share": "纯国内生产份额（1_VA_D/SVA）",
    "2_VA_RT_share": "传统贸易份额（2_VA_RT/SVA）",
    "3a_VA_GVC_S_share": "简单 GVC 份额（3a_VA_GVC_S/SVA）",
    "GVCPs": "GVC 相对位置（GVCPs）",
    # Match the label the step itself shows; without this the report printed the
    # raw field key for step 5's network metric.
    "weighted degree": "加权总度(入+出；自环双计)",
    # Keep the legacy schema key in provenance, but never teach its misspelling.
    "betweenesscentrality": "全正边二值介数（探索性拓扑基准）",
}
_SHOCK_SOURCE_STATUS_LABELS = {
    "official_event_source_complete": "官方事件/日期来源完整",
    "partial_official_event_source": "官方事件/日期来源仅部分覆盖",
    "teaching_encoding_no_event_source": "没有逐项事件 URL 的教学编码",
}
_STATUS_LABELS = {
    "ok": "可报告",
    "warning": "需谨慎解释",
    "insufficient": "样本支持度不足",
    "invalid_design": "设计无效",
    "unknown": "未记录设计状态",
}
_OUTCOME_INTERPRETATIONS = {
    "trade": {
        "negative": "出口分解中外国增加值这一项的占比下降，但不能单独证明供应链已经回流。",
        "positive": "出口分解中外国增加值这一项的占比上升，仍需检查比较条件和其他共同变化。",
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
        "negative": "全正边二值拓扑基准下降；未经边阈值敏感性检验，不能据此证明枢纽地位下降或发生脱钩。",
        "positive": "全正边二值拓扑基准上升；未经边阈值敏感性检验，不能据此证明经济重要性增强。",
    },
}
_REFLECTION_MIN_LENGTHS = {
    "research_question": 12,
    "evidence_interpretation": 40,
    "limitations": 30,
}
_INDICATOR_SOURCES = {
    "explicit-indicator-trend",
    "explicit-indicator-comparison",
    "explicit-indicator-composition",
}
_COMPOSITION_COMPONENT_METRICS = {
    6: ("DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"),
    7: ("1_VA_D", "2_VA_RT", "3a_VA_GVC_S", "3b_VA_GVC_C"),
}
_COMPOSITION_TOTAL_METRICS = {6: "gross_exports", 7: "SVA"}


class ReportGateError(RuntimeError):
    def __init__(self, missing: list[dict[str, Any]]):
        self.missing = missing
        super().__init__("实验报告需要先完成理解检查、关键实验操作与原创分析")


@dataclass
class TeachingReport:
    markdown: str
    provenance: dict[str, Any]
    suggested_filename: str


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


def _observation_reading(observation: dict[str, Any]) -> str:
    """步骤 1 观察值的完整读法:把无方向的「行 × 列 = 值」写成带供给方向的句子,
    避免报告读者把行(供给方)误读成使用方——与前端表格的方向标注一致。"""
    row = _safe(observation.get("row", "—"))
    column = _safe(observation.get("column", "—"))
    raw_value = observation.get("value", "—")
    value = _number(raw_value) if isinstance(raw_value, (int, float)) else _safe(raw_value)
    table = str(observation.get("table") or "z")
    if table == "y":
        return f"{row}(行·供给方) → {column}(列·最终需求) = {value}"
    if table == "accounts":
        return f"{row} 的 {column} = {value}"
    return f"{row}(行·供给方) → {column}(列·使用方) = {value}"


def _count(value: Any) -> str:
    if isinstance(value, int) and not isinstance(value, bool):
        return f"{value:,}"
    if isinstance(value, float) and value.is_integer():
        return f"{int(value):,}"
    return _number(value)


def _signed(value: float, digits: int) -> str:
    rounded = f"{value:+.{digits}f}"
    # Match the result card: a small nonzero estimate/CI endpoint is not zero.
    return f"{value:+.2g}" if value != 0 and float(rounded) == 0 else rounded


def _setting_value(key: str, value: Any) -> str:
    mappings = {
        "granularity": GRANULARITY_LABELS,
        "shock_type": {"tariff": "关税冲击"},
        "method": METHOD_LABELS,
        "control_mode": CONTROL_MODE_LABELS,
        "price_mode": PRICE_MODE_LABELS,
        "scenario": {"clean": "基准教学面板"},
    }
    mapping = mappings.get(key, {})
    return _safe(mapping.get(str(value), value))


def _coefficient_label(name: Any, design: dict[str, Any]) -> str:
    raw = str(name)
    if raw == X_COLUMN:
        return "模拟关税暴露强度"
    return _safe(raw)


def _primary_coefficient(design: dict[str, Any], result: dict[str, Any]) -> dict[str, Any] | None:
    candidates = [
        item
        for item in _list_values(result.get("coefs"))
        if isinstance(item, dict) and item.get("name") == X_COLUMN
    ]
    return candidates[0] if len(candidates) == 1 else None


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
    increment = 0.01
    effect = float(coefficient["coef"]) * increment
    ci_low, ci_high = coefficient.get("ci_low"), coefficient.get("ci_high")
    ci = (
        (float(ci_low), float(ci_high))
        if not _global_inference_suppressed(result)
        and isinstance(ci_low, (int, float))
        and isinstance(ci_high, (int, float))
        else None
    )
    effect_label = "冲击强度每增加 1 个百分点"
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


def _evidence_reading(
    outcome: str, coefficient: dict[str, Any], suppressed: bool
) -> tuple[str, str]:
    if suppressed:
        return "不可作方向判断", "统计推断已被抑制；点估计只是计算输出，不能据此判断上升或下降。"
    ci_low, ci_high = coefficient.get("ci_low"), coefficient.get("ci_high")
    if not isinstance(ci_low, (int, float)) or not isinstance(ci_high, (int, float)):
        return "证据不足", "置信区间未记录，不能确定估计方向。"
    if ci_high < 0:
        return "发现负向变化证据", _OUTCOME_INTERPRETATIONS[outcome]["negative"]
    if ci_low > 0:
        return "发现正向变化证据", _OUTCOME_INTERPRETATIONS[outcome]["positive"]
    return "证据不足，无法判断方向", "95% 置信区间跨过 0；这不等于“没有效应”，而是当前证据不足以确定方向。"


def _summary_design_limit(
    status: str, support: dict[str, Any], reasons: list[Any]
) -> str | None:
    if status in {"insufficient", "invalid_design"} and reasons:
        return _safe(reasons[0], 360)
    untreated_clusters = support.get("untreated_clusters")
    if untreated_clusters == 0:
        treated_clusters = _count(support.get("treated_clusters"))
        untreated_entities = _count(support.get("untreated_entities"))
        return (
            f"估计样本中没有完全未暴露的对照聚类：{treated_clusters} 个聚类都至少包含一个暴露实体；"
            f"仍有 {untreated_entities} 个未暴露实体（可能包括冻结 cohort 中仅保留冲击前行的实体），"
            "聚类层面的共同冲击识别仍更依赖模型设定。"
        )
    if status == "warning" and reasons:
        return _safe(reasons[0], 360)
    return None



def _list_values(value: Any) -> list[Any]: return value if isinstance(value,list) else []
__all__=[n for n in globals() if not n.startswith("__")]
