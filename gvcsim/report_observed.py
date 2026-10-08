from __future__ import annotations

import json
import re
from typing import Any, Callable, cast

from gvcsim import quizzes
from gvcsim.report_common import (
    GATE_STEPS,
    _COMPOSITION_TOTAL_SHORT,
    composition_set,
    _STEP_TITLES,
    _STUDENT_METRIC_LABELS,
    _list_values,
    _safe,
    _signed,
    reading_digits,
    reading_number,
)
from gvcsim.report_gate import (
    _indicator_material_complete,
    _network_material_complete,
    _step_data,
    _valid_indicator_observations,
)
from gvcsim.report_labels import country_label, sector_label
from gvcsim.report_reference import country_reference, industry_reference
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
        "> 以下三段由学生本人撰写；文中引用的数字可在后文的实验记录与回归结果中核对。",
        "",
        "### 我的研究问题",
        "",
        _reflection_value(reflection.get("research_question")),
        "",
        "### 我的结果解释",
        "",
        _reflection_value(reflection.get("evidence_interpretation")),
        "",
        "### 我的局限与反思",
        "",
        _reflection_value(reflection.get("limitations")),
        "",
    ]


def _quiz_sections(session: dict[str, Any]) -> list[str]:
    lines = ["## 理解题答题记录", ""]
    for step in GATE_STEPS:
        selected = quizzes.selected_answers(step, _step_data(session, step).get("quiz"))
        lines.extend((f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}", ""))
        for item in selected:
            question = _safe(item["question"])
            # Questions end with "？"; a colon after it printed "？：".
            joiner = " " if question.endswith(("？", "?")) else "："
            lines.append(f"- {question}{joiner}{_safe(item['answer'])}")
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


def _chart_value(observation: dict[str, Any]) -> float:
    value = float(observation["value"])
    return value * 100 if observation.get("unit") == "%" else value


def _chart_unit(chart: dict[str, Any]) -> str:
    """The reading unit of a chart; percentage charts all end their axis label with “（%）”."""
    y_label = str(chart.get("y_label") or "")
    return "%" if y_label.endswith("（%）") else y_label


def _reading(value: float, unit: str) -> str:
    """A chart reading in the page's fixed precision: whole millions for amounts, three decimals otherwise."""
    return f"{reading_number(value, unit)}%" if unit == "%" else reading_number(value, unit)


def _change(delta: float, unit: str) -> str:
    """A change in the chart's own unit: percentage points for shares, grouped amounts in 百万美元."""
    # Same precision as the page's reading cards: whole millions for amounts, three decimals otherwise.
    if unit == "%":
        return f"{_signed(delta, 3)} 个百分点"
    if unit == "百万美元":
        return f"{_signed(delta, 0 if abs(delta) >= 1 else 3)} 百万美元"
    return _signed(delta, reading_digits(delta, unit) if delta else 3)


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
    observations: list[dict[str, Any]], total_metric: str, country: str, industry: str, year: int, metric: str
) -> float | None:
    total = _find_value(observations, country, industry, year, total_metric)
    part = _find_value(observations, country, industry, year, metric)
    if total is None or part is None or total <= 0:
        return None
    return part / total * 100


