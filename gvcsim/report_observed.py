from __future__ import annotations

import json
import re
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
    """Preserve prose inside a literal block that cannot consume later sections."""
    text = value if isinstance(value, str) else "—"
    fence = "`" * max(3, 1 + max((len(run) for run in re.findall(r"`+", text)), default=0))
    return f"{fence}gvcsim-reflection\n{text}\n{fence}"


def _reflection_section(session: dict[str, Any]) -> list[str]:
    reflection = _step_data(session, 15)
    return [
        "## 结论",
        "",
        "> 本节由学生填写。相关数字见后文。",
        "",
        "### 我的研究问题",
        "",
        _reflection_value(reflection.get("research_question")),
        "",
        "### 我的结果解释",
        "",
        _reflection_value(reflection.get("evidence_interpretation")),
        "",
        "### 局限",
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
        view = selection.get("view") if isinstance(selection, dict) else None
        context = "构成演变 · " if view == "evolution" else "前后向 · " if view == "directions" else ""
        # Industry-level trends (e.g. step 9) must name the industry, or the chart reads as a national total.
        industries = sorted(
            {str(item.get("industry") or "") for item in observations if item["metric"] == metric} - {""}
        )
        if len(industries) == 1:
            context += f"{industries[0]} 行业 · "
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
        )
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
    # Name the single year / industry the bars come from; otherwise the comparison has no stated scope.
    selected_years = sorted({int(item["year"]) for item in selected})
    selected_industries = sorted({str(item.get("industry") or "") for item in selected} - {""})
    scope = f"{selected_years[0]} 年 · " if len(selected_years) == 1 else ""
    if len(selected_industries) == 1:
        scope += f"{selected_industries[0]} 行业 · "
    return {
        "version": 1,
        "type": "bar",
        "title": (
            f"{title}：{scope}{_STUDENT_METRIC_LABELS.get(available_metrics[0], available_metrics[0])}同口径国家比较"
            if single_metric
            else f"{title}：{scope}同口径国家比较"
        ),
        "y_label": y_label,
        "items": items,
    }


def _observed_charts(data: dict[str, Any], step: int, observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep every saved trend metric, with composition totals excluded explicitly."""
    selection = data.get("indicator_selection")
    is_evolution = isinstance(selection, dict) and selection.get("view") == "evolution"
    source = str(observations[0]["source"])
    components = _COMPOSITION_COMPONENT_METRICS.get(step)
    if source not in {"explicit-indicator-trend", "explicit-network-trend"}:
        return [_observed_chart(data, step, observations)]
    available = list(dict.fromkeys(str(item["metric"]) for item in observations))
    metrics = [metric for metric in components if metric in available] if is_evolution and components else available
    selection = selection if isinstance(selection, dict) else {}
    return [
        _observed_chart(
            {**data, "indicator_selection": {**selection, "metric": metric}},
            step,
            observations,
        )
        for metric in metrics
    ]


def _observed_evidence_section(session: dict[str, Any]) -> list[str]:
    """Place saved observed comparisons before simulated regression evidence."""
    lines = [
        "## 真实指标比较",
        "",
        "> 图表使用步骤 6–9 保存的同口径读数。完整数值见“保存的实验快照”。",
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
            selection = data.get("indicator_selection")
            view = selection.get("view") if isinstance(selection, dict) else None
            context = "前后向指标" if view == "directions" else "构成演变" if view == "evolution" else "已保存指标"
            lines.extend((f"> {context}按指标拆成多张两国同口径趋势图，保留每项读数与变化。", ""))
        for chart in charts:
            display_chart = chart
            if chart["type"] == "bar" and len(chart["items"]) > 12:
                display_chart = {**chart, "items": chart["items"][:12]}
                lines.extend(
                    (
                        f"> 主图按保存顺序展示前 12 / {len(chart['items'])} 条读数；"
                        "下方极值使用全部保存读数。完整数值表见后文“保存的实验快照”。",
                        "",
                    )
                )
            lines.append("```gvcsim-chart")
            lines.append(json.dumps(display_chart, ensure_ascii=False, separators=(",", ":")))
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
                largest_labels = "、".join(
                    item["label"] for item in chart["items"] if item["value"] == largest["value"]
                )
                smallest_labels = "、".join(
                    item["label"] for item in chart["items"] if item["value"] == smallest["value"]
                )
                scope = (
                    "保存的构成项中" if observations[0]["source"] == "explicit-indicator-composition" else "保存范围内"
                )
                lines.append(
                    f"- 自动读图：{scope}最高为 {largest_labels}（{_number(largest['value'])}），"
                    f"最低为 {smallest_labels}（{_number(smallest['value'])}）。这是同口径描述性比较。"
                )
            lines.append("")
    return lines


__all__ = [n for n in globals() if not n.startswith("__")]
