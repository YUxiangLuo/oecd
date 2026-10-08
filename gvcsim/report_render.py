from __future__ import annotations

import json
import re
from typing import Any, cast

from gvcsim.regression.estimation import two_way_note
from gvcsim.regression.validity import CLUSTER_INTERVAL_NOTE
from gvcsim.report_common import (
    _KIND_DIMENSIONS,
    _SHOCK_SOURCE_STATUS_LABELS,
    _STATUS_LABELS,
    _STEP_OUTCOMES,
    _STEP_TITLES,
    _STUDENT_METRIC_LABELS,
    _coefficient_label,
    _count,
    _effective_status,
    _evidence_reading,
    _depvar_kind,
    _global_inference_suppressed,
    _is_default_baseline,
    _list_values,
    _natural_effect,
    _number,
    _observation_reading,
    _primary_coefficient,
    _safe,
    _setting_value,
    _summary_design_limit,
    reading_number,
)
from gvcsim.report_gate import _indicator_material_complete, _step_data, _valid_indicator_observations
from gvcsim.report_labels import DB_TABLE_NAMES, FINAL_DEMAND_NAMES, country_label, sector_label
from gvcsim.report_observed import _viewed_shock_event_sources
from gvcsim.report_saved_run import _result_is_reportable, _result_is_qualified


def _entity_label(item: dict[str, Any]) -> str:
    """An observation's economy (and industry) by name, as on the pages: "CHN 中国 · C29 汽车及零部件"."""
    country = item.get("country")
    if not country:
        return str(item.get("entity", "—"))
    industry = item.get("industry")
    return f"{country_label(str(country))} · {sector_label(str(industry))}" if industry else country_label(str(country))


def _rate(percent: float) -> str:
    """A tariff rate as set (10%, 7.5%), without padding zeros."""
    return f"{percent:.2f}".rstrip("0").rstrip(".")


