from __future__ import annotations

import math
import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from gvcsim.regression.estimation import two_way_note
from gvcsim.regression.teaching import MARKET
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
    _list_values,
    _model_summary,
    _natural_effect,
    _no_negative_zero,
    _number,
    _observation_reading,
    _primary_coefficient,
    _safe,
    _setting_value,
    _summary_design_limit,
    _y_label,
    network_digits,
    reading_number,
    shown_per_point,
    with_count_unit,
    y_display,
)
from gvcsim.report_gate import _indicator_material_complete, _step_data, _valid_indicator_observations
from gvcsim.report_labels import DB_TABLE_NAMES, FINAL_DEMAND_NAMES, country_label, sector_label
from gvcsim.report_observed import _viewed_shock_event_sources
from gvcsim.report_regression_chart import family_chart, summary_chart
from gvcsim.report_saved_run import _result_is_reportable, _result_is_qualified


def _entity_label(item: dict[str, Any]) -> str:
    """An observation's economy (and industry) by name, as on the pages: "CHN 中国 · C29 汽车及零部件"."""
    country = item.get("country")
    if not country:
        return str(item.get("entity", "—"))
    industry = item.get("industry")
    return f"{country_label(str(country))} · {sector_label(str(industry))}" if industry else country_label(str(country))


def _depvar_display(label: Any) -> str:
    """The saved Y label as the pages show it: "加权总度", not the step 5 detail "加权总度（入+出）"."""
    return y_display(label)


def _cjk_punctuation(text: str) -> str:
    """Saved design and estimator notes predate the full-width style: print "排除 ROW（…）", "样本过滤：…"."""
    text = re.sub(r"(?<=[\u4e00-\u9fff]):", "：", text)
    return re.sub(r"\(([^()]*[\u4e00-\u9fff][^()]*)\)", r"（\1）", text)


def _rate(percent: float) -> str:
    """A tariff rate as set (10%, 7.5%), without padding zeros."""
    return f"{percent:.2f}".rstrip("0").rstrip(".")


def _points(share: float) -> str:
    """A share in percentage points to two decimals, as on step 10; a tiny one keeps two significant digits."""
    points = share * 100
    if 0 < points < 0.005:
        return f"{points:.{min(10, math.ceil(-math.log10(points)) + 1)}f}"
    return f"{points:.2f}"


def _fixed(value: float, digits: int) -> str:
    """JavaScript ``toFixed``: the exact value rounded half up at ``digits`` decimals, never "-0"."""
    text = str(Decimal(value).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))
    return text[1:] if text.startswith("-") and not any(char in "123456789" for char in text) else text


def _shown_decimals(share: float) -> int:
    """Decimals ``_points`` gives a share: two, or two significant digits for a tiny positive one."""
    points = share * 100
    return min(10, math.ceil(-math.log10(points)) + 1) if 0 < points < 0.005 else 2


def worked_numbers(w: float, tau: float, x: float) -> tuple[str, str]:
    """w (in %) and X (in percentage points) as step 10 shows them (frontend ``workedNumbers``): two decimals, more
    only until the shown w times the shown τ rounds to the shown X, so "X = w × τ" and the conversions in steps
    11–14 check by hand (0.22444, not 0.22). An exact zero X reads "0"."""

    def w_at(decimals: int) -> str:
        return _fixed(w * 100, decimals)

    w_base, x_base = _shown_decimals(w), _shown_decimals(x)
    if x == 0:
        return w_at(w_base), "0"
    tau_shown = Decimal(_rate(tau * 100))
    for extra in range(7):
        for w_decimals, x_decimals in ((w_base + extra, x_base + extra), (w_base + extra, x_base + extra + 1)):
            w_text, x_text = w_at(w_decimals), _fixed(x * 100, x_decimals)
            product = (Decimal(w_text) * tau_shown / 100).quantize(
                Decimal(1).scaleb(-x_decimals), rounding=ROUND_HALF_UP
            )
            if product == Decimal(x_text):
                return w_text, x_text
    return w_at(w_base), _fixed(x * 100, x_base)


def _example_x(item: dict[str, Any], x: float, tau: float) -> str:
    """An example's X at step 10's digits when its w is known, else two decimals."""
    w = item.get("teaching_export_share_w")
    if isinstance(w, (int, float)) and not isinstance(w, bool) and math.isfinite(w) and math.isfinite(tau):
        return worked_numbers(float(w), tau, x)[1]
    return _points(x)


