"""第 16 步实验报告：由服务端从答题结果与自动保存的实验状态生成。

步骤 1–15 只以答题通过作为报告门槛。切片、筛选、图表和运行结果是可选的
会话快照，不影响完成度。报告只复估当前学生真实运行过、且能绑定当前
assignment/attempt/manifest 的回归；没有运行时明确记为未记录，不补跑默认模型。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast

import pandas as pd

from gvcsim import artifacts, evidence, quizzes, trusted_evidence
from gvcsim.regression.design import (
    CONTROL_MODES,
    GRANULARITIES,
    METHODS,
    PRICE_MODES,
    SCENARIOS,
    SHOCK_TYPES,
    RegressionDesign,
)
from gvcsim.regression.panel import ROW_CODE, RegressionResult, run_design
from gvcsim.report import _industry_network_top, _load_panel, _load_panel_file
from gvcsim.session import SESSION_VERSION
from gvcsim.shocks import SHOCK_LABELS
from gvcsim.steps import STEPS

GATE_STEPS = tuple(n for n in sorted(evidence.STEP_LABS) if evidence.STEP_LABS[n] != "rep")
_STEP_TITLES: dict[int, str] = {cast(int, item["n"]): cast(str, item["title"]) for item in STEPS}
_STEP_OUTCOMES: dict[int, str] = {
    cast(int, item["n"]): cast(str, item["regression_outcome"]) for item in STEPS if item.get("regression_outcome")
}

_REG_SETTING_ENUMS: dict[str, set[str]] = {
    "granularity": set(GRANULARITIES),
    "shockType": set(SHOCK_TYPES),
    "method": set(METHODS),
    "controlMode": set(CONTROL_MODES),
    "priceMode": set(PRICE_MODES),
    "scenario": set(SCENARIOS),
    "weightMode": {"fixed_pretreatment", "contemporaneous"},
}

_SNAPSHOT_FIELDS = (
    "slice",
    "observation",
    "year",
    "chart",
    "compared",
    "metric",
    "observations",
    "drill",
    "viewed_shock_types",
    "viewed_events",
)

_STATUS_LABELS = {
    "ok": "可按课程口径解释",
    "warning": "可展示,但须披露设计问题",
    "insufficient": "处理支持度不足,已抑制推断",
    "invalid_design": "设计与处理路径不相容,已停止推断",
}


class ReportGateError(RuntimeError):
    """前 15 步答题未全部通过，不能生成报告。"""

    def __init__(self, missing: list[dict[str, Any]]):
        self.missing = missing
        super().__init__("实验报告需要先通过第 1–15 步的理解检查")


@dataclass
class TeachingReport:
    report_key: str
    markdown: str
    provenance: dict[str, Any]
    suggested_filename: str


def check_gate(
    session: dict[str, Any], *, subject: str | None = None, require_trusted: bool = False
) -> list[dict[str, Any]]:
    """返回尚未答题通过的步骤；空列表表示可以生成报告。"""
    blocked = []
    for step in GATE_STEPS:
        item = evidence.evaluate_step(step, session, subject=subject, require_trusted=require_trusted)
        if not item.complete:
            blocked.append({"step": step, "title": _STEP_TITLES.get(step, ""), "missing": item.missing})
    return blocked


def _step_data(session: dict[str, Any], step: int) -> dict[str, Any]:
    record = session.get("steps", {}).get(str(step))
    data = record.get("data") if isinstance(record, dict) else None
    return data if isinstance(data, dict) else {}


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _settings_to_design(outcome: str, settings: dict[str, Any]) -> tuple[RegressionDesign, str] | None:
    """把合法的客户端设置还原成设计；可选实验状态有问题时忽略，不阻塞报告。"""
    for key, allowed in _REG_SETTING_ENUMS.items():
        value = settings.get(key)
        if value is not None and value not in allowed:
            return None
    if "interaction" in settings and not isinstance(settings["interaction"], bool):
        return None
    kwargs: dict[str, Any] = {"outcome": outcome}
    for key, field in (
        ("granularity", "granularity"),
        ("shockType", "shock_type"),
        ("method", "method"),
        ("controlMode", "control_mode"),
        ("priceMode", "price_mode"),
        ("scenario", "scenario"),
    ):
        value = settings.get(key)
        if isinstance(value, str) and value:
            kwargs[field] = value
    if isinstance(settings.get("interaction"), bool):
        kwargs["interaction"] = settings["interaction"]
    try:
        return RegressionDesign(**kwargs), str(settings.get("weightMode") or "fixed_pretreatment")
    except (KeyError, ValueError):
        return None


def _claims_to_design(outcome: str, claims: dict[str, Any]) -> tuple[RegressionDesign, str] | None:
    design_data = _as_dict(claims.get("design"))
    if design_data.get("outcome") != outcome:
        return None
    kwargs: dict[str, Any] = {"outcome": outcome}
    for key in ("granularity", "shock_type", "method", "control_mode", "price_mode", "scenario"):
        value = design_data.get(key)
        if isinstance(value, str) and value:
            kwargs[key] = value
    if isinstance(design_data.get("interaction"), bool):
        kwargs["interaction"] = design_data["interaction"]
    if isinstance(design_data.get("exclude_row"), bool):
        kwargs["exclude_row"] = design_data["exclude_row"]
    try:
        design = RegressionDesign(**kwargs)
    except (KeyError, ValueError):
        return None
    weight_mode = str(design_data.get("weight_mode") or "fixed_pretreatment")
    if weight_mode not in _REG_SETTING_ENUMS["weightMode"]:
        return None
    return design, weight_mode


def _saved_run_design(
    session: dict[str, Any],
    step: int,
    outcome: str,
    *,
    subject: str | None,
    require_trusted: bool,
) -> tuple[RegressionDesign, str] | None:
    data = _step_data(session, step)
    run = _as_dict(data.get("run"))
    if not run:
        return None
    settings = _as_dict(run.get("settings"))
    if require_trusted:
        if not subject:
            return None
        claims = trusted_evidence.verify_regression_run(
            data.get("run_id"),
            subject=subject,
            manifest_id=str(session.get("manifest_id") or ""),
            outcome=outcome,
            settings=settings,
            step=step,
        )
        return _claims_to_design(outcome, claims) if claims else None
    return _settings_to_design(outcome, settings)


def _rerun_recorded(session: dict[str, Any], *, subject: str | None, require_trusted: bool) -> list[dict[str, Any]]:
    """只复估学生实际运行过且可信的回归；缺失或无效运行直接略过。"""
    runs: list[dict[str, Any]] = []
    for step, outcome in sorted(_STEP_OUTCOMES.items()):
        saved = _saved_run_design(
            session,
            step,
            outcome,
            subject=subject,
            require_trusted=require_trusted,
        )
        if saved is None:
            continue
        design, weight_mode = saved
        try:
            panel = _load_panel(design)
            if weight_mode == "contemporaneous":
                required = {"tariff_shock_contemporaneous", "treated_contemporaneous"}
                if design.shock_type != "tariff" or not required.issubset(panel.columns):
                    continue
                panel = panel.copy()
                panel[design.shock_col] = panel["tariff_shock_contemporaneous"]
                panel[design.treated_col] = panel["treated_contemporaneous"]
            result: RegressionResult = run_design(panel, design)
        except (KeyError, OSError, ValueError):
            continue
        runs.append(
            {
                "step": step,
                "title": _STEP_TITLES.get(step, ""),
                "outcome": outcome,
                "design": design,
                "result": result,
                "weight_mode": weight_mode,
            }
        )
    return runs


def _experiment_snapshots(session: dict[str, Any]) -> dict[str, Any]:
    """只抽取报告会展示的实验快照，不包含答题和随机收据。"""
    snapshots: dict[str, Any] = {}
    for step in GATE_STEPS:
        if evidence.STEP_LABS[step] in {"qc", "reg"}:
            continue
        data = _step_data(session, step)
        snapshot = {key: data[key] for key in _SNAPSHOT_FIELDS if key in data}
        if snapshot:
            snapshots[str(step)] = snapshot
    return snapshots


def _fingerprint(session: dict[str, Any], manifest_id: str, runs: list[dict[str, Any]], student: str) -> str:
    """内容寻址：只纳入报告实际使用的答案、实验快照与回归设计。"""
    payload = json.dumps(
        {
            "manifest_id": manifest_id,
            "student": student,
            "quizzes": {str(step): _step_data(session, step).get("quiz") for step in GATE_STEPS},
            "snapshots": _experiment_snapshots(session),
            "designs": [{"equation": run["design"].equation(), "weight_mode": run["weight_mode"]} for run in runs],
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _quiz_lines(step: int, data: dict[str, Any]) -> list[str]:
    selected = quizzes.selected_answers(step, data.get("quiz"))
    if not selected:
        return ["- 理解检查：未记录", ""]
    lines: list[str] = []
    for index, item in enumerate(selected, start=1):
        lines += [f"{index}. {item['question']}", f"   - 答案：{item['answer']}"]
    lines.append("")
    return lines


def _quiz_sections(session: dict[str, Any]) -> list[str]:
    lines = [
        "## 2. 理解检查摘要",
        "",
        "以下是步骤 1–15 已通过的选择题答案；答题通过是这些步骤唯一的完成条件。",
        "",
    ]
    for step in GATE_STEPS:
        lines += [f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}", ""]
        lines += _quiz_lines(step, _step_data(session, step))
    return lines


def _snapshot_lines(data: dict[str, Any]) -> list[str]:
    """把不可信的客户端快照压成有限、单行的 Markdown 文本。"""

    def inline(value: Any, limit: int = 180) -> str:
        text = " ".join(str(value).split()).replace("`", "ʼ").replace("|", "¦")
        return text if len(text) <= limit else f"{text[: limit - 1]}…"

    def render_list(value: Any, *, limit: int = 8) -> str:
        if not isinstance(value, list):
            return ""
        items = [inline(item) for item in value[:limit]]
        if len(value) > limit:
            items.append(f"另 {len(value) - limit} 项")
        return "、".join(items)

    lines: list[str] = []
    if isinstance(data.get("slice"), dict):
        slice_ = data["slice"]
        lines.append(
            "- 查看切片："
            + " / ".join(
                inline(slice_.get(key) or "—")
                for key in ("year", "table", "row_country", "row_sector", "col_country", "col_sector")
            )
        )
    if isinstance(data.get("observation"), dict):
        item = data["observation"]
        lines.append(
            f"- 选中单元格：{inline(item.get('row', '—'))} × {inline(item.get('column', '—'))}"
            f" = {inline(item.get('value', '—'))}"
        )
    if isinstance(data.get("year"), int):
        lines.append(f"- 当前年份：{data['year']}")
    if data.get("chart"):
        lines.append(f"- 图表视角：`{inline(data['chart'])}`")
    compared = render_list(data.get("compared"))
    if compared:
        lines.append("- 对比对象：" + compared)
    if data.get("metric"):
        lines.append(f"- 查看指标：`{inline(data['metric'])}`")
    if data.get("drill"):
        lines.append(f"- 下钻对象：{inline(data['drill'])}")
    if isinstance(data.get("observations"), list):
        rendered = []
        for item in data["observations"][:8]:
            if not isinstance(item, dict):
                continue
            entity = item.get("entity") or "·".join(
                inline(item.get(key) or "") for key in ("country", "industry")
            ).strip("·")
            rendered.append(f"{inline(entity)} ({inline(item.get('year', '—'))}) = {inline(item.get('value', '—'))}")
        if rendered:
            lines.append("- 自动保存的观察值：" + "；".join(rendered))
    viewed_types = render_list(data.get("viewed_shock_types"))
    if viewed_types:
        labels = render_list([SHOCK_LABELS.get(str(item), str(item)) for item in data["viewed_shock_types"]])
        lines.append("- 查看过的冲击类别：" + labels)
    viewed_events = render_list(data.get("viewed_events"))
    if viewed_events:
        lines.append("- 打开过的政策事件：" + viewed_events)
    return lines


def _snapshot_sections(session: dict[str, Any]) -> list[str]:
    lines = [
        "## 3. 自动记录的实验过程",
        "",
        "本节来自学生实验会话自动保存的关键界面状态，不追踪逐次点击，也不作为步骤完成条件；这些快照未由服务端重算验证。",
        "",
    ]
    count = 0
    for raw_step, data in _experiment_snapshots(session).items():
        step = int(raw_step)
        rendered = _snapshot_lines(_as_dict(data))
        if not rendered:
            continue
        count += 1
        lines += [f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}", "", *rendered, ""]
    if count == 0:
        lines += ["未记录到可展示的实验快照。", ""]
    return lines


def _top5_table(values: pd.Series, entity_header: str, value_header: str, digits: int) -> list[str]:
    return [
        f"| {entity_header} | {value_header} |",
        "|---|---:|",
        *[f"| {name} | {value:.{digits}f} |" for name, value in values.items()],
        "",
    ]


def _indicator_summary(year: int) -> list[str]:
    country_panel = _load_panel_file("panel_country.csv")
    snap = country_panel[country_panel["year"] == year].copy()
    snap = snap[snap["country"].astype(str) != ROW_CODE]
    if snap.empty:
        raise ReportGateError(
            [{"step": 0, "title": "缺少指标截面", "missing": [f"panel_country.csv 中没有 {year} 年截面"]}]
        )
    snap = snap.set_index("country")
    industry_panel = _load_panel_file("panel_industry.csv")
    return [
        f"## 4. GVC 指标摘要（{year} 年截面）",
        "",
        f"覆盖 {snap.shape[0]} 个经济体。以下是 OECD ICIO 计算出的全局背景，不代表学生执行了回归。",
        "",
        "**FVA 份额最高**（出口中外国增加值占毛出口比重）：",
        "",
        *_top5_table(snap["FVA_share"].nlargest(5), "经济体", "FVA 份额", 3),
        "**GVC 位置指数最高**（前向/后向 GVC 生产长度之比）：",
        "",
        *_top5_table(snap["GVCPs"].nlargest(5), "经济体", "GVCPs", 3),
        "**全球国家×行业网络介数中心性最高**：",
        "",
        *_top5_table(_industry_network_top(industry_panel, year, exclude_row=True), "国家×行业节点", "介数中心性", 1),
    ]


def _qc_sections(qc_manifest: dict[str, Any]) -> list[str]:
    lines = [
        "## 1. 数据质检状态",
        "",
        "本节直接来自当前数据产物的发布质检，不要求学生另行选择或提交处置。",
        "",
    ]
    groups: list[tuple[str, dict[str, Any]]] = []
    for year, status in sorted(_as_dict(qc_manifest.get("years")).items()):
        if isinstance(status, dict):
            groups.append((str(year), status))
    for key, label in (("controls", "控制变量"), ("shocks", "政策冲击")):
        status = qc_manifest.get(key)
        if isinstance(status, dict):
            groups.append((label, status))
    disclosures = 0
    for label, status in groups:
        fatal = [str(item) for item in status.get("fatal") or []]
        warning = [str(item) for item in status.get("warning") or []]
        disclosure = [str(item) for item in status.get("disclosure") or []]
        if not (fatal or warning or disclosure or status.get("override")):
            continue
        disclosures += 1
        lines.append(f"### {label}")
        lines.append("")
        if status.get("override"):
            lines.append("- **包含显式 QC override；下游结果必须持续披露。**")
        if fatal:
            lines.append("- Fatal：" + "、".join(fatal))
        if warning:
            lines.append("- Warning：" + "、".join(warning))
        if disclosure:
            lines.append("- Disclosure：" + "、".join(disclosure))
        lines.append("")
    if disclosures == 0:
        lines += ["当前发布清单没有需要额外披露的 QC 项。", ""]
    return lines


def _coef_rows(result: RegressionResult) -> list[str]:
    rows = []
    for coef in result.coefs:
        ci = f"[{coef.ci_low:.4f}, {coef.ci_high:.4f}]" if coef.ci_low is not None else "—"
        p = f"{coef.p:.3f}" if coef.p is not None else "—"
        rows.append(f"| {coef.name} | {coef.coef:.4f} | {coef.se:.4f} | {ci} | {p} | {coef.stars or '—'} |")
    return rows


def _regression_sections(runs: list[dict[str, Any]]) -> list[str]:
    lines = [
        "## 5. 学生实际运行的教学回归",
        "",
        "这里只收录与当前学生、作业尝试和数据版本匹配的运行，并由服务端按原设计重新估计。未运行的步骤不会自动补跑默认模型。",
        "",
    ]
    run_steps = {int(run["step"]) for run in runs}
    for step in sorted(_STEP_OUTCOMES):
        if step not in run_steps:
            lines.append(f"- 步骤 {step} · {_STEP_TITLES.get(step, '')}：未记录学生运行。")
    if len(run_steps) < len(_STEP_OUTCOMES):
        lines.append("")

    for run in runs:
        result: RegressionResult = run["result"]
        design: RegressionDesign = run["design"]
        status = result.status or "ok"
        lines += [
            f"### 步骤 {run['step']} · {run['title']}",
            "",
            "- 来源：学生实际运行，服务端已校验并复估",
            f"- 被解释变量：{design.depvar_label}",
            f"- 政策冲击：{design.shock_type_label}  ·  方法：{design.method_label}  ·  粒度：{design.granularity_label}",
            f"- 控制：{design.control_mode_label}  ·  样本：{design.sample_filter}",
            f"- 暴露权重：{'首次处理前固定（主口径）' if run['weight_mode'] == 'fixed_pretreatment' else '当期贸易结构（仅稳健性）'}",
            f"- **设计有效性：{status} — {_STATUS_LABELS.get(status, status)}**",
            "",
            "| 变量 | 系数 | 聚类标准误 | 95% 置信区间 | p | 显著性 |",
            "|---|---:|---:|---:|---:|:---:|",
            *_coef_rows(result),
            "",
            f"N = {result.n_obs}；聚类 {result.n_clusters} 组"
            + (
                f"（处理聚类 {result.support['treated_clusters']}、对照聚类 {result.support['untreated_clusters']}）"
                if result.support
                else ""
            ),
            "",
        ]
        if result.status_reasons:
            lines += ["设计问题：", "", *[f"- {reason}" for reason in result.status_reasons], ""]
        support = result.support or {}
        lines += [
            "结构化设计预检：",
            "",
            f"- 处理聚类 / 永不处理聚类：{support.get('treated_clusters', '—')} / {support.get('untreated_clusters', '—')}",
            f"- 处理撤销实体：{len(support.get('reversal_entities') or [])}；占处理后个体年 {support.get('reversal_share', 0):.2%}",
            f"- 推断是否抑制：{'是' if support.get('suppress_inference') else '否'}",
            "",
        ]
        if result.support and result.support.get("untreated_clusters") == 0:
            lines += ["- **预检警告**：没有永不处理聚类；结论仅依赖错位处理时点。", ""]
        if design.outcome == "network":
            lines += ["- **预检警告**：网络节点间存在干扰/外溢，传统 SUTVA 不成立。", ""]
        if result.marginal_effects:
            lines += [
                "服务端按完整协方差矩阵计算的条件边际效应：",
                "",
                "| 政策项 | 基期 GVC 水平 | 中心化值 | 效应 | 聚类标准误 | 95% 置信区间 |",
                "|---|---|---:|---:|---:|---:|",
            ]
            for item in result.marginal_effects:
                interval = f"[{item['ci_low']:.4f}, {item['ci_high']:.4f}]" if item.get("ci_low") is not None else "—"
                lines.append(
                    f"| {item['policy_term']} | {item['label']} | {item['baseline_gvc_centered']:.4f} | "
                    f"{item['effect']:.4f} | {item['se']:.4f} | {interval} |"
                )
            lines.append("")
    return lines


def _limitations(runs: list[dict[str, Any]]) -> list[str]:
    granularities = "、".join(sorted({run["design"].granularity_label for run in runs})) or "未记录学生回归"
    return [
        "## 7. 结论与限制",
        "",
        f"- 本报告由服务端从当前实验会话生成；前 15 步答题通过后即可产出（回归粒度：{granularities}）。",
        "- 自动保存的筛选和观察值只是实验快照，不是完成凭证，也不应被解释为因果证据。",
        "- 冲击变量为**拟真演示面板**；即使未来接入真实事件数据，仍需论证冲击外生性、趋势可比性、处理效应异质性并完成稳健性检验。",
        "- 控制变量支持 ICIO 内生派生与 WDI/IMF 风格宏观 mock；**GDP 平减指数为拟真 mock，不是官方价格指数**。",
        "- 指标采用公开文献口径：WWZ (2013) 总贸易核算、WWYZ (2017) 生产分解与生产长度，以及 Gephi-compatible 有向网络中心性；本报告不输出 exporter-importer-sector 双边矩阵明细。",
        "- 被标为 `insufficient` 或 `invalid_design` 的估计已抑制推断量；这不代表“没有效应”。",
        "",
    ]


def _render(session: dict[str, Any], student: str, runs: list[dict[str, Any]], provenance: dict[str, Any]) -> str:
    years = provenance["artifact"]["years"]
    lines: list[str] = [
        "# 贸易政策冲击对全球价值链结构的影响",
        "",
        f"学生：{student}  ·  内容版本：`{provenance['session_fingerprint']}`",
        "",
        "> **数据边界**：结果变量与网络指标来自真实 OECD ICIO "
        f"（{years[0]}–{years[-1]}）；政策冲击为确定性教学 mock。"
        "本报告用于练习识别与推断，不构成现实政策结论。",
        "",
    ]
    lines += _qc_sections(_as_dict(provenance["artifact"].get("qc")))
    lines += _quiz_sections(session)
    lines += _snapshot_sections(session)
    lines += _indicator_summary(int(years[-1]))
    lines += _regression_sections(runs)

    build = provenance["artifact"].get("build") or {}
    runtime = build.get("runtime") or {}
    package_versions = runtime.get("packages") or {}
    runtime_summary = " / ".join(
        [
            f"Python {runtime.get('python', '—')}",
            f"pandas {package_versions.get('pandas', '—')}",
            f"numpy {package_versions.get('numpy', '—')}",
            f"linearmodels {package_versions.get('linearmodels', '—')}",
        ]
    )
    lines += [
        "## 6. 溯源与状态",
        "",
        "| 项 | 值 |",
        "|---|---|",
        f"| 报告指纹 report_key | `{provenance['report_key']}` |",
        f"| 产物清单 manifest_id | `{provenance['manifest_id']}` |",
        f"| 会话契约版本 | `{provenance['session_version']}` |",
        f"| 报告状态 | `{provenance['status']}` |",
        f"| 产物 schema / 网络算法 | `{provenance['artifact']['schema_version']}` / `{provenance['artifact']['network_algorithm']}` |",
        f"| 构建 Git commit / dirty | `{build.get('git_commit', '—')}` / `{build.get('git_dirty', '—')}` |",
        f"| 影响产物的 source tree SHA-256 | `{build.get('source_tree_sha256', '—')}` |",
        f"| 构建运行环境 | {runtime_summary} |",
        "",
        "同一组答题结果、报告中展示的实验快照、实际回归设计与数据产物会得到同一个 report_key。",
        "",
    ]
    lines += _limitations(runs)
    return "\n".join(lines)


def build(
    session: dict[str, Any],
    student: str,
    session_revision: int,
    *,
    subject: str | None = None,
    require_trusted: bool = False,
) -> TeachingReport:
    """从实验会话生成报告；前 15 步答题未通过时抛 ReportGateError。"""
    blocked = check_gate(session, subject=subject, require_trusted=require_trusted)
    if blocked:
        raise ReportGateError(blocked)

    manifest_id = artifacts.manifest_id()
    if session.get("manifest_id") != manifest_id:
        raise ReportGateError(
            [{"step": 0, "title": "数据产物已更新", "missing": ["实验会话对应的产物已过期，请重新答题后再生成报告"]}]
        )

    runs = _rerun_recorded(session, subject=subject, require_trusted=require_trusted)
    report_key = _fingerprint(session, manifest_id, runs, student)
    contract = artifacts.artifact_contract()
    from gvcsim.config import processed_years

    provenance = {
        "report_key": report_key,
        "session_fingerprint": report_key,
        "manifest_id": manifest_id,
        "session_revision": session_revision,
        "session_version": SESSION_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": "generated",
        "artifact": {**contract, "years": processed_years(), **artifacts.manifest_provenance()},
        "runs": [
            {
                "step": run["step"],
                "outcome": run["outcome"],
                "design": run["design"].equation(),
                "status": run["result"].status,
                "weight_mode": run["weight_mode"],
                "source": "student_run",
            }
            for run in runs
        ],
    }
    markdown = _render(session, student, runs, provenance)
    provenance["content_sha256"] = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
    return TeachingReport(
        report_key=report_key,
        markdown=markdown,
        provenance=provenance,
        suggested_filename=f"gvc_experiment_report_{report_key}.md",
    )
