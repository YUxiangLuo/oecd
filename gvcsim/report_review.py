"""The outro's frozen review, built from the same canonical evidence as the report body.

No client estimates or current workspace selections are used. Numeric values and display
precision travel together so percentages, ratios and simulated scores cannot be confused.
"""

from __future__ import annotations

import math
from typing import Any, Literal, TypedDict

from gvcsim.regression.spec import DEFAULT_SPEC, ModelSpec
from gvcsim.regression.teaching import baseline
from gvcsim.report_common import (
    UNIT_NAMES,
    _STEP_TITLES,
    _depvar_kind,
    _effective_status,
    _global_inference_suppressed,
    _signed,
    _y_label,
    estimate_digits,
)
from gvcsim.report_gate import _step_data
from gvcsim.report_labels import country_label, sector_label
from gvcsim.report_observed import _reflection_text
from gvcsim.report_workbench import _per_point, _shared_digits, _x_span, _x_sum


class ReviewEstimate(TypedDict):
    step: int
    outcome: str
    y_label: str
    unit: str
    x_span: str
    value: float | None
    interval: tuple[float, float] | None
    value_text: str
    interval_text: str
    inference: Literal["positive", "negative", "uncertain", "unavailable"]
    inference_note: str
    n_obs: int | None
    years: list[int]


class ReviewEvidence(TypedDict):
    step: int
    title: str
    chart_titles: list[str]
    countries: list[str]
    industry_scope: str
    industries: list[str]
    years: list[int]


class ReviewModel(TypedDict):
    step: int
    name: str
    specification: str
    reference: ReviewEstimate
    result: ReviewEstimate


class ReportReview(TypedDict):
    research_question: str
    evidence_interpretation: str
    limitations: str
    evidence: list[ReviewEvidence]
    results: list[ReviewEstimate]
    custom_models: list[ReviewModel]


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def review_estimate(
    step: int,
    outcome: str,
    run: dict[str, Any] | str,
    spec: ModelSpec,
    *,
    baseline_key: str | None = None,
    digits: int | None = None,
) -> ReviewEstimate:
    # Even a failed optional run must keep the student's selected Y and X span.
    design = (
        run["design"]
        if isinstance(run, dict)
        else {
            "baseline": baseline_key,
            "baseline_label": baseline(outcome, baseline_key).label,
            "depvar_kind": baseline(outcome, baseline_key).kind,
        }
    )
    result = run["result"] if isinstance(run, dict) else {}
    kind = _depvar_kind(outcome, design)
    coefficient = _x_sum(result, spec)
    value, bounds = None, None
    if coefficient and _finite(coefficient.get("coef")) and _effective_status(result) != "invalid_design":
        value, bounds = _per_point(kind, result, coefficient)
        if bounds and (
            _global_inference_suppressed(result) or not all(_finite(v) for v in bounds) or bounds[0] > bounds[1]
        ):
            bounds = None
    inference: Literal["positive", "negative", "uncertain", "unavailable"] = "unavailable"
    note = "未获得可用估计值，原因见报告中的模型说明。" if value is None else "区间估计不可用，无法据此作出统计推断。"
    if bounds:
        if bounds[0] <= 0 <= bounds[1]:
            inference, note = (
                "uncertain",
                "95% 置信区间包含 0，尚不能拒绝所估参数为 0 的原假设；不显著不等于不存在关联。",
            )
        elif bounds[0] > 0:
            inference, note = "positive", "95% 置信区间下限大于 0，呈显著正向关联（5% 水平）。"
        else:
            inference, note = "negative", "95% 置信区间上限小于 0，呈显著负向关联（5% 水平）。"
    shown_digits = digits if digits is not None else estimate_digits(kind, value, bounds) if value is not None else 0
    years = (result.get("sample_flow") or {}).get("years") or []
    return {
        "step": step,
        "outcome": outcome,
        "y_label": _y_label(outcome, design),
        "unit": UNIT_NAMES[kind],
        "x_span": _x_span(spec),
        "value": value,
        "interval": bounds,
        "value_text": _signed(value, shown_digits) if value is not None else "—",
        "interval_text": f"[{_signed(bounds[0], shown_digits)}, {_signed(bounds[1], shown_digits)}]"
        if bounds
        else "无法推断",
        "inference": inference,
        "inference_note": note,
        "n_obs": result.get("n_obs"),
        "years": list(years),
    }


def _evidence(material: dict[str, Any]) -> ReviewEvidence:
    observations = material["observations"]
    countries = list(dict.fromkeys(str(item["country"]) for item in observations))
    industries = list(dict.fromkeys(str(item["industry"]) for item in observations if item.get("industry")))
    scope = (
        "国家整体"
        if not industries
        else sector_label(industries[0])
        if len(industries) == 1
        else f"已记录的 {len(industries)} 个行业"
    )
    return {
        "step": material["step"],
        "title": _STEP_TITLES[material["step"]],
        "chart_titles": [str(chart["title"]) for chart in material["charts"]],
        "countries": [country_label(code) for code in countries],
        "industry_scope": scope,
        "industries": [sector_label(code) for code in industries],
        "years": sorted({int(item["year"]) for item in observations}),
    }


def build_review(
    session: dict[str, Any],
    runs: list[dict[str, Any]],
    materials: list[dict[str, Any]],
    custom_tables: list[dict[str, Any]],
) -> ReportReview:
    reflection = _step_data(session, 15)
    models: list[ReviewModel] = []
    for table in custom_tables:
        columns = table["columns"]
        kind = baseline(table["outcome"], table["baseline"]).kind
        digits = _shared_digits(columns, kind)
        reference = review_estimate(
            table["step"],
            table["outcome"],
            columns[0]["run"],
            columns[0]["spec"],
            baseline_key=table["baseline"],
            digits=digits,
        )
        for column in columns[1:]:
            models.append(
                {
                    "step": table["step"],
                    "name": column["name"],
                    "specification": column["spec"].summary(),
                    "reference": reference,
                    "result": review_estimate(
                        table["step"],
                        table["outcome"],
                        column["run"],
                        column["spec"],
                        baseline_key=table["baseline"],
                        digits=digits,
                    ),
                }
            )
    return {
        "research_question": _reflection_text(reflection.get("research_question", "")),
        "evidence_interpretation": _reflection_text(reflection.get("evidence_interpretation", "")),
        "limitations": _reflection_text(reflection.get("limitations", "")),
        "evidence": [_evidence(material) for material in materials],
        "results": [review_estimate(run["step"], run["outcome"], run, DEFAULT_SPEC) for run in runs],
        "custom_models": models,
    }
