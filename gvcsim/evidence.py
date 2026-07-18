"""课程完成的真值:由服务端从实验会话重新计算。

HEAD 把“到过第 n 步”渲染成绿色对勾并统计成完成率,于是快速点过 16 步就等于
完成课程。本模块给出相反的定义:**完成 = 会话里存在这一步要求的学习证据**,
访问不算,深链更不算。

判定只在服务端进行(见 gvcsim/classroom/routes.py):客户端可以任意伪造自己的
界面,但伪造不了服务端从会话重算的结论。

证据形态按 lab 类型定义,而不是逐步硬编码——16 步只有 7 类实验台:
    db     选定一个有效切片
    shock  三类政策冲击(关税/制裁/出口管制)各至少查看一个
    qc     看过质检结论,并写下对警告的处置判断
    ind    至少对比两个实体的同一指标
    viz    保存一个图表配置和对比对象
    reg    跑出结果,并写下一句识别判断
    rep    报告(见第 16 步;由报告闭环单独校验)

课程政策(非统计定理):步骤 1、3–15 均要求轻量 CER，步骤 2 用 QC 处置理由；
其中对象、数值、事件和运行由服务端复核，文字的经济学质量留给教师 rubric。
因此“有一段文字”本身不够，必须同时有绑定当前 attempt/manifest 的真实动作。
"""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Any, cast

from gvcsim.regression.design import (
    CONTROL_MODES,
    GRANULARITIES,
    METHODS,
    PRICE_MODES,
    SCENARIOS,
    SHOCK_TYPES,
)
from gvcsim import trusted_evidence
from gvcsim.shocks import SHOCK_LABELS, SHOCK_SPECS, events_metadata
from gvcsim.steps import STEPS

# 文字判断的最小长度。中文信息密度高,一句有内容的判断通常超过它;
# 它挡不住刻意乱敲,但那已不是"证据不足"而是学术诚信问题。
MIN_JUDGMENT_CHARS = 15
MIN_CER_CHARS = 12
CER_FIELDS = ("claim", "evidence", "reasoning", "boundary")

# 第 11 步要求三类政策冲击都看过:关税是密集处理、制裁是稀疏处理、
# 出口管制是单国处理,三者的识别难度完全不同,只看一个会形成错误直觉。
# 用稳定键而不是界面文案:改个标签不该让所有学生的第 11 步证据失效。
REQUIRED_SHOCK_TYPES = tuple(SHOCK_SPECS)

# 第 2 步的处置决定:面对质检警告,真实研究里只有这三条路。
QC_DISPOSITIONS = ("stop", "fix", "disclose")

# 会话里保存的回归设定 → 允许的稳定键。键名是前端 RegressionSettings 的字段名。
_REG_SETTING_ENUMS: dict[str, set[str]] = {
    "granularity": set(GRANULARITIES),
    "shockType": set(SHOCK_TYPES),
    "method": set(METHODS),
    "controlMode": set(CONTROL_MODES),
    "priceMode": set(PRICE_MODES),
    "scenario": set(SCENARIOS),
    "weightMode": {"fixed_pretreatment", "contemporaneous"},
}


@dataclass
class StepEvidence:
    """一步的完成判定结果。"""

    step: int
    complete: bool
    # 未完成时,还差什么(直接可展示给学生的中文说明)。
    missing: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"step": self.step, "complete": self.complete, "missing": list(self.missing)}


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _judgment_missing(data: dict[str, Any], prompt: str) -> list[str]:
    judgment = _text(data.get("judgment"))
    if not judgment:
        return [prompt]
    if len(judgment) < MIN_JUDGMENT_CHARS:
        return [f"{prompt}(至少 {MIN_JUDGMENT_CHARS} 字,当前 {len(judgment)} 字)"]
    return []