# How each recorded unit is read, in the order the notes list them (steps 6–9).
_UNIT_READINGS = (
    ("百万美元", "金额为当年价格（百万美元）"),
    ("%", "份额以百分数列示，变化按百分点解释"),
    ("长度单位", "长度按长度单位列示（约等于平均经过的生产环节数），变化按长度单位解释"),
    ("无量纲", "位置指数没有单位，按原值比较（大于 1 表示相对更上游）"),
)
_UNIT_KINDS = {"%": "份额", "长度单位": "长度", "无量纲": "位置指数"}
_NETWORK_UNITS = {"未归一化介数", "连接数", "路径长度", "中心性单位"}


def _unit_kinds(observations: list[dict[str, Any]], step: int | None = None) -> str:
    """What a section without amounts holds, from its recorded units: "份额", "长度和位置指数", "网络指标".
    Step 9's closeness, harmonic closeness and eigencentrality are recorded as "无量纲" too; they are network
    metrics, not step 8's position index."""
    units = list(dict.fromkeys(str(item.get("unit") or "") for item in observations))
    if step == 9 or (units and all(unit in _NETWORK_UNITS for unit in units)):
        return "只看连接、不看金额的网络指标"
    kinds = list(dict.fromkeys(_UNIT_KINDS.get(unit, "比值或指数") for unit in units))
    return "和".join(kinds) or "比值或指数"


def _unit_reading_note(observations: list[dict[str, Any]]) -> str:
    """The reading note under a step 6–8 table, for the units it actually records."""
    units = {str(item.get("unit") or "") for item in observations}
    notes = [note for unit, note in _UNIT_READINGS if unit in units]
    return ("；".join(notes) or "数值按所列单位解释") + "。"


def _country_reading(item: dict[str, Any]) -> str:
    """A steps 2–5 reading as one phrase, e.g. “2020 年 CHN 中国 外国增加值项占比 11.730%”."""
    metric = _STUDENT_METRIC_LABELS.get(str(item.get("metric")), _safe(item.get("metric", "—")))
    value = item.get("value")
    unit = str(item.get("unit") or "")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        number = reading_number(float(value) * (100 if unit == "%" else 1), unit)
        shown = f"{number}%" if unit == "%" else f"{number} {_safe(unit)}" if unit == "百万美元" else number
    else:
        shown = _safe(value if value not in (None, "") else "—")
    return f"{_safe(item.get('year', '—'))} 年 {_safe(country_label(str(item.get('country', ''))))} {metric} {shown}"


def _yi_usd(million_usd: float) -> str:
    """An amount in million USD as 亿美元, as step 10 writes it ("10 亿美元", "2,489 亿美元")."""
    yi = million_usd / 100
    digits = 0 if abs(yi) >= 100 else 1 if abs(yi) >= 1 or yi == 0 else 2
    text = f"{yi:,.{digits}f}"
    return f"{text.rstrip('0').rstrip('.') if '.' in text else text} 亿美元"


def _tax_status(country: str, scenario: dict[str, Any] | None) -> str | None:
    """被加税／未被加税 for a sample country (the market is 加征关税的一方); None when the release does not say."""
    if country == MARKET:
        return "加征关税的一方"
    taxed = (scenario or {}).get("taxed", {}).get(country)
    return None if taxed is None else "被加税" if taxed else "未被加税"


def _with_tax_status(country: str, scenario: dict[str, Any] | None) -> str:
    status = _tax_status(country, scenario)
    return f"{_safe(country_label(country))}{f'（{status}）' if status else ''}"


def _scenario_line(scenario: dict[str, Any] | None) -> str | None:
    """Step 10's scenario and the rule that picks the taxed countries, as the page states it: "美国从 2018 年起对
    2016 年对美货物贸易顺差达到或超过 10 亿美元的 N 国加征 25% 关税，其余 M 国未被加税"."""
    if not scenario:
        return None
    taxed, untaxed = scenario.get("taxed_countries"), scenario.get("untaxed_countries")
    rate, policy_year = scenario.get("tariff_rate"), scenario.get("policy_year")
    if not isinstance(taxed, int) or not isinstance(untaxed, int) or not isinstance(rate, (int, float)):
        return None
    raw_rule = scenario.get("taxed_rule")
    rule: dict[str, Any] = raw_rule if isinstance(raw_rule, dict) else {}
    minimum, rule_year = rule.get("min_million_usd"), rule.get("year")
    since = f"从 {policy_year} 年起" if isinstance(policy_year, int) else ""
    who = (
        f"{f'{rule_year} 年' if isinstance(rule_year, int) else '首年'}对美货物贸易顺差达到或超过 {_yi_usd(float(minimum))}的 {taxed} 国"
        if isinstance(minimum, (int, float)) and math.isfinite(minimum)
        else f"{taxed} 国"
    )
    # A space between 对 and a number ("对 2016 年"), none before 首年.
    space = " " if who[:1].isdigit() else ""
    # Teaching data v8 taxes goods only (the rule carries a scope); an older release taxed every industry.
    if rule.get("scope"):
        return (
            f"- 情景：美国{since}对{space}{who}的货物（农业、采矿业和制造业，ICIO 行业 A–C）加征 "
            f"{_rate(float(rate) * 100)}% 关税，服务业不加税；其余 {untaxed} 国未被加税。"
        )
    return f"- 情景：美国{since}对{space}{who}加征 {_rate(float(rate) * 100)}% 关税，其余 {untaxed} 国未被加税。"


