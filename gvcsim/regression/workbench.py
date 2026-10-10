"""The "自己设计模型（选做）" panel of steps 11–14: what a student may choose, and how saved models are kept.

The page renders its choices from ``options()``; a saved model (``steps[N].data.custom_results[]``) is checked by
``custom_results_problem`` before the session is stored. A saved model's ``snapshot`` is for the page only: the
report recomputes every model it prints from the saved ``(outcome, baseline, spec)``.
"""

from __future__ import annotations

import json
from typing import Any

from gvcsim import config
from gvcsim.regression.spec import (
    CONTROL_LAGS,
    CONTROLS,
    DEFAULT_SPEC,
    FIXED_EFFECT_INCLUDES,
    FIXED_EFFECT_LABELS,
    FIXED_EFFECTS,
    X_LAGS,
    ModelSpec,
    x_term_label,
)
from gvcsim.regression.teaching import VERSION, selectable_baselines

MAX_SAVED = 6
MAX_IN_REPORT = 3
MAX_COMPARED = 4
NAME_MAX_LENGTH = 20
# A snapshot holds one result table (about 2 KB); the bound keeps a tampered session from storing anything larger.
MAX_SNAPSHOT_BYTES = 16_000
CUSTOM_RESULT_KEYS = frozenset({"id", "name", "outcome", "baseline", "spec", "in_report", "saved_at", "snapshot"})

X_LAG_DESCRIPTIONS = {0: "当期：今年的 X", 1: "滞后 1 期：上一年的 X", 2: "滞后 2 期：两年前的 X"}
X_LAG_NOTE = "数据只到 2020 年、2018 年起加税，滞后 3 期在样本内全为 0，无法估计。"
CONTROL_LAG_LABELS = {0: "当期", 1: "滞后 1 期"}
CONTROL_LAG_NOTE = "控制变量没有 2015 年的数据，选滞后 1 期时样本从 2017 年开始（少一年的记录）。"
FIXED_EFFECT_DESCRIPTIONS = {
    "country": "每个国家一个截距",
    "industry": "每个行业一个截距",
    "country_industry": "每个国家的每个行业一个截距，包含国家 FE 和行业 FE",
    "year": "每年一个截距，扣掉所有单位共同的年度变化",
    "country_year": "每个国家每年一个截距，包含国家 FE 和年份 FE；会吸收所有国家层面的控制变量（4 个控制变量都是）",
}
NO_FIXED_EFFECTS_NOTE = "都不勾时模型加常数项，表头写“无固定效应”。"
# "试一试": one change at a time, each a contrast the course data were built to show; questions only, no answers.
TRIES = (
    "去掉“汇率变动”：X 各项合计变大还是变小？再改用“国家×年份”固定效应呢？",
    "只放当期 X（去掉 L1.X）：合计和默认模型相差多少？",
    "固定效应改成“国家 + 行业 + 年份”（不勾“国家×行业”）：结果怎样变？",
    "加上 L2.X，或加上 GDP、贸易开放度：结论变了吗？",
)
HINTS = (
    "每次只改一处设定，与第一列的默认模型比较：X 各项的系数和合计变了多少？观测值和年份是否相同？",
    "与 Y 无关的变量在 10% 水平上大约每 10 次也会出现一次 *，不要只凭一颗星下结论。",
)
FOOTNOTE = (
    "注：括号内为按国家聚类的标准误。*** p<0.01, ** p<0.05, * p<0.1。系数为原单位，X 以份额计（0.25 = 25%），"
    "X 增加 1 个百分点时 Y 的变化 = 系数 × 0.01。2018 年以前没有关税，X 的滞后在加税前按 0 处理。"
)
SAMPLE_DIFFERS_NOTE = "这几列的样本不同，差异有一部分来自样本，而不只是设定。"
SUPPRESSED_NOTE = "标准库对照未通过，已隐藏推断结果（p 值、星号与区间）。"


