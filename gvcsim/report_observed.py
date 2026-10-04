from __future__ import annotations

import json
import re
from typing import Any, cast

from gvcsim import quizzes
from gvcsim.report_common import (
    GATE_STEPS,
    _COMPOSITION_COMPONENT_METRICS,
    _COMPOSITION_TOTAL_METRICS,
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
from gvcsim.report_labels import country_label, sector_label
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


_BAR_DISPLAY_LIMIT = 40
_COMPOSITION_TOTAL_SHORT = {6: "总出口", 7: "总增加值"}


def _chart_value(observation: dict[str, Any]) -> float:
    value = float(observation["value"])
    return value * 100 if observation.get("unit") == "%" else value


def _chart_unit(chart: dict[str, Any]) -> str:
    """The reading unit of a chart; percentage charts all end their axis label with “（%）”."""
    y_label = str(chart.get("y_label") or "")
    return "%" if y_label.endswith("（%）") else y_label


def _reading(value: float, unit: str) -> str:
    return f"{_number(value)}%" if unit == "%" else _number(value)


def _change(delta: float, unit: str) -> str:
    """A change in the chart's own unit: percentage points for shares, grouped amounts in 百万美元."""
    if unit == "%":
        return f"{_signed(delta, 2)} 个百分点"
    magnitude = abs(delta)
    if unit == "百万美元":
        return f"{_signed(delta, 0 if magnitude >= 1 else 2)} 百万美元"
    return _signed(delta, 0 if magnitude >= 100 else 2 if magnitude >= 1 else 3)


def _item_label(item: dict[str, Any]) -> str:
    return f"{item['group']} · {item['label']}" if item.get("group") else str(item["label"])


def _find_value(
    observations: list[dict[str, Any]], country: str, industry: str, year: int, metric: str
) -> float | None:
    for item in observations:
        if (
            item["country"] == country
            and str(item.get("industry") or "") == industry
            and int(item["year"]) == year
            and item["metric"] == metric
        ):
            return float(item["value"])
    return None


def _share_of_total(
    observations: list[dict[str, Any]], step: int, country: str, industry: str, year: int, metric: str
) -> float | None:
    total = _find_value(observations, country, industry, year, _COMPOSITION_TOTAL_METRICS[step])
    part = _find_value(observations, country, industry, year, metric)
    if total is None or part is None or total <= 0:
        return None
    return part / total * 100


def _composition_share_bar(
    data: dict[str, Any], step: int, observations: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Single-year composition as the page shows it: each part as a share of the total, per country."""
    countries = [str(item) for item in _list_values(data.get("compared"))]
    industry = str(observations[0].get("industry") or "")
    year = int(observations[0]["year"])
    items = []
    for metric in _COMPOSITION_COMPONENT_METRICS.get(step, ()):
        for country in countries:
            share = _share_of_total(observations, step, country, industry, year, metric)
            if share is None:
                return None
            items.append(
                {"label": _STUDENT_METRIC_LABELS.get(metric, metric), "group": country_label(country), "value": share}
            )
    scope = f"{year} 年 · " + (f"{sector_label(industry)} · " if industry else "")
    total = _COMPOSITION_TOTAL_SHORT[step]
    return {
        "version": 1,
        "type": "bar",
        "title": f"步骤 {step} · {_STEP_TITLES[step]}：{scope}{total}构成（各项占比）",
        "y_label": f"占{total}的百分比（%）",
        "items": items,
    }


def _composition_share_lines(
    data: dict[str, Any], step: int, observations: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Composition over the years as shares of the total, like the page; one chart per part so small parts
    are not flattened by the largest one, with both countries on the same scale."""
    countries = [str(item) for item in _list_values(data.get("compared"))]
    industry = next((str(item.get("industry") or "") for item in observations), "")
    years = sorted({int(item["year"]) for item in observations})
    total = _COMPOSITION_TOTAL_SHORT[step]
    scope = f"{sector_label(industry)} · " if industry else ""
    charts = []
    for metric in _COMPOSITION_COMPONENT_METRICS.get(step, ()):
        series = []
        for country in countries:
            points = [
                {"label": str(year), "value": share}
                for year in years
                if (share := _share_of_total(observations, step, country, industry, year, metric)) is not None
            ]
            if not points:
                return []
            series.append({"label": country_label(country), "points": points})
        part = _STUDENT_METRIC_LABELS.get(metric, metric)
        charts.append(
            {
                "version": 1,
                "type": "line",
                "title": f"步骤 {step} · {_STEP_TITLES[step]}：构成演变 · {scope}{part}占{total}比重两国历年趋势",
                "x_label": "年份",
                "y_label": f"占{total}的百分比（%）",
                "series": series,
            }
        )
    return charts


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
            context += f"{sector_label(industries[0])} · "
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
                series.append({"label": country_label(country), "points": points})
        return {
            "version": 1,
            "type": "line",
            "title": f"{title}：{context}{_STUDENT_METRIC_LABELS.get(metric, metric)}两国历年趋势",
            "x_label": "年份",
            "y_label": y_label,
            "series": series,
        }
    if source == "explicit-indicator-composition":
        shares = _composition_share_bar(data, step, observations)
        if shares is not None:
            return shares
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
    selected_years = sorted({int(item["year"]) for item in selected})
    selected_industries = sorted({str(item.get("industry") or "") for item in selected} - {""})
    by_industry = len(selected_industries) > 1

    def item_for(item: dict[str, Any]) -> dict[str, Any]:
        parts = [
            sector_label(str(item.get("industry") or "")) if by_industry else "",
            "" if single_metric else _STUDENT_METRIC_LABELS.get(str(item["metric"]), str(item["metric"])),
        ]
        label = " · ".join(part for part in parts if part)
        # Bars of one country share a colour; with nothing else to name, the bar is the country itself.
        if not label:
            return {"label": country_label(str(item["country"])), "value": _chart_value(item)}
        return {"label": label, "group": country_label(str(item["country"])), "value": _chart_value(item)}

    items = [item_for(item) for item in selected]
    # Name the single year / industry the bars come from; otherwise the comparison has no stated scope.
    scope = f"{selected_years[0]} 年 · " if len(selected_years) == 1 else ""
    if len(selected_industries) == 1:
        scope += f"{sector_label(selected_industries[0])} · "
    metric_label = _STUDENT_METRIC_LABELS.get(available_metrics[0], available_metrics[0])
    # Bars spanning several industries are the "定位行业" ranking, ordered by country A (steps 6–9).
    if (source == "explicit-network-ranking" or by_industry) and single_metric and countries:
        name = f"{scope}{metric_label}行业排名（按 {country_label(countries[0])} 降序）"
    elif single_metric:
        name = f"{scope}{metric_label}同口径国家比较"
    else:
        name = f"{scope}同口径国家比较"
    return {"version": 1, "type": "bar", "title": f"{title}：{name}", "y_label": y_label, "items": items}


def _observed_charts(data: dict[str, Any], step: int, observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep every saved trend metric; composition over the years is shown as shares, like the page."""
    selection = data.get("indicator_selection")
    is_evolution = isinstance(selection, dict) and selection.get("view") == "evolution"
    source = str(observations[0]["source"])
    components = _COMPOSITION_COMPONENT_METRICS.get(step)
    if source not in {"explicit-indicator-trend", "explicit-network-trend"}:
        return [_observed_chart(data, step, observations)]
    if is_evolution and components:
        shares = _composition_share_lines(data, step, observations)
        if shares:
            return shares
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
            if view == "evolution":
                lines.extend(
                    ("> 构成演变按分项拆成多张两国趋势图，纵轴是该项占总量的比重；金额读数见“保存的实验快照”。", "")
                )
            else:
                context = "前后向指标" if view == "directions" else "已保存指标"
                lines.extend((f"> {context}按指标拆成多张两国同口径趋势图，保留每项读数与变化。", ""))
        for chart in charts:
            unit = _chart_unit(chart)
            display_chart = chart
            if chart["type"] == "bar" and len(chart["items"]) > _BAR_DISPLAY_LIMIT:
                display_chart = {**chart, "items": chart["items"][:_BAR_DISPLAY_LIMIT]}
                lines.extend(
                    (
                        f"> 主图按保存顺序展示前 {_BAR_DISPLAY_LIMIT} / {len(chart['items'])} 条读数；"
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
                        f"{series['label']} 从 {first['label']} 年 {_reading(first['value'], unit)} 变为 "
                        f"{last['label']} 年 {_reading(last['value'], unit)}（{_change(last['value'] - first['value'], unit)}）"
                    )
                lines.append(f"- 自动读图：{'；'.join(changes)}。这是描述性变化，不自动构成政策效应。")
            else:
                largest = max(chart["items"], key=lambda item: item["value"])
                smallest = min(chart["items"], key=lambda item: item["value"])
                largest_labels = "、".join(
                    _item_label(item) for item in chart["items"] if item["value"] == largest["value"]
                )
                smallest_labels = "、".join(
                    _item_label(item) for item in chart["items"] if item["value"] == smallest["value"]
                )
                scope = (
                    "保存的构成项中" if observations[0]["source"] == "explicit-indicator-composition" else "保存范围内"
                )
                lines.append(
                    f"- 自动读图：{scope}最高为 {largest_labels}（{_reading(largest['value'], unit)}），"
                    f"最低为 {smallest_labels}（{_reading(smallest['value'], unit)}）。这是同口径描述性比较。"
                )
            lines.append("")
    return lines


__all__ = [n for n in globals() if not n.startswith("__")]