def _is_service(industry: object) -> bool:
    """A service industry: the teaching tariff falls on goods only (ICIO sectors A, B and C; v8)."""
    return str(industry)[:1] not in ("A", "B", "C")


def _experiment_sections(session: dict[str, Any], scenario: dict[str, Any] | None = None) -> list[str]:
    """Render only snapshots produced by explicit student interactions. ``scenario`` is step 10's scenario from the
    release (``teaching.country_exposure_overview`` plus each country's taxed flag); without it the step 10
    section leaves out the scenario line and the 被加税／未被加税 labels."""
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
        # Steps 2–5 record one country's reading automatically; a record saved before that change may hold two
        # countries and is listed as recorded.
        automatic = bool(observations) and all(
            item.get("source") == "auto-indicator-comparison" for item in observations
        )
        if compared:
            # One saved economy is read against the global reference; two or more are a comparison.
            if step in (2, 3, 4, 5):
                # The student picks the country on the page and the reading is recorded for it: "系统自动记录的国家"
                # read as if the system had chosen the country.
                compared_label = "学生选定的国家" if chosen else "记录的国家"
            elif len(compared) == 1:
                compared_label = "学生选定的国家" if chosen else "所看国家"
            else:
                compared_label = "学生选定的比较" if chosen else "比较对象"
            lines.append(f"- {compared_label}：{'、'.join(_safe(country_label(str(item))) for item in compared)}")
        if observations:
            has_amounts = any(item.get("unit") == "百万美元" for item in observations)
            if step in (6, 7, 8, 9) and any(item.get("year") == 2020 for item in observations):
                price_note = (
                    "金额按当年价格计，变化可能包含价格因素。"
                    if has_amounts
                    else f"本节为{_unit_kinds(observations, step)}，不直接受价格水平影响，但仍受下述结构外推影响。"
                )
                lines.append(
                    f"- **2020 年：现价与疫情期外推限制**。{price_note}"
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
                    "- 行业指标来自完整国家×行业中间品网络，不对应国家贸易概览的位置；加权流量为当年价格；"
                    "介数等只看连接、不看金额的指标，数值高不等于经济上更重要。"
                )
            if step in (6, 7, 8):
                lines.append(
                    "- 记录的图表材料（学生选定的完整图表；指标与单位逐行列示）："
                    if chosen
                    else "- 记录的图表材料（系统按学生最后查看的完整图表自动记录；指标与单位逐行列示）："
                )
                # The data release id is listed under "报告溯源"; the body only says how to read the numbers.
                lines.append(f"- {_unit_reading_note(observations)}")
            elif step in (2, 3, 4, 5):
                lines.append(f"- 记录的读数：{'；'.join(_country_reading(item) for item in observations)}")
                if step in (2, 3, 4) and automatic:
                    lines.append("- 数值为国家级代表指标：页面可按国家×行业浏览，报告材料统一按国家级记录。")
                if step == 5 and metric_label == "weighted degree":
                    lines.append(
                        "- 国家级加权总度：该国全部出口 + 进口，中间品和最终品都算在内（不含国内流量）；"
                        "行业级数值只算中间品流量，两者不能直接比较。"
                    )
            else:
                lines.append(
                    f"- 记录的代表指标：{_STUDENT_METRIC_LABELS.get(str(metric_label), _safe(metric_label or '—'))}"
                )
            entity_header = "国家×行业" if any(item.get("industry") for item in observations) else "国家"
            lines.extend(("", f"| {entity_header} | 年份 | 指标 | 单位 | 数值 |", "|---|---:|---|---|---:|"))
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
            # Only steps 2–5 reach this: steps 6–9 skip a section without complete readings.
            lines.append("- 本步只记录了国家，没有记录代表指标数值。")
        lines.append("")

    shock = _step_data(session, 10)
    if shock.get("viewed_teaching_panel"):
        captured = True
        # The scenario first (who is taxed and why), as at the top of step 10; then the example followed.
        scenario_line = _scenario_line(scenario)
        lines.extend(
            (
                f"### 步骤 10 · {_STEP_TITLES.get(10, '')}",
                "",
                *([scenario_line] if scenario_line else []),
                (
                    f"- 两国趋势示例：{'、'.join(_with_tax_status(str(value), scenario) for value in shock.get('compared', []))} · "
                    f"{_safe(sector_label(str(shock.get('teaching_industry'))))} · 全部可用年份"
                    if isinstance(shock.get("compared"), list) and len(shock["compared"]) == 2
                    else f"- 查看对象：{_with_tax_status(str(shock.get('teaching_country')), scenario)}"
                    + (
                        f" · {_safe(sector_label(str(shock.get('teaching_industry'))))}"
                        if shock.get("teaching_industry")
                        else ""
                    )
                    + f" · {_safe(shock.get('teaching_year'))}"
                ),
                "- X = 首年对美出口份额 w × 加征税率 τ（单位：个百分点）。",
            )
        )
        teaching_observation = shock.get("teaching_observation")
        if isinstance(teaching_observation, dict):
            worked = worked_numbers(
                float(teaching_observation["teaching_export_share_w"]),
                float(teaching_observation["teaching_tariff_rate_tau"]),
                float(teaching_observation["teaching_tariff_exposure"]),
            )
            lines.extend(
                (
                    f"- 换算用的例子：{_safe(country_label(str(teaching_observation.get('country'))))} · "
                    f"{_safe(sector_label(str(teaching_observation.get('industry'))))} · {_safe(teaching_observation.get('year'))}",
                    # X is read in percentage points throughout steps 10–14, so print it the same way here.
                    # Same digits as step 10: w and X to two decimals, more where the product would not check by
                    # hand; the tariff rate as set.
                    f"- w = {worked[0]}%；"
                    f"τ = {_rate(float(teaching_observation['teaching_tariff_rate_tau']) * 100)}%；"
                    f"X = w × τ = {worked[1]} 个百分点"
                    + (
                        "（服务业不在加税范围内，τ = 0）"
                        if _is_service(teaching_observation.get("industry"))
                        and float(teaching_observation["teaching_tariff_rate_tau"]) == 0
                        else ""
                    ),
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
                "- 回归用的 X：按所选冲击类型汇总该类型全部已编码事件的国家×行业暴露；单个事件的选择不影响回归样本。",
                "- “受影响”只表示这里编码的关税暴露大于零，不是政策机关发布的名单；暴露为零也不代表现实中没受其他政策或外溢影响。",
                "",
            )
        )

    if not captured:
        lines.extend(("- 未保存额外实验快照。", ""))
    return lines


