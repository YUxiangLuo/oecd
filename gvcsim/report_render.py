from __future__ import annotations

from typing import Any

from gvcsim.report_common import (
    _OUTCOME_UNITS,
    _SHOCK_SOURCE_STATUS_LABELS,
    _STATUS_LABELS,
    _STEP_OUTCOMES,
    _STEP_TITLES,
    _STUDENT_METRIC_LABELS,
    _coefficient_label,
    _count,
    _effective_status,
    _evidence_reading,
    _global_inference_suppressed,
    _list_values,
    _natural_effect,
    _number,
    _observation_reading,
    _primary_coefficient,
    _safe,
    _setting_value,
    _summary_design_limit,
)
from gvcsim.report_gate import _indicator_material_complete, _step_data, _valid_indicator_observations
from gvcsim.report_observed import _viewed_shock_event_sources
from gvcsim.report_saved_run import _result_is_reportable, _result_is_qualified


def _experiment_sections(session: dict[str, Any]) -> list[str]:
    """Render only snapshots produced by explicit student interactions."""
    lines = [
        "## 保存的实验快照",
        "",
        "以下内容来自会话中实际保存的切片、筛选和观察；未操作的默认视图不会被写成学生发现。",
        "",
    ]
    captured = False

    db = _step_data(session, 1)
    raw_slice = db.get("slice")
    browse_slice: dict[str, Any] | None = raw_slice if isinstance(raw_slice, dict) else None
    raw_observation = db.get("observation")
    observation: dict[str, Any] | None = raw_observation if isinstance(raw_observation, dict) else None
    source_slice = (
        observation
        if observation is not None
        and observation.get("year") not in (None, "")
        and observation.get("table") not in (None, "")
        else browse_slice
    )
    if source_slice or observation:
        captured = True
        lines.extend(("### 步骤 1 · OECD ICIO 数据浏览", ""))
        if source_slice:
            selection = "；".join(
                f"{label}={_safe(source_slice.get(key, '—'))}"
                for key, label in (
                    ("year", "年份"),
                    ("table", "表"),
                    ("row_country", "供给国"),
                    ("row_sector", "供给行业"),
                    ("col_country", "使用/需求国"),
                    ("col_sector", "使用行业/最终需求"),
                )
                if source_slice.get(key) not in (None, "")
            )
            lines.append(f"- 保存的切片：{selection or '—'}")
        if observation:
            lines.append(f"- 记录的单元格：{_observation_reading(observation)}")
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
        has_snapshot = any(
            data.get(key) not in (None, "", []) for key in ("year", "country", "chart", "drill", "metric")
        ) or bool(compared or observations)
        if not has_snapshot:
            continue
        captured = True
        lines.extend((f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}", ""))
        context = []
        for key, label in (("year", "年份"), ("country", "国家"), ("chart", "图表视角"), ("drill", "下钻")):
            if step not in (6, 7, 8, 9) and data.get(key) not in (None, ""):
                context.append(f"{label}={_safe(data[key])}")
        if context:
            lines.append(f"- 保存的视图：{'；'.join(context)}")
        if compared:
            lines.append(f"- 主动比较：{'、'.join(_safe(item) for item in compared)}")
        if observations:
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
                lines.append("- 记录的显式图表材料（指标与单位逐行列示）：")
                lines.append(
                    f"- 数据版本：{_safe(observations[0]['release'])}。金额为当年价格；份额以百分数列示，变化按百分点解释。"
                )
            else:
                lines.append(
                    f"- 记录的代表指标：{_STUDENT_METRIC_LABELS.get(str(metric_label), _safe(metric_label or '—'))}"
                )
            lines.extend(("", "| 实体 | 年份 | 指标 | 单位 | 数值 |", "|---|---:|---|---|---:|"))
            for item in observations:
                observation_value = item.get("value", "—")
                if item.get("unit") == "%" and isinstance(observation_value, (int, float)):
                    observation_value *= 100
                lines.append(
                    f"| {_safe(item.get('entity', item.get('country', '—')))} | "
                    f"{_safe(item.get('year', '—'))} | "
                    f"{_STUDENT_METRIC_LABELS.get(str(item.get('metric')), _safe(item.get('metric', '—')))} | "
                    f"{_safe(item.get('unit', '—'))} | "
                    f"{_number(observation_value) if isinstance(observation_value, (int, float)) else _safe(observation_value)} |"
                )
        elif compared:
            lines.append("- 本步仅保存比较对象，未记录代表指标数值。")
        lines.append("")

    shock = _step_data(session, 10)
    if shock.get("viewed_teaching_panel"):
        captured = True
        lines.extend(
            (
                "### 步骤 10 · 模拟关税数据",
                "",
                (
                    f"- 两国趋势示例：{'、'.join(_safe(value) for value in shock.get('compared', []))} · "
                    f"{_safe(shock.get('teaching_industry'))} · 全部可用年份"
                    if isinstance(shock.get("compared"), list) and len(shock["compared"]) == 2
                    else f"- 查看对象：{_safe(shock.get('teaching_country'))} · {_safe(shock.get('teaching_year'))}"
                ),
                f"- 模拟版本：{_safe(shock.get('teaching_panel_version'))}",
                "- X = 首年销往美国的出口份额 × 虚构税率；并非美国真实政策。",
            )
        )
        teaching_observation = shock.get("teaching_observation")
        if isinstance(teaching_observation, dict):
            lines.extend(
                (
                    f"- 自动保存的代表行：{_safe(teaching_observation.get('country'))} · "
                    f"{_safe(teaching_observation.get('industry'))} · {_safe(teaching_observation.get('year'))}",
                    f"- w={_number(float(teaching_observation['teaching_export_share_w']) * 100)}%；"
                    f"τ={_number(float(teaching_observation['teaching_tariff_rate_tau']) * 100)}%；"
                    f"X=w×τ={_number(float(teaching_observation['teaching_tariff_exposure']))}",
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
        "### 四类指标并读（预先指定结果族）",
        "",
        "这四步分别估计贸易流、生产、长度和网络；四项结果必须完整报告，不能只挑区间未跨 0 的结果。"
        "下表列出各步实际保存的可报告结果；系数因量纲和估计对象不同不能比大小，"
        "网络项还是未经边阈值敏感性检验的探索性拓扑基准。",
        "",
        "| 步骤 | 指标 | 冲击 | 比较方式 | 估计对象与相对变化 | 95% 区间 | 证据判断 |",
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
        evidence, _interpretation = _evidence_reading(outcome, coefficient, suppressed)
        lines.append(
            f"| {step} | {_safe(design.get('depvar_label', outcome))} | "
            f"{_setting_value('shock_type', design.get('shock_type'))} | "
            f"{_setting_value('method', design.get('method'))} | {_safe(effect_label)}：{effect} | {interval} | {evidence} |"
        )
    lines.append("")
    if len({item for item in designs}) > 1:
        lines.extend(
            (
                "- **读表注意：** 上表各行的冲击、比较方式或控制设定并不相同，只能并列查看，不能当成同一个系数比较。",
                "",
            )
        )
    return lines


def _evidence_summary(runs: list[dict[str, Any]]) -> list[str]:
    lines = [
        "## 关键证据摘要",
        "",
        "本节把保存的主要估计翻译成课堂中的单位和证据判断。完整方程、全部控制项与诊断保留在后面的技术附录。",
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
            "（对照表采用）"
            if used_in_table
            else ("（探索结果，未列入对照表）" if not _result_is_qualified(result, design) else "")
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
        evidence, interpretation = _evidence_reading(outcome, coefficient, suppressed)
        setting = " · ".join(
            _setting_value(key, design.get(key))
            for key in ("shock_type", "method", "granularity", "control_mode", "scenario")
            if design.get(key) not in (None, "")
        )
        lines.extend(
            (
                "| 项目 | 学生可读结果 |",
                "|---|---|",
                f"| 研究对象 | {_safe(design.get('depvar_label', outcome))} |",
                f"| 保存的模型 | {setting or '—'} |",
                f"| {effect_label} | **{effect}** |",
                f"| 95% 置信区间 | {interval} |",
                f"| 证据判断 | **{evidence}** |",
                f"| 设计状态 | {_STATUS_LABELS.get(status, _STATUS_LABELS['unknown'])} |",
                "",
                f"- **可以支持的表述：** {interpretation}",
                "- **不能支持的表述：** 本结果不能自动证明拟真政策冲击导致了现实中的 GVC 变化。",
            )
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
    lines = ["", "| 变量 | 点估计 | 标准误 | 95% 置信区间 | p 值 |", "|---|---:|---:|---:|---:|"]
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
                    f"- 结果量纲：{_OUTCOME_UNITS.get(run['outcome'], '原始单位')}",
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
            notes = [_safe(note) for note in _list_values(result.get("notes"))]
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


def _qc_disclosure_section(summary: dict[str, Any], integrity: Any) -> list[str]:
    status = integrity.get("status") if isinstance(integrity, dict) else "unknown"
    lines = [
        "## 数据完整性与诊断披露",
        "",
        f"- 自动完整性验证：{'通过' if status == 'passed' else '状态未知'}。文件哈希、结构、键覆盖和来源绑定属于发布门槛。",
        "- 发布政策：完整性、逆矩阵有效性及计算恒等式失败阻断发布；经济账户异常、范围诊断和回归设计限制仍完整保留并在此披露。",
    ]
    for key, label in (("fatal", "非阻断诊断发现"), ("warning", "警告"), ("disclosure", "补充披露")):
        if summary[key]:
            lines.append(f"- {label}：{'、'.join(summary[key])}")
    lines.append("")
    return lines


__all__=[n for n in globals() if not n.startswith("__")]
