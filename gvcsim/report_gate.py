from __future__ import annotations

import math
import unicodedata
from typing import Any, cast

from gvcsim import evidence
from gvcsim.numeric import finite_number
from gvcsim.regression.teaching import VERSION as TEACHING_VERSION
from gvcsim.report_common import (
    GATE_STEPS,
    REFLECTION_TEXT_LIMIT,
    _INDICATOR_SOURCES,
    _REFLECTION_MIN_LENGTHS,
    _STEP_OUTCOMES,
    _STEP_TITLES,
    _list_values,
    composition_set,
)
from gvcsim.report_saved_run import _saved_runs


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
        if not finite_number(value):
            continue
        if raw.get("scope") not in {"country", "country-industry"}:
            continue
        if raw.get("scope") == "country-industry" and raw.get("industry") in (None, ""):
            continue
        if raw.get("scope") == "country" and raw.get("industry") not in (None, ""):
            continue
        result.append(raw)
    return result


# Steps 6–9 material: one economy read against the global reference, or a comparison of up to five.
MAX_COMPARED = 5


def _valid_entities(compared: list[str]) -> bool:
    """1–5 distinct economies; ROW is an accounting remainder, never an entity."""
    return 1 <= len(compared) <= MAX_COMPARED and len(set(compared)) == len(compared) and "ROW" not in compared


def _indicator_material_complete(data: dict[str, Any], step: int) -> bool:
    compared = [str(item) for item in _list_values(data.get("compared")) if str(item).strip()]
    if not _valid_entities(compared):
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
    # A single economy is read against the global reference, which exists only for country-level readings.
    if len(compared) == 1 and next(iter({str(item["scope"]) for item in observations})) != "country":
        return False
    if source == "explicit-indicator-composition":
        # The saved parts must be exactly one of the step's composition sets (step 7: forward or backward).
        if composition_set(step, (str(item["metric"]) for item in observations)) is None:
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

        def years_of(country: str, item: tuple[str, str]) -> set[int]:
            return {year for metric_name, industry, year in keys_by_country[country] if (metric_name, industry) == item}

        # Every economy has at least two years for every series, over the same years as the first economy.
        return bool(series) and all(
            len(years_of(country, item)) >= 2 and years_of(country, item) == years_of(compared[0], item)
            for country in compared
            for item in series
        )
    # Same-year comparisons and compositions must be complete for every economy (the same keys as the
    # first one).  A composition contains multiple components; all saved components survive.
    return (
        all(keys_by_country[country] == keys_by_country[compared[0]] for country in compared)
        and bool(keys_by_country[compared[0]])
        and len({year for _metric, _industry, year in keys_by_country[compared[0]]}) == 1
        and (
            source != "explicit-indicator-composition"
            or len({metric for metric, _industry, _year in keys_by_country[compared[0]]}) >= 2
        )
    )


# Steps 2–5 record the reading automatically from the country being viewed.
AUTO_COMPARISON_SOURCE = "auto-indicator-comparison"


def _table_comparison_complete(data: dict[str, Any]) -> bool:
    """Steps 2–5 require one finite, country-level reading of the selected country."""
    compared = [str(item) for item in _list_values(data.get("compared")) if str(item).strip()]
    observations = [item for item in _list_values(data.get("observations")) if isinstance(item, dict)]
    # ROW is the rest-of-world accounting remainder, not an economy.
    if len(compared) != 1 or compared == ["ROW"] or len(observations) != 1:
        return False
    item = observations[0]
    required = ("entity", "country", "year", "value", "metric", "unit", "release", "scope", "source")
    if any(item.get(key) in (None, "") for key in required):
        return False
    return (
        not isinstance(item.get("year"), bool)
        and isinstance(item.get("year"), int)
        and finite_number(item.get("value"))
        and str(item.get("entity")) == str(item.get("country")) == compared[0]
        and item.get("scope") == "country"
        and item.get("source") == AUTO_COMPARISON_SOURCE
        and data.get("metric") == item["metric"]
    )


