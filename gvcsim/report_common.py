from __future__ import annotations

import math
from dataclasses import dataclass
from collections.abc import Iterable
from typing import Any, cast

from gvcsim import evidence
from gvcsim.indicator_schema import INDICATOR_SCHEMA
from gvcsim.regression.design import CONTROL_MODE_LABELS, GRANULARITY_LABELS, METHOD_LABELS, PRICE_MODE_LABELS
from gvcsim.regression.teaching import X_COLUMN
from gvcsim.report_labels import country_sector_label, final_demand_label
from gvcsim.steps import STEPS

REFLECTION_TEXT_LIMIT = 2400
GATE_STEPS = tuple(step for step in sorted(evidence.STEP_LABS) if evidence.STEP_LABS[step] != "rep")
_STEP_TITLES = {cast(int, item["n"]): cast(str, item["title"]) for item in STEPS}
_STEP_OUTCOMES = {
    cast(int, item["n"]): cast(str, item["regression_outcome"]) for item in STEPS if item.get("regression_outcome")
}
# Keyed by the saved Y's kind, not its family: step 13 can use the GVC position index instead of a length.
_KIND_DIMENSIONS = {
    "share": "份额（×100 = 百分点）",
    "length": "长度单位（1 个长度单位约等于平均多经过 1 个生产环节）；另附标准差换算（标准差即 Y 的典型差距）",
    "position": "无量纲（前向 GVC 段长度 ÷ 后向 GVC 段长度，以 1 为分界）；另附标准差换算（标准差即 Y 的典型差距）",
    "network": "中心性原始单位（按真实网络指标的排名校准生成，不是步骤 5、9 的百万美元）；另附标准差换算（标准差即 Y 的典型差距）",
}
_STUDENT_METRIC_LABELS = {
    **{key: value["label"] for key, value in cast(dict[str, dict[str, Any]], INDICATOR_SCHEMA["fields"]).items()},
    "FVA_share": "外国增加值项占比",
    "3b_VA_GVC_C_share": "复杂 GVC 生产份额",
    "1_VA_D_share": "纯国内生产份额",
    "2_VA_RT_share": "传统贸易生产份额",
    "3a_VA_GVC_S_share": "简单 GVC 生产份额",
    # Network metrics ("weighted degree" → 加权总度, "betweenesscentrality" → 介数) come from the schema
    # labels above, so the report names them as the pages do and never prints the raw, misspelt keys.
}
_SHOCK_SOURCE_STATUS_LABELS = {
    "official_event_source_complete": "官方事件/日期来源完整",
    "partial_official_event_source": "官方事件/日期来源仅部分覆盖",
    "teaching_encoding_no_event_source": "没有逐项事件 URL 的教学编码",
}
_STATUS_LABELS = {
    "ok": "可以解读",
    "warning": "可以解读，但要写明下面的限制",
    "insufficient": "数据不够，不能判断方向",
    "invalid_design": "计算设定有问题，不能判断方向",
    "unknown": "没有记录",
}
# The fixed Y of each step, as the step pages name it.
_DEFAULT_Y_LABELS = {
    "trade": "外国增加值项占比",
    "production": "复杂 GVC 生产份额",
    "length": "前向 GVC 段长度",
    "network": "加权总度",
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
        super().__init__("先答对理解题、补齐实验材料、写完你的分析，才能生成报告")


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
        # Four fixed decimals, as on the page ("0.0010", not "0.0009587").
        return f"{numeric:.4f}"
    # Large amounts (e.g. million-USD flows) read better as grouped integers than as 4.584e+06.
    if abs(numeric) >= 1000:
        return f"{numeric:,.0f}"
    return _no_negative_zero(f"{numeric:.4g}")


def _no_negative_zero(text: str) -> str:
    """A number that rounds to zero reads "0.00", never "-0.00" (frontend ``stripNegativeZero``)."""
    return text[1:] if text.startswith("-") and not any(char in "123456789" for char in text) else text


def reading_digits(value: float, unit: str) -> int:
    """Decimals of a reading, as on the pages (frontend ``readingDigits``): whole millions for amounts, whole
    counts and path lengths, three decimals otherwise; an exact zero reads "0"."""
    if (
        value == 0
        or (unit == "百万美元" and abs(value) >= 1)
        or unit in ("连接数", "路径长度")
        or (unit == "未归一化介数" and abs(value) >= 1)
    ):
        return 0
    return 3


def reading_number(value: float, unit: str) -> str:
    """A reading's number in the page's fixed precision (shares are passed already multiplied by 100)."""
    digits = reading_digits(value, unit)
    text = f"{value:,.{digits}f}"
    return text[1:] if text.startswith("-") and float(text.replace(",", "")) == 0 else text


def _db_amount(value: float) -> str:
    """A step 1 cell as the step 1 table shows it (frontend ``fmtDb``): up to two decimals, more for small flows."""
    if value == 0:
        return "0"
    magnitude = abs(value)
    digits = 4 if magnitude < 1 else 3 if magnitude < 10 else 2
    text = f"{value:,.{digits}f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


_ACCOUNT_NAMES = {"TLS": "产品税减补贴", "VA": "增加值", "OUT": "总产出"}


def _observation_reading(observation: dict[str, Any]) -> str:
    """步骤 1 观察值的完整读法:把无方向的「行 × 列 = 值」写成带供给方向的句子,
    避免报告读者把行(供给方)误读成使用方——与前端表格的方向标注和名称一致。"""
    row_code = str(observation.get("row", "—"))
    column_code = str(observation.get("column", "—"))
    row = _safe(country_sector_label(row_code))
    raw_value = observation.get("value", "—")
    # Every ICIO cell (Z, Y and the VA/TLS/OUT accounts) is in million USD, as the step 1 table says.
    value = (
        f"{_db_amount(float(raw_value))} 百万美元"
        if isinstance(raw_value, (int, float)) and not isinstance(raw_value, bool) and math.isfinite(float(raw_value))
        else _safe(raw_value)
    )
    table = str(observation.get("table") or "z")
    if table == "y":
        return f"{row}（行·供给方） → {_safe(final_demand_label(column_code))}（列·最终需求） = {value}"
    if table == "accounts":
        account = _ACCOUNT_NAMES.get(column_code)
        return f"{row} 的 {_safe(column_code)}{f'（{account}）' if account else ''} = {value}"
    return f"{row}（行·供给方） → {_safe(country_sector_label(column_code))}（列·使用方） = {value}"


def _count(value: Any) -> str:
    if isinstance(value, int) and not isinstance(value, bool):
        return f"{value:,}"
    if isinstance(value, float) and value.is_integer():
        return f"{int(value):,}"
    return _number(value)


def _share_digits(points: float) -> int:
    """As on the page: 0.005–0.1 point gets 3 decimals ("+0.008", not "+0.01"); smaller ones fall back in _signed."""
    return 3 if 0.005 <= abs(points) < 0.1 else 2


def standardized_digits(point: float | None, bounds: tuple[float, float] | None) -> int:
    """Decimals of a size in standard deviations, as on the page (``standardizedDigits``): 3 when the point or an
    interval end is below 0.1 (2 decimals put 0.0459 on the edge of "[-0.05, -0.04]"), otherwise 2; more digits
    until the interval's ends differ, at most 4."""
    values = [value for value in (point, *(bounds or ())) if value is not None]
    start = 3 if any(abs(value) < 0.1 for value in values) else 2
    if bounds is None:
        return start
    return next((d for d in range(start, 5) if _signed(bounds[0], d) != _signed(bounds[1], d)), 4)


def network_digits(size: float) -> int:
    """Decimals of a centrality amount, by its size (frontend ``networkDigits``)."""
    return 0 if size >= 100 else 1 if size >= 10 else 2 if size >= 1 else 3 if size >= 0.1 else 4 if size >= 0.01 else 5


def network_interval_digits(point: float, bounds: tuple[float, float] | None) -> int:
    """Decimals of a network estimate and its 95% interval, one count for all three (frontend
    ``networkIntervalDigits``): 2 ("-40.80"); more when a nonzero value would round to 0 at 2, so it keeps two
    significant digits; more again until the interval's ends print differently. Closeness used to read
    "[-0.01, -0.0047]": one end at 2 decimals, the other at two significant digits."""
    values = [point, *(bounds or ())]
    tiny = [value for value in values if math.isfinite(value) and value != 0 and float(f"{value:.2f}") == 0]
    digits = max([2, *(max(0, 1 - math.floor(math.log10(abs(value)))) for value in tiny)])
    while bounds is not None and digits < 8 and _signed(bounds[0], digits) == _signed(bounds[1], digits):
        digits += 1
    return digits


def distinct_digits(digits: int, point: float, bounds: tuple[float, float] | None) -> int:
    """One more decimal (up to three more) while an interval end prints the same as the estimate (frontend
    ``distinctDigits``): "-0.018" with "[-0.019, -0.018]" reads "-0.0184" with "[-0.0192, -0.0176]"."""
    shown = digits
    while (
        bounds is not None
        and shown < digits + 3
        and _signed(point, shown) in (_signed(bounds[0], shown), _signed(bounds[1], shown))
    ):
        shown += 1
    return shown


def estimate_digits(kind: str, value: float, bounds: tuple[float, float] | None) -> int:
    """Decimals of an estimate per 1 percentage point of X and its interval in the Y's own unit (shares in points),
    as on the page (frontend ``estimateDigits``)."""
    base = (
        network_interval_digits(value, bounds)
        if kind == "network"
        else 4
        if kind == "position"
        else 3
        if kind == "length"
        else _share_digits(value)
    )
    return distinct_digits(base, value, bounds)


# The unit as named beside a chart or a bar, and as a counted quantity (frontend ``unitName`` / ``countUnit``): the
# position index is a ratio, "无量纲" as on step 7, so its amounts are bare numbers ("约低 0.0021").
UNIT_NAMES = {"share": "百分点", "length": "长度单位", "position": "无量纲", "network": "中心性原始单位"}
COUNT_UNITS = {"share": "个百分点", "length": "个长度单位", "position": "", "network": "个中心性原始单位"}


def with_count_unit(amount: str, kind: str) -> str:
    """An amount with its counted unit (frontend ``withCountUnit``): "-0.018 个长度单位"; the position index's "-0.0021"."""
    unit = COUNT_UNITS.get(kind, "个长度单位")
    return f"{amount} {unit}" if unit else amount


def _signed(value: float, digits: int) -> str:
    # -0.0 reads "+0.000", as on the page (``signed``), never "-0.000".
    value = 0.0 if value == 0 else value
    rounded = f"{value:+,.{digits}f}"
    # Match the result card (toPrecision(2)): a small nonzero estimate/CI endpoint is not zero, and keeps
    # its trailing zero ("-0.0050", not "-0.005" next to the page's "-0.0050").
    return f"{value:+#.2g}" if value != 0 and float(rounded.replace(",", "")) == 0 else rounded


# The design labels are a data contract (saved runs are checked against them); the report words them plainly.
_SETTING_DISPLAY = {
    "granularity": {"country_industry": "国家×行业"},
    "shock_type": {"tariff": "关税"},
    "method": {"twfe_intensity": "双向固定效应（TWFE）"},
    "scenario": {"clean": "基准情景"},
}


def _setting_value(key: str, value: Any) -> str:
    mappings = {
        "granularity": GRANULARITY_LABELS,
        "shock_type": {"tariff": "关税冲击"},
        "method": METHOD_LABELS,
        "control_mode": CONTROL_MODE_LABELS,
        "price_mode": PRICE_MODE_LABELS,
        "scenario": {"clean": "基准情景"},
    }
    display = _SETTING_DISPLAY.get(key, {}).get(str(value))
    if display is not None:
        return display
    mapping = mappings.get(key, {})
    return _safe(mapping.get(str(value), value))


def _model_summary(design: dict[str, Any]) -> str:
    """The saved model in plain words: "双向固定效应（TWFE） · 国家×行业 · 不加控制变量"."""
    return " · ".join(
        _setting_value(key, design.get(key))
        for key in ("method", "granularity", "control_mode")
        if design.get(key) not in (None, "")
    )


def _coefficient_label(name: Any, design: dict[str, Any]) -> str:
    raw = str(name)
    if raw == X_COLUMN:
        # The page's name for X (steps 10–14 and their coefficient tables).
        return "关税暴露 X"
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
    # An association across country×industry records, as on the step pages ("X 每高 1 个百分点的国家×行业…").
    effect_label = "关税暴露 X 每高 1 个百分点，Y 平均相差"
    kind = _depvar_kind(outcome, design)
    if kind == "share":
        share_digits = estimate_digits(kind, effect * 100, (ci[0], ci[1]) if ci else None)
        effect_text = f"{_signed(effect * 100, share_digits)} 个百分点"
        interval = (
            f"[{_signed(ci[0] * increment * 100, share_digits)}, {_signed(ci[1] * increment * 100, share_digits)}] 个百分点"
            if ci
            else "—"
        )
    else:
        # Lengths, the position index and centrality: the value in its own unit, with its size in standard
        # deviations of Y as on the page ("-0.018 个长度单位（幅度约 0.031 个标准差）"); the sd size is unsigned,
        # the number before it carries the sign.
        # The position index has no unit ("无量纲"): its amounts are bare numbers, as on the page.
        sd = result.get("depvar_std")
        positive_sd = float(sd) if isinstance(sd, (int, float)) and math.isfinite(sd) and float(sd) > 0 else None
        sd_bounds = (ci[0] * increment / positive_sd, ci[1] * increment / positive_sd) if ci and positive_sd else None
        sd_point = effect / positive_sd if positive_sd is not None else None
        sd_digits = standardized_digits(sd_point, sd_bounds)
        # The estimate and both interval ends in the same decimals, more where an end would read as the estimate,
        # as on the page.
        digits = estimate_digits(kind, effect, (ci[0] * increment, ci[1] * increment) if ci else None)
        effect_text = with_count_unit(_signed(effect, digits), kind)
        if sd_point is not None:
            effect_text += f"（幅度约 {_signed(sd_point, sd_digits)[1:]} 个标准差）"
        interval = (
            with_count_unit(f"[{_signed(ci[0] * increment, digits)}, {_signed(ci[1] * increment, digits)}]", kind)
            + (
                f"（约 [{_signed(sd_bounds[0], sd_digits)}, {_signed(sd_bounds[1], sd_digits)}] 个标准差）"
                if sd_bounds is not None
                else ""
            )
            if ci
            else "—"
        )
    return effect_label, effect_text, interval


def y_display(label: Any) -> str:
    """A saved Y label (a data contract) as the pages show it: "加权总度", "介数"."""
    text = str(label).removesuffix("（入+出）")
    return "介数" if text == "网络介数（全正边二值）" else text


def _y_label(outcome: str, design: dict[str, Any] | None) -> str:
    """The saved Y as the step pages name it: the family's fixed Y or the chosen same-family indicator."""
    design = design if isinstance(design, dict) else {}
    if design.get("baseline") is not None and _is_default_baseline(outcome, design):
        return _DEFAULT_Y_LABELS.get(outcome, outcome)
    for key in ("baseline_label", "depvar_label"):
        label = design.get(key)
        if isinstance(label, str) and label:
            return y_display(label)
    return _DEFAULT_Y_LABELS.get(outcome, outcome)


def _effect_size(outcome: str, design: dict[str, Any] | None, coefficient: dict[str, Any]) -> str:
    """The size of the change per 1 percentage point of X, unsigned, in the step's unit ("0.55 个百分点"), in the
    digits of the result table (``_natural_effect``)."""
    kind = _depvar_kind(outcome, design or {})
    scale = 1.0 if kind == "share" else 0.01
    effect = float(coefficient["coef"]) * scale
    low, high = coefficient.get("ci_low"), coefficient.get("ci_high")
    bounds = (
        (float(low) * scale, float(high) * scale)
        if isinstance(low, (int, float)) and isinstance(high, (int, float))
        else None
    )
    size = _signed(effect, estimate_digits(kind, effect, bounds)).lstrip("+-")
    return with_count_unit(size, kind)


def _association(outcome: str, design: dict[str, Any] | None, coefficient: dict[str, Any], negative: bool) -> str:
    """What a direction supports, as an association across country×industry records, with its number."""
    long_short = _depvar_kind(outcome, design or {}) == "length"
    more, less = ("长", "短") if long_short else ("高", "低")
    word = less if negative else more
    return (
        f"关税暴露 X 越高的国家×行业，{_y_label(outcome, design)}平均越{word}"
        f"（X 每高 1 个百分点，约{word} {_effect_size(outcome, design, coefficient)}）。"
    )


def _evidence_reading(
    outcome: str, coefficient: dict[str, Any], suppressed: bool, design: dict[str, Any] | None = None
) -> tuple[str, str]:
    if suppressed:
        return (
            "方向不确定（不显示区间）",
            "这一项数据不够，不显示 95% 区间；不能据此判断方向，也不能写成“没有影响”。",
        )
    ci_low, ci_high = coefficient.get("ci_low"), coefficient.get("ci_high")
    if not isinstance(ci_low, (int, float)) or not isinstance(ci_high, (int, float)):
        return "方向不确定（区间没有记录）", "95% 区间没有记录，不能判断方向。"
    if ci_high < 0:
        return "方向明确：X 越高，Y 越低", _association(outcome, design, coefficient, negative=True)
    if ci_low > 0:
        return "方向明确：X 越高，Y 越高", _association(outcome, design, coefficient, negative=False)
    return (
        "方向不确定",
        "95% 区间包含 0，不能说“没有关联”，只能说方向还不确定。",
    )


def _summary_design_limit(status: str, support: dict[str, Any], reasons: list[Any]) -> str | None:
    if status in {"insufficient", "invalid_design"} and reasons:
        return _safe(reasons[0], 360)
    untreated_clusters = support.get("untreated_clusters")
    if untreated_clusters == 0:
        treated_clusters = _count(support.get("treated_clusters"))
        untreated_entities = _count(support.get("untreated_entities"))
        return (
            f"没有完全不受关税影响的国家可以对照：{treated_clusters} 个国家都至少有一个行业受到影响"
            f"（仍有 {untreated_entities} 个国家×行业未受影响），所以结果更依赖模型假设。"
        )
    if status == "warning" and reasons:
        return _safe(reasons[0], 360)
    return None


def _list_values(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


__all__ = [n for n in globals() if not n.startswith("__")]
