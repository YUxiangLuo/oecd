from __future__ import annotations

import json
from typing import Any, cast

from gvcsim import quizzes
from gvcsim.report_common import (
    GATE_STEPS,
    _COMPOSITION_COMPONENT_METRICS,
    _STEP_TITLES,
    _STUDENT_METRIC_LABELS,
    _list_values,
    _number,
    _safe,
    _signed,
)
from gvcsim.report_gate import (
    _indicator_material_complete,
    _network_material_complete,
    _step_data,
    _valid_indicator_observations,
)
from gvcsim.shocks import events_metadata


def _reflection_value(value: Any) -> str:
    """Keep accepted student prose byte-for-byte instead of normalizing Markdown."""
    return value if isinstance(value, str) else "—"


def _reflection_section(session: dict[str, Any]) -> list[str]:
    reflection = _step_data(session, 15)
    return [
        "## 一页结论：我的问题、证据与局限",
        "",
        "> 先读这一节即可了解学生的主张；后续章节提供可复核数字、理解检查和技术附录。",
        "",
        "### 我的研究问题",
        "",
        _reflection_value(reflection.get("research_question")),
        "",
        "### 我的证据解释",
        "",
        _reflection_value(reflection.get("evidence_interpretation")),
        "",
        "### 我不能据此推出什么",
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


def _viewed_shock_event_sources(session: dict[str, Any]) -> list[dict[str, Any]]:
    """Resolve saved step-10 event names to the catalogue's source contract."""
    shock = _step_data(session, 10)
    requested = [str(item) for item in _list_values(shock.get("viewed_events"))]
    selected = shock.get("selected_event_key")
    if isinstance(selected, str) and selected:
        requested.append(selected.rsplit("::", 1)[0])
    by_name = {str(item.get("name")): item for item in events_metadata() if item.get("name")}
    resolved: list[dict[str, Any]] = []
    for name in dict.fromkeys(requested):
        item = by_name.get(name)
        if item is None:
            resolved.append(
                {
                    "name": name,
                    "source_status": "unknown_saved_event",
                    "source_disclosure": "保存的事件已不在当前课程目录中；来源状态无法确认。",
                    "source_urls": [],
                }
            )
            continue
        resolved.append(
            {
                "name": name,
                "source_status": item.get("source_status"),
                "source_disclosure": item.get("source_disclosure"),
                "source_urls": list(item.get("source_urls") or []),
            }
        )
    return resolved


def _chart_value(observation: dict[str, Any]) -> float:
    value = float(observation["value"])
    return value * 100 if observation.get("unit") == "%" else value


def _observed_chart(data: dict[str, Any], step: int, observations: list[dict[str, Any]]) -> dict[str, Any]:
    source = str(observations[0]["source"])
    units = {str(item["unit"]) for item in observations}
    unit = next(iter(units)) if len(units) == 1 else "按图例所示单位"
    y_label = "百分比（%）" if unit == "%" else unit
    title = f"步骤 {step} · {_STEP_TITLES[step]}"
    if source in {"explicit-indicator-trend", "explicit-network-trend"}:
        available_metrics = list(dict.fromkeys(str(item["metric"]) for item in observations))
        selection = data.get("indicator_selection")
        selected_metric = selection.get("metric") if isinstance(selection, dict) else None
        metric = str(selected_metric) if selected_metric in available_metrics else available_metrics[0]
        context = "构成演变 · " if isinstance(selection, dict) and selection.get("view") == "evolution" else ""
        countries = [str(item) for item in _list_values(data.get("compared"))]
        series = []
        for country in countries:
            points = sorted(
                (
                    {"label": str(item["year"]), "value": _chart_value(item)}
                    for item in observations
                    if item["country"] == country and item["metric"] == metric
                ),
                key=lambda point: int(cast(str, point["label"])),
            )
            if points:
                series.append({"label": country, "points": points})
        return {
            "version": 1,
            "type": "line",
            "title": f"{title}：{context}{_STUDENT_METRIC_LABELS.get(metric, metric)}两国历年趋势",
            "x_label": "年份",
            "y_label": y_label,
            "series": series,
        }
    available_metrics = list(dict.fromkeys(str(item["metric"]) for item in observations))
    single_metric = len(available_metrics) == 1
    countries = [str(item) for item in _list_values(data.get("compared"))]
    if source == "explicit-indicator-composition":
        industry = str(observations[0].get("industry") or "")
        year = int(observations[0]["year"])
        identities = [(industry, year, metric) for metric in _COMPOSITION_COMPONENT_METRICS.get(step, ())]
    else:
        identities = list(
            dict.fromkeys(
                (str(item.get("industry") or ""), int(item["year"]), str(item["metric"])) for item in observations
            )
        )[:6]
    selected = [
        item
        for industry, year, metric in identities
        for country in countries
        for item in observations
        if item["country"] == country
        and str(item.get("industry") or "") == industry
        and item["year"] == year
        and item["metric"] == metric
    ]
    items = [
        {
            "label": " · ".join(
                part
                for part in (
                    str(item["country"]),
                    str(item.get("industry") or ""),
                    "" if single_metric else _STUDENT_METRIC_LABELS.get(str(item["metric"]), str(item["metric"])),
                )
                if part
            ),
            "value": _chart_value(item),
        }
        for item in selected
    ]
    return {
        "version": 1,
        "type": "bar",
        "title": (
            f"{title}：{_STUDENT_METRIC_LABELS.get(available_metrics[0], available_metrics[0])}同口径国家比较"
            if single_metric
            else f"{title}：同口径国家比较"
        ),
        "y_label": y_label,
        "items": items,
    }


def _observed_charts(data: dict[str, Any], step: int, observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep every selected composition component while retaining two-country trend charts."""
    selection = data.get("indicator_selection")
    is_evolution = isinstance(selection, dict) and selection.get("view") == "evolution"
    source = str(observations[0]["source"])
    components = _COMPOSITION_COMPONENT_METRICS.get(step)
    if source != "explicit-indicator-trend" or not is_evolution or components is None:
        return [_observed_chart(data, step, observations)]
    assert isinstance(selection, dict)
    available = {str(item["metric"]) for item in observations}
    return [
        _observed_chart(
            {**data, "indicator_selection": {**selection, "metric": metric}},
            step,
            observations,
        )
        for metric in components
        if metric in available
    ]


def _observed_evidence_section(session: dict[str, Any]) -> list[str]:
    """Place saved observed comparisons before simulated regression evidence."""
    lines = [
        "## 真实指标：时间变化与国家比较",
        "",
        "> 图表由步骤 6–9 已保存的同口径读数自动生成；无需学生重复抄录。图下保留完整数值表供复核。",
        "",
    ]
    for step in range(6, 10):
        data = _step_data(session, step)
        observations = (
            _valid_indicator_observations(data)
            if step in (6, 7, 8)
            else [item for item in _list_values(data.get("observations")) if isinstance(item, dict)]
        )
        complete = _indicator_material_complete(data, step) if step in (6, 7, 8) else _network_material_complete(data)
        if not complete or not observations:
            continue
        lines.extend((f"### 步骤 {step} · {_STEP_TITLES[step]}", ""))
        charts = _observed_charts(data, step, observations)
        if len(charts) > 1:
            lines.extend(("> 构成演变按构成项拆成多张两国同口径趋势图，避免把不同分项连接成一条线。", ""))
        for chart in charts:
            lines.append("```gvcsim-chart")
            lines.append(json.dumps(chart, ensure_ascii=False, separators=(",", ":")))
            lines.extend(("```", ""))
            if chart["type"] == "line":
                changes = []
                for series in chart["series"]:
                    first, last = series["points"][0], series["points"][-1]
                    changes.append(
                        f"{series['label']} 从 {first['label']} 年 {_number(first['value'])} 变为 "
                        f"{last['label']} 年 {_number(last['value'])}（变化 {_signed(last['value'] - first['value'], 3)}）"
                    )
                lines.append(f"- 自动读图：{'；'.join(changes)}。这是描述性变化，不自动构成政策效应。")
            else:
                largest = max(chart["items"], key=lambda item: item["value"])
                smallest = min(chart["items"], key=lambda item: item["value"])
                lines.append(
                    f"- 自动读图：保存范围内最高为 {largest['label']}（{_number(largest['value'])}），"
                    f"最低为 {smallest['label']}（{_number(smallest['value'])}）。这是同口径描述性比较。"
                )
            lines.append("")
    return lines


__all__=[n for n in globals() if not n.startswith("__")]