def _experiment_sections(session: dict[str, Any]) -> list[str]:
    """Render only snapshots produced by explicit student interactions."""
    lines = [
        "## 保存的实验快照",
        "",
        "本节列出各步记录的材料：多数由系统按学生实际查看的页面自动记录，学生另选或运行的结果以学生操作为准；系统默认的项目已注明。",
        "",
    ]
    captured = False

    # Only recorded material is printed. The browsed slice (`slice`) and the other view-only keys are
    # excluded from the report fingerprint, so reading them here would let a report drift from its
    # records without ever showing "需更新"; the recorded cell carries the slice it was captured from.
    db = _step_data(session, 1)
    raw_observation = db.get("observation")
    observation: dict[str, Any] | None = raw_observation if isinstance(raw_observation, dict) else None
    source_slice = (
        observation
        if observation is not None
        and observation.get("year") not in (None, "")
        and observation.get("table") not in (None, "")
        else None
    )
    if observation:
        captured = True
        lines.extend(("### 步骤 1 · OECD ICIO 数据浏览", ""))
        if source_slice:

            def slice_value(key: str, value: Any) -> str:
                text = str(value)
                if key == "table":
                    return DB_TABLE_NAMES.get(text, text)
                if key in ("row_country", "col_country"):
                    return country_label(text)
                if key == "col_sector" and text in FINAL_DEMAND_NAMES:
                    return FINAL_DEMAND_NAMES[text]
                if key in ("row_sector", "col_sector"):
                    return sector_label(text)
                return text

            selection = "；".join(
                f"{label}：{_safe(slice_value(key, source_slice[key]))}"
                for key, label in (
                    ("year", "年份"),
                    ("table", "表"),
                    ("row_country", "供给国"),
                    ("row_sector", "供给行业"),
                    ("col_country", "使用／需求国"),
                    ("col_sector", "使用行业／最终需求"),
                )
                if source_slice.get(key) not in (None, "")
            )
            lines.append(f"- 保存的切片：{selection or '—'}")
        if observation:
            label = "记录的单元格（系统默认记录，学生未另选）" if observation.get("auto") is True else "记录的单元格"
            lines.append(f"- {label}：{_observation_reading(observation)}")
        lines.append("")

    for step in range(2, 10):
        data = _step_data(session, step)
        compared = _list_values(data.get("compared"))
        observations = [item for item in _list_values(data.get("observations")) if isinstance(item, dict)]
        if step in (6, 7, 8):
            observations = _valid_indicator_observations(data)
            if not _indicator_material_complete(data, step):
                continue
        elif step == 9:
            observations = [
                item
                for item in observations
                if item.get("source") in {"explicit-network-trend", "explicit-network-ranking"}
            ]
            if not observations:
                continue
        # A section needs recorded material; browsing state alone (year/country/chart/drill) is not printed.
        if not (compared or observations):
            continue
        captured = True
        lines.extend((f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}", ""))
        # Set when the student recorded this material explicitly after submitting the report.
        chosen = data.get("material_chosen") is True
        if compared:
            automatic = bool(observations) and all(
                item.get("source") == "auto-indicator-comparison" for item in observations
            )
            # One saved economy is read against the global reference; two or more are a comparison.
            # Steps 2-5 record the viewed country with a comparison country defaulting to USA (CHN for USA);
            # a partner the student changed is their choice even though the page recorded it automatically.
            default_partner = "CHN" if compared and compared[0] == "USA" else "USA"
            partner_changed = automatic and len(compared) == 2 and compared[1] != default_partner
            if len(compared) == 1:
                compared_label = "学生选定的国家" if chosen else "系统自动记录的国家" if automatic else "所看国家"
            elif chosen:
                compared_label = "学生选定的比较"
            elif partner_changed:
                compared_label = "学生选定的比较（页面自动记录）"
            else:
                compared_label = "系统自动记录的比较（默认对比国家）" if automatic else "比较对象"
            lines.append(f"- {compared_label}：{'、'.join(_safe(country_label(str(item))) for item in compared)}")
        if observations:
            has_amounts = any(item.get("unit") == "百万美元" for item in observations)
            if step in (6, 7, 8, 9) and any(item.get("year") == 2020 for item in observations):
                price_note = (
                    "金额按当年价格计，变化可能包含价格因素。"
                    if has_amounts
                    else "本节为份额、长度或指数，不直接受价格水平影响，但仍受下述结构外推影响。"
                )
                lines.append(
                    f"- **2020 年：现价与疫情期外推限制。** {price_note}"
                    "OECD 2023 版中部分国家的投入产出结构由此前基准表外推，疫情对行业的冲击并不均匀；"
                    "请区分价格、统计编制与实际数量或结构变化，不能仅凭该年转折判断生产调整。"
                    "参见 [OECD TiVA 2023 指南第 42 页]"
                    "(https://www.oecd.org/content/dam/oecd/en/topics/policy-sub-issues/trade-in-value-added/tiva-indicators-guide-2023.pdf#page=42)。"
                )
            # Steps 2-5 carry one step-level metric; step 9 records the metric on
            # each observation, so fall back to it instead of printing “—”.
            metric_label = data.get("metric") or next(
                (item.get("metric") for item in observations if item.get("metric")), None
            )
            if step == 9 and observations[0].get("source") in {"explicit-network-trend", "explicit-network-ranking"}:
                view_label = (
                    "历年趋势"
                    if observations[0]["source"] == "explicit-network-trend"
                    else "行业排名（按国家 A 降序，记录展示范围）"
                )
                lines.append(f"- 记录方式：{view_label}；单位：{_safe(observations[0].get('unit', '未记录'))}")
                lines.append(
                    "- 行业指标来自完整国家×行业中间品网络，不对应国家贸易概览的位置；加权流量为当年价格，拓扑指标不等同经济重要性。"
                )
            if step in (6, 7, 8):
                lines.append(
                    "- 记录的图表材料（学生选定的完整图表；指标与单位逐行列示）："
                    if chosen
                    else "- 记录的图表材料（系统按学生最后查看的完整图表自动记录；指标与单位逐行列示）："
                )
                lines.append(
                    f"- 数据版本：{_safe(observations[0]['release'])}。"
                    + ("金额为当年价格；" if has_amounts else "")
                    + "份额以百分数列示，变化按百分点解释。"
                )
            else:
                lines.append(
                    f"- 记录的代表指标：{_STUDENT_METRIC_LABELS.get(str(metric_label), _safe(metric_label or '—'))}"
                )
                if step in (2, 3, 4) and automatic:
                    lines.append("- 数值为国家级代表指标：页面可按国家–行业浏览，报告材料统一按国家级记录。")
                if step == 5 and metric_label == "weighted degree":
                    lines.append(
                        "- 国家级加权总度只含国家之间的贸易（不含国内流量），不能与含国内流量的行业级数值直接比较。"
                    )
            lines.extend(("", "| 实体 | 年份 | 指标 | 单位 | 数值 |", "|---|---:|---|---|---:|"))
            for item in observations:
                observation_value = item.get("value", "—")
                if item.get("unit") == "%" and isinstance(observation_value, (int, float)):
                    observation_value *= 100
                lines.append(
                    f"| {_safe(_entity_label(item))} | "
                    f"{_safe(item.get('year', '—'))} | "
                    f"{_STUDENT_METRIC_LABELS.get(str(item.get('metric')), _safe(item.get('metric', '—')))} | "
                    f"{_safe(item.get('unit', '—'))} | "
                    f"{reading_number(float(observation_value), str(item.get('unit') or '')) if isinstance(observation_value, (int, float)) and not isinstance(observation_value, bool) else _safe(observation_value)} |"
                )
        elif compared:
            lines.append("- 本步仅保存比较对象，未记录代表指标数值。")
        lines.append("")

    shock = _step_data(session, 10)
    if shock.get("viewed_teaching_panel"):
        captured = True
        lines.extend(
            (
                "### 步骤 10 · 关税数据",
                "",
                (
                    f"- 两国趋势示例：{'、'.join(_safe(country_label(str(value))) for value in shock.get('compared', []))} · "
                    f"{_safe(sector_label(str(shock.get('teaching_industry'))))} · 全部可用年份"
                    if isinstance(shock.get("compared"), list) and len(shock["compared"]) == 2
                    else f"- 查看对象：{_safe(country_label(str(shock.get('teaching_country'))))}"
                    + (
                        f" · {_safe(sector_label(str(shock.get('teaching_industry'))))}"
                        if shock.get("teaching_industry")
                        else ""
                    )
                    + f" · {_safe(shock.get('teaching_year'))}"
                ),
                f"- 数据版本：{_safe(shock.get('teaching_panel_version'))}",
                "- X = 首年销往美国的出口份额 × 税率。",
            )
        )
        teaching_observation = shock.get("teaching_observation")
        if isinstance(teaching_observation, dict):
            lines.extend(
                (
                    f"- 自动保存的代表行：{_safe(country_label(str(teaching_observation.get('country'))))} · "
                    f"{_safe(sector_label(str(teaching_observation.get('industry'))))} · {_safe(teaching_observation.get('year'))}",
                    # X is read in percentage points throughout steps 10–14, so print it the same way here.
                    # Same precision as step 10's table: w and X to two decimals, the tariff rate as set.
                    f"- w={float(teaching_observation['teaching_export_share_w']) * 100:.2f}%；"
                    f"τ={_rate(float(teaching_observation['teaching_tariff_rate_tau']) * 100)}%；"
                    f"X=w×τ={float(teaching_observation['teaching_tariff_exposure']) * 100:.2f} 个百分点",
                )
            )
        lines.append("")
    viewed_types = _list_values(shock.get("viewed_shock_types"))
    viewed_events = _list_values(shock.get("viewed_events"))
    selected_event = shock.get("selected_event_key")
    event_sources = _viewed_shock_event_sources(session)
    if viewed_types or viewed_events or selected_event:
        captured = True
        lines.extend(("### 步骤 10 · 贸易政策冲击数据接入", ""))
        if viewed_types:
            lines.append(f"- 查看过的冲击类型：{'、'.join(_safe(item) for item in viewed_types)}")
        if viewed_events:
            lines.append(f"- 查看过的政策事件：{'、'.join(_safe(item) for item in viewed_events)}")
        if selected_event:
            lines.append(f"- 最后选择的事件：{_safe(selected_event)}（仅用于探索定位，不限定下游回归样本）")
        if event_sources:
            lines.extend(("- 已查看事件的来源状态：", ""))
            for event in event_sources:
                status = _SHOCK_SOURCE_STATUS_LABELS.get(str(event.get("source_status")), "当前目录无法确认来源状态")
                urls = [str(url) for url in _list_values(event.get("source_urls")) if isinstance(url, str)]
                source_links = "、".join(f"[来源 {index + 1}]({url})" for index, url in enumerate(urls))
                lines.append(
                    f"  - {_safe(event.get('name', '—'))}：{status}{f'；{source_links}' if source_links else ''}"
                )
                lines.append(f"    - 映射边界：{_safe(event.get('source_disclosure', '—'))}")
        lines.extend(
            (
                "- 下游回归口径：按所选冲击类型汇总该类型全部已编码事件的国家×行业暴露，不把单个事件选择当作回归筛选。",
                "- 处理组语义：treated 表示本面板所编码政策增量的强度严格大于零；首次正暴露定义 G_i。它不是政策机关发布的权威处理标记。低强度仍是暴露，不能把面板中为零理解为现实中不受任何其他政策或外溢影响。",
                "",
            )
        )

    if not captured:
        lines.extend(("- 未保存额外实验快照。", ""))
    return lines


def _reported_by_step(runs: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    chosen: dict[int, dict[str, Any]] = {}
    for run in runs:
        if _result_is_reportable(run["result"], run["design"]) and run["step"] not in chosen:
            chosen[run["step"]] = run
    return chosen


def _comparison_table(runs: list[dict[str, Any]]) -> list[str]:
    qualified = _reported_by_step(runs)
    lines = [
        "### 四项回归结果汇总",
        "",
        "这四步分别估计贸易流、生产、长度和网络；四项结果必须完整报告，不能只挑区间未跨 0 的结果。"
        "下表列出各步实际保存的可报告结果；系数因量纲和估计对象不同不能比大小，"
        "网络 Y 的单位与份额、长度不同，不能与前三步的系数比大小。",
        "",
        "| 步骤 | 指标 | 冲击 | 比较方式 | 估计对象与相对变化 | 标称 95% 近似区间 | 证据判断 |",
        "|---|---|---|---|---|---|---|",
    ]
    designs = []
    for step, outcome in sorted(_STEP_OUTCOMES.items()):
        run = qualified.get(step)
        if run is None:
            lines.append(f"| {step} | {_safe(_STEP_TITLES.get(step, outcome))} | — | — | — | — | 未保存可报告估计 |")
            continue
        design, result = run["design"], run["result"]
        designs.append((design.get("shock_type"), design.get("method"), design.get("granularity")))
        coefficient = _primary_coefficient(design, result)
        if coefficient is None or not isinstance(coefficient.get("coef"), (int, float)):
            lines.append(
                f"| {step} | {_safe(design.get('depvar_label', outcome))} | "
                f"{_setting_value('shock_type', design.get('shock_type'))} | "
                f"{_setting_value('method', design.get('method'))} | — | — | 无可估计配对，诊断已记录、不能推断 |"
            )
            continue
        effect_label, effect, interval = _natural_effect(outcome, design, result, coefficient)
        suppressed = _global_inference_suppressed(result)
        evidence, _interpretation = _evidence_reading(outcome, coefficient, suppressed, design)
        lines.append(
            f"| {step} | {_safe(design.get('depvar_label', outcome))} | "
            f"{_setting_value('shock_type', design.get('shock_type'))} | "
            f"{_setting_value('method', design.get('method'))} | {_safe(effect_label)}：{effect} | {interval} | {evidence} |"
        )
    lines.append("")
    if len({item for item in designs}) > 1:
        lines.extend(
            (
                "- 各行设定不同，不能直接比较系数。",
                "",
            )
        )
    return lines


# Same row labels and units as the coefficient plot on the step 11–14 pages.
_COEFFICIENT_ROW_LABELS = {
    "trade": "外国增加值项占比",
    "production": "复杂 GVC 生产份额",
    "length": "前向 GVC 段长度",
    "network": "加权总度",
}
_COEFFICIENT_UNITS = {"trade": "个百分点", "production": "个百分点", "length": "长度单位", "network": "中心性原始单位"}
_KIND_UNITS = {"share": "个百分点", "length": "长度单位", "position": "位置指数单位", "network": "中心性原始单位"}


def _chart_row(outcome: str, design: dict[str, Any]) -> tuple[str, str, float]:
    """Row label, unit and Y level scale of a saved run: the family's fixed Y or its chosen baseline."""
    kind = _depvar_kind(outcome, design)
    y_scale = 100.0 if kind == "share" else 1.0
    if _is_default_baseline(outcome, design):
        return _COEFFICIENT_ROW_LABELS.get(outcome, outcome), _COEFFICIENT_UNITS.get(outcome, "原始单位"), y_scale
    label = design.get("baseline_label")
    return (label if isinstance(label, str) and label else outcome), _KIND_UNITS.get(kind, "原始单位"), y_scale


def _coefficient_chart(
    step: int, outcome: str, coefficient: dict[str, Any], suppressed: bool, design: dict[str, Any] | None = None
) -> list[str]:
    """Estimate per 1-percentage-point increase in X, with its interval, as on the step's own page."""
    label, unit, y_scale = _chart_row(outcome, design or {})
    # Shares: β × 0.01 × 100 percentage points; lengths and centrality: β × 0.01 raw units.
    scale = y_scale / 100

    # Display precision, like the tables; full values stay in the provenance.
    def shown(value: Any) -> float:
        return float(f"{float(value) * scale:.4g}")

    item: dict[str, Any] = {"label": label, "value": shown(coefficient["coef"])}
    ci_low, ci_high = coefficient.get("ci_low"), coefficient.get("ci_high")
    if not suppressed and isinstance(ci_low, (int, float)) and isinstance(ci_high, (int, float)):
        item["ci_low"], item["ci_high"] = shown(ci_low), shown(ci_high)
    chart = {
        "version": 1,
        "type": "coefficient",
        "title": f"步骤 {step} · X 每增加 1 个百分点时 Y 的平均变化",
        "x_label": unit,
        "items": [item],
    }
    return ["```gvcsim-chart", json.dumps(chart, ensure_ascii=False, separators=(",", ":")), "```", ""]


def _binscatter_chart(
    step: int, outcome: str, result: dict[str, Any], design: dict[str, Any] | None = None
) -> list[str]:
    """The binned scatter behind the estimate, in the same display units as the coefficient chart."""
    label, unit, y_scale = _chart_row(outcome, design or {})
    binscatter = result.get("binscatter")
    if not isinstance(binscatter, dict):
        return []
    bins, slope = binscatter.get("bins"), binscatter.get("slope")
    if not isinstance(bins, list) or len(bins) < 2 or not isinstance(slope, (int, float)) or isinstance(slope, bool):
        return []
    points = []
    for item in bins:
        if not isinstance(item, dict):
            return []
        values = [item.get("x"), item.get("y"), item.get("n")]
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in values):
            return []
        x, y, n = (float(value) for value in cast(list[int | float], values))
        points.append({"x": float(f"{x * 100:.4g}"), "y": float(f"{y * y_scale:.4g}"), "n": int(n)})
    chart = {
        "version": 1,
        "type": "binscatter",
        "title": f"步骤 {step} · 回归在量什么：X 越大，Y 平均怎样变",
        "x_label": "关税暴露 X（个百分点，已扣除固定效应）",
        "y_label": f"{label}（{unit}）",
        "points": points,
        # Slope in display units: β per 1 percentage point of X, in the outcome's shown unit.
        "slope": float(f"{float(slope) * y_scale / 100:.4g}"),
    }
    return ["```gvcsim-chart", json.dumps(chart, ensure_ascii=False, separators=(",", ":")), "```", ""]


def _teaching_sample_lines(source_filter: dict[str, Any] | None) -> list[str]:
    if source_filter is None:
        return []
    return [
        "### 教学样本的来源",
        "",
        f"- 首年排除 ROW 后有 {_count(source_filter.get('source_baseline_rows'))} 个候选国家×行业单元；"
        f"生成面板时剔除 {_count(source_filter.get('excluded_source_baseline_rows'))} 个，"
        f"保留 {_count(source_filter.get('published_entities'))} 个供四项回归共同使用。",
        "- 共同规则：首年四类默认指标及销往美国的出口份额均有效；两类份额和出口份额在 0–1 内，长度大于 0，加权总度不小于 0。",
        "- 这些单元构成四项回归共用的样本。下列回归记录数以年度行计，与筛选阶段的单元数区分。",
        "",
    ]


def _evidence_summary(runs: list[dict[str, Any]], source_filter: dict[str, Any] | None = None) -> list[str]:
    lines = [
        "## 关键证据摘要",
        "",
        "本节用课堂上的读数单位说明估计结果；完整方程和诊断见技术附录。",
        "",
        *_teaching_sample_lines(source_filter),
        "区间口径：如提供区间，均为**标称 95% 的近似聚类区间**。" + CLUSTER_INTERVAL_NOTE,
        "",
        *_comparison_table(runs),
    ]
    if not runs:
        lines.extend(("- 未保存可展示的回归结果。", ""))
        return lines
    qualified = _reported_by_step(runs)
    for run in runs:
        step, outcome = run["step"], run["outcome"]
        design, result = run["design"], run["result"]
        support = result.get("support") if isinstance(result.get("support"), dict) else {}
        status = _effective_status(result)
        primary = _primary_coefficient(design, result)
        suppressed = _global_inference_suppressed(result)
        used_in_table = qualified.get(step) is run
        marker = (
            "（汇总表采用此结果）"
            if used_in_table
            else ("（探索结果，未列入汇总表）" if not _result_is_qualified(result, design) else "")
        )
        coefficient = primary
        lines.extend((f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}{marker}", ""))
        if coefficient is None or not isinstance(coefficient.get("coef"), (int, float)):
            lines.extend(
                (
                    "- 当前设定没有可解读的主要政策系数；这是可提交的实验诊断。",
                    *[f"- 诊断：{_safe(reason)}" for reason in _list_values(support.get("reasons"))],
                    "",
                )
            )
            continue
        effect_label, effect, interval = _natural_effect(outcome, design, result, coefficient)
        evidence, interpretation = _evidence_reading(outcome, coefficient, suppressed, design)
        setting = " · ".join(
            _setting_value(key, design.get(key))
            for key in ("shock_type", "method", "granularity", "control_mode", "scenario")
            if design.get(key) not in (None, "")
        )
        lines.extend(_coefficient_chart(step, outcome, coefficient, suppressed, design))
        if not suppressed:
            lines.extend(_binscatter_chart(step, outcome, result, design))
        lines.extend(
            (
                "| 项目 | 结果 |",
                "|---|---|",
                f"| 研究对象 | {_safe(design.get('depvar_label', outcome))} |",
                f"| 保存的模型 | {setting or '—'} |",
                f"| {effect_label} | **{effect}** |",
                f"| 标称 95% 的近似聚类区间 | {interval} |",
                f"| 证据判断 | **{evidence}** |",
                f"| 设计状态 | {_STATUS_LABELS.get(status, _STATUS_LABELS['unknown'])} |",
                "",
                f"- **可以支持的表述**：{interpretation}",
            )
        )
        lines.append(
            f"- 使用的年度记录：{_count(result.get('n_obs'))}；"
            f"国家×行业单元：{_count(result.get('n_entities'))}；国家聚类：{_count(result.get('n_clusters'))}。"
        )
        flow = result.get("sample_flow")
        if isinstance(flow, dict):
            lines.append(
                f"- 回归阶段：输入 {_count(flow.get('input_rows'))} 行年度记录，"
                f"另剔除 {_count(flow.get('dropped_rows_total'))} 行。"
            )
        reasons = [*_list_values(result.get("status_reasons")), *_list_values(support.get("reasons"))]
        design_limit = _summary_design_limit(status, support, reasons)
        if design_limit:
            lines.append(f"- **最重要的设计限制：** {design_limit}")
        lines.append("")
    return lines


def _technical_support_lines(design: dict[str, Any], result: dict[str, Any], support: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    if support:
        support_bits = []
        for key, label in (
            ("treated_entities", "处理个体"),
            ("treated_clusters", "贡献处理聚类"),
            ("paired_control_clusters", "配对贡献对照聚类"),
            ("untreated_entities", "估计样本内未暴露个体"),
            ("untreated_clusters", "估计样本内完全未暴露聚类"),
            ("reversal_share", "处理撤销行占比"),
        ):
            if support.get(key) is not None:
                value = support[key]
                rendered = (
                    f"{float(value) * 100:.2f}%"
                    if key == "reversal_share" and isinstance(value, (int, float))
                    else _count(value)
                )
                support_bits.append(f"{label}={rendered}")
        if support_bits:
            lines.append(f"- 处理支持：{'；'.join(support_bits)}")

    return lines


def _reported_inference_cells(
    design: dict[str, Any],
    result: dict[str, Any],
    term: str,
    ci_low: Any,
    ci_high: Any,
    p_raw: Any,
    *,
    suppressed: bool,
) -> tuple[str, str]:
    if suppressed:
        return "已抑制", "已抑制"
    interval = f"[{_number(ci_low)}, {_number(ci_high)}]" if ci_low is not None and ci_high is not None else "—"
    return interval, _number(p_raw, p_value=True)


def _technical_estimate_tables(
    design: dict[str, Any],
    result: dict[str, Any],
    *,
    suppressed: bool,
) -> list[str]:
    lines = ["", "| 变量 | 点估计 | 标准误 | 标称 95% 近似区间 | p 值 |", "|---|---:|---:|---:|---:|"]
    for coefficient in result.get("coefs", []):
        if not isinstance(coefficient, dict):
            continue
        interval, p_value = _reported_inference_cells(
            design,
            result,
            str(coefficient.get("name", "")),
            coefficient.get("ci_low"),
            coefficient.get("ci_high"),
            coefficient.get("p"),
            suppressed=suppressed,
        )
        lines.append(
            f"| {_coefficient_label(coefficient.get('name', '—'), design)} | {_number(coefficient.get('coef'))} | "
            f"{_number(coefficient.get('se'))} | {interval} | {p_value} |"
        )

    return lines


def _run_sections(runs: list[dict[str, Any]]) -> list[str]:
    lines = [
        "## 技术附录：保存的回归结果",
        "",
        "以下结果来自会话中保存的服务端运行，不在报告生成时重新估计。同一步可能有最近一次探索和一份可报告快照。表格数值为便于阅读做了四位有效数字的显示舍入；完整原始值仍保留在报告溯源数据中。",
        "极小 p 值以 <0.0001 展示，不能读作概率为零。",
        "表中系数按 X 的原始单位计（X 是份额，0.01 即 1 个百分点）：正文“关税暴露 X 每增加 1 个百分点”的读数 = 系数 × 0.01；"
        "贸易流和生产两项的 Y 也是份额，再乘 100 换成百分点，所以数值与系数相同。",
        "",
    ]
    grouped: dict[int, list[dict[str, Any]]] = {step: [] for step in _STEP_OUTCOMES}
    for run in runs:
        grouped.setdefault(run["step"], []).append(run)
    for step in sorted(_STEP_OUTCOMES):
        step_runs = grouped.get(step) or []
        if not step_runs:
            lines.append(f"- 步骤 {step} · {_STEP_TITLES.get(step, '')}：未记录。")
            continue
        for index, run in enumerate(step_runs):
            design, result = run["design"], run["result"]
            support = result.get("support") if isinstance(result.get("support"), dict) else {}
            status = _effective_status(result)
            reasons = [*_list_values(result.get("status_reasons")), *_list_values(support.get("reasons"))]
            reasons = list(dict.fromkeys(_safe(reason) for reason in reasons))
            globally_suppressed = _global_inference_suppressed(result)
            suppressed = globally_suppressed
            heading = f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}"
            if len(step_runs) > 1:
                heading += f"（保存 {index + 1}/{len(step_runs)}）"
            lines.extend(
                (
                    heading,
                    "",
                    f"- 因变量：{_safe(design.get('depvar_label', run['outcome']))}",
                    f"- 结果量纲：{_KIND_DIMENSIONS.get(_depvar_kind(run['outcome'], design), '原始单位')}",
                    f"- 方程：`{_safe(design.get('equation', '—'))}`",
                    f"- 设计状态：{_STATUS_LABELS.get(str(status), _STATUS_LABELS['unknown'])}；观测数：{_count(result.get('n_obs'))}",
                )
            )
            setting_bits = [
                f"{label}={_setting_value(key, design[key])}"
                for key, label in (
                    ("granularity", "粒度"),
                    ("shock_type", "冲击类型"),
                    ("method", "方法"),
                    ("control_mode", "控制变量"),
                    ("price_mode", "价格口径"),
                    ("scenario", "教学场景"),
                )
                if design.get(key) not in (None, "")
            ]
            if setting_bits:
                lines.append(f"- 保存的设定：{'；'.join(setting_bits)}")
            if reasons:
                lines.append("- 主要设计限制：")
                lines.extend(f"  - {reason}" for reason in reasons)
            lines.extend(_technical_support_lines(design, result, support))
            if suppressed:
                lines.append(
                    "- **统计推断已抑制**：下表点估计仅说明计算输出；不得把缺失的 p 值或置信区间解释为无效应，也不得据此形成方向性结论。"
                )
            lines.extend(_technical_estimate_tables(design, result, suppressed=suppressed))
            # Runs saved before the wording change carry "双向固定效应(entity_id + year),within 变换后 OLS".
            notes = [
                _safe(
                    re.sub(
                        r"^双向固定效应\((\S+) \+ (\S+)\),within 变换后 OLS$",
                        lambda match: two_way_note(match.group(1), match.group(2)),
                        str(note),
                    )
                )
                for note in _list_values(result.get("notes"))
            ]
            if notes:
                lines.extend(("", "方法与限制："))
                lines.extend(f"- {note}" for note in notes)
            lines.append("")
    return lines


def _qc_release_summary(qc: Any) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "requires_disclosure": False,
        "override": False,
        "fatal": [],
        "warning": [],
        "disclosure": [],
    }

    def visit(value: Any) -> None:
        if not isinstance(value, dict):
            return
        summary["requires_disclosure"] = summary["requires_disclosure"] or value.get("requires_disclosure") is True
        summary["override"] = summary["override"] or value.get("override") is True
        # Input/regression summaries use "warning"; output QC v4 uses
        # "warnings". Normalize both before deduplicating the report findings.
        for field, severity in (
            ("fatal", "fatal"),
            ("warning", "warning"),
            ("warnings", "warning"),
            ("disclosure", "disclosure"),
        ):
            names = value.get(field)
            if isinstance(names, list):
                summary[severity].extend(str(name) for name in names)
        for child in value.values():
            visit(child)

    visit(qc)
    for severity in ("fatal", "warning", "disclosure"):
        summary[severity] = list(dict.fromkeys(summary[severity]))
    summary["requires_disclosure"] = bool(
        summary["requires_disclosure"]
        or summary["override"]
        or summary["fatal"]
        or summary["warning"]
        or summary["disclosure"]
    )
    return summary


def _qc_display_name(name: str) -> str:
    """QC check names are stored as written in the QC contract (half-width brackets); print them in report style."""
    return name.replace("(", "（").replace(")", "）")


def _qc_disclosure_section(summary: dict[str, Any], integrity: Any) -> list[str]:
    status = integrity.get("status") if isinstance(integrity, dict) else "unknown"
    lines = [
        "## 数据完整性与诊断披露",
        "",
        f"- 自动完整性验证：{'通过' if status == 'passed' else '状态未知'}。文件、表结构和数据来源都已核对。",
        "- 检查规则：完整性、逆矩阵或计算恒等式不通过时，数据不会发布；经济账户异常、取值范围和回归设计限制会保留，并在下面列出。",
    ]
    for key, label in (("fatal", "非阻断诊断发现"), ("warning", "警告"), ("disclosure", "补充披露")):
        if summary[key]:
            lines.append(f"- {label}：{'、'.join(_qc_display_name(str(name)) for name in summary[key])}")
    lines.append("")
    return lines


__all__ = [n for n in globals() if not n.startswith("__")]