def _regression_heading(step: int) -> str:
    """A step 11–14 heading without its default Y ("贸易流回归"): the saved run's Y is stated below it."""
    return _STEP_TITLES.get(step, "").split("：")[0]


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
        "下表列出四步保存的结果（贸易流、生产、长度、网络），各用自己的单位，表中数值不能直接比较"
        + ("；表后的图将其统一换算为标准差，以便并列比较。" if qualified else "。"),
        "",
        "| 步骤 | 指标 | X 每高 1 个百分点，Y 平均相差 | 95% 区间 | 方向 |",
        "|---|---|---|---|---|",
    ]
    designs = []
    for step, outcome in sorted(_STEP_OUTCOMES.items()):
        run = qualified.get(step)
        if run is None:
            lines.append(f"| {step} | {_safe(_STEP_TITLES.get(step, outcome))} | — | — | 还没有计算 |")
            continue
        design, result = run["design"], run["result"]
        designs.append((design.get("shock_type"), design.get("method"), design.get("granularity")))
        coefficient = _primary_coefficient(design, result)
        if coefficient is None or not isinstance(coefficient.get("coef"), (int, float)):
            lines.append(
                f"| {step} | {_safe(_depvar_display(design.get('depvar_label', outcome)))} | — | — | "
                "没算出估计值（原因已记录） |"
            )
            continue
        _effect_label, effect, interval = _natural_effect(outcome, design, result, coefficient)
        suppressed = _global_inference_suppressed(result)
        evidence, _interpretation = _evidence_reading(outcome, coefficient, suppressed, design)
        lines.append(
            f"| {step} | {_safe(_depvar_display(design.get('depvar_label', outcome)))} | {effect} | {interval} | {evidence} |"
        )
    lines.append("")
    lines.extend(summary_chart(qualified))
    if len({item for item in designs}) > 1:
        lines.extend(
            (
                "- 各行的计算设定不同，不能直接比较估计值。",
                "",
            )
        )
    return lines


