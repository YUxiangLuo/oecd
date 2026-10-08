"""The report's regression bar charts, mirroring the step 11–15 pages.

Per step: one bar per Y of the step's family (the saved Y marked), from the course's fixed estimates of every Y
(``_estimate_overview``) with the saved Y's bar taken from the saved run itself, so the chart and the step's
table print the same numbers. Summary: one bar per step's saved run, all in standard deviations.
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
    _share_digits,
    _signed,
    _y_label,
    standardized_digits,
    y_display,
)

# Native digits of a value per 1 percentage point of X, as in the result table (``_natural_effect``).
_NATIVE_DIGITS = {"length": 3, "position": 4, "network": 2}
_COUNT_UNITS = {
    "share": "个百分点",
    "length": "个长度单位",
    "position": "个位置指数单位",
    "network": "个中心性原始单位",
}
_NATIVE_UNITS = {"length": "长度单位", "position": "位置指数单位", "network": "中心性原始单位"}
_STEP_NAMES = {11: "贸易流", 12: "生产", 13: "长度", 14: "网络"}


def _shown(value: float) -> float:
    """Display precision for the plotted numbers, like the tables; full values stay in the provenance."""
    return float(f"{value:.4g}")


def _finite(value: Any) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _bar(
    kind: str,
    coef: Any,
    ci: tuple[float, float] | None,
    depvar_std: Any,
    *,
    standardized: bool,
    with_unit: bool = False,
) -> dict[str, Any] | None:
    """One bar per 1 percentage point of X: shares in percentage points, otherwise in standard deviations with
    the native value first ("-40.11（0.047 个标准差）"). None when it cannot be drawn (no estimate or no SD)."""
    if not _finite(coef):
        return None
    if not standardized:
        # β × 0.01 × 100 points, the same expression as the result table.
        points = float(coef) * 0.01 * 100
        digits = _share_digits(points)
        item: dict[str, Any] = {"value": _shown(points), "text": _signed(points, digits)}
        if ci is not None:
            item["ci_low"], item["ci_high"] = _shown(ci[0] * 0.01 * 100), _shown(ci[1] * 0.01 * 100)
        return item
    if not _finite(depvar_std) or float(depvar_std) <= 0:
        return None
    std = float(depvar_std)
    native = float(coef) * 0.01
    sd_point = native / std
    sd_bounds = (ci[0] * 0.01 / std, ci[1] * 0.01 / std) if ci is not None else None
    sd_digits = standardized_digits(sd_point, sd_bounds)
    if kind == "share":
        native_text = _signed(native * 100, _share_digits(native * 100))
    else:
        native_text = _signed(native, _NATIVE_DIGITS.get(kind, 3))
    if with_unit:
        native_text += f" {_COUNT_UNITS.get(kind, '个原始单位')}"
    # Unsigned, as in the table ("幅度约 0.047 个标准差"): the native number before it carries the sign.
    item = {"value": _shown(sd_point), "text": f"{native_text}（{_signed(sd_point, sd_digits)[1:]} 个标准差）"}
    if sd_bounds is not None:
        item["ci_low"], item["ci_high"] = _shown(sd_bounds[0]), _shown(sd_bounds[1])
    return item


def _saved_interval(result: dict[str, Any], coefficient: dict[str, Any]) -> tuple[float, float] | None:
    low, high = coefficient.get("ci_low"), coefficient.get("ci_high")
    if _global_inference_suppressed(result) or not _finite(low) or not _finite(high):
        return None
    return float(low), float(high)


def _chart_block(chart: dict[str, Any]) -> list[str]:
    return ["```gvcsim-chart", json.dumps(chart, ensure_ascii=False, separators=(",", ":")), "```", ""]


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
    saved_kind = _depvar_kind(outcome, design)
    family = (overview or {}).get("outcomes", {}).get(outcome) if isinstance(overview, dict) else None
    rows: list[dict[str, Any]] = [item for item in family if isinstance(item, dict)] if isinstance(family, list) else []
    saved_row = {
        "saved": True,
        "label": _y_label(outcome, design),
        "kind": saved_kind,
        "coef": coefficient.get("coef"),
        "ci": _saved_interval(result, coefficient),
        "depvar_std": result.get("depvar_std"),
    }
    entries: list[dict[str, Any]] = []
    for row in rows:
        if row.get("key") == saved_key:
            entries.append(saved_row)
            continue
        low, high = row.get("ci_low"), row.get("ci_high")
        suppressed = row.get("suppress_inference") is True or row.get("status") in {"insufficient", "invalid_design"}
        entries.append(
            {
                "saved": False,
                "label": y_display(row.get("label") or row.get("key") or "—"),
                "kind": str(row.get("kind") or "length"),
                "coef": row.get("coef"),
                "ci": (float(low), float(high)) if not suppressed and _finite(low) and _finite(high) else None,
                "depvar_std": row.get("depvar_std"),
            }
        )
    if not any(entry["saved"] for entry in entries):
        # No overview (or the saved Y is not in it): the saved bar alone, still the same numbers as the table.
        entries.append(saved_row)
    # The rule of the step pages, by family (so a chart without the overview keeps the page's unit): one shared
    # unit (the share families) stays in percentage points; mixed units (lengths and the position index;
    # centralities of very different sizes) are put in standard deviations.
    kinds = [item.kind for item in BASELINES.get(outcome, ())] or [entry["kind"] for entry in entries]
    standardized = any(kind != "share" for kind in kinds)
    items: list[dict[str, Any]] = []
    missing: list[str] = []
    for entry in entries:
        bar = _bar(entry["kind"], entry["coef"], entry["ci"], entry["depvar_std"], standardized=standardized)
        if bar is None:
            missing.append(str(entry["label"]))
            continue
        items.append({"label": str(entry["label"]), **bar, **({"saved": True} if entry["saved"] else {})})
    if not any(item.get("saved") for item in items):
        return []
    unit = "个标准差" if standardized else "个百分点"
    chart: dict[str, Any] = {
        "version": 1,
        "type": "diverging-bar",
        "title": f"步骤 {step} · "
        + (f"{_STEP_NAMES.get(step, '本步')}的 {len(items)} 个 Y" if len(items) > 1 else "你保存的 Y")
        + "：X 每高 1 个百分点，Y 平均相差多少",
        "x_label": f"X 每高 1 个百分点，Y 平均相差（{unit}）",
        "items": items,
    }
    notes = []
    if standardized:
        units = "、".join(dict.fromkeys(_NATIVE_UNITS.get(entry["kind"], "原始单位") for entry in entries))
        notes.append(
            f"条形和括号内是个标准差（标准差即 Y 在国家×行业之间的典型差距），单位或大小相差很多的 Y 才能放在一起比；括号前是原始数值（{units}）。"
        )
    if missing:
        notes.append(f"{'、'.join(missing)}没有可画的估计，未画出。")
    if notes:
        chart["note"] = "".join(notes)
    if len(items) == 1:
        return _chart_block(chart)
    return [
        *_chart_block(chart),
        "- 图中标“已保存”的是你保存的 Y，下表是它的详细数字；其余 Y 是课程用同一份数据、同一个模型算出的结果，每位同学都一样。",
        "",
    ]


def summary_chart(qualified: dict[int, dict[str, Any]]) -> list[str]:
    """The step 15 summary: each step's saved run as one bar in standard deviations, SD = (β × 0.01) / that
    run's depvar_std, with the native value and unit first."""
    items: list[dict[str, Any]] = []
    missing: list[str] = []
    for step in sorted(qualified):
        run = qualified[step]
        design, result = run["design"], run["result"]
        coefficient = _primary_coefficient(design, result)
        label = _y_label(run["outcome"], design)
        bar = (
            _bar(
                _depvar_kind(run["outcome"], design),
                coefficient.get("coef"),
                _saved_interval(result, coefficient),
                result.get("depvar_std"),
                standardized=True,
                with_unit=True,
            )
            if isinstance(coefficient, dict)
            else None
        )
        if bar is None:
            missing.append(f"步骤 {step}")
            continue
        items.append({"label": label, "sub": f"步骤 {step}", **bar})
    if not items:
        return []
    chart: dict[str, Any] = {
        "version": 1,
        "type": "diverging-bar",
        "title": "四步保存的结果，都换成个标准差",
        "x_label": "X 每高 1 个百分点，Y 平均相差（个标准差）",
        "items": items,
        "note": "标准差即 Y 在国家×行业之间的典型差距；括号前是各步原始单位的数值，和上表相同。"
        + (f"{'、'.join(missing)} 没有记录标准差，未画出。" if missing else ""),
    }
    return _chart_block(chart)


__all__ = ["family_chart", "summary_chart"]