def _network_material_complete(data: dict[str, Any]) -> bool:
    compared = [str(item) for item in _list_values(data.get("compared")) if str(item).strip()]
    observations = [item for item in _list_values(data.get("observations")) if isinstance(item, dict)]
    # Step 9 readings are always industry-level, where the same-industry reference exists for one economy too.
    if not _valid_entities(compared) or not observations:
        return False
    required = ("entity", "country", "industry", "year", "value", "metric", "unit", "release", "scope", "source")
    if any(any(item.get(key) in (None, "") for key in required) for item in observations):
        return False
    if any(
        isinstance(item.get("year"), bool)
        or not isinstance(item.get("year"), int)
        or not finite_number(item.get("value"))
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
    if not keys[compared[0]] or any(keys[country] != keys[compared[0]] for country in compared):
        return False
    years = {year for _industry, year in keys[compared[0]]}
    return len(years) >= 2 if sources == {"explicit-network-trend"} else len(years) == 1


def check_material_gate(session: dict[str, Any]) -> list[dict[str, Any]]:
    """Return only missing report evidence/actions, independently of quizzes."""
    blocked: list[dict[str, Any]] = []
    observation = _step_data(session, 1).get("observation")
    has_observation = (
        isinstance(observation, dict)
        and all(observation.get(key) not in (None, "") for key in ("row", "column", "value", "year", "table"))
        and finite_number(observation.get("value"))
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
            if not _table_comparison_complete(data):
                blocked.append(
                    {
                        "step": step,
                        "title": _STEP_TITLES.get(step, ""),
                        "missing": [
                            "请打开本步“动手拆解”并等待数据加载，系统会自动记录所选国家的代表指标"
                            if step != 5
                            else "请打开本步中心性表并等待数据加载，系统会自动记录所选国家的加权总度（国家整体）"
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
                        "missing": [
                            "请在一张读数完整的图表下点“把这张图记为本步报告材料”"
                            "（只看一个国家时用国家整体口径，或加入 1–4 个对比国家）"
                        ],
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
                            "请在一张读数完整的行业历年变化或行业排名下点“把这张图记为本步报告材料”"
                            "（可加入 1–4 个对比国家）"
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
        numeric_valid = all(finite_number(value) for value in numeric)
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
                "missing": ["请打开步骤 10 等数据加载完，系统会自动记录你选的例子（报告已提交时，请点“改用当前例子”）"],
            }
        )

    qualified_steps = {run["step"] for run in _saved_runs(session)}
    for step in sorted(_STEP_OUTCOMES):
        if step in qualified_steps:
            continue
        blocked.append(
            {
                "step": step,
                "title": _STEP_TITLES.get(step, ""),
                "missing": [
                    f"请点击“计算{_STEP_TITLES.get(step, '').split('：')[0] or '回归'}”，结果会自动保存；没算出方向时结果也会保存"
                ],
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
        if not isinstance(value, str) or reflection_length(value) < minimum:
            reflection_missing.append(f"请用自己的话填写{label}（至少 {minimum} 字）")
        if isinstance(value, str) and len(value) > REFLECTION_TEXT_LIMIT:
            reflection_missing.append(f"{label}不能超过 {REFLECTION_TEXT_LIMIT} 字")
    if reflection_missing:
        blocked.append({"step": 15, "title": "你的分析（三个问题）", "missing": reflection_missing})
    return _merge_gate_blocks(blocked)


# Code points that show nothing by themselves: control, format (zero-width, bidi), combining marks.
_INVISIBLE_CATEGORIES = frozenset({"Cc", "Cf", "Mn", "Me"})


def reflection_length(value: str) -> int:
    """The written length of a step-15 answer (frontend ``reflectionLength``): visible code points, each run of
    whitespace between words counting as one; a field of zero-width spaces is empty."""
    words = (
        "".join(char for char in word if unicodedata.category(char) not in _INVISIBLE_CATEGORIES)
        for word in value.split()
    )
    return len(" ".join(word for word in words if word))


def check_gate(session: dict[str, Any], *, quiz_bank: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Return the combined quiz and report-material gate used for generation. ``quiz_only``: the step's material is
    complete and only its quiz is not (never answered, answered wrong, or saved for an older version), so the page's
    link goes to the quiz rather than the top of the step."""
    blocked: list[dict[str, Any]] = []
    quiz_missing: dict[int, list[str]] = {}
    for step in GATE_STEPS:
        result = evidence.evaluate_step(step, session, quiz_bank=quiz_bank)
        if not result.complete:
            blocked.append({"step": step, "title": _STEP_TITLES.get(step, ""), "missing": result.missing})
            quiz_missing[step] = list(result.missing)
    blocked.extend(check_material_gate(session))
    return [
        {**item, "quiz_only": item["missing"] == quiz_missing.get(int(item["step"]))}
        for item in _merge_gate_blocks(blocked)
    ]
