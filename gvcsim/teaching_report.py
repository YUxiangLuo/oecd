"""Generate the step-16 report from the saved experiment session."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast

from gvcsim import evidence, quizzes
from gvcsim.artifacts import NETWORK_ALGORITHM, dataset_metadata
from gvcsim.config import processed_years
from gvcsim.data.citations import report_source_disclosures, report_source_label
from gvcsim.session import SESSION_VERSION
from gvcsim.steps import STEPS

GATE_STEPS = tuple(step for step in sorted(evidence.STEP_LABS) if evidence.STEP_LABS[step] != "rep")
_STEP_TITLES = {cast(int, item["n"]): cast(str, item["title"]) for item in STEPS}
_STEP_OUTCOMES = {
    cast(int, item["n"]): cast(str, item["regression_outcome"])
    for item in STEPS
    if item.get("regression_outcome")
}
_OUTCOME_UNITS = {
    "trade": "份额原始单位（乘以 100 后按百分点解释）",
    "production": "份额原始单位（乘以 100 后按百分点解释）",
    "length": "生产环节长度单位",
    "network": "介数中心性原始单位；跨指标比较时另参考样本标准差单位",
}
_STATUS_LABELS = {
    "ok": "可报告",
    "warning": "需谨慎解释",
    "insufficient": "处理支持度不足",
    "invalid_design": "设计无效",
    "unknown": "未记录设计状态",
}


class ReportGateError(RuntimeError):
    def __init__(self, missing: list[dict[str, Any]]):
        self.missing = missing
        super().__init__("实验报告需要先通过第 1–15 步的理解检查")


@dataclass
class TeachingReport:
    markdown: str
    provenance: dict[str, Any]
    suggested_filename: str


def _step_data(session: dict[str, Any], step: int) -> dict[str, Any]:
    record = session.get("steps", {}).get(str(step))
    data = record.get("data") if isinstance(record, dict) else None
    return data if isinstance(data, dict) else {}


def check_gate(session: dict[str, Any], **_unused: Any) -> list[dict[str, Any]]:
    blocked = []
    for step in GATE_STEPS:
        result = evidence.evaluate_step(step, session)
        if not result.complete:
            blocked.append({"step": step, "title": _STEP_TITLES.get(step, ""), "missing": result.missing})
    return blocked


def _safe(value: Any, limit: int = 240) -> str:
    rendered = " ".join(str(value).split()).replace("|", "¦").replace("`", "ʼ")
    return rendered[:limit]


def _saved_runs(session: dict[str, Any]) -> list[dict[str, Any]]:
    """Use stored design/result objects directly; malformed optional runs are ignored."""
    runs: list[dict[str, Any]] = []
    for step, outcome in sorted(_STEP_OUTCOMES.items()):
        run = _step_data(session, step).get("run")
        if not isinstance(run, dict):
            continue
        design, result = run.get("design"), run.get("result")
        if not isinstance(design, dict) or not isinstance(result, dict) or design.get("outcome") != outcome:
            continue
        coefs = result.get("coefs")
        if not isinstance(coefs, list):
            continue
        runs.append({"step": step, "outcome": outcome, "design": design, "result": result})
    return runs


def _quiz_sections(session: dict[str, Any]) -> list[str]:
    lines = ["## 理解检查摘要", ""]
    for step in GATE_STEPS:
        selected = quizzes.selected_answers(step, _step_data(session, step).get("quiz"))
        lines.extend((f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}", ""))
        for item in selected:
            lines.append(f"- {_safe(item['question'])}：{_safe(item['answer'])}")
        lines.append("")
    return lines


def _list_values(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


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
    slice_ = db.get("slice") if isinstance(db.get("slice"), dict) else None
    observation = db.get("observation") if isinstance(db.get("observation"), dict) else None
    if slice_ or observation:
        captured = True
        lines.extend(("### 步骤 1 · OECD ICIO 数据浏览", ""))
        if slice_:
            selection = "；".join(
                f"{label}={_safe(slice_.get(key, '—'))}"
                for key, label in (
                    ("year", "年份"), ("table", "表"), ("row_country", "供给国"),
                    ("row_sector", "供给行业"), ("col_country", "使用/需求国"),
                    ("col_sector", "使用行业/最终需求"),
                )
                if slice_.get(key) not in (None, "")
            )
            lines.append(f"- 保存的切片：{selection or '—'}")
        if observation:
            lines.append(
                f"- 记录的单元格：{_safe(observation.get('row', '—'))} × "
                f"{_safe(observation.get('column', '—'))} = {_safe(observation.get('value', '—'))}"
            )
        lines.append("")

    for step in range(3, 11):
        data = _step_data(session, step)
        compared = _list_values(data.get("compared"))
        observations = [item for item in _list_values(data.get("observations")) if isinstance(item, dict)]
        has_snapshot = any(
            data.get(key) not in (None, "", []) for key in ("year", "country", "chart", "drill", "metric")
        ) or bool(compared or observations)
        if not has_snapshot:
            continue
        captured = True
        lines.extend((f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}", ""))
        context = []
        for key, label in (("year", "年份"), ("country", "国家"), ("chart", "图表视角"), ("drill", "下钻")):
            if data.get(key) not in (None, ""):
                context.append(f"{label}={_safe(data[key])}")
        if context:
            lines.append(f"- 保存的视图：{'；'.join(context)}")
        if compared:
            lines.append(f"- 主动比较：{'、'.join(_safe(item) for item in compared)}")
        if observations:
            lines.extend((f"- 记录指标：`{_safe(data.get('metric', '—'))}`", "", "| 实体 | 年份 | 数值 |", "|---|---:|---:|"))
            for item in observations:
                lines.append(
                    f"| {_safe(item.get('entity', item.get('country', '—')))} | "
                    f"{_safe(item.get('year', '—'))} | {_safe(item.get('value', '—'))} |"
                )
        lines.append("")

    shock = _step_data(session, 11)
    viewed_types = _list_values(shock.get("viewed_shock_types"))
    viewed_events = _list_values(shock.get("viewed_events"))
    selected_event = shock.get("selected_event_key")
    if viewed_types or viewed_events or selected_event:
        captured = True
        lines.extend(("### 步骤 11 · 贸易政策冲击数据接入", ""))
        if viewed_types:
            lines.append(f"- 查看过的冲击类型：{'、'.join(_safe(item) for item in viewed_types)}")
        if viewed_events:
            lines.append(f"- 查看过的政策事件：{'、'.join(_safe(item) for item in viewed_events)}")
        if selected_event:
            lines.append(f"- 最后选择的事件：{_safe(selected_event)}（仅用于探索定位，不限定下游回归样本）")
        lines.extend((
            "- 下游回归口径：按所选冲击类型汇总该类型全部已编码事件的国家×行业暴露，不把单个事件选择当作回归筛选。",
            "",
        ))

    if not captured:
        lines.extend(("- 未保存额外实验快照。", ""))
    return lines


def _run_sections(runs: list[dict[str, Any]]) -> list[str]:
    lines = [
        "## 保存的回归结果",
        "",
        "报告直接展示实验中最后保存的服务端运行结果，不会重新估计。点估计是条件相关性的估计量；只有设计有效、处理支持充分且识别假设成立时，才可进一步讨论因果解释。",
        "",
    ]
    by_step = {run["step"]: run for run in runs}
    for step in sorted(_STEP_OUTCOMES):
        run = by_step.get(step)
        if not run:
            lines.append(f"- 步骤 {step} · {_STEP_TITLES.get(step, '')}：未记录。")
            continue
        design, result = run["design"], run["result"]
        support = result.get("support") if isinstance(result.get("support"), dict) else {}
        status = result.get("status") or support.get("status") or "unknown"
        reasons = [*_list_values(result.get("status_reasons")), *_list_values(support.get("reasons"))]
        reasons = list(dict.fromkeys(_safe(reason) for reason in reasons))
        suppressed = bool(support.get("suppress_inference")) or status in ("insufficient", "invalid_design")
        lines.extend((
            f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}", "",
            f"- 因变量：{_safe(design.get('depvar_label', run['outcome']))}",
            f"- 结果量纲：{_OUTCOME_UNITS.get(run['outcome'], '原始单位')}",
            f"- 方程：`{_safe(design.get('equation', '—'))}`",
            f"- 设计状态：{_STATUS_LABELS.get(str(status), _safe(status))}（`{_safe(status)}`）；观测数：{_safe(result.get('n_obs', '—'))}",
        ))
        setting_bits = [
            f"{label}={_safe(design[key])}"
            for key, label in (
                ("granularity", "粒度"), ("shock_type", "冲击类型"), ("method", "方法"),
                ("control_mode", "控制变量"), ("price_mode", "价格口径"), ("scenario_label", "教学场景"),
            )
            if design.get(key) not in (None, "")
        ]
        if setting_bits:
            lines.append(f"- 保存的设定：{'；'.join(setting_bits)}")
        if reasons:
            lines.append(f"- 状态原因：{'；'.join(reasons)}")
        if support:
            support_bits = []
            for key, label in (
                ("treated_entities", "处理个体"), ("treated_clusters", "处理聚类"),
                ("untreated_clusters", "对照聚类"), ("reversal_share", "处理撤销行占比"),
            ):
                if support.get(key) is not None:
                    support_bits.append(f"{label}={_safe(support[key])}")
            if support_bits:
                lines.append(f"- 处理支持：{'；'.join(support_bits)}")
        if suppressed:
            lines.append("- **统计推断已抑制**：下表点估计仅说明计算输出；不得把缺失的 p 值或置信区间解释为无效应，也不得据此形成方向性结论。")
        lines.extend(("", "| 变量 | 点估计 | 标准误 | 95% 置信区间 | p 值 |", "|---|---:|---:|---:|---:|"))
        for coefficient in result.get("coefs", []):
            if isinstance(coefficient, dict):
                ci_low, ci_high = coefficient.get("ci_low"), coefficient.get("ci_high")
                interval = "已抑制" if suppressed and (ci_low is None or ci_high is None) else (
                    f"[{_safe(ci_low)}, {_safe(ci_high)}]" if ci_low is not None and ci_high is not None else "—"
                )
                p_raw = coefficient.get("p")
                p_value = "已抑制" if suppressed and p_raw is None else (_safe(p_raw) if p_raw is not None else "—")
                lines.append(
                    f"| {_safe(coefficient.get('name', '—'))} | {_safe(coefficient.get('coef', '—'))} | "
                    f"{_safe(coefficient.get('se', '—'))} | {interval} | {p_value} |"
                )
        marginal_effects = [
            item for item in _list_values(result.get("marginal_effects")) if isinstance(item, dict)
        ]
        if marginal_effects:
            lines.extend((
                "", "交互模型边际效应（主效应与交互项的线性组合）：", "",
                "| 政策项 | 处理前 GVC 水平 | 边际效应 | 95% 置信区间 | p 值 |",
                "|---|---|---:|---:|---:|",
            ))
            for item in marginal_effects:
                ci_low, ci_high = item.get("ci_low"), item.get("ci_high")
                interval = "已抑制" if suppressed and (ci_low is None or ci_high is None) else (
                    f"[{_safe(ci_low)}, {_safe(ci_high)}]" if ci_low is not None and ci_high is not None else "—"
                )
                p_raw = item.get("p")
                p_value = "已抑制" if suppressed and p_raw is None else (_safe(p_raw) if p_raw is not None else "—")
                lines.append(
                    f"| {_safe(item.get('policy_term', '—'))} | {_safe(item.get('label', '—'))} | "
                    f"{_safe(item.get('effect', '—'))} | {interval} | {p_value} |"
                )
        diagnostics = result.get("diagnostics") if isinstance(result.get("diagnostics"), dict) else {}
        pretrend = diagnostics.get("pretrend") if isinstance(diagnostics.get("pretrend"), dict) else None
        if pretrend:
            if pretrend.get("available"):
                lines.append(
                    f"- 冲击前趋势联合检验：F={_safe(pretrend.get('statistic', '—'))}，"
                    f"p={_safe(pretrend.get('p', '—'))}；{_safe(pretrend.get('interpretation', ''))}"
                )
            else:
                lines.append(
                    f"- 冲击前趋势联合检验：不可评估；{_safe(pretrend.get('interpretation') or pretrend.get('reason') or '未提供原因')}"
                )
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
        for severity in ("fatal", "warning", "disclosure"):
            names = value.get(severity)
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


def _qc_disclosure_section(summary: dict[str, Any]) -> list[str]:
    if not summary["requires_disclosure"]:
        return []
    lines = ["## 数据质量披露", ""]
    if summary["override"]:
        lines.append("- 本数据版本包含经显式 override 接受的 fatal QC 项，仅可按教学边界使用。")
    for key, label in (("fatal", "Fatal"), ("warning", "Warning"), ("disclosure", "Disclosure")):
        if summary[key]:
            lines.append(f"- {label}：{'、'.join(summary[key])}")
    lines.append("")
    return lines


def build(session: dict[str, Any], student: str, *_unused: Any, **_unused_kw: Any) -> TeachingReport:
    blocked = check_gate(session)
    if blocked:
        raise ReportGateError(blocked)
    years = processed_years()
    if not years:
        raise ReportGateError([{"step": 0, "title": "数据不可用", "missing": ["尚未生成固定数据产物"]}])
    runs = _saved_runs(session)
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    fingerprint = hashlib.sha256(json.dumps(session, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]
    metadata: dict[str, Any] = {}
    try:
        metadata = dataset_metadata()
    except (OSError, ValueError, TypeError, RuntimeError):
        pass
    data_sources = metadata.get("data_sources") if isinstance(metadata.get("data_sources"), dict) else {}
    qc_metadata = metadata.get("qc") if isinstance(metadata.get("qc"), dict) else {}
    qc_summary = _qc_release_summary(qc_metadata)
    network_algorithm = str(metadata.get("network_algorithm") or NETWORK_ALGORITHM)
    provenance = {
        "generated_at": generated_at,
        "years": years,
        "session_version": SESSION_VERSION,
        "session_fingerprint": fingerprint,
        "runs": [{"step": run["step"], "outcome": run["outcome"], "design": run["design"]} for run in runs],
        "algorithm": "WWZ/WWYZ indicators; unweighted path centralities; saved classroom regression output",
        "network_algorithm": network_algorithm,
        "data_sources": data_sources,
        "qc": qc_metadata,
    }
    source = report_source_label(data_sources)
    lines = [
        "# GVC 指标与政策冲击：教学实验记录", "",
        f"学生：{_safe(student)}", "",
        f"> 数据覆盖 {years[0]}–{years[-1]}，指标来源：{_safe(source)}。政策冲击为基于公开事件手工编码的拟真教学面板，不能用于研究结论。", "",
        "> 本报告汇总描述性探索和已保存的教学估计，不证明政策冲击导致了 GVC 变化。因果解释至少依赖冲击外生性、趋势可比性、无同期混杂、处理定义与模型相容，以及处理效应异质性得到妥善处理。", "",
        *_quiz_sections(session), *_experiment_sections(session), *_run_sections(runs), *_qc_disclosure_section(qc_summary),
        "## 数据与方法说明", "",
        "- 指标算法：WWZ/WWYZ 增加值贸易与生产长度口径；网络保留有向正流量边，加权度使用流量权重，介数、距离和特征向量中心性按有向无权网络计算。",
        "- 无权路径口径把每条正流量边视为同样长度，因此高介数表示拓扑上的最短路径中介位置，不自动等于经济规模大、关键瓶颈或不可替代。",
        "- 冲击口径：界面中的单个事件用于定位和理解；回归按冲击类型使用该类型全部已编码事件汇总形成的暴露面板。",
        "- 回归结果来自学生会话中保存的最后一次服务端运行，不在报告生成时复算。",
        f"- 生成时间：{generated_at}；会话摘要：`{fingerprint}`。", "",
        *report_source_disclosures(data_sources), "",
    ]
    markdown = "\n".join(lines)
    provenance["content_sha256"] = hashlib.sha256(markdown.encode()).hexdigest()
    return TeachingReport(markdown, provenance, f"gvc_experiment_report_{fingerprint}.md")