def _composition_share_bar(
    data: dict[str, Any], step: int, observations: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Single-year composition as the page shows it: each part as a share of the total, per country."""
    countries = [str(item) for item in _list_values(data.get("compared"))]
    chosen = composition_set(step, (str(item["metric"]) for item in observations))
    if chosen is None:
        return None
    components, total_metric = chosen
    industry = str(observations[0].get("industry") or "")
    year = int(observations[0]["year"])
    items = []
    for metric in components:
        for country in countries:
            share = _share_of_total(observations, total_metric, country, industry, year, metric)
            if share is None:
                return None
            items.append(
                {"label": _STUDENT_METRIC_LABELS.get(metric, metric), "group": country_label(country), "value": share}
            )
        # Country-level composition also shows each part's global median share, as a third bar.
        reference = country_reference(metric, year, share_of=(metric, total_metric)) if not industry else None
        if reference is not None:
            items.append(
                {
                    "label": _STUDENT_METRIC_LABELS.get(metric, metric),
                    "group": f"全球中位数（{reference['n']} 个经济体）",
                    "value": reference["median"] * 100,
                    "reference": True,
                }
            )
    scope = f"{year} 年 · " + (f"{sector_label(industry)} · " if industry else "")
    total = _COMPOSITION_TOTAL_SHORT.get(total_metric, total_metric)
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
    chosen = composition_set(step, (str(item["metric"]) for item in observations))
    if chosen is None:
        return []
    components, total_metric = chosen
    industry = next((str(item.get("industry") or "") for item in observations), "")
    years = sorted({int(item["year"]) for item in observations})
    total = _COMPOSITION_TOTAL_SHORT.get(total_metric, total_metric)
    scope = f"{sector_label(industry)} · " if industry else ""
    charts = []
    for metric in components:
        series = []
        for country in countries:
            points = [
                {"label": str(year), "value": share}
                for year in years
                if (share := _share_of_total(observations, total_metric, country, industry, year, metric)) is not None
            ]
            if not points:
                return []
            series.append({"label": country_label(country), "points": points})
        part = _STUDENT_METRIC_LABELS.get(metric, metric)
        chart: dict[str, Any] = {
            "version": 1,
            "type": "line",
            "title": f"步骤 {step} · {_STEP_TITLES[step]}：构成演变 · {scope}{part}占{total}比重历年趋势",
            "x_label": "年份",
            "y_label": f"占{total}的百分比（%）",
            "series": series,
        }
        # Country-level parts also show the global median share, as the trend charts do.
        references = (
            {year: country_reference(metric, year, share_of=(metric, total_metric)) for year in years}
            if not industry
            else {}
        )
        if references and all(reference is not None for reference in references.values()):
            last = cast(dict[str, Any], references[years[-1]])
            chart["title"] += "（含全球中位数）"
            chart["series"] = [
                *series,
                {
                    "label": f"全球中位数（{last['n']} 个经济体）",
                    "points": [
                        {"label": str(year), "value": cast(dict[str, Any], references[year])["median"] * 100}
                        for year in years
                    ],
                    "reference": True,
                },
            ]
            chart["_context"] = {
                "references": {str(year): cast(dict[str, Any], reference) for year, reference in references.items()}
            }
        charts.append(chart)
    return charts


def _industry_lookup(industry: str, countries: list[str]) -> Callable[[str, int], dict[str, Any] | None]:
    """Step 9: the same industry in every economy, with the saved countries' ranks."""

    def lookup(metric: str, year: int) -> dict[str, Any] | None:
        rows = industry_reference(metric, year, industry=industry, countries=tuple(countries))
        return rows[0] if rows else None

    return lookup


def _trend_reference(
    metric: str,
    series: list[dict[str, Any]],
    unit: str,
    lookup: Callable[[str, int], dict[str, Any] | None] = country_reference,
    scope: str = "",
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]] | None:
    """Global median per saved year, or None when any year lacks a reference."""
    years = sorted({int(point["label"]) for item in series for point in item["points"]})
    references = {year: lookup(metric, year) for year in years}
    if not years or any(reference is None for reference in references.values()):
        return None
    scale = 100 if unit == "%" else 1
    last = cast(dict[str, Any], references[years[-1]])
    median_series = {
        "label": f"全球中位数（{scope}{last['n']} 个经济体）",
        "points": [
            {"label": str(year), "value": cast(dict[str, Any], references[year])["median"] * scale} for year in years
        ],
        "reference": True,
    }
    return median_series, {str(year): cast(dict[str, Any], reference) for year, reference in references.items()}


def _with_industry_medians(
    items: list[dict[str, Any]], selected: list[dict[str, Any]], metric: str, year: int, unit: str
) -> list[dict[str, Any]]:
    """Step 9 ranking: after each industry's bars, that industry's median across all economies."""
    medians = {row["industry"]: row for row in industry_reference(metric, year)}
    scale = 100 if unit == "%" else 1
    result: list[dict[str, Any]] = []
    for index, (item, source) in enumerate(zip(items, selected)):
        result.append(item)
        industry = str(source.get("industry") or "")
        following = selected[index + 1] if index + 1 < len(selected) else None
        if industry in medians and (following is None or str(following.get("industry") or "") != industry):
            reference = medians[industry]
            result.append(
                {
                    "label": item["label"],
                    "group": f"全球中位数（同行业，{reference['n']} 个经济体）",
                    "value": reference["median"] * scale,
                    "reference": True,
                }
            )
    return result