def _teaching_sample_lines(source_filter: dict[str, Any] | None) -> list[str]:
    if source_filter is None:
        return []
    return [
        "### 回归用的国家×行业",
        "",
        f"- 首年共有 {_count(source_filter.get('source_baseline_rows'))} 个国家×行业（不含“世界其他地区”ROW），"
        f"其中 {_count(source_filter.get('excluded_source_baseline_rows'))} 个没有进入样本："
        "美国是加征关税的一方，它的各行业按设计不在样本中；其余是缺少必要数据被剔除的。"
        f"剩下 {_count(source_filter.get('published_entities'))} 个用于四项回归。",
        # Two different stages: this one builds the sample; each run's "计算时再剔除" checks it again.
        "- 上面的剔除在准备关税数据时就已完成。下面每步回归里的“计算时再剔除 n 条”指计算前再次核查样本、"
        "剔除仍有缺失值的年度记录，与上述剔除互不重复，通常为 0。",
        "- 剔除规则：首年四个默认指标和对美出口份额都要有效；两类份额和出口份额在 0–1 之间，长度大于 0，加权总度不小于 0。",
        "- 下面的记录数按“每个国家×行业每年一条”计。",
        "",
    ]


def _example_size(kind: str, change: float) -> str:
    """The unsigned Y change implied for the step 10 example, in the step's display unit (shares in points;
    frontend ``exampleEffect``)."""
    size = abs(change)
    if kind == "network":
        digits = network_digits(size)
    else:
        digits = {"share": 2, "position": 4}.get(kind, 3)
    # The position index has no unit: a bare number, as on the page.
    if 0 < size < 0.5 * 10**-digits:
        return with_count_unit(f"不到 {10**-digits:.{digits}f}", kind)
    # Thousands separators, as the page writes them ("约为 -1,382 个中心性原始单位"). Half up on the decimal
    # product, as by hand: 0.018 × 23.25 = 0.4185 reads 0.419 (float formatting alone gives 0.418).
    rounded = Decimal(repr(size)).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    return with_count_unit(f"{rounded:,.{digits}f}", kind)


