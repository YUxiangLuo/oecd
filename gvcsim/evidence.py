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

课程政策(非统计定理):要求文字判断的只有质检与四步回归——这些步骤的核心
不是“点出数字”,而是“作出取舍”。其余步骤用可验证的动作作为证据,避免把
16 个文本框变成学生乱敲应付的假证据。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, cast

from gvcsim.regression.design import (
    CONTROL_MODES,
    GRANULARITIES,
    METHODS,
    PRICE_MODES,
    SCENARIOS,
    SHOCK_TYPES,
)
from gvcsim.shocks import SHOCK_LABELS, SHOCK_SPECS
from gvcsim.steps import STEPS

# 文字判断的最小长度。中文信息密度高,一句有内容的判断通常超过它;
# 它挡不住刻意乱敲,但那已不是"证据不足"而是学术诚信问题。
MIN_JUDGMENT_CHARS = 15

# 第 2 步要求三类政策冲击都看过:关税是密集处理、制裁是稀疏处理、
# 出口管制是单国处理,三者的识别难度完全不同,只看一个会形成错误直觉。
# 用稳定键而不是界面文案:改个标签不该让所有学生的第 2 步证据失效。
REQUIRED_SHOCK_TYPES = tuple(SHOCK_SPECS)

# 第 3 步的处置决定:面对质检警告,真实研究里只有这三条路。
QC_DISPOSITIONS = ("stop", "fix", "disclose")

# 会话里保存的回归设定 → 允许的稳定键。键名是前端 RegressionSettings 的字段名。
_REG_SETTING_ENUMS: dict[str, set[str]] = {
    "granularity": set(GRANULARITIES),
    "shockType": set(SHOCK_TYPES),
    "method": set(METHODS),
    "controlMode": set(CONTROL_MODES),
    "priceMode": set(PRICE_MODES),
    "scenario": set(SCENARIOS),
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


def _judgment_missing(data: dict[str, Any], prompt: str) -> list[str]:
    judgment = _text(data.get("judgment"))
    if not judgment:
        return [prompt]
    if len(judgment) < MIN_JUDGMENT_CHARS:
        return [f"{prompt}(至少 {MIN_JUDGMENT_CHARS} 字,当前 {len(judgment)} 字)"]
    return []


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
    return [f"切片还缺:{'、'.join(missing)}"] if missing else []


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

# 步号 → lab 类型。以 steps.py 为唯一来源,课程调整时不必改本模块。
# STEPS 的字典值是异构的(int/str/list),静态类型只能推出 object,这里在边界处收窄。
STEP_LABS: dict[int, str] = {cast(int, step["n"]): cast(str, step["lab"]) for step in STEPS}


def evaluate_step(step: int, session: dict[str, Any]) -> StepEvidence:
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
    return StepEvidence(step=step, complete=not missing, missing=missing)


def evaluate(session: dict[str, Any]) -> list[StepEvidence]:
    """判定全部 16 步。"""
    return [evaluate_step(n, session) for n in sorted(STEP_LABS)]


def completed_steps(session: dict[str, Any]) -> list[int]:
    return [item.step for item in evaluate(session) if item.complete]


def completion_summary(session: dict[str, Any]) -> dict[str, Any]:
    """给前端与教师端的完成度摘要。"""
    items = evaluate(session)
    return {
        "steps": [item.to_dict() for item in items],
        "completed": [item.step for item in items if item.complete],
        "completed_count": sum(1 for item in items if item.complete),
        "total": len(items),
    }
