from __future__ import annotations

import math
from typing import Any, cast

from gvcsim import evidence
from gvcsim.regression.teaching import VERSION as TEACHING_VERSION
from gvcsim.report_common import (
    GATE_STEPS,
    REFLECTION_TEXT_LIMIT,
    _COMPOSITION_COMPONENT_METRICS,
    _COMPOSITION_TOTAL_METRICS,
    _INDICATOR_SOURCES,
    _REFLECTION_MIN_LENGTHS,
    _STEP_OUTCOMES,
    _STEP_TITLES,
    _list_values,
)
from gvcsim.report_saved_run import _gate_qualified_runs


def _step_data(session: dict[str, Any], step: int) -> dict[str, Any]:
    record = session.get("steps", {}).get(str(step))
    data = record.get("data") if isinstance(record, dict) else None
    return data if isinstance(data, dict) else {}


def _merge_gate_blocks(blocked: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep one actionable report-gate entry per course step."""
    merged: dict[int, dict[str, Any]] = {}
    for item in blocked:
        step = int(item["step"])
        if step not in merged:
            merged[step] = {**item, "missing": list(item["missing"])}
            continue
        missing = merged[step]["missing"]
        for reason in item["missing"]:
            if reason not in missing:
                missing.append(reason)
    return list(merged.values())


def _valid_indicator_observations(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Return schema-complete, finite, explicitly saved step 6–8 readings."""
    result = []
    for raw in _list_values(data.get("observations")):
        if not isinstance(raw, dict) or raw.get("source") not in _INDICATOR_SOURCES:
            continue
        required = ("entity", "country", "year", "value", "metric", "unit", "release", "scope")
        if any(raw.get(key) in (None, "") for key in required):
            continue
        if isinstance(raw.get("year"), bool) or not isinstance(raw.get("year"), int):
            continue
        value = raw.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            continue
        if raw.get("scope") not in {"country", "country-industry"}:
            continue
        if raw.get("scope") == "country-industry" and raw.get("industry") in (None, ""):
            continue
        if raw.get("scope") == "country" and raw.get("industry") not in (None, ""):
            continue
        result.append(raw)
    return result


def _indicator_material_complete(data: dict[str, Any], step: int) -> bool:
    compared = [str(item) for item in _list_values(data.get("compared")) if str(item).strip()]
    if len(compared) != 2 or len(set(compared)) != 2:
        return False
    observations = _valid_indicator_observations(data)
    if not observations or {str(item["country"]) for item in observations} != set(compared):
        return False
    if (
        len({str(item["scope"]) for item in observations}) != 1
        or len({str(item["release"]) for item in observations}) != 1
    ):
        return False
    metric_units = {(str(item["metric"]), str(item["unit"])) for item in observations}
    if len({metric for metric, _unit in metric_units}) != len(metric_units):
        return False
    sources = {str(item["source"]) for item in observations}
    if len(sources) != 1:
        return False
    source = next(iter(sources))
    if source == "explicit-indicator-composition":
        components = _COMPOSITION_COMPONENT_METRICS.get(step)
        total = _COMPOSITION_TOTAL_METRICS.get(step)
        required_components = set(components) | {total} if components is not None and total is not None else None
        if required_components is None or {item["metric"] for item in observations} != required_components:
            return False
    keys_by_country: dict[str, set[tuple[str, str, int]]] = {
        country: {
            (str(item["metric"]), str(item.get("industry", "")), int(item["year"]))
            for item in observations
            if item["country"] == country
        }
        for country in compared
    }
    if source == "explicit-indicator-trend":
        series = {(str(item["metric"]), str(item.get("industry", ""))) for item in observations}
        return (
            bool(series)
            and all(
                len(
                    {
                        year
                        for metric_name, industry, year in keys_by_country[country]
                        if (metric_name, industry) == item
                    }
                )
                >= 2
                for country in compared
                for item in series
            )
            and all(
                {
                    year
                    for metric_name, industry, year in keys_by_country[compared[0]]
                    if (metric_name, industry) == item
                }
                == {
                    year
                    for metric_name, industry, year in keys_by_country[compared[1]]
                    if (metric_name, industry) == item
                }
                for item in series
            )
        )
    # Same-year comparisons and compositions must be pairwise complete.  A
    # composition contains multiple components; all saved components survive.
    return (
        keys_by_country[compared[0]] == keys_by_country[compared[1]]
        and bool(keys_by_country[compared[0]])
        and len({year for _metric, _industry, year in keys_by_country[compared[0]]}) == 1
        and (
            source != "explicit-indicator-composition"
            or len({metric for metric, _industry, _year in keys_by_country[compared[0]]}) >= 2
        )
    )


# Steps 2–5 record the comparison automatically from the country being viewed; older explicit saves stay valid.
AUTO_COMPARISON_SOURCE = "auto-indicator-comparison"
EXPLICIT_COMPARISON_SOURCE = "explicit-indicator-table-comparison"


def _table_comparison_complete(data: dict[str, Any], *, allow_auto: bool = False) -> bool:
    """Steps 2–5 require one finite, same-year reading for each of two countries."""
    sources = {EXPLICIT_COMPARISON_SOURCE, AUTO_COMPARISON_SOURCE} if allow_auto else {EXPLICIT_COMPARISON_SOURCE}
    compared = [str(item) for item in _list_values(data.get("compared")) if str(item).strip()]
    observations = [item for item in _list_values(data.get("observations")) if isinstance(item, dict)]
    if len(compared) != 2 or len(set(compared)) != 2 or len(observations) != 2:
        return False
    required = ("entity", "country", "year", "value", "metric", "unit", "release", "scope", "source")
    if any(any(item.get(key) in (None, "") for key in required) for item in observations):
        return False
    if any(
        isinstance(item.get("year"), bool)
        or not isinstance(item.get("year"), int)
        or isinstance(item.get("value"), bool)
        or not isinstance(item.get("value"), (int, float))
        or not math.isfinite(float(item["value"]))
        or str(item.get("entity")) != str(item.get("country"))
        or item.get("scope") != "country"
        or item.get("source") not in sources
        for item in observations
    ):
        return False
    return (
        {str(item["country"]) for item in observations} == set(compared)
        and len({item["year"] for item in observations}) == 1
        and len({str(item["metric"]) for item in observations}) == 1
        and len({str(item["unit"]) for item in observations}) == 1
        and len({str(item["release"]) for item in observations}) == 1
        and data.get("metric") == observations[0]["metric"]
    )


def _network_material_complete(data: dict[str, Any]) -> bool:
    compared = [str(item) for item in _list_values(data.get("compared")) if str(item).strip()]
    observations = [item for item in _list_values(data.get("observations")) if isinstance(item, dict)]
    if len(compared) != 2 or len(set(compared)) != 2 or not observations:
        return False
    required = ("entity", "country", "industry", "year", "value", "metric", "unit", "release", "scope", "source")
    if any(any(item.get(key) in (None, "") for key in required) for item in observations):
        return False
    if any(
        isinstance(item.get("year"), bool)
        or not isinstance(item.get("year"), int)
        or isinstance(item.get("value"), bool)
        or not isinstance(item.get("value"), (int, float))
        or not math.isfinite(float(item["value"]))
        or item.get("scope") != "country-industry"
        for item in observations
    ):
        return False
    if {str(item["country"]) for item in observations} != set(compared):
        return False
    identities = [(str(item["country"]), str(item["industry"]), int(item["year"])) for item in observations]
    if len(identities) != len(set(identities)):
        return False
    if (
        len({str(item["metric"]) for item in observations}) != 1
        or len({str(item["unit"]) for item in observations}) != 1
    ):
        return False
    if len({str(item["release"]) for item in observations}) != 1:
        return False
    sources = {str(item["source"]) for item in observations}
    if len(sources) != 1 or not sources <= {"explicit-network-trend", "explicit-network-ranking"}:
        return False
    keys = {
        country: {(str(item["industry"]), int(item["year"])) for item in observations if item["country"] == country}
        for country in compared
    }
    if keys[compared[0]] != keys[compared[1]] or not keys[compared[0]]:
        return False
    years = {year for _industry, year in keys[compared[0]]}
    return len(years) >= 2 if sources == {"explicit-network-trend"} else len(years) == 1


def check_material_gate(session: dict[str, Any], **_unused: Any) -> list[dict[str, Any]]:
    """Return only missing report evidence/actions, independently of quizzes."""
    blocked: list[dict[str, Any]] = []
    observation = _step_data(session, 1).get("observation")
    has_observation = (
        isinstance(observation, dict)
        and all(observation.get(key) not in (None, "") for key in ("row", "column", "value", "year", "table"))
        and isinstance(observation.get("value"), (int, float))
        and not isinstance(observation.get("value"), bool)
        and math.isfinite(float(observation["value"]))
    )
    if not has_observation:
        blocked.append(
            {
                "step": 1,
                "title": _STEP_TITLES.get(1, ""),
                "missing": ["请打开本步并等待表格加载，系统会自动记录一个单元格（也可点击其他单元格替换）"],
            }
        )

    for step in range(2, 10):
        data = _step_data(session, step)
        if step in (2, 3, 4, 5):
            if not _table_comparison_complete(data, allow_auto=True):
                blocked.append(
                    {
                        "step": step,
                        "title": _STEP_TITLES.get(step, ""),
                        "missing": [
                            "请打开本步“动手拆解”并等待数据加载，系统会自动记录两国同年的代表指标"
                            if step != 5
                            else "请打开本步中心性表并等待数据加载，系统会自动记录两国同年的加权总度"
                        ],
                    }
                )
            continue
        if step in (6, 7, 8):
            if not _indicator_material_complete(data, step):
                blocked.append(
                    {
                        "step": step,
                        "title": _STEP_TITLES.get(step, ""),
                        "missing": ["请选择恰好两个国家并查看一张读数完整的图表，系统会自动记录为本步报告材料"],
                    }
                )
            continue
        if step == 9:
            if not _network_material_complete(data):
                blocked.append(
                    {
                        "step": step,
                        "title": _STEP_TITLES.get(step, ""),
                        "missing": [
                            "请在“两国行业比较”中选择两个国家并查看一张读数完整的趋势或行业排名，系统会自动记录为本步报告材料"
                        ],
                    }
                )
            continue

    shock_data = _step_data(session, 10)
    required_panel = {
        "teaching_country": str,
        "teaching_year": int,
        "viewed_teaching_panel": bool,
        "teaching_panel_version": str,
    }
    panel_valid = all(isinstance(shock_data.get(key), kind) for key, kind in required_panel.items())
    panel_valid = panel_valid and not isinstance(shock_data.get("teaching_year"), bool)
    panel_valid = panel_valid and bool(str(shock_data.get("teaching_country", "")).strip())
    panel_valid = panel_valid and shock_data.get("viewed_teaching_panel") is True
    panel_valid = panel_valid and shock_data.get("teaching_panel_version") == TEACHING_VERSION
    teaching_observation = shock_data.get("teaching_observation")
    if isinstance(teaching_observation, dict):
        numeric = [
            teaching_observation.get("teaching_export_share_w"),
            teaching_observation.get("teaching_tariff_rate_tau"),
            teaching_observation.get("teaching_tariff_exposure"),
        ]
        numeric_valid = all(
            isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))
            for value in numeric
        )
        values = [float(cast(int | float, value)) for value in numeric] if numeric_valid else []
        panel_valid = panel_valid and numeric_valid and all(value >= 0 for value in values)
        panel_valid = panel_valid and teaching_observation.get("country") == shock_data.get("teaching_country")
        panel_valid = panel_valid and teaching_observation.get("year") == shock_data.get("teaching_year")
        panel_valid = panel_valid and teaching_observation.get("version") == TEACHING_VERSION
        panel_valid = panel_valid and len(values) == 3 and math.isclose(values[2], values[0] * values[1], abs_tol=1e-12)
    else:
        panel_valid = False
    if not panel_valid:
        blocked.append(
            {
                "step": 10,
                "title": _STEP_TITLES.get(10, ""),
                "missing": ["请打开本步并等待模拟关税面板加载，系统会自动记录所选例子"],
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
                "missing": ["请点击“运行回归”，结果会自动保存；无法推断时也会保存诊断结果"],
            }
        )

    reflection = _step_data(session, 15)
    reflection_missing = []
    for key, label in (
        ("research_question", "研究问题"),
        ("evidence_interpretation", "结果解释"),
        ("limitations", "局限与反思"),
    ):
        minimum = _REFLECTION_MIN_LENGTHS[key]
        value = reflection.get(key)
        if not isinstance(value, str) or len(" ".join(value.split())) < minimum:
            reflection_missing.append(f"请用自己的话填写{label}（至少 {minimum} 个字符）")
        if isinstance(value, str) and len(value) > REFLECTION_TEXT_LIMIT:
            reflection_missing.append(f"{label}不能超过 {REFLECTION_TEXT_LIMIT} 个字符")
    if reflection_missing:
        blocked.append({"step": 15, "title": "原创分析与反思", "missing": reflection_missing})
    return _merge_gate_blocks(blocked)


def check_gate(session: dict[str, Any], **_unused: Any) -> list[dict[str, Any]]:
    """Return the combined quiz and report-material gate used for generation."""
    blocked: list[dict[str, Any]] = []
    for step in GATE_STEPS:
        result = evidence.evaluate_step(step, session)
        if not result.complete:
            blocked.append({"step": step, "title": _STEP_TITLES.get(step, ""), "missing": result.missing})
    blocked.extend(check_material_gate(session))
    return _merge_gate_blocks(blocked)
