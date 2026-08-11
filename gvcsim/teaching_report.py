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


def _run_sections(runs: list[dict[str, Any]]) -> list[str]:
    lines = ["## 保存的回归结果", "", "报告直接展示实验中最后保存的运行结果，不会重新估计。", ""]
    by_step = {run["step"]: run for run in runs}
    for step in sorted(_STEP_OUTCOMES):
        run = by_step.get(step)
        if not run:
            lines.append(f"- 步骤 {step} · {_STEP_TITLES.get(step, '')}：未记录。")
            continue
        design, result = run["design"], run["result"]
        lines.extend((
            f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}", "",
            f"- 方程：`{_safe(design.get('equation', '—'))}`",
            f"- 状态：`{_safe(result.get('status', 'ok'))}`；观测数：{_safe(result.get('n_obs', '—'))}", "",
            "| 变量 | 系数 | 标准误 | p 值 |", "|---|---:|---:|---:|",
        ))
        for coefficient in result.get("coefs", []):
            if isinstance(coefficient, dict):
                lines.append(
                    f"| {_safe(coefficient.get('name', '—'))} | {_safe(coefficient.get('coef', '—'))} | "
                    f"{_safe(coefficient.get('se', '—'))} | {_safe(coefficient.get('p', '—'))} |"
                )
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
        "algorithm": "WWZ/WWYZ indicators; saved classroom regression output",
        "network_algorithm": network_algorithm,
        "data_sources": data_sources,
        "qc": qc_metadata,
    }
    source = report_source_label(data_sources)
    lines = [
        "# 贸易政策冲击对全球价值链结构的影响", "",
        f"学生：{_safe(student)}", "",
        f"> 数据覆盖 {years[0]}–{years[-1]}，指标来源：{_safe(source)}。本报告用于教学练习。", "",
        *_quiz_sections(session), *_run_sections(runs), *_qc_disclosure_section(qc_summary),
        "## 数据与方法说明", "",
        "- 指标算法：WWZ/WWYZ 增加值贸易与生产长度口径；网络保留有向正流量边，加权度使用流量权重，介数、距离和特征向量中心性按有向无权网络计算。",
        "- 回归结果来自学生会话中保存的最后一次服务端运行，不在报告生成时复算。",
        f"- 生成时间：{generated_at}；会话摘要：`{fingerprint}`。", "",
        *report_source_disclosures(data_sources), "",
    ]
    markdown = "\n".join(lines)
    provenance["content_sha256"] = hashlib.sha256(markdown.encode()).hexdigest()
    return TeachingReport(markdown, provenance, f"gvc_experiment_report_{fingerprint}.md")
