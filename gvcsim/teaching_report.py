"""第 16 步的实验报告:由服务端从学生的实验会话生成。

HEAD 的第 16 步是一个独立的参数表单,重新生成一份通用系统报告,和前 15 步
毫无关系;提交接口又直接收下客户端给的任意 Markdown。于是"报告已提交"只能
证明有人上传过一段文字——不能证明学生做过课程、不能证明报告对应他保存的实验、
更不能证明里面的回归还对得上当前数据。

本模块给出闭环:

  1. **前置门槛**:1–15 步的学习证据必须齐全,否则拒绝生成。
  2. **服务端复估**:回归按学生保存的设定在服务端重跑,报告里的数字不来自客户端。
  3. **绑定溯源**:report_key(内容指纹)、session revision、manifest_id 一起落库,
     日后可以回答"这份报告由哪套数据、哪次会话、哪个设计生成"。
  4. **学生自己的判断**:质检处置与四步识别判断原样进入报告——这是报告里唯一
     无法由机器复算的部分,也正是教学要留下的东西。

报告正文是普通 GFM(表格 + 文字),复制到任何 Markdown 阅读器都完整可读,
不依赖本系统的私有图表块。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast

import pandas as pd

from gvcsim import artifacts, evidence
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.panel import ROW_CODE, RegressionResult, run_design
from gvcsim.report import _industry_network_top, _load_panel, _load_panel_file
from gvcsim.session import SESSION_VERSION
from gvcsim.steps import STEPS

# 生成报告前必须完成的步骤:除第 16 步自身外的全部。
GATE_STEPS = tuple(n for n in sorted(evidence.STEP_LABS) if evidence.STEP_LABS[n] != "rep")

# STEPS 的字典值是异构的,静态类型只能推出 object,这里在边界处收窄(同 evidence.py)。
_STEP_TITLES: dict[int, str] = {cast(int, s["n"]): cast(str, s["title"]) for s in STEPS}
_STEP_OUTCOMES: dict[int, str] = {
    cast(int, s["n"]): cast(str, s["regression_outcome"]) for s in STEPS if s.get("regression_outcome")
}

_QC_DISPOSITION_LABELS = {
    "stop": "停止分析",
    "fix": "修正数值",
    "disclose": "披露后继续",
}

_STATUS_LABELS = {
    "ok": "可按课程口径解释",
    "warning": "可展示,但须披露设计问题",
    "insufficient": "处理支持度不足,已抑制推断",
    "invalid_design": "设计与处理路径不相容,已停止推断",
}


class ReportGateError(RuntimeError):
    """前 15 步证据不齐,不能生成报告。"""

    def __init__(self, missing: list[dict[str, Any]]):
        self.missing = missing
        super().__init__("实验报告需要先完成第 1–15 步的学习证据")


@dataclass
class TeachingReport:
    report_key: str
    markdown: str
    provenance: dict[str, Any]
    # 学生「另存为」时的建议文件名;带 report_key 便于教师把文件对回具体那份报告。
    suggested_filename: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "report_key": self.report_key,
            "markdown": self.markdown,
            "provenance": self.provenance,
            "suggested_filename": self.suggested_filename,
        }


def check_gate(
    session: dict[str, Any], *, subject: str | None = None, require_trusted: bool = False
) -> list[dict[str, Any]]:
    """返回未完成的前置步骤;空表示可以生成。"""
    blocked = []
    for step in GATE_STEPS:
        item = evidence.evaluate_step(step, session, subject=subject, require_trusted=require_trusted)
        if not item.complete:
            blocked.append({"step": step, "title": _STEP_TITLES.get(step, ""), "missing": item.missing})
    qc_step = next(n for n, lab in evidence.STEP_LABS.items() if lab == "qc")
    if _step_data(session, qc_step).get("disposition") == "stop":
        blocked.append(
            {
                "step": qc_step,
                "title": _STEP_TITLES.get(qc_step, ""),
                "missing": ["你选择了停止分析；必须等待数据修复并重新完成 QC，不能生成或提交下游报告"],
            }
        )
    return blocked


def _step_data(session: dict[str, Any], step: int) -> dict[str, Any]:
    record = session.get("steps", {}).get(str(step))
    data = record.get("data") if isinstance(record, dict) else None
    return data if isinstance(data, dict) else {}


def _settings_to_design(outcome: str, settings: dict[str, Any]) -> RegressionDesign:
    """把学生保存的设定还原成回归设计。

    这里只接受会话里存过的字段;缺失时回落到课程默认值,而不是猜测。

    会话的 data 是客户端可写的不透明 blob,因此必须自己校验入参:
    正常路径上 evidence._check_reg 已经把非法设定挡在门槛外(该步不算完成),
    这里是第二道防线——宁可给出一个可执行的 409,也不要让伪造的设定
    一路走到 SHOCK_SPECS[...] 抛 KeyError、变成一个无从解释的 500。
    """
    bad = evidence.invalid_regression_settings(settings)
    if bad:
        raise ReportGateError(
            [
                {
                    "step": 0,
                    "title": "保存的回归设定无法识别",
                    "missing": [f"设定 {'、'.join(bad)} 不是合法取值;请回到对应回归步骤重新运行"],
                }
            ]
        )
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
        return RegressionDesign(**kwargs)
    except ValueError as error:
        # 枚举值都合法、但组合不成立(如 network outcome 配国家级粒度)。
        raise ReportGateError([{"step": 0, "title": "保存的回归设定不成立", "missing": [str(error)]}]) from error


def _rerun(session: dict[str, Any]) -> list[dict[str, Any]]:
    """按学生保存的设定在服务端重跑四步回归。

    报告里的系数、状态与结论一律来自这次重跑,而不是客户端上传的数字:
    客户端可以显示任何东西,但它改不了服务端用同一份产物重算出的结果。
    """
    runs: list[dict[str, Any]] = []
    for step, outcome in sorted(_STEP_OUTCOMES.items()):
        data = _step_data(session, step)
        settings = (data.get("run") or {}).get("settings") or {}
        design = _settings_to_design(outcome, settings)
        panel = _load_panel(design)
        weight_mode = str(settings.get("weightMode") or "fixed_pretreatment")
        if weight_mode == "contemporaneous":
            required = {"tariff_shock_contemporaneous", "treated_contemporaneous"}
            if design.shock_type != "tariff" or not required.issubset(panel.columns):
                raise ReportGateError(
                    [
                        {
                            "step": step,
                            "title": _STEP_TITLES.get(step, ""),
                            "missing": ["当期权重稳健性设定与当前产物不匹配"],
                        }
                    ]
                )
            panel = panel.copy()
            panel[design.shock_col] = panel["tariff_shock_contemporaneous"]
            panel[design.treated_col] = panel["treated_contemporaneous"]
        result: RegressionResult = run_design(panel, design)
        runs.append(
            {
                "step": step,
                "title": _STEP_TITLES.get(step, ""),
                "outcome": outcome,
                "design": design,
                "result": result,
                "judgment": str(data.get("judgment", "")).strip(),
                "weight_mode": weight_mode,
                "cer": data.get("cer") if isinstance(data.get("cer"), dict) else {},
                "checks": data.get("checks") if isinstance(data.get("checks"), dict) else {},
                "placebo_run_id": str(data.get("placebo_run_id") or ""),
            }
        )
    return runs


def _fingerprint(session: dict[str, Any], manifest_id: str, runs: list[dict[str, Any]], student: str) -> str:
    """报告指纹:同一份会话内容 + 同一套产物 → 同一个 report_key。

    用内容而不是时间戳做键:学生重复点“生成”不会堆出一串实质相同的报告,
    而任何一处证据或数据变化都会得到一个新的 key。
    """

    def semantic(value: Any) -> Any:
        if isinstance(value, dict):
            normalized = {
                key: semantic(item)
                for key, item in value.items()
                if key != "evidence_id" and key != "run_id" and key != "placebo_run_id" and not key.endswith("_run_id")
            }
            # 一个只装随机收据的 checks 容器在去掉 *_run_id 后为空；它与未创建
            # checks 的会话语义相同，不应让重复生成得到不同 report_key。
            if normalized.get("checks") == {}:
                normalized.pop("checks")
            return normalized
        if isinstance(value, list):
            return [semantic(item) for item in value]
        return value

    payload = json.dumps(
        {
            "manifest_id": manifest_id,
            "student": student,
            "steps": {str(n): semantic(_step_data(session, n)) for n in GATE_STEPS},
            "designs": [run["design"].equation() for run in runs],
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _learning_evidence_sections(session: dict[str, Any]) -> list[str]:
    """把步骤 1、3–11 的实际对象、镜头、事件与 CER 原样写入报告。"""
    lines = ["## 2. 我的描述性学习证据", "", "以下内容来自我逐步提交、由服务器绑定当前数据版本的 CER。", ""]
    for step in GATE_STEPS:
        lab = evidence.STEP_LABS[step]
        if lab in {"qc", "reg"}:
            continue
        data = _step_data(session, step)
        cer_value = data.get("cer")
        cer: dict[str, Any] = cer_value if isinstance(cer_value, dict) else {}
        lines += [f"### 步骤 {step} · {_STEP_TITLES.get(step, '')}", ""]
        if isinstance(data.get("slice"), dict):
            slice_ = data["slice"]
            lines.append(
                "- 切片: "
                + " / ".join(
                    str(slice_.get(key) or "—")
                    for key in ("year", "table", "row_country", "row_sector", "col_country", "col_sector")
                )
            )
        if data.get("chart"):
            lines.append(f"- 图表镜头: `{data['chart']}`")
        if data.get("compared"):
            lines.append("- 对比对象: " + "、".join(str(item) for item in data["compared"]))
        if data.get("metric"):
            lines.append(f"- 核查指标: `{data['metric']}`")
        if isinstance(data.get("observations"), list):
            rendered = []
            for item in data["observations"]:
                if isinstance(item, dict):
                    entity = item.get("entity") or "·".join(
                        str(item.get(key) or "") for key in ("country", "industry")
                    ).strip("·")
                    rendered.append(f"{entity} ({item.get('year', '—')}) = {item.get('value', '—')}")
            if rendered:
                lines.append("- 服务端复核数值: " + "；".join(rendered))
        if data.get("viewed_events"):
            lines.append("- 具体政策事件: " + "；".join(str(item) for item in data["viewed_events"]))
        lines += [
            f"- **Claim**: {cer.get('claim', '(未记录)')}",
            f"- **Evidence**: {cer.get('evidence', '(未记录)')}",
            f"- **Reasoning**: {cer.get('reasoning', '(未记录)')}",
            f"- **Boundary**: {cer.get('boundary', '(未记录)')}",
            "",
        ]
    return lines


def _top5_table(values: pd.Series, entity_header: str, value_header: str, digits: int) -> list[str]:
    """Top5 用普通 GFM 表格呈现,不用私有图表块。

    HEAD 这里用的是 ``gvcsim-chart`` fenced JSON,只有本项目的 renderer 认得;
    报告一旦离开本系统(复制到 GitHub、教学平台、批改工具)就只剩一段 JSON。
    表格损失了视觉冲击,但换来"在任何 Markdown 阅读器里都完整可读"。
    """
    return [
        f"| {entity_header} | {value_header} |",
        "|---|---:|",
        *[f"| {name} | {value:.{digits}f} |" for name, value in values.items()],
        "",
    ]


def _indicator_summary(year: int) -> list[str]:
    """GVC 指标摘要:学生做完 11 步指标与可视化之后,报告里该有的描述性画面。

    这是课程固定的全局截面(取最新可用年份),不随学生设定变化——它回答的是
    "这些经济体在 GVC 里长什么样",是后面四个回归的背景,不是学生的实验结果。
    """
    country_panel = _load_panel_file("panel_country.csv")
    snap = country_panel[country_panel["year"] == year].copy()
    snap = snap[snap["country"].astype(str) != ROW_CODE]
    if snap.empty:
        raise ReportGateError(
            [{"step": 0, "title": "缺少指标截面", "missing": [f"panel_country.csv 中没有 {year} 年截面"]}]
        )
    snap = snap.set_index("country")
    industry_panel = _load_panel_file("panel_industry.csv")

    top_fva = snap["FVA_share"].nlargest(5)
    top_gvcpos = snap["GVCPs"].nlargest(5)
    top_between = _industry_network_top(industry_panel, year, exclude_row=True)

    return [
        f"## 3. GVC 指标摘要({year} 年截面)",
        "",
        f"覆盖 {snap.shape[0]} 个经济体。以下是真实 OECD ICIO 计算出的全局画面,"
        "是后面四个回归的背景;它不随我的设定变化。",
        "",
        "**FVA 份额最高**(WWZ 口径,出口中外国增加值占毛出口比重):",
        "",
        *_top5_table(top_fva, "经济体", "FVA 份额", 3),
        "**GVC 位置指数最高**(WWYZ 口径,前向/后向 GVC 生产长度之比,越大越上游):",
        "",
        *_top5_table(top_gvcpos, "经济体", "GVCPs", 3),
        "**全球国家×行业网络介数中心性最高**(供应链枢纽):",
        "",
        *_top5_table(top_between, "国家×行业节点", "介数中心性", 1),
    ]


def _limitations(granularity_label: str) -> list[str]:
    """结论与限制。

    这一段是 HEAD 里写得最好的披露文字:方法学出处、控制变量的真实/mock 身份、
    以及明确声明"本报告不输出什么"。它与证据闭环正交,重建时不该丢。
    """
    return [
        "## 6. 结论与限制",
        "",
        f"- 本报告由服务端从我自己的实验会话生成,前 15 步的学习证据齐全才允许产出(本次回归粒度:{granularity_label})。",
        "- 冲击变量为**拟真演示面板**(事件与量级参考公开资料的手工编码,出口暴露度由 OECD ICIO 双边流向计算)。"
        "即使未来接入真实 PIIE/WTO 数据与官方 HS→ICIO 映射,仍需论证冲击外生性、趋势可比性、"
        "处理效应异质性并完成稳健性检验,才能形成研究结论。",
        "- 控制变量支持 ICIO 内生派生与 WDI/IMF 风格宏观 mock,用于稳健性演示;"
        "**GDP 平减指数为拟真 mock,不是官方价格指数**。论文级研究仍需接入真实 WDI/IMF/行业价格指数。",
        "- 指标采用公开文献口径:WWZ (2013) 总贸易核算法、WWYZ (2017) 生产分解与生产长度,"
        "以及 Gephi 有向全正边网络中心性;国家网络指标如实输出,网络回归仅使用存在节点差异的"
        "国家–行业级结果;本报告不输出 exporter-importer-sector 双边矩阵明细。",
        "- 被标为 `insufficient` 或 `invalid_design` 的估计已抑制 p 值、置信区间与显著性标记:"
        "那不是“没有效应”,而是当前设计无法评估。",
        "",
    ]


def _coef_rows(result: RegressionResult) -> list[str]:
    rows = []
    for coef in result.coefs:
        ci = f"[{coef.ci_low:.4f}, {coef.ci_high:.4f}]" if coef.ci_low is not None else "—"
        p = f"{coef.p:.3f}" if coef.p is not None else "—"
        rows.append(f"| {coef.name} | {coef.coef:.4f} | {coef.se:.4f} | {ci} | {p} | {coef.stars or '—'} |")
    return rows


def _render(session: dict[str, Any], student: str, runs: list[dict[str, Any]], provenance: dict[str, Any]) -> str:
    qc = _step_data(session, next(n for n, lab in evidence.STEP_LABS.items() if lab == "qc"))
    years = provenance["artifact"]["years"]
    lines: list[str] = [
        "# 贸易政策冲击对全球价值链结构的影响",
        "",
        f"学生:{student}  ·  内容版本:`{provenance['session_fingerprint']}`",
        "",
        "> **数据边界**:结果变量与网络指标来自真实 OECD ICIO "
        f"({years[0]}–{years[-1]});"
        "政策冲击(关税/制裁/出口管制)为**确定性 mock**,以真实事件为原型手工编码。"
        "因此本报告可以用来练习识别与推断,**不构成任何现实政策结论**。",
        "",
        "## 1. 数据质检与处置",
        "",
    ]
    qc_manifest = provenance["artifact"].get("qc") or {}
    overridden = [
        f"{year}: {'、'.join(status.get('fatal') or [])}"
        for year, status in (qc_manifest.get("years") or {}).items()
        if isinstance(status, dict) and status.get("override")
    ]
    if overridden:
        lines += [
            "> **QC override 持续披露**:以下 fatal 检查经显式 override 后发布；所有下游数字和推断均受其限制。",
            "",
            *[f"> - {item}" for item in overridden],
            "",
        ]
    disposition = _QC_DISPOSITION_LABELS.get(str(qc.get("disposition")), "(未记录)")
    lines += [
        f"面对质检结果,我的处置是:**{disposition}**。",
        "",
        f"理由:{qc.get('judgment', '(未记录)')}",
        "",
    ]
    if qc.get("failed_checks"):
        lines += ["当前失败检查:", "", *[f"- {item}" for item in qc["failed_checks"]], ""]
    if qc.get("remediation"):
        lines += [f"修正规则:{qc['remediation']}  ·  服务端复检:{'通过' if qc.get('retest_passed') else '未通过'}", ""]
    if qc.get("disclosures"):
        lines += ["持续披露:", "", *[f"- {item}" for item in qc["disclosures"]], ""]
    lines += _learning_evidence_sections(session)
    lines += _indicator_summary(int(years[-1]))
    lines += [
        "## 4. 四步教学实证回归(服务端复估)",
        "",
        "下表由服务端按我在各步保存的设定**重新估计**得到,不是界面上的数字。",
        "",
    ]

    for run in runs:
        result: RegressionResult = run["result"]
        design: RegressionDesign = run["design"]
        status = result.status or "ok"
        lines += [
            f"### 步骤 {run['step']} · {run['title']}",
            "",
            f"- 被解释变量:{design.depvar_label}",
            f"- 政策冲击:{design.shock_type_label}  ·  方法:{design.method_label}  ·  粒度:{design.granularity_label}",
            f"- 控制:{design.control_mode_label}  ·  样本:{design.sample_filter}",
            f"- 暴露权重:{'首次处理前固定（主口径）' if run['weight_mode'] == 'fixed_pretreatment' else '当期贸易结构（仅稳健性）'}",
            f"- **设计有效性:{status} — {_STATUS_LABELS.get(status, status)}**",
            "",
            "| 变量 | 系数 | 聚类标准误 | 95% 置信区间 | p | 显著性 |",
            "|---|---:|---:|---:|---:|:---:|",
            *_coef_rows(result),
            "",
            f"N = {result.n_obs};聚类 {result.n_clusters} 组"
            + (
                f"(处理聚类 {result.support['treated_clusters']}、对照聚类 {result.support['untreated_clusters']})"
                if result.support
                else ""
            ),
            "",
        ]
        if result.status_reasons:
            lines += ["设计问题:", ""] + [f"- {reason}" for reason in result.status_reasons] + [""]
        support = result.support or {}
        lines += [
            "结构化设计预检:",
            "",
            f"- 处理聚类 / 永不处理聚类: {support.get('treated_clusters', '—')} / {support.get('untreated_clusters', '—')}",
            f"- 处理撤销实体: {len(support.get('reversal_entities') or [])}；占处理后个体年 {support.get('reversal_share', 0):.2%}",
            f"- 推断是否抑制: {'是' if support.get('suppress_inference') else '否'}",
            "",
        ]
        if result.support and result.support.get("untreated_clusters") == 0:
            lines += ["- **预检警告**:没有永不处理聚类；结论仅依赖错位处理时点。", ""]
        if design.outcome == "network":
            lines += ["- **预检警告**:网络节点间存在干扰/外溢，传统 SUTVA 不成立。", ""]
        checks = run["checks"]
        if run["step"] == 12:
            lines += [
                "- 必做对照:无控制 baseline 与加入控制模型均有服务端 run event。",
                "",
            ]
        elif run["step"] == 13:
            lines += [
                "- 必做对照:无交互 baseline 与 GVC 交互模型均有服务端 run event。",
                f"- 边际效应解释:{checks.get('marginal_effect', '(未记录)')}",
                "",
            ]
            if result.marginal_effects:
                lines += [
                    "服务端按完整协方差矩阵计算的条件边际效应:",
                    "",
                    "| 政策项 | 基期 GVC 水平 | 中心化值 | 效应 | 聚类标准误 | 95% 置信区间 |",
                    "|---|---|---:|---:|---:|---:|",
                ]
                for item in result.marginal_effects:
                    interval = (
                        f"[{item['ci_low']:.4f}, {item['ci_high']:.4f}]" if item.get("ci_low") is not None else "—"
                    )
                    lines.append(
                        f"| {item['policy_term']} | {item['label']} | {item['baseline_gvc_centered']:.4f} | "
                        f"{item['effect']:.4f} | {item['se']:.4f} | {interval} |"
                    )
                lines.append("")
        elif run["step"] == 14:
            lines += [
                f"- 事前趋势诊断:{checks.get('pretrend', '(未记录)')}",
                f"- 事后动态效应:{checks.get('post_effect', '(未记录)')}",
                "",
            ]
        elif run["step"] == 15:
            lines += ["- 必做安慰剂:服务端 event 已校验并绑定当前 attempt。", ""]
        cer = run["cer"]
        lines += [
            f"**我的识别判断**:{run['judgment'] or '(未记录)'}",
            "",
            f"- **Claim**: {cer.get('claim', '(未记录)')}",
            f"- **Evidence**: {cer.get('evidence', '(未记录)')}",
            f"- **Reasoning**: {cer.get('reasoning', '(未记录)')}",
            f"- **Boundary**: {cer.get('boundary', '(未记录)')}",
            "",
        ]

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
        "## 5. 溯源与状态",
        "",
        "| 项 | 值 |",
        "|---|---|",
        f"| 报告指纹 report_key | `{provenance['report_key']}` |",
        f"| 产物清单 manifest_id | `{provenance['manifest_id']}` |",
        f"| 会话契约版本 | `{provenance['session_version']}` |",
        f"| 报告状态 | `{provenance['status']}`（提交后由 submission 实体另行记录） |",
        f"| 产物 schema / 网络算法 | `{provenance['artifact']['schema_version']}` / "
        f"`{provenance['artifact']['network_algorithm']}` |",
        f"| 构建 Git commit / dirty | `{build.get('git_commit', '—')}` / `{build.get('git_dirty', '—')}` |",
        f"| 影响产物的 source tree SHA-256 | `{build.get('source_tree_sha256', '—')}` |",
        f"| 构建运行环境 | {runtime_summary} |",
        "",
        "同一份会话内容与同一套数据产物会得到同一个 report_key;任何一处证据或数据发生变化,report_key 都会随之改变。",
        "",
    ]
    # 四步回归的粒度按学生自己的设定;它们共用同一套设定时直接报它。
    granularity_labels = {run["design"].granularity_label for run in runs}
    lines += _limitations("、".join(sorted(granularity_labels)))
    return "\n".join(lines)


def build(
    session: dict[str, Any],
    student: str,
    session_revision: int,
    *,
    subject: str | None = None,
    require_trusted: bool = False,
) -> TeachingReport:
    """从实验会话生成报告;前 15 步证据不齐时抛 ReportGateError。"""
    blocked = check_gate(session, subject=subject, require_trusted=require_trusted)
    if blocked:
        raise ReportGateError(blocked)

    manifest_id = artifacts.manifest_id()
    if session.get("manifest_id") != manifest_id:
        raise ReportGateError(
            [{"step": 0, "title": "数据产物已更新", "missing": ["实验会话对应的产物已过期,请重新完成实验后再生成报告"]}]
        )

    runs = _rerun(session)
    report_key = _fingerprint(session, manifest_id, runs, student)
    contract = artifacts.artifact_contract()
    from gvcsim.config import processed_years

    manifest_provenance = artifacts.manifest_provenance()
    provenance = {
        "report_key": report_key,
        "session_fingerprint": report_key,
        "manifest_id": manifest_id,
        "session_revision": session_revision,
        "session_version": SESSION_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": "generated",
        "artifact": {**contract, "years": processed_years(), **manifest_provenance},
        "runs": [
            {
                "step": run["step"],
                "outcome": run["outcome"],
                "design": run["design"].equation(),
                "status": run["result"].status,
                "weight_mode": run["weight_mode"],
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
