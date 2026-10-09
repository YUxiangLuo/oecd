"""The report's regression bar charts, mirroring the step 11–15 pages number for number.

Per step (frontend ``familyBarRows``): one bar per Y of the step's family, in the course overview's order (the
default first), from the course's fixed estimates of every Y (``_estimate_overview``); the saved Y's bar is taken
from the saved run itself and marked 已保存, so the chart, the page and the step's table print the same numbers.
Summary (frontend ``regressionSummaryRows``): one bar per step's saved run, all in standard deviations.
Numbers and labels follow frontend ``barFigures``: shares in 个百分点 when every Y of the family is a share,
otherwise 个标准差 = (β × 0.01) / depvar_std with the native value first ("-40.11（-0.047 个标准差）").
"""

from __future__ import annotations

import json
import math
from typing import Any, TypeGuard

from gvcsim.regression.teaching import BASELINES
from gvcsim.report_common import (
    _depvar_kind,
    _global_inference_suppressed,
    _primary_coefficient,
    _signed,
    _y_label,
    estimate_digits,
    standardized_digits,
    y_display,
)

_COUNT_UNITS = {
    "share": "个百分点",
    "length": "个长度单位",
    "position": "个位置指数单位",
    "network": "个中心性原始单位",
}
_FAMILIES = {11: "贸易流", 12: "生产", 13: "长度", 14: "网络"}
UNIT_TITLES = {
    "points": "X 每高 1 个百分点，Y 平均相差（个百分点）",
    "sd": "X 每高 1 个百分点，Y 平均相差（个标准差）",
}
# Step 12's four forward shares add up to 100% of value added, so their four estimates add up to about 0.
_FORWARD_SHARES = ("1_VA_D_share", "2_VA_RT_share", "3a_VA_GVC_S_share", "3b_VA_GVC_C_share")


def _shown(value: float) -> float:
    """Display precision for the plotted numbers, like the tables; full values stay in the provenance."""
    return float(f"{value:.4g}")


def _finite(value: Any) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _native(kind: str, coef: float, ci: tuple[float, float] | None) -> tuple[float, tuple[float, float] | None]:
    """The value in the Y's own unit per 1 percentage point of X, with its interval: β × 0.01 × 100 points for shares
    (the result table's expression), β × 0.01 otherwise."""
    to_native = 0.01 * (100 if kind == "share" else 1)
    return float(coef) * to_native, ((ci[0] * to_native, ci[1] * to_native) if ci is not None else None)


def _standardized(coef: float, ci: tuple[float, float] | None, depvar_std: Any) -> tuple[float, Any] | None:
    """(β × 0.01) / sd(Y) with its interval, or None without a positive standard deviation."""
    if not _finite(depvar_std) or float(depvar_std) <= 0:
        return None
    std = float(depvar_std)
    return float(coef) * 0.01 / std, ((ci[0] * 0.01 / std, ci[1] * 0.01 / std) if ci is not None else None)


def chart_digits(items: list[tuple[float, int]]) -> int | None:
    """One decimal count for a chart's (value, digits) pairs (frontend ``chartDigits``): as many as the bar needing
    the most has on its own, but no more than gives the largest value four significant figures (or its own digits);
    a value too small for that keeps two significant digits, as ``_signed`` does everywhere."""
    finite = [(value, digits) for value, digits in items if math.isfinite(value)]
    if not finite:
        return None
    largest_value, largest_digits = max(finite, key=lambda item: abs(item[0]))
    cap = max(0, 3 - math.floor(math.log10(abs(largest_value)))) if largest_value != 0 else math.inf
    return int(max(largest_digits, min(cap, max(digits for _, digits in finite))))


def _chart_digits(entries: list[dict[str, Any]]) -> tuple[int | None, int | None]:
    """The native and standard-deviation decimals of a family chart (frontend ``familyChartDigits``)."""
    native: list[tuple[float, int]] = []
    sd: list[tuple[float, int]] = []
    for entry in entries:
        if not _finite(entry["coef"]):
            continue
        value, bounds = _native(entry["kind"], entry["coef"], entry["ci"])
        native.append((value, estimate_digits(entry["kind"], value, bounds)))
        standardized = _standardized(entry["coef"], entry["ci"], entry["depvar_std"])
        if standardized is not None:
            sd.append((standardized[0], standardized_digits(*standardized)))
    return chart_digits(native), chart_digits(sd)


