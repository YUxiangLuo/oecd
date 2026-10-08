from __future__ import annotations

import math
from dataclasses import dataclass
from collections.abc import Iterable
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
# Keyed by the saved Y's kind, not its family: step 13 can use the GVC position index instead of a length.
_KIND_DIMENSIONS = {
    "share": "份额原始单位（乘以 100 后按百分点解释）",
    "length": "长度单位",
    "position": "位置指数单位",
    "network": "中心性原始单位；跨指标比较时另参考样本标准差单位",
}
_STUDENT_METRIC_LABELS = {
    **{key: value["label"] for key, value in cast(dict[str, dict[str, Any]], INDICATOR_SCHEMA["fields"]).items()},
    "FVA_share": "外国增加值项占比",
    "3b_VA_GVC_C_share": "复杂 GVC 生产份额",
    "1_VA_D_share": "纯国内生产份额",
    "2_VA_RT_share": "传统贸易生产份额",
    "3a_VA_GVC_S_share": "简单 GVC 生产份额",
    # Match the label the step itself shows; without this the report printed the
    # raw field key for step 5's network metric.
    "weighted degree": "加权总度（入+出）",
    # Keep the legacy schema key in provenance, but never teach its misspelling.
    "betweenesscentrality": "网络介数（全正边二值）",
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
# Same-family alternative baselines (teaching.BASELINES): what a direction would mean if the real
# indicator of the same definition moved that way.
_BASELINE_INTERPRETATIONS = {
    "DVAex_share": {
        "negative": "国内增加值出口占比下降：出口价值中由本国创造的部分变小。",
        "positive": "国内增加值出口占比上升：出口价值中由本国创造的部分变大。",
    },
    "3_VA_GVC_share": {
        "negative": "前向 GVC 生产总份额下降：SVA 中与跨境生产相关的部分占比变小。",
        "positive": "前向 GVC 生产总份额上升：SVA 中与跨境生产相关的部分占比变大。",
    },
    "3a_VA_GVC_S_share": {
        "negative": "简单 GVC 生产份额下降：只跨境一次就被吸收的增加值占比变小。",
        "positive": "简单 GVC 生产份额上升：只跨境一次就被吸收的增加值占比变大。",
    },
    "3_FGY_GVC_share": {
        "negative": "后向 GVC 生产总份额下降：最终品生产中与跨境生产相关的部分占比变小。",
        "positive": "后向 GVC 生产总份额上升：最终品生产中与跨境生产相关的部分占比变大。",
    },
    "2_VA_RT_share": {
        "negative": "传统贸易生产份额下降：经一次出口直接被进口国吸收的增加值占比变小。",
        "positive": "传统贸易生产份额上升：经一次出口直接被进口国吸收的增加值占比变大。",
    },
    "1_VA_D_share": {
        "negative": "纯国内生产份额下降：不经出口、在国内被吸收的增加值占比变小。",
        "positive": "纯国内生产份额上升：不经出口、在国内被吸收的增加值占比变大。",
    },
    "PLy_GVC": {
        "negative": "后向 GVC 段长度缩短：从最终品回溯的 GVC 生产环节减少。",
        "positive": "后向 GVC 段长度延长：从最终品回溯的 GVC 生产环节增加。",
    },
    "GVCPs": {
        "negative": "位置指数下降：在该口径下相对更靠下游。",
        "positive": "位置指数上升：在该口径下相对更上游。",
    },
    "weighted_indegree": {
        "negative": "加权入度下降：买入侧的流量规模变小。",
        "positive": "加权入度上升：买入侧的流量规模变大。",
    },
    "weighted_outdegree": {
        "negative": "加权出度下降：卖出侧的流量规模变小。",
        "positive": "加权出度上升：卖出侧的流量规模变大。",
    },
    "betweenesscentrality": {
        "negative": "介数下降：在二值拓扑最短路径上的中介位置减弱。",
        "positive": "介数上升：在二值拓扑最短路径上的中介位置增强。",
    },
    "closnesscentrality": {
        "negative": "接近中心性下降：到其他节点的网络距离变远。",
        "positive": "接近中心性上升：到其他节点的网络距离变近。",
    },
}
_OUTCOME_INTERPRETATIONS = {
    "trade": {
        "negative": "外国增加值项占比下降：出口价值中来自国外投入的部分变小。",
        "positive": "外国增加值项占比上升：出口价值中来自国外投入的部分变大。",
    },
    "production": {
        "negative": "复杂 GVC 生产份额下降：SVA 中经多次跨境生产的部分占比变小。",
        "positive": "复杂 GVC 生产份额上升：SVA 中经多次跨境生产的部分占比变大。",
    },
    "length": {
        "negative": "前向 GVC 段长度缩短：增加值到最终吸收经过的生产环节减少。",
        "positive": "前向 GVC 段长度延长：增加值到最终吸收经过的生产环节增加。",
    },
    "network": {
        "negative": "加权总度下降：节点买入与卖出的总流量规模变小。",
        "positive": "加权总度上升：节点买入与卖出的总流量规模变大。",
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
# Step 7 can also be read from the final-goods (backward) side; each set is (components, total).
_COMPOSITION_SETS: dict[int, tuple[tuple[tuple[str, ...], str], ...]] = {
    6: ((_COMPOSITION_COMPONENT_METRICS[6], "gross_exports"),),
    7: (
        (_COMPOSITION_COMPONENT_METRICS[7], "SVA"),
        (("1_FGY_D", "2_FGY_RT", "3a_FGY_GVC_S", "3b_FGY_GVC_C"), "FGY"),
    ),
}
_COMPOSITION_TOTAL_SHORT = {"gross_exports": "总出口", "SVA": "总增加值", "FGY": "最终品生产"}


def composition_set(step: int, metrics: Iterable[str]) -> tuple[tuple[str, ...], str] | None:
    """The (components, total) set a saved composition uses, or None when the metrics match no set."""
    saved = set(metrics)
    for components, total in _COMPOSITION_SETS.get(step, ()):
        if saved == set(components) | {total}:
            return components, total
    return None


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
    if p_value:
        if not 0 <= numeric <= 1:
            return "—"
        # A numerical tail probability may underflow to zero; do not print an exact zero.
        if numeric < 0.0001:
            return "<0.0001"
    # Large amounts (e.g. million-USD flows) read better as grouped integers than as 4.584e+06.
    if abs(numeric) >= 1000:
        return f"{numeric:,.0f}"
    return f"{numeric:.4g}"


def _observation_reading(observation: dict[str, Any]) -> str:
    """步骤 1 观察值的完整读法:把无方向的「行 × 列 = 值」写成带供给方向的句子,
    避免报告读者把行(供给方)误读成使用方——与前端表格的方向标注一致。"""
    row = _safe(observation.get("row", "—"))
    column = _safe(observation.get("column", "—"))
    raw_value = observation.get("value", "—")
    # Every ICIO cell (Z, Y and the VA/TLS/OUT accounts) is in million USD, as the step 1 table says.
    value = (
        f"{_number(raw_value)} 百万美元"
        if isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool)
        else _safe(raw_value)
    )
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
    rounded = f"{value:+,.{digits}f}"
    # Match the result card (toPrecision(2)): a small nonzero estimate/CI endpoint is not zero, and keeps
    # its trailing zero ("-0.0050", not "-0.005" next to the page's "-0.0050").
    return f"{value:+#.2g}" if value != 0 and float(rounded.replace(",", "")) == 0 else rounded


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
        return "关税暴露强度"
    return _safe(raw)


def _primary_coefficient(design: dict[str, Any], result: dict[str, Any]) -> dict[str, Any] | None:
    candidates = [
        item for item in _list_values(result.get("coefs")) if isinstance(item, dict) and item.get("name") == X_COLUMN
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


_DEFAULT_KINDS = {"trade": "share", "production": "share", "length": "length", "network": "network"}


def _depvar_kind(outcome: str, design: dict[str, Any]) -> str:
    """How the saved Y is read: shares in percentage points, the rest in their own units."""
    kind = design.get("depvar_kind") if isinstance(design, dict) else None
    return (
        kind
        if isinstance(kind, str) and kind in {"share", "length", "position", "network"}
        else _DEFAULT_KINDS.get(outcome, "length")
    )


def _is_default_baseline(outcome: str, design: dict[str, Any]) -> bool:
    from gvcsim.regression.teaching import default_baseline

    key = design.get("baseline") if isinstance(design, dict) else None
    return key is None or (outcome in _DEFAULT_KINDS and key == default_baseline(outcome).key)


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
    effect_label = "关税暴露 X 每增加 1 个百分点"
    kind = _depvar_kind(outcome, design)
    if kind == "share":
        effect_text = f"{_signed(effect * 100, 2)} 个百分点"
        interval = (
            f"[{_signed(ci[0] * increment * 100, 2)}, {_signed(ci[1] * increment * 100, 2)}] 个百分点" if ci else "—"
        )
    elif kind == "network":
        sd = result.get("depvar_std")
        relative = effect / float(sd) if isinstance(sd, (int, float)) and float(sd) > 0 else None
        effect_text = f"{_signed(effect, 2)} 个中心性原始单位"
        if relative is not None:
            effect_text += f"（约 {_signed(relative, 2)} 个样本标准差）"
        interval = f"[{_signed(ci[0] * increment, 2)}, {_signed(ci[1] * increment, 2)}] 个原始单位" if ci else "—"
    else:
        unit = "位置指数单位" if kind == "position" else "长度单位"
        digits = 4 if kind == "position" else 3
        effect_text = f"{_signed(effect, digits)} 个{unit}"
        interval = (
            f"[{_signed(ci[0] * increment, digits)}, {_signed(ci[1] * increment, digits)}] 个{unit}" if ci else "—"
        )
    return effect_label, effect_text, interval


def _interpretations(outcome: str, design: dict[str, Any] | None) -> dict[str, str]:
    """Direction sentences for the saved Y: the family's fixed indicator or the chosen same-family baseline."""
    key = design.get("baseline") if isinstance(design, dict) else None
    if isinstance(key, str) and key in _BASELINE_INTERPRETATIONS and not _is_default_baseline(outcome, design or {}):
        return _BASELINE_INTERPRETATIONS[key]
    return _OUTCOME_INTERPRETATIONS[outcome]


def _evidence_reading(
    outcome: str, coefficient: dict[str, Any], suppressed: bool, design: dict[str, Any] | None = None
) -> tuple[str, str]:
    if suppressed:
        return "不可作方向判断", "统计推断已被抑制；点估计只是计算输出，不能据此判断上升或下降。"
    ci_low, ci_high = coefficient.get("ci_low"), coefficient.get("ci_high")
    if not isinstance(ci_low, (int, float)) or not isinstance(ci_high, (int, float)):
        return "证据不足", "置信区间未记录，不能确定估计方向。"
    if ci_high < 0:
        return "本次样本支持负向关联", _interpretations(outcome, design)["negative"]
    if ci_low > 0:
        return "本次样本支持正向关联", _interpretations(outcome, design)["positive"]
    return (
        "证据不足，无法判断方向",
        "95% 置信区间包含 0（跨过或触及）；这不等于“没有效应”，而是当前证据不足以确定方向。",
    )


def _summary_design_limit(status: str, support: dict[str, Any], reasons: list[Any]) -> str | None:
    if status in {"insufficient", "invalid_design"} and reasons:
        return _safe(reasons[0], 360)
    untreated_clusters = support.get("untreated_clusters")
    if untreated_clusters == 0:
        treated_clusters = _count(support.get("treated_clusters"))
        untreated_entities = _count(support.get("untreated_entities"))
        return (
            f"估计样本中没有完全未暴露的对照聚类：{treated_clusters} 个聚类都至少包含一个暴露实体；"
            f"仍有 {untreated_entities} 个未暴露实体，"
            "聚类层面的共同冲击识别仍更依赖模型设定。"
        )
    if status == "warning" and reasons:
        return _safe(reasons[0], 360)
    return None


def _list_values(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


__all__ = [n for n in globals() if not n.startswith("__")]