def _example_conversion(
    outcome: str, design: dict[str, Any], coefficient: dict[str, Any], directional: bool, example: Any
) -> str | None:
    """The page's "按你在步骤 10 选的例子换算…" line. ``example`` is the example step 10 recorded (its X, as saved
    there) or, as on the page, the examples followed from step 10 in order: the recorded one and its comparison
    country ("CRI 哥斯达黎加 · C29 汽车 未被加税，X = 0，按估计没有与 X 相关的差异")."""
    examples = [example] if isinstance(example, dict) else list(example) if isinstance(example, (list, tuple)) else []
    parsed: list[tuple[dict[str, Any], float, float]] = []
    for item in examples:
        if not isinstance(item, dict):
            continue
        try:
            x = float(item["teaching_tariff_exposure"])
            tau = float(item.get("teaching_tariff_rate_tau") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(x):
            parsed.append((item, x, tau))
    if not parsed:
        return None
    # Only an example with X > 0 converts; an open direction is said once, after the last of them.
    converted = [item for item, x, _tau in parsed if x > 0 and str(item.get("country")) != MARKET]
    parts = []
    for item, x, tau in parsed:
        label = f"{_safe(country_label(str(item.get('country'))))} · {_safe(sector_label(str(item.get('industry'))))}"
        if str(item.get("country")) == MARKET:
            text = f"{label} 属于加征关税的一方，按设计不在回归样本中，X 记为 0 只是定义，不做换算"
        elif x > 0:
            # The printed estimate per point × the printed X, so the line checks by hand (as on the page).
            change = shown_per_point(outcome, design, coefficient) * float(_example_x(item, x, tau))
            size = _example_size(_depvar_kind(outcome, design), change)
            words = _difference_words(_depvar_kind(outcome, design))
            if size.startswith("不到"):
                amount = size
            else:
                amount = f"约为 {'-' if change < 0 else '+'}{size}"
            reading = (
                f"（Y 偏{words[0] if change < 0 else words[1]}）"
                if directional
                else "；但区间包含 0，差异的高低方向并不确定"
                if item is converted[-1]
                else ""
            )
            text = f"{label} 的 X 为 {_example_x(item, x, tau)} 个百分点，按估计与 X 相关的差异{amount}{reading}"
        elif tau == 0 and _is_service(item.get("industry")):
            text = f"{label} 是服务业，不在加税范围内（τ = 0），X = 0，按估计没有与 X 相关的差异"
        elif tau > 0:
            text = f"{label} 被加税但首年不向美国出口（w = 0），X = 0，按估计没有与 X 相关的差异"
        else:
            text = f"{label} 未被加税，X = 0，按估计没有与 X 相关的差异"
        parts.append(text)
    return f"- **按步骤 10 的例子换算**：{'；'.join(parts)}。"


def _difference_words(kind: str) -> tuple[str, str]:
    """How a gap in Y is said, (lower, higher): lengths are 短/长, everything else 低/高."""
    return ("短", "长") if kind == "length" else ("低", "高")


# The page shows the same words at the top of every step 11–14 result card (frontend ``GENERATED_Y_DISCLOSURE``).
GENERATED_Y_DISCLOSURE = (
    "教学数据：步骤 11–14 的 Y 由课程按设定生成，与 X 的关联是有意设计的，多数 Y 设得很清晰（区间窄、p 值小），"
    "精度高于真实数据通常能得到的结果。结果用于练习读回归，不是真实关税影响的证据。"
)


def _evidence_summary(
    runs: list[dict[str, Any]],
    source_filter: dict[str, Any] | None = None,
    teaching_observation: Any = None,
    overview: dict[str, Any] | None = None,
) -> list[str]:
    """``overview`` is the course's estimate of every Y (``_estimate_overview``) for the per-step bar charts;
    without it each chart shows the saved Y alone."""
    lines = [
        "## 关键证据摘要",
        "",
        # Bold body text, not a grey blockquote: the reader should see it before any number.
        f"**{GENERATED_Y_DISCLOSURE}**",
        "",
        "本节用课堂上的读数单位说明估计结果；公式和详细数字见技术附录。",
        "",
        *_teaching_sample_lines(source_filter),
        "区间说明：95% 区间是真实系数的合理取值范围，包含 0 时方向不确定。" + CLUSTER_INTERVAL_NOTE,
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
        # Usually a step has one saved run; only when it has two does the heading say which one the summary uses.
        several = sum(1 for other in runs if other["step"] == step) > 1
        marker = (
            ""
            if not several
            else "（用于汇总表）"
            if used_in_table
            else ("（另一次计算，未用于汇总表）" if not _result_is_qualified(result, design) else "")
        )
        coefficient = primary
        # The step's title names its default Y; the saved run may use another, so the heading names the
        # regression only and the saved Y is given in the table below ("结果指标 Y").
        lines.extend((f"### 步骤 {step} · {_regression_heading(step)}{marker}", ""))
        if coefficient is None or not isinstance(coefficient.get("coef"), (int, float)):
            lines.extend(
                (
                    "- 这次没有算出 X 的估计值；结果仍然保存，可以写进报告。",
                    *[f"- 原因：{_safe(reason)}" for reason in _list_values(support.get("reasons"))],
                    "",
                )
            )
            continue
        effect_label, effect, interval = _natural_effect(outcome, design, result, coefficient)
        evidence, interpretation = _evidence_reading(outcome, coefficient, suppressed, design)
        directional = evidence.startswith("方向明确")
        lines.extend(family_chart(step, outcome, design, result, coefficient, overview))
        lines.extend(
            (
                "| 项目 | 结果 |",
                "|---|---|",
                f"| 结果指标 Y | {_safe(_y_label(outcome, design))} |",
                f"| 模型 | {_model_summary(design) or '—'} |",
                f"| {effect_label} | **{effect}** |",
                f"| 95% 区间 | {interval} |",
                f"| 方向 | **{evidence}** |",
                f"| 结果能否解读 | {_STATUS_LABELS.get(status, _STATUS_LABELS['unknown'])} |",
                "",
                # An open direction gets a caution, not a claim it "supports".
                f"- **{'可以支持的表述' if directional else '表述提醒'}**：{interpretation}",
            )
        )
        if not suppressed:
            conversion = _example_conversion(outcome, design, coefficient, directional, teaching_observation)
            if conversion:
                lines.append(conversion)
        flow = result.get("sample_flow")
        dropped = f"；计算时再剔除 {_count(flow.get('dropped_rows_total'))} 条" if isinstance(flow, dict) else ""
        lines.append(
            f"- 使用 {_count(result.get('n_obs'))} 条年度记录（{_count(result.get('n_entities'))} 个国家×行业"
            f" × {_count(result.get('n_times'))} 年，来自 {_count(result.get('n_clusters'))} 个国家）{dropped}。"
        )
        if _depvar_kind(outcome, design) == "network":
            # Said here, next to the number, not only in the appendix: the unit is not step 5/9's 百万美元.
            lines.append(
                "- **单位**：中心性原始单位。这一步的 Y 是课程按真实网络指标的排名校准生成的，"
                "不是步骤 5、9 里以百万美元计的加权总度，不能和那两步的数值直接比较。"
            )
        reasons = [*_list_values(result.get("status_reasons")), *_list_values(support.get("reasons"))]
        design_limit = _summary_design_limit(status, support, reasons)
        if design_limit:
            lines.append(f"- **需要写明的限制**：{design_limit}")
        lines.append("")
    return lines


def _technical_support_lines(design: dict[str, Any], result: dict[str, Any], support: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    if support:
        support_bits = []
        if support.get("treated_entities") is not None:
            countries = (
                f"（来自 {_count(support['treated_clusters'])} 个国家）"
                if support.get("treated_clusters") is not None
                else ""
            )
            support_bits.append(f"X 大于 0 的国家×行业 {_count(support['treated_entities'])} 个{countries}")
        if support.get("untreated_entities") is not None:
            countries = (
                f"（含 {_count(support['untreated_clusters'])} 个国家的全部行业）"
                if support.get("untreated_clusters") is not None
                else ""
            )
            support_bits.append(f"X 始终为 0 的 {_count(support['untreated_entities'])} 个{countries}")
        if support_bits:
            lines.append(f"- 加税情况：{'；'.join(support_bits)}。")

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
        return "不显示", "不显示"
    low, high = _fixed4(ci_low), _fixed4(ci_high)
    interval = f"[{low}, {high}]" if "—" not in (low, high) else "—"
    return interval, _number(p_raw, p_value=True)


def _fixed4(value: Any) -> str:
    """A coefficient, SE or interval end as the page's 详细数字 table prints it (``fixed4``): four decimals, both
    interval ends alike ("[-0.4109, -0.3790]", not "[-0.4109, -0.379]"), thousands grouped ("-4,080.3723")."""
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
        return "—"
    return _no_negative_zero(f"{float(value):,.4f}")


def _technical_estimate_tables(
    design: dict[str, Any],
    result: dict[str, Any],
    *,
    suppressed: bool,
    outcome: str | None = None,
) -> list[str]:
    # The raw coefficient is per 1.00 of X (X is a share); the column after it is the page's reading, per
    # 1 percentage point of X in Y's unit, so the two can be matched (they differ 100x for lengths and centrality).
    lines = [
        "",
        # The page's column order (详细数字), t 值 included.
        "| 变量 | X 每高 1 个百分点，Y 平均相差 | 系数（X 按份额计） | 95% 区间（按系数计） | 标准误（按国家聚类） | t 值 | p 值 |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    primary = _primary_coefficient(design, result)
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
        per_point = (
            _natural_effect(outcome, design, result, coefficient)[1].split("（")[0]
            if outcome is not None and coefficient is primary and isinstance(coefficient.get("coef"), (int, float))
            else "—"
        )
        t = coefficient.get("t")
        # Shown where the interval is (as the page shows t only when inference is allowed).
        t_value = f"{t:,.2f}" if isinstance(t, (int, float)) and math.isfinite(t) and interval not in ("—", "不显示") else "—"
        lines.append(
            f"| {_coefficient_label(coefficient.get('name', '—'), design)} | {per_point} | "
            f"{_fixed4(coefficient.get('coef'))} | {interval} | {_fixed4(coefficient.get('se'))} | {t_value} | {p_value} |"
        )

    return lines


def _run_sections(runs: list[dict[str, Any]]) -> list[str]:
    lines = [
        "## 技术附录：保存的回归结果",
        "",
        # One source line per paragraph: Markdown joins consecutive lines with a space, which would show
        # after each "。".
        "以下是你在步骤 11–14 保存的计算结果，生成报告时不会重算。每步通常只有最后一次计算；只有最后一次没有算出可用结果时，才会同时列出用于汇总表的那一次。"
        "系数、标准误和区间保留 4 位小数，与步骤 11–14 页面上的“详细数字”表相同；很小的 p 值显示为 <0.0001，不表示概率为零。",
        "",
        "表中的“系数”对应 X 相差 1（即 100 个百分点）时 Y 平均相差多少；除以 100 即为正文中“X 每高 1 个百分点”对应的数值，"
        "表中另列一栏。贸易流和生产两步的 Y 是份额，正文又换算为百分点（乘以 100），先除以 100 再乘以 100，两栏数值相同；"
        "长度和网络两步不作此换算，两栏相差 100 倍。",
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
            heading = f"### 步骤 {step} · {_regression_heading(step)}"
            if len(step_runs) > 1:
                heading += f"（保存 {index + 1}/{len(step_runs)}）"
            lines.extend(
                (
                    heading,
                    "",
                    f"- 结果指标 Y：{_safe(_y_label(run['outcome'], design))}",
                    f"- 单位：{_KIND_DIMENSIONS.get(_depvar_kind(run['outcome'], design), '原始单位')}",
                    # The saved equation names data columns; the report shows its symbols, as the step pages do.
                    "- 公式：Y = β·X + α（每个国家×行业的平均水平）+ λ（每年的共同变化）+ ε（随机波动）",
                    f"- 结果能否解读：{_STATUS_LABELS.get(str(status), _STATUS_LABELS['unknown'])}；记录数：{_count(result.get('n_obs'))}",
                )
            )
            setting_bits = [
                f"{label}：{_setting_value(key, design[key])}"
                for key, label in (
                    ("method", "模型"),
                    ("granularity", "观察单位"),
                    ("control_mode", "控制变量"),
                    ("price_mode", "价格"),
                )
                if design.get(key) not in (None, "")
            ]
            if setting_bits:
                lines.append(f"- 保存的设定：{'；'.join(setting_bits)}")
            if reasons:
                lines.append("- 需要写明的限制：")
                lines.extend(f"  - {reason}" for reason in reasons)
            lines.extend(_technical_support_lines(design, result, support))
            if suppressed:
                lines.append("- **这一项不显示 95% 区间**：数据不够，不能据此判断方向，也不能写成“没有关联”。")
            lines.extend(_technical_estimate_tables(design, result, suppressed=suppressed, outcome=run["outcome"]))
            notes = list(
                dict.fromkeys(
                    _safe(_cjk_punctuation(_plain_note(str(note)))) for note in _list_values(result.get("notes"))
                )
            )
            if notes:
                lines.extend(("", "计算方法与限制："))
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


def _plain_note(note: str) -> str:
    """Estimator notes saved with a run, in the course's words (older runs carry older wordings)."""
    # "双向固定效应(entity_id + year),within 变换后 OLS" and "双向固定效应（国家–行业单元 + 年份），组内变换后 OLS".
    two_way = re.match(r"^双向固定效应[（(](\S+) \+ (\S+)[)）][,，](?:within |组内)变换后 OLS$", note)
    if two_way:
        return two_way_note(two_way.group(1), two_way.group(2))
    components = re.match(r"^实体—年份二部图有 (\d+) 个连通分量", note)
    if components:
        return f"样本分成 {components.group(1)} 组互不重叠的数据；估计值是这几组共同的斜率。"
    return note


def _qc_display_name(name: str) -> str:
    """QC check names are stored as written in the QC contract (half-width brackets); print them in report style,
    with a space between Chinese and Latin letters ("原始 OUT = Z 列和 + VA + TLS")."""
    name = name.replace("(", "（").replace(")", "）")
    return re.sub(r"(?<=[\u4e00-\u9fff])(?=[A-Za-z])|(?<=[A-Za-z])(?=[\u4e00-\u9fff])", " ", name)


def _qc_disclosure_section(summary: dict[str, Any], integrity: Any) -> list[str]:
    status = integrity.get("status") if isinstance(integrity, dict) else "unknown"
    lines = [
        "## 数据检查",
        "",
        f"- 自动完整性检查：{'通过' if status == 'passed' else '状态未知'}。文件、表结构和数据来源都已核对。",
        "- 检查规则：完整性、矩阵求逆或计算恒等式检查不通过时，数据不会发布；账户里的异常值、取值范围和回归设定上的限制会保留，并在下面列出。",
    ]
    if any(summary[key] for key in ("fatal", "warning", "disclosure")):
        lines.append(
            "- 下面是系统自动检查 OECD 原始数据和计算结果时发现、需要留意的项目（检查名保留系统原文）；它们没有阻止数据发布。"
        )
    # A check listed under a stronger severity is not repeated below it.
    shown: set[str] = set()
    for key, label in (
        ("fatal", "需要留意（检查未通过，经人工确认后发布）"),
        ("warning", "提醒（检查发现个别特殊取值，例如负的增加值；这些取值来自原始数据，已保留）"),
        ("disclosure", "通过，附说明（检查通过，只记录了在容差内的微小偏差或特殊取值）"),
    ):
        names = [str(name) for name in summary[key] if str(name) not in shown]
        shown.update(names)
        if names:
            lines.append(f"- {label}：{'、'.join(_qc_display_name(name) for name in names)}")
    lines.append("")
    return lines


__all__ = [n for n in globals() if not n.startswith("__")]