def _bar(
    kind: str,
    coef: Any,
    ci: tuple[float, float] | None,
    depvar_std: Any,
    *,
    standardized: bool,
    with_unit: bool = False,
    digits: tuple[int | None, int | None] = (None, None),
) -> dict[str, Any]:
    """One bar per 1 percentage point of X (frontend ``barFigures``). Without an estimate or a standard deviation
    the bar is 0 and its label says so; the renderer draws it grey with "方向不确定". Alone, a bar has the result
    table's digits; a family chart passes one (native, standard deviation) count for all its bars."""
    if not _finite(coef):
        return {"value": 0.0, "text": "没算出估计值"}
    native, native_bounds = _native(kind, coef, ci)
    # In the result table's digits (``_natural_effect``), with its interval, or the chart's.
    native_digits = digits[0] if digits[0] is not None else estimate_digits(kind, native, native_bounds)
    native_text = _signed(native, native_digits)
    if with_unit:
        native_text += f" {_COUNT_UNITS.get(kind, '个原始单位')}"
    if not standardized:
        item: dict[str, Any] = {"value": _shown(native), "text": native_text}
        if ci is not None:
            item["ci_low"], item["ci_high"] = _shown(ci[0] * 0.01 * 100), _shown(ci[1] * 0.01 * 100)
        return item
    standardized_value = _standardized(coef, ci, depvar_std)
    if standardized_value is None:
        return {"value": 0.0, "text": f"{native_text}（没有标准差）"}
    sd_point, sd_bounds = standardized_value
    sd_digits = digits[1] if digits[1] is not None else standardized_digits(sd_point, sd_bounds)
    # Signed, as the bar and its interval sit on a signed axis ("-40.11（-0.047 个标准差）"); only the table's
    # "幅度约 0.047 个标准差" is an unsigned size.
    item = {"value": _shown(sd_point), "text": f"{native_text}（{_signed(sd_point, sd_digits)} 个标准差）"}
    if sd_bounds is not None:
        item["ci_low"], item["ci_high"] = _shown(sd_bounds[0]), _shown(sd_bounds[1])
    return item


def _saved_interval(result: dict[str, Any], coefficient: dict[str, Any]) -> tuple[float, float] | None:
    low, high = coefficient.get("ci_low"), coefficient.get("ci_high")
    if _global_inference_suppressed(result) or not _finite(low) or not _finite(high):
        return None
    return float(low), float(high)


def _overview_interval(row: dict[str, Any]) -> tuple[float, float] | None:
    """An overview row's interval unless its inference is suppressed (frontend ``overviewEstimate``)."""
    low, high = row.get("ci_low"), row.get("ci_high")
    if row.get("suppress_inference") is True or row.get("status") not in {"ok", "warning"}:
        return None
    return (float(low), float(high)) if _finite(low) and _finite(high) else None


def _chart_block(chart: dict[str, Any]) -> list[str]:
    return ["```gvcsim-chart", json.dumps(chart, ensure_ascii=False, separators=(",", ":")), "```", ""]


def _forward_share_identity(rows: list[dict[str, Any]]) -> str | None:
    """Frontend ``forwardShareIdentity``: the step 12 line under the chart."""
    coefs = [next((row.get("coef") for row in rows if row.get("key") == key), None) for key in _FORWARD_SHARES]
    if not all(_finite(coef) for coef in coefs):
        return None
    total = sum(float(coef) for coef in coefs if _finite(coef))
    shown = "0.00" if abs(total) < 0.005 else _signed(total, 2)
    return (
        f"纯国内、传统贸易、简单 GVC、复杂 GVC 四项份额合计 100%，所以这四条相加约为 0（{shown}）；"
        "前向 GVC 生产总份额 = 简单 + 复杂。"
    )


# Step 14: weighted degree is in-degree + out-degree in every row (frontend ``NETWORK_DEGREE_IDENTITY``).
_DEGREE_KEYS = ("weighted_degree", "weighted_indegree", "weighted_outdegree")
NETWORK_DEGREE_IDENTITY = "加权总度 = 加权入度 + 加权出度，所以这两条的原始值相加约等于加权总度那一条。"


def _degree_identity(rows: list[dict[str, Any]]) -> str | None:
    keys = {row.get("key") for row in rows}
    return NETWORK_DEGREE_IDENTITY if all(key in keys for key in _DEGREE_KEYS) else None


