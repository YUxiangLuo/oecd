"""The "自己设计模型（选做）" panel of steps 11–14: what a student may choose, and how saved models are kept.

The page renders its choices from ``options()``; a saved model (``steps[N].data.custom_results[]``) is checked by
``custom_results_problem`` before the session is stored. A saved model's ``snapshot`` is for the page only: the
report recomputes every model it prints from the saved ``(outcome, baseline, spec)``.
"""

from __future__ import annotations

import json
import unicodedata
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
NO_FIXED_EFFECTS_NOTE = "都不勾时模型加常数项，表下的设定写作“无固定效应”。"
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
# Said whatever stopped the inference: the library check (regression.panel) or the design's treatment support.
SUPPRESSED_NOTE = "未通过估计检查，已隐藏推断结果（p 值、星号与区间）。"


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


# Invisible or layout characters (control, zero-width, bidi override, line/paragraph separators): a name made of
# them looks empty or reorders the text around it in the report. The page refuses the same set (nameProblem).
_NAME_FORBIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp"})
# Format characters that build one visible emoji (👩‍💻, 👨‍👩‍👧‍👦 joined by U+200D; tag letters of 🏴 flags).
_EMOJI_JOINERS = frozenset({"\u200d", *map(chr, range(0xE0020, 0xE0080))})
_INVISIBLE_ALONE = frozenset({"Cc", "Cf", "Mn", "Me", "Zs", "Zl", "Zp"})
_ZWJ, _TAG_FLAG, _TAG_END = "\u200d", "\U0001f3f4", "\U000e007f"


def _tag_letter(char: str) -> bool:
    return "\U000e0020" <= char <= "\U000e007e"


def _joiner_misplaced(name: str) -> bool:
    """A joiner outside the emoji it builds: U+200D not between two emoji (a skin tone or U+FE0F may end the first),
    or tag letters not in a 🏴 flag ending with the cancel tag. Elsewhere it is an invisible mark that makes two
    identical-looking names differ ("结果1" and "结果1" + U+200D) or carries hidden text. The page checks the same."""
    index = 0
    while index < len(name):
        char = name[index]
        if char == _ZWJ:
            before = name[index - 1] if index else ""
            after = name[index + 1] if index + 1 < len(name) else ""
            if not (
                before
                and after
                and (unicodedata.category(before) in {"So", "Sk"} or before == "\ufe0f")
                and unicodedata.category(after) == "So"
            ):
                return True
        elif _tag_letter(char) or char == _TAG_END:
            start = index
            while index < len(name) and _tag_letter(name[index]):
                index += 1
            if not start or name[start - 1] != _TAG_FLAG or index == start or name[index : index + 1] != _TAG_END:
                return True
        index += 1
    return False


def _name_key(name: str) -> str:
    """A name as it reads: two names differing only in format characters or U+FE0F are the same name."""
    return "".join(char for char in name if unicodedata.category(char) != "Cf" and char != "\ufe0f")


def name_problem(name: Any) -> str | None:
    """Why a saved model's name cannot be stored, or None; the page's ``nameProblem`` gives the same answers."""
    if not isinstance(name, str) or not any(unicodedata.category(char) not in _INVISIBLE_ALONE for char in name):
        return "请输入名称"
    if _joiner_misplaced(name) or any(
        unicodedata.category(char) in _NAME_FORBIDDEN_CATEGORIES and char not in _EMOJI_JOINERS for char in name
    ):
        return "名称不能包含不可见字符"
    if name != name.strip() or len(name) > NAME_MAX_LENGTH:
        return f"模型名称应为 1–{NAME_MAX_LENGTH} 个字符，前后不留空格"
    return None


def _spec_problem(value: Any) -> tuple[ModelSpec | None, str | None]:
    """The saved spec, normalised, or why it cannot be stored."""
    try:
        spec = ModelSpec.from_dict(value)
    except ValueError as error:
        return None, str(error)
    except TypeError:
        return None, "模型设定的格式无效"
    # Stored as the server returned it (``design.spec``), so its lists are already in canonical order; compared as JSON
    # so 1.0 cannot stand in for 1, with sorted keys because the database returns each control as {"lag", "name"}.
    if json.dumps(spec.to_dict(), sort_keys=True) != json.dumps(value, sort_keys=True):
        return None, "模型设定不是规范形式"
    return spec, None


def custom_results_problem(value: Any, outcome: str) -> str | None:
    """Why a step's saved models cannot be stored, or None. Checked on every session save."""
    if not isinstance(value, list):
        return "已保存的模型必须是列表"
    if len(value) > MAX_SAVED:
        return f"每步最多保存 {MAX_SAVED} 个模型"
    baselines = {item.key for item in selectable_baselines(outcome)}
    ids: set[str] = set()
    names: set[str] = set()
    models: dict[tuple[str, str], str] = {}
    in_report = 0
    for item in value:
        if not isinstance(item, dict) or set(item) != CUSTOM_RESULT_KEYS:
            return "已保存模型的字段不完整"
        identifier, name = item["id"], item["name"]
        if not isinstance(identifier, str) or not 1 <= len(identifier) <= 64 or identifier in ids:
            return "已保存模型的编号无效或重复"
        ids.add(identifier)
        problem = name_problem(name)
        if problem:
            return problem
        if _name_key(name) in names:
            return f"本步已有名为“{name}”的模型"
        names.add(_name_key(name))
        if not isinstance(item["outcome"], str) or item["outcome"] != outcome:
            return "已保存模型的结果指标与本步不符"
        if not isinstance(item["baseline"], str) or item["baseline"] not in baselines:
            return "已保存模型的 Y 不在当前课程数据中"
        spec, problem = _spec_problem(item["spec"])
        if spec is None:
            return problem
        # The page offers neither (its first column is the default model; a repeat shows the saved one).
        if spec == DEFAULT_SPEC:
            return "默认模型就是表中第一列，不用另存"
        key = (item["baseline"], json.dumps(spec.to_dict()))
        if key in models:
            return f"这个设定已保存为“{models[key]}”"
        models[key] = name
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