def _cer_missing(data: dict[str, Any]) -> list[str]:
    cer = data.get("cer")
    if not isinstance(cer, dict):
        return ["请提交 Claim–Evidence–Reasoning–Boundary 四段学习证据"]
    labels = {"claim": "主张", "evidence": "数值证据", "reasoning": "推理", "boundary": "边界/限制"}
    missing = [labels[key] for key in CER_FIELDS if len(_text(cer.get(key))) < MIN_CER_CHARS]
    problems = [f"CER 还缺少至少 {MIN_CER_CHARS} 字的:{'、'.join(missing)}"] if missing else []
    completed = [_text(cer.get(key)) for key in CER_FIELDS if _text(cer.get(key))]
    if len(set(completed)) != len(completed):
        problems.append("CER 四段不能用同一段文字重复填充")
    evidence_text = _text(cer.get("evidence"))
    if evidence_text and not re.search(r"\d", evidence_text):
        problems.append("CER 的 Evidence 必须引用至少一个具体数值")
    return problems


def _distinct(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    return list(dict.fromkeys(_text(v) for v in values if _text(v)))


def _check_db(data: dict[str, Any]) -> list[str]:
    """选定一个有效切片:年份 + 表 + 行国家,以及(除账户项外)列国家。

    账户项表(TLS/VA/OUT)只有行方向的账户项,没有列国家维度,因此不要求它——
    判定必须跟随数据本身的形状,否则那张表永远无法完成。
    """
    slice_ = data.get("slice")
    if not isinstance(slice_, dict):
        return ["请在表格里自己选定一个切片(年份、表、行国家等);页面打开时的默认切片不计入证据"]
    required = {"year": "年份", "table": "表(Z / Y / 账户项)", "row_country": "行国家"}
    if str(slice_.get("table", "")) != "accounts":
        required["col_country"] = "列国家"
    missing = [label for key, label in required.items() if not _text(str(slice_.get(key, "")))]
    problems = [f"切片还缺:{'、'.join(missing)}"] if missing else []
    observation = data.get("observation")
    if not isinstance(observation, dict) or not all(
        (
            _text(observation.get("row")),
            _text(observation.get("column")),
            isinstance(observation.get("value"), (int, float)) and not isinstance(observation.get("value"), bool),
        )
    ):
        problems.append("请在当前切片中主动选择一个具体数值单元格作为可核查证据")
    return problems


def _check_shock(data: dict[str, Any]) -> list[str]:
    viewed = set(_distinct(data.get("viewed_shock_types")))
    absent = [t for t in REQUIRED_SHOCK_TYPES if t not in viewed]
    # 证据存的是稳定键,给学生看的提示用文案。
    labels = "、".join(SHOCK_LABELS.get(t, t) for t in absent)
    return [f"还需查看这些类型的政策冲击事件:{labels}"] if absent else []


def _check_qc(data: dict[str, Any]) -> list[str]:
    """质检这一步的核心不是“看过报告”,而是**作出处置决定**并说明理由。

    因此动作证据是三选一的处置(停止/修正/披露后继续),而不是一个“已阅”布尔值——
    后者与“到过”没有区别,正是本次重建要消灭的东西。
    """
    missing: list[str] = []
    if data.get("disposition") not in QC_DISPOSITIONS:
        missing.append("请先对质检结果作出处置决定:停止分析、修正数值,还是披露后继续")
    missing += _judgment_missing(data, "请写下作出该处置的理由(哪一项质检、为什么这样处理)")
    return missing


def _check_qc_workflow(data: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    if data.get("disposition") == "fix":
        if not _text(data.get("remediation")):
            missing.append("选择修正后，请记录实际修正规则")
        if data.get("retest_passed") is not True:
            missing.append("选择修正后，必须完成复检并通过才能继续")
    elif data.get("disposition") == "disclose" and not _distinct(data.get("disclosures")):
        missing.append("选择披露后继续时，请列出将进入下游页面和报告的异常")
    return missing


def _check_ind(data: dict[str, Any]) -> list[str]:
    compared = _distinct(data.get("compared"))
    if len(compared) < 2:
        return [f"请至少对比两个实体的同一指标(当前 {len(compared)} 个)"]
    return []


def _check_viz(data: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    if not _text(str(data.get("chart", ""))):
        missing.append("请点选一个图表视角;页面打开时的默认视图不计入证据")
    compared = _distinct(data.get("compared"))
    if len(compared) < 2:
        missing.append(f"请选出至少两个对比对象(当前 {len(compared)} 个)")
    return missing


def invalid_regression_settings(settings: Any) -> list[str]:
    """按枚举白名单挑出非法的回归设定;返回可读的 `键=值` 列表。

    会话的 ``data`` 是不透明 blob(各实验台自己决定存什么),因此客户端可以往
    里写任何东西。这里在**完成度判定**这一层把伪造设定挡下:设定不合法 →
    该步不算完成 → 第 16 步门槛不开 → 报告生成器根本拿不到这种数据。
    """
    if not isinstance(settings, dict):
        return ["settings 不是对象"]
    bad = []
    for key, allowed in _REG_SETTING_ENUMS.items():
        value = settings.get(key)
        if value is not None and value not in allowed:
            bad.append(f"{key}={value!r}")
    return bad


def _check_reg(data: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    run = data.get("run")
    if not isinstance(run, dict) or not _text(str(run.get("depvar", ""))):
        missing.append("请先用当前设定跑出一次回归结果")
    else:
        bad = invalid_regression_settings(run.get("settings") or {})
        if bad:
            missing.append(f"这次运行保存的设定无法识别({'、'.join(bad)});请重新运行本步")
    missing += _judgment_missing(data, "请写下这次估计的识别判断:结果能否作因果解释,为什么")
    return missing


def _check_rep(data: dict[str, Any]) -> list[str]:
    """第 16 步:报告闭环(服务端重跑 + 绑定 provenance)由报告环节单独校验。"""
    if not _text(str(data.get("report_key", ""))):
        return ["请在完成前 15 步后生成实验报告"]
    return []


_CHECKS = {
    "db": _check_db,
    "shock": _check_shock,
    "qc": _check_qc,
    "ind": _check_ind,
    "viz": _check_viz,
    "reg": _check_reg,
    "rep": _check_rep,
}

_TRUSTED_KINDS = {
    "db": "slice",
    "qc": "qc_resolution",
    "ind": "indicator",
    "viz": "visualization",
    "shock": "shock",
}


def _learning_payload(data: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in data.items() if key != "evidence_id"}


def normalize_issue_payload(step: int, kind: str, payload: Any) -> dict[str, Any]:
    """校验并归一化由 /evidence/issue 签收的学生证据。"""
    lab = STEP_LABS.get(step)
    expected = _TRUSTED_KINDS.get(lab or "")
    if expected != kind:
        raise ValueError(f"步骤 {step} 只能签发 {expected or '服务端专用'} 证据")
    if not isinstance(payload, dict):
        raise ValueError("evidence payload 必须是对象")
    clean = dict(payload)
    if lab != "qc" and _cer_missing(clean):
        raise ValueError(_cer_missing(clean)[0])
    if kind == "qc_resolution":
        missing = _check_qc(clean)
        if clean.get("disposition") == "fix" and not _text(clean.get("remediation")):
            missing.append("选择修正后，请记录实际修正规则")
        if clean.get("disposition") == "disclose" and not _distinct(clean.get("disclosures")):
            missing.append("选择披露后继续时，请逐项确认当前失败检查")
    elif kind == "slice":
        missing = _check_db(clean)
    elif kind == "indicator":
        missing = [item for item in _check_ind(clean) if not item.startswith("CER")]
    elif kind == "visualization":
        missing = [item for item in _check_viz(clean) if not item.startswith("CER")]
    else:
        missing = _check_shock(clean)
        event_types = {str(item["name"]): str(item["shock_type"]) for item in events_metadata()}
        viewed_events = _distinct(clean.get("viewed_events"))
        unknown = [name for name in viewed_events if name not in event_types]
        if unknown:
            missing.append("无法识别政策事件:" + "、".join(unknown))
        covered_types = {event_types[name] for name in viewed_events if name in event_types}
        absent_types = [kind_ for kind_ in REQUIRED_SHOCK_TYPES if kind_ not in covered_types]
        if absent_types:
            missing.append("三类冲击必须各保存一个具体事件")
    if missing:
        raise ValueError("；".join(missing))
    return clean


# 步号 → lab 类型。以 steps.py 为唯一来源,课程调整时不必改本模块。
# STEPS 的字典值是异构的(int/str/list),静态类型只能推出 object,这里在边界处收窄。
STEP_LABS: dict[int, str] = {cast(int, step["n"]): cast(str, step["lab"]) for step in STEPS}


def evaluate_step(
    step: int,
    session: dict[str, Any],
    *,
    subject: str | None = None,
    require_trusted: bool = False,
) -> StepEvidence:
    """判定单步是否完成。会话里没有该步记录即为未完成。"""
    lab = STEP_LABS.get(step)
    if lab is None:
        raise ValueError(f"未知步骤:{step}")
    record = session.get("steps", {}).get(str(step))
    data = record.get("data") if isinstance(record, dict) else None
    if not isinstance(data, dict):
        # 只“到过”这一步不会产生任何记录,因此这里就是访问≠完成的落点。
        return StepEvidence(step=step, complete=False, missing=_CHECKS[lab]({}))
    missing = _CHECKS[lab](data)
    if require_trusted and lab in {"db", "ind", "viz", "shock", "reg"}:
        missing += _cer_missing(data)
    if require_trusted and lab == "shock" and len(_distinct(data.get("viewed_events"))) < len(REQUIRED_SHOCK_TYPES):
        missing.append("请保存三类冲击各自对应的具体事件，而不只是类型名称")
    if require_trusted and lab == "qc":
        missing += _check_qc_workflow(data)
    kind = _TRUSTED_KINDS.get(lab)
    if require_trusted and kind:
        if not subject:
            missing.append("服务端无法确认这份证据属于当前学生")
        elif not trusted_evidence.verify_learning_evidence(
            data.get("evidence_id"),
            subject=subject,
            step=step,
            kind=kind,
            manifest_id=str(session.get("manifest_id") or ""),
            payload=_learning_payload(data),
        ):
            missing.append("筛选/CER 已变化或证据并非服务端签发，请重新提交可核查证据")
    if require_trusted and lab == "reg":
        run = _as_dict(data.get("run"))
        settings = _as_dict(run.get("settings"))
        outcome = next(
            (
                str(item["regression_outcome"])
                for item in STEPS
                if item.get("n") == step and item.get("regression_outcome")
            ),
            "",
        )
        run_id = data.get("run_id") or run.get("run_id")
        verified = (
            trusted_evidence.verify_regression_run(
                run_id,
                subject=subject or "",
                manifest_id=str(session.get("manifest_id") or ""),
                outcome=outcome,
                settings=settings,
                step=step,
            )
            if subject
            else None
        )
        if not verified:
            missing.append("当前回归结果没有匹配该学生、步骤、设定与产物的服务端 run_id")
        checks = _as_dict(data.get("checks"))

        def verified_check(name: str, kind_: str = "regression") -> dict[str, Any] | None:
            return (
                trusted_evidence.verify_regression_run(
                    checks.get(name),
                    subject=subject or "",
                    manifest_id=str(session.get("manifest_id") or ""),
                    outcome=outcome,
                    settings={},
                    kind=kind_,
                    step=step,
                )
                if subject
                else None
            )

        def same_design(left: dict[str, Any] | None, right: dict[str, Any] | None, *, except_keys: set[str]) -> bool:
            if not left or not right:
                return False
            left_design = _as_dict(left.get("design"))
            right_design = _as_dict(right.get("design"))
            keys = {
                "outcome",
                "granularity",
                "shock_type",
                "method",
                "control_mode",
                "interaction",
                "price_mode",
                "scenario",
                "exclude_row",
                "weight_mode",
            } - except_keys
            return all(left_design.get(key) == right_design.get(key) for key in keys)

        if step == 12:
            baseline = verified_check("baseline_run_id")
            controlled = verified_check("controlled_run_id")
            if not baseline or _as_dict(baseline.get("design")).get("control_mode") != "none":
                missing.append("贸易回归需保存一份无控制变量的服务端 baseline_run_id")
            if not controlled or _as_dict(controlled.get("design")).get("control_mode") == "none":
                missing.append("贸易回归需保存一份加入控制变量的 controlled_run_id")
            if (
                baseline
                and controlled
                and not same_design(baseline, controlled, except_keys={"control_mode", "price_mode"})
            ):
                missing.append("两次贸易回归除控制变量外必须使用完全相同的冲击、样本、方法和权重口径")
        elif step == 13:
            baseline = verified_check("baseline_run_id") or verified_check("no_interaction_run_id")
            interaction = verified_check("interaction_run_id")
            if not baseline or _as_dict(baseline.get("design")).get("interaction") is not False:
                missing.append("生产回归需保存未加入交互项的 baseline_run_id")
            if not interaction or _as_dict(interaction.get("design")).get("interaction") is not True:
                missing.append("生产回归需保存加入交互项的 interaction_run_id")
            if baseline and interaction and not same_design(baseline, interaction, except_keys={"interaction"}):
                missing.append("两次生产回归除交互项外必须使用完全相同的冲击、样本、方法和权重口径")
            marginal = _text(checks.get("marginal_effect"))
            if len(marginal) < MIN_JUDGMENT_CHARS or not re.search(r"\d", marginal):
                missing.append("请用具体数值解释低/中/高基期 GVC 下的边际效应")
        elif step == 14:
            if not verified or _as_dict(verified.get("design")).get("method") != "event_study":
                missing.append("长度步骤必须保存一份事件研究 run_id")
            for key, label in (("pretrend", "事前趋势诊断"), ("post_effect", "事后效应")):
                text = _text(checks.get(key))
                if len(text) < MIN_JUDGMENT_CHARS or not re.search(r"\d", text):
                    missing.append(f"请引用具体数值记录{label}")
        elif step == 15:
            placebo_token = checks.get("placebo_run_id") or data.get("placebo_run_id")
            placebo = (
                trusted_evidence.verify_regression_run(
                    placebo_token,
                    subject=subject or "",
                    manifest_id=str(session.get("manifest_id") or ""),
                    outcome=outcome,
                    settings={},
                    kind="placebo",
                    step=step,
                )
                if subject
                else None
            )
            if not placebo:
                missing.append("网络步骤必须完成并保存服务端 placebo_run_id")
            elif verified and not same_design(verified, placebo, except_keys=set()):
                missing.append("安慰剂必须与本步主回归使用完全相同的 outcome、样本、冲击、方法、控制、交互和权重设定")
            boundary = _text(_as_dict(data.get("cer")).get("boundary"))
            if not re.search(r"SUTVA|干扰|相互影响|网络外溢", boundary, flags=re.IGNORECASE):
                missing.append("网络回归的 Boundary 必须讨论 SUTVA/节点间干扰或网络外溢")
    if require_trusted and lab == "rep" and subject:
        try:
            from gvcsim.classroom import db

            report_key = str(data.get("report_key") or "")
            report = db.report_by_key(subject, report_key) if report_key else None
        except Exception:
            report = None
        if not isinstance(report, dict) or report.get("manifest_id") != session.get("manifest_id"):
            missing.append("report_key 没有绑定当前学生、attempt 与 manifest 的真实服务端报告")
    return StepEvidence(step=step, complete=not missing, missing=missing)


def evaluate(
    session: dict[str, Any], *, subject: str | None = None, require_trusted: bool = False
) -> list[StepEvidence]:
    """判定全部 16 步。"""
    return [evaluate_step(n, session, subject=subject, require_trusted=require_trusted) for n in sorted(STEP_LABS)]


def completed_steps(session: dict[str, Any], *, subject: str | None = None, require_trusted: bool = False) -> list[int]:
    return [item.step for item in evaluate(session, subject=subject, require_trusted=require_trusted) if item.complete]


def completion_summary(
    session: dict[str, Any], *, subject: str | None = None, require_trusted: bool = False
) -> dict[str, Any]:
    """给前端与教师端的完成度摘要。"""
    items = evaluate(session, subject=subject, require_trusted=require_trusted)
    return {
        "steps": [item.to_dict() for item in items],
        "completed": [item.step for item in items if item.complete],
        "completed_count": sum(1 for item in items if item.complete),
        "total": len(items),
    }
