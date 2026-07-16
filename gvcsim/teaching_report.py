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


def check_gate(session: dict[str, Any]) -> list[dict[str, Any]]:
    """返回未完成的前置步骤;空表示可以生成。"""
    blocked = []
    for step in GATE_STEPS:
        item = evidence.evaluate_step(step, session)
        if not item.complete:
            blocked.append({"step": step, "title": _STEP_TITLES.get(step, ""), "missing": item.missing})
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
    runs = []
    for step, outcome in sorted(_STEP_OUTCOMES.items()):
        data = _step_data(session, step)
        settings = (data.get("run") or {}).get("settings") or {}
        design = _settings_to_design(outcome, settings)
        result: RegressionResult = run_design(_load_panel(design), design)
        runs.append(
            {
                "step": step,
                "title": _STEP_TITLES.get(step, ""),
                "outcome": outcome,
                "design": design,
                "result": result,
                "judgment": str(data.get("judgment", "")).strip(),
            }
        )
    return runs


def _fingerprint(session: dict[str, Any], manifest_id: str, runs: list[dict[str, Any]]) -> str:
    """报告指纹:同一份会话内容 + 同一套产物 → 同一个 report_key。

    用内容而不是时间戳做键:学生重复点“生成”不会堆出一串实质相同的报告,
    而任何一处证据或数据变化都会得到一个新的 key。
    """
    payload = json.dumps(
        {
            "manifest_id": manifest_id,
            "steps": {str(n): _step_data(session, n) for n in GATE_STEPS},
            "designs": [run["design"].equation() for run in runs],
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


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
        f"## 2. GVC 指标摘要({year} 年截面)",
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
        "## 5. 结论与限制",
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
        f"学生:{student}  ·  生成时间:{provenance['generated_at']}",
        "",
        "> **数据边界**:结果变量与网络指标来自真实 OECD ICIO "
        f"({years[0]}–{years[-1]});"
        "政策冲击(关税/制裁/出口管制)为**确定性 mock**,以真实事件为原型手工编码。"
        "因此本报告可以用来练习识别与推断,**不构成任何现实政策结论**。",
        "",
        "## 1. 数据质检与处置",
        "",
    ]
    disposition = _QC_DISPOSITION_LABELS.get(str(qc.get("disposition")), "(未记录)")
    lines += [
        f"面对质检结果,我的处置是:**{disposition}**。",
        "",
        f"理由:{qc.get('judgment', '(未记录)')}",
        "",
    ]
    lines += _indicator_summary(int(years[-1]))
    lines += [
        "## 3. 四步教学实证回归(服务端复估)",
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
        lines += [f"**我的识别判断**:{run['judgment'] or '(未记录)'}", ""]

    lines += [
        "## 4. 溯源",
        "",
        "| 项 | 值 |",
        "|---|---|",
        f"| 报告指纹 report_key | `{provenance['report_key']}` |",
        f"| 产物清单 manifest_id | `{provenance['manifest_id']}` |",
        f"| 实验会话 revision | {provenance['session_revision']} |",
        f"| 会话契约版本 | `{provenance['session_version']}` |",
        f"| 产物 schema / 网络算法 | `{provenance['artifact']['schema_version']}` / "
        f"`{provenance['artifact']['network_algorithm']}` |",
        "",
        "同一份会话内容与同一套数据产物会得到同一个 report_key;任何一处证据或数据发生变化,report_key 都会随之改变。",
        "",
    ]
    # 四步回归的粒度按学生自己的设定;它们共用同一套设定时直接报它。
    granularity_labels = {run["design"].granularity_label for run in runs}
    lines += _limitations("、".join(sorted(granularity_labels)))
    return "\n".join(lines)


def build(session: dict[str, Any], student: str, session_revision: int) -> TeachingReport:
    """从实验会话生成报告;前 15 步证据不齐时抛 ReportGateError。"""
    blocked = check_gate(session)
    if blocked:
        raise ReportGateError(blocked)

    manifest_id = artifacts.manifest_id()
    if session.get("manifest_id") != manifest_id:
        raise ReportGateError(
            [{"step": 0, "title": "数据产物已更新", "missing": ["实验会话对应的产物已过期,请重新完成实验后再生成报告"]}]
        )

    runs = _rerun(session)
    report_key = _fingerprint(session, manifest_id, runs)
    contract = artifacts.artifact_contract()
    from gvcsim.config import processed_years

    provenance = {
        "report_key": report_key,
        "manifest_id": manifest_id,
        "session_revision": session_revision,
        "session_version": SESSION_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "artifact": {**contract, "years": processed_years()},
        "runs": [
            {
                "step": run["step"],
                "outcome": run["outcome"],
                "design": run["design"].equation(),
                "status": run["result"].status,
            }
            for run in runs
        ],
    }
    return TeachingReport(
        report_key=report_key,
        markdown=_render(session, student, runs, provenance),
        provenance=provenance,
        suggested_filename=f"gvc_experiment_report_{report_key}.md",
    )