def _is_reference_item(item: dict[str, Any]) -> bool:
    """Global-median bars are a reference for the saved readings, not readings themselves."""
    return item.get("reference") is True


def _rank_reading(context: dict[str, Any], countries: list[str]) -> str:
    """“CHN 中国在 76 个经济体中从第 55 位变为第 54 位” for the saved years, highest first."""
    references = context["references"]
    years = sorted(references, key=int)
    first, last = references[years[0]], references[years[-1]]

    unranked = False

    def rank(reference: dict[str, Any], country: str) -> str:
        nonlocal unranked
        tie = reference.get("ties", {}).get(country, 1)
        # Same wording as the page (rankText): a year in which every economy has the same reading has no rank.
        if tie >= reference["n"]:
            unranked = True
            return "不分名次"
        return f"{'并列' if tie > 1 else ''}第 {reference['ranks'][country]} 位"

    # When every economy has the same reading (e.g. an industry with no flows anywhere), a rank says nothing.
    if all(reference.get("ties") and min(reference["ties"].values()) >= reference["n"] for reference in (first, last)):
        return f"全部 {last['n']} 个经济体{context.get('scope', '')}数值相同，排名不作比较"
    parts = []
    for country in countries:
        if country not in first["ranks"] or country not in last["ranks"]:
            continue
        first_rank, last_rank = rank(first, country), rank(last, country)
        parts.append(
            f"{country_label(country)}{last_rank}"
            if years[0] == years[-1]
            else f"{country_label(country)} {years[0]} 年与 {years[-1]} 年均为{last_rank}"
            if first_rank == last_rank
            else f"{country_label(country)}从{first_rank}变为{last_rank}"
        )
    if not parts:
        return ""
    note = "（不分名次：该年全部经济体数值相同）" if unranked else ""
    return f"在 {last['n']} 个经济体{context.get('scope', '')}中（从高到低），{'；'.join(parts)}{note}"


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
        metric_label = _STUDENT_METRIC_LABELS.get(metric, metric)
        # Country-level trends in steps 6–8 also show where the saved countries sit among all economies.
        if source == "explicit-indicator-trend" and not industries and series and countries:
            reference = _trend_reference(metric, series, unit)
            rank_scope = ""
        elif source == "explicit-network-trend" and len(industries) == 1 and series and countries:
            # Step 9: the saved industry against the same industry in every economy.
            reference = _trend_reference(
                metric, series, unit, _industry_lookup(industries[0], countries), scope="同行业，"
            )
            rank_scope = "的同一行业"
        else:
            reference = None
            rank_scope = ""
        if reference is None:
            return {
                "version": 1,
                "type": "line",
                "title": f"{title}：{context}{metric_label}历年趋势",
                "x_label": "年份",
                "y_label": y_label,
                "series": series,
            }
        median_series, references = reference
        return {
            "version": 1,
            "type": "line",
            "title": f"{title}：{context}{metric_label}历年趋势（含全球中位数）",
            "x_label": "年份",
            "y_label": y_label,
            "series": [*series, median_series],
            "_context": {"references": references, "scope": rank_scope},
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
        chosen = composition_set(step, available_metrics)
        identities = [(industry, year, metric) for metric in (chosen[0] if chosen else ())]
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
    if source == "explicit-network-ranking" and by_industry and single_metric and len(selected_years) == 1:
        items = _with_industry_medians(items, selected, available_metrics[0], selected_years[0], unit)
    # A same-year, country-level comparison also places the two countries among all economies.
    same_year_reference = (
        country_reference(available_metrics[0], selected_years[0])
        if source == "explicit-indicator-comparison"
        and single_metric
        and not selected_industries
        and len(selected_years) == 1
        else None
    )
    # Name the single year / industry the bars come from; otherwise the comparison has no stated scope.
    scope = f"{selected_years[0]} 年 · " if len(selected_years) == 1 else ""
    if len(selected_industries) == 1:
        scope += f"{sector_label(selected_industries[0])} · "
    metric_label = _STUDENT_METRIC_LABELS.get(available_metrics[0], available_metrics[0])
    if same_year_reference is not None:
        scale = 100 if unit == "%" else 1
        items.append(
            {
                "label": f"全球中位数（{same_year_reference['n']} 个经济体）",
                "value": same_year_reference["median"] * scale,
                "reference": True,
            }
        )
        return {
            "version": 1,
            "type": "bar",
            "title": f"{title}：{scope}{metric_label}：所选国家与全球中位数",
            "y_label": y_label,
            "items": items,
            "_context": {"references": {str(selected_years[0]): same_year_reference}},
        }
    # Bars spanning several industries are the "行业排名" view, ordered by country A (steps 6–9).
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
    chosen = composition_set(step, {str(item["metric"]) for item in observations})
    components = chosen[0] if chosen else None
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
        "> 图表使用步骤 6–9 保存的同口径读数；国家整体的图表另画出全部经济体的中位数，步骤 9 的行业图表另画出全部经济体同一行业的中位数，用于定位。完整数值见“保存的实验快照”。",
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
                    ("> 构成演变按分项拆成多张趋势图，纵轴是该项占总量的比重；金额读数见“保存的实验快照”。", "")
                )
            else:
                scope = "前后向指标" if view == "directions" else "已保存指标"
                lines.extend((f"> {scope}按指标拆成多张同口径趋势图，保留每项读数与变化。", ""))
        countries_saved = [str(item) for item in _list_values(data.get("compared"))]
        for chart in charts:
            unit = _chart_unit(chart)
            context = chart.get("_context")
            chart = {key: value for key, value in chart.items() if not key.startswith("_")}
            display_chart = chart
            if chart["type"] == "bar" and len(chart["items"]) > _BAR_DISPLAY_LIMIT:
                # Cut at a group boundary so an industry never loses one of its bars, and count only the
                # saved readings (global-median bars are reference, not readings).
                cut = _BAR_DISPLAY_LIMIT
                while (
                    0 < cut < len(chart["items"]) and chart["items"][cut]["label"] == chart["items"][cut - 1]["label"]
                ):
                    cut -= 1
                shown = chart["items"][: cut or _BAR_DISPLAY_LIMIT]
                display_chart = {**chart, "items": shown}
                saved_total = sum(1 for item in chart["items"] if not _is_reference_item(item))
                saved_shown = sum(1 for item in shown if not _is_reference_item(item))
                lines.extend(
                    (
                        f"> 主图按保存顺序展示前 {saved_shown} / {saved_total} 条读数；"
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
                        f"{series['label']}{'' if str(series['label']).endswith('）') else ' '}从 {first['label']} 年 {_reading(first['value'], unit)} 变为 "
                        f"{last['label']} 年 {_reading(last['value'], unit)}（{_change(last['value'] - first['value'], unit)}）"
                    )
                ranks = _rank_reading(context, countries_saved) if context else ""
                lines.append(
                    f"- 自动读图：{'；'.join(changes)}。{ranks + '。' if ranks else ''}变化按未取整的原值计算，可能与两端读数之差相差末位 1。这是描述性变化，不自动构成政策效应。"
                )
            elif context:
                year = next(iter(context["references"]))
                median = context["references"][year]["median"] * (100 if unit == "%" else 1)
                readings = "、".join(
                    f"{item['label']} {_reading(item['value'], unit)}"
                    for item in chart["items"]
                    if not str(item["label"]).startswith("全球中位数")
                )
                ranks = _rank_reading(context, countries_saved)
                lines.append(
                    f"- 自动读图：{year} 年 {readings}；全球中位数 {_reading(median, unit)}。"
                    f"{ranks + '。' if ranks else ''}排名只表示相对高低，这是同口径描述性比较。"
                )
            else:
                # Extremes are read among the saved countries; global-median bars are reference only.
                saved_items = [item for item in chart["items"] if not _is_reference_item(item)]
                largest = max(saved_items, key=lambda item: item["value"])
                smallest = min(saved_items, key=lambda item: item["value"])
                largest_labels = "、".join(
                    _item_label(item) for item in saved_items if item["value"] == largest["value"]
                )
                smallest_labels = "、".join(
                    _item_label(item) for item in saved_items if item["value"] == smallest["value"]
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