def options() -> dict[str, Any]:
    """Everything the workbench offers, in page order, with the default model and the limits."""
    return {
        "version": VERSION,
        "default_spec": DEFAULT_SPEC.to_dict(),
        "x_lags": [{"lag": lag, "label": x_term_label(lag), "description": X_LAG_DESCRIPTIONS[lag]} for lag in X_LAGS],
        "x_lag_note": X_LAG_NOTE,
        "controls": [
            {
                "name": key,
                "label": info.label,
                "definition": info.definition,
                "source": "课程生成" if info.source == "generated" else "按 ICIO 计算",
            }
            for key, info in CONTROLS.items()
        ],
        "control_lags": [{"lag": lag, "label": CONTROL_LAG_LABELS[lag]} for lag in CONTROL_LAGS],
        "control_lag_note": CONTROL_LAG_NOTE,
        "fixed_effects": [
            {
                "key": key,
                "label": FIXED_EFFECT_LABELS[key],
                "description": FIXED_EFFECT_DESCRIPTIONS[key],
                "includes": list(FIXED_EFFECT_INCLUDES.get(key, ())),
            }
            for key in FIXED_EFFECTS
        ],
        "no_fixed_effects_note": NO_FIXED_EFFECTS_NOTE,
        "limits": {
            "saved": MAX_SAVED,
            "in_report": MAX_IN_REPORT,
            "compared": MAX_COMPARED,
            "name_length": NAME_MAX_LENGTH,
            # New calculations per student and minute (a model computed before does not count); said when refused.
            "runs_per_minute": config.REGRESSION_RUNS_PER_MINUTE,
        },
        "tries": list(TRIES),
        "hints": list(HINTS),
        "footnote": FOOTNOTE,
        "sample_differs_note": SAMPLE_DIFFERS_NOTE,
        "suppressed_note": SUPPRESSED_NOTE,
    }


def _spec_problem(value: Any) -> str | None:
    try:
        canonical = ModelSpec.from_dict(value).to_dict()
    except (TypeError, ValueError) as error:
        return str(error)
    # Stored as the server returned it (``design.spec``), so it is already in canonical order.
    return None if canonical == value else "模型设定不是规范形式"


def custom_results_problem(value: Any, outcome: str) -> str | None:
    """Why a step's saved models cannot be stored, or None. Checked on every session save."""
    if not isinstance(value, list):
        return "已保存的模型必须是列表"
    if len(value) > MAX_SAVED:
        return f"每步最多保存 {MAX_SAVED} 个模型"
    baselines = {item.key for item in selectable_baselines(outcome)}
    ids: set[str] = set()
    names: set[str] = set()
    in_report = 0
    for item in value:
        if not isinstance(item, dict) or set(item) != CUSTOM_RESULT_KEYS:
            return "已保存模型的字段不完整"
        identifier, name = item["id"], item["name"]
        if not isinstance(identifier, str) or not 1 <= len(identifier) <= 64 or identifier in ids:
            return "已保存模型的编号无效或重复"
        ids.add(identifier)
        if not isinstance(name, str) or name != name.strip() or not 1 <= len(name) <= NAME_MAX_LENGTH:
            return f"模型名称应为 1–{NAME_MAX_LENGTH} 个字符"
        if name in names:
            return f"本步已有名为“{name}”的模型"
        names.add(name)
        if item["outcome"] != outcome:
            return "已保存模型的结果指标与本步不符"
        if item["baseline"] not in baselines:
            return "已保存模型的 Y 不在当前课程数据中"
        problem = _spec_problem(item["spec"])
        if problem:
            return problem
        if not isinstance(item["in_report"], bool):
            return "“放入报告”必须是是或否"
        in_report += item["in_report"]
        if not isinstance(item["saved_at"], str) or not 1 <= len(item["saved_at"]) <= 40:
            return "已保存模型的保存时间无效"
        snapshot = item["snapshot"]
        if (
            not isinstance(snapshot, dict)
            or len(json.dumps(snapshot, ensure_ascii=False).encode()) > MAX_SNAPSHOT_BYTES
        ):
            return "已保存模型的结果快照无效或过大"
    if in_report > MAX_IN_REPORT:
        return f"每步最多 {MAX_IN_REPORT} 个模型放入报告"
    return None


def reported_custom_results(value: Any) -> list[dict[str, Any]]:
    """The saved models a report prints and depends on: ``(name, outcome, baseline, spec)`` of each one marked
    放入报告, in saved order. Saving, deleting or re-running a model that is not in the report changes nothing here."""
    if not isinstance(value, list):
        return []
    return [
        {key: item.get(key) for key in ("name", "outcome", "baseline", "spec")}
        for item in value
        if isinstance(item, dict) and item.get("in_report") is True
    ]