def family_chart(
    step: int,
    outcome: str,
    design: dict[str, Any],
    result: dict[str, Any],
    coefficient: dict[str, Any],
    overview: dict[str, Any] | None,
) -> list[str]:
    """Every Y of the step's family as a diverging bar, the saved Y's bar from the saved run (marked 已保存)."""
    saved_key = design.get("baseline")
    family = overview.get("outcomes", {}).get(outcome) if isinstance(overview, dict) else None
    rows: list[dict[str, Any]] = [item for item in family if isinstance(item, dict)] if isinstance(family, list) else []
    saved_entry = {
        "saved": True,
        "label": _y_label(outcome, design),
        "kind": _depvar_kind(outcome, design),
        "coef": coefficient.get("coef"),
        "ci": _saved_interval(result, coefficient),
        "depvar_std": result.get("depvar_std"),
    }
    entries: list[dict[str, Any]] = []
    for row in rows:
        if row.get("key") == saved_key:
            entries.append({**saved_entry, "label": y_display(row.get("label") or saved_entry["label"])})
            continue
        entries.append(
            {
                "saved": False,
                "label": y_display(row.get("label") or row.get("key") or "—"),
                "kind": str(row.get("kind") or "length"),
                "coef": row.get("coef"),
                "ci": _overview_interval(row),
                "depvar_std": row.get("depvar_std"),
            }
        )
    if not any(entry["saved"] for entry in entries):
        # No overview (or the saved Y is not in it): the saved bar alone, still the same numbers as the table.
        entries.append(saved_entry)
    # The page's rule, by family (so a chart without the overview keeps the page's unit): 个百分点 only when every Y
    # of the family is a share; otherwise 个标准差 (lengths with the position index; centralities of any size).
    kinds = [item.kind for item in BASELINES.get(outcome, ())] or [entry["kind"] for entry in entries]
    standardized = not all(kind == "share" for kind in kinds)
    # One decimal count for the whole chart ("-0.0184", "-0.0152", "-0.0006"), as on the page.
    digits = _chart_digits(entries)
    items = [
        {
            "label": str(entry["label"]),
            # In 个标准差 the native unit goes under the name, as on the page.
            **({"sub": _COUNT_UNITS.get(entry["kind"], "个原始单位").removeprefix("个")} if standardized else {}),
            **_bar(
                entry["kind"],
                entry["coef"],
                entry["ci"],
                entry["depvar_std"],
                standardized=standardized,
                digits=digits,
            ),
            **({"saved": True} if entry["saved"] else {}),
        }
        for entry in entries
    ]
    chart: dict[str, Any] = {
        "version": 1,
        "type": "diverging-bar",
        "title": f"步骤 {step} · "
        + (f"{_FAMILIES.get(step, '本步')}的 {len(items)} 个 Y" if len(items) > 1 else "你保存的 Y")
        + "：X 每高 1 个百分点，Y 平均相差多少",
        "x_label": UNIT_TITLES["sd" if standardized else "points"],
        "items": items,
    }
    if standardized:
        chart["note"] = (
            "条长都换算成标准差（标准差即 Y 在国家×行业之间的典型差距），这样单位或量级差异较大的 Y 也能并列比较；"
            "条旁先写原始单位的数值，括号里是标准差。"
        )
    lines = _chart_block(chart)
    identity = (
        _forward_share_identity(rows)
        if outcome == "production"
        else _degree_identity(rows)
        if outcome == "network"
        else None
    )
    if identity:
        lines.extend((f"- {identity}", ""))
    if len(items) > 1:
        lines.extend(
            (
                "- 图中标“已保存”的是你保存的 Y，下表是它的详细数字；其余 Y 由课程用同一份数据、同一模型计算，对所有学生相同。",
                "",
            )
        )
    return lines


def summary_chart(qualified: dict[int, dict[str, Any]]) -> list[str]:
    """The step 15 summary: each step's saved run as one bar in standard deviations, SD = (β × 0.01) / that
    run's depvar_std, with the native value and unit first."""
    items: list[dict[str, Any]] = []
    missing: list[str] = []
    for step in sorted(_FAMILIES):
        run = qualified.get(step)
        family = f"步骤 {step} · {_FAMILIES[step]}"
        if run is None:
            missing.append(family)
            continue
        design, result = run["design"], run["result"]
        coefficient = _primary_coefficient(design, result) or {}
        bar = _bar(
            _depvar_kind(run["outcome"], design),
            coefficient.get("coef"),
            _saved_interval(result, coefficient),
            result.get("depvar_std"),
            standardized=True,
            with_unit=True,
        )
        items.append({"label": _y_label(run["outcome"], design), "sub": family, **bar})
    if not items:
        return []
    note = "标准差即 Y 在国家×行业之间的典型差距；条形旁先写各步原始单位的数值（和上表相同），括号里是个标准差。"
    chart: dict[str, Any] = {
        "version": 1,
        "type": "diverging-bar",
        "title": "四步保存的结果（都换算成标准差）",
        "x_label": UNIT_TITLES["sd"],
        "items": items,
        "note": note + (f"{'、'.join(missing)}：还没计算。" if missing else ""),
    }
    return _chart_block(chart)


__all__ = ["NETWORK_DEGREE_IDENTITY", "UNIT_TITLES", "family_chart", "summary_chart"]
