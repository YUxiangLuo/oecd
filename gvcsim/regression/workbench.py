"""The "改模型、对比（选做）" panel of steps 11–14: what a student may choose, the preset experiments, and the one
model experiment a step may put into the report.

The page renders its choices from ``options()``; the experiment a student put into the report
(``steps[N].data.experiment``) is checked by ``experiment_problem`` before the session is stored. Its ``snapshot`` is
for the page only: the report recomputes the model it prints from the saved ``spec`` on the step's default Y.
"""

from __future__ import annotations

import json
from typing import Any

from gvcsim import config
from gvcsim.regression.spec import (
    CONTROL_LAGS,
    CONTROLS,
    DEFAULT_SPEC,
    EXCHANGE_RATE_COLUMN,
    FDI_COLUMN,
    FIXED_EFFECT_INCLUDES,
    FIXED_EFFECT_LABELS,
    FIXED_EFFECTS,
    GDP_COLUMN,
    POPULATION_COLUMN,
    X_LAGS,
    ModelSpec,
    x_term_label,
)
from gvcsim.regression.teaching import VERSION

# A snapshot holds one result table (about 2 KB); the bound keeps a tampered session from storing anything larger.
MAX_SNAPSHOT_BYTES = 16_000
EXPERIMENT_KEYS = frozenset({"spec", "saved_at", "snapshot"})

X_LAG_DESCRIPTIONS = {0: "当期：今年的 X", 1: "滞后 1 期：上一年的 X", 2: "滞后 2 期：两年前的 X"}
X_LAG_NOTE = "数据只到 2020 年、2018 年起加税，滞后 3 期在样本内全为 0，无法估计。"
CONTROL_LAG_LABELS = {0: "当期", 1: "滞后 1 期"}
CONTROL_LAG_NOTE = (
    "控制变量没有 2015 年的数据，参与估计的滞后 1 期控制使样本从 2017 年开始；被国家×年份 FE 吸收的控制不删样本。"
)
FIXED_EFFECT_DESCRIPTIONS = {
    "country": "每个国家一个截距",
    "industry": "每个行业一个截距",
    "country_industry": "每个国家的每个行业一个截距，包含国家 FE 和行业 FE",
    "year": "每年一个截距，扣掉所有单位共同的年度变化",
    "country_year": "每个国家每年一个截距，包含国家 FE 和年份 FE；会吸收本页全部国家层面的控制变量（包括滞后项），省略这些变量但不因其缺失删样本",
}
NO_FIXED_EFFECTS_NOTE = "都不勾时模型加常数项，表下的设定写作“无固定效应”。"


def _without(controls: tuple[tuple[str, int], ...], *names: str) -> tuple[tuple[str, int], ...]:
    return tuple(item for item in controls if item[0] not in names)


# The preset experiments, in page order: each changes one thing of the default model, each a contrast the course
# data were built to show. The question is asked, not answered. Their labels name the experiment in the report.
PRESETS: tuple[tuple[str, str, str, ModelSpec], ...] = (
    (
        "no_exchange_rate",
        "去掉汇率变动",
        "X 各项合计变大还是变小？",
        ModelSpec(
            DEFAULT_SPEC.x_lags, _without(DEFAULT_SPEC.controls, EXCHANGE_RATE_COLUMN), DEFAULT_SPEC.fixed_effects
        ),
    ),
    (
        "current_x_only",
        "只放当期 X（去掉 L1.X）",
        "合计和默认模型相差多少？",
        ModelSpec((0,), DEFAULT_SPEC.controls, DEFAULT_SPEC.fixed_effects),
    ),
    (
        "separate_effects",
        "固定效应改为国家 + 行业 + 年份",
        "不勾“国家×行业”，结果怎样变？",
        ModelSpec(DEFAULT_SPEC.x_lags, DEFAULT_SPEC.controls, ("country", "industry", "year")),
    ),
    (
        "country_year_effects",
        "改用国家×年份固定效应",
        "宏观控制被吸收后，X 各项合计怎样变？",
        ModelSpec(DEFAULT_SPEC.x_lags, DEFAULT_SPEC.controls, ("country_industry", "country_year")),
    ),
    (
        "no_gdp",
        "去掉 GDP 对数",
        "X 各项合计怎样变化？",
        ModelSpec(DEFAULT_SPEC.x_lags, _without(DEFAULT_SPEC.controls, GDP_COLUMN), DEFAULT_SPEC.fixed_effects),
    ),
    (
        "extra_controls",
        "加上人口增长率和 FDI 净流入占比",
        "多放变量是否一定更好？",
        ModelSpec(
            DEFAULT_SPEC.x_lags,
            (*DEFAULT_SPEC.controls, (POPULATION_COLUMN, 0), (FDI_COLUMN, 0)),
            DEFAULT_SPEC.fixed_effects,
        ),
    ),
    (
        "lag2",
        "加上两年前的 X（L2.X）",
        "L2.X 的区间是否包含 0？",
        ModelSpec((0, 1, 2), DEFAULT_SPEC.controls, DEFAULT_SPEC.fixed_effects),
    ),
)
CUSTOM_LABEL = "自定义设定"
HINTS = (
    "在课程模拟数据中，每次只改一处设定，与第一列的默认模型比较：X 各项的系数和合计变了多少？观测值和年份是否相同？",
    "与 Y 无关的变量在 10% 水平上大约每 10 次也会出现一次 *，不要只凭一颗星下结论。",
)
FOOTNOTE = (
    "注：括号内为按国家聚类的标准误。*** p<0.01, ** p<0.05, * p<0.1。系数为原单位，X 以份额计（0.25 = 25%），"
    "X 增加 1 个百分点时 Y 的变化 = 系数 × 0.01。2018 年以前没有关税，X 的滞后在加税前按 0 处理。"
    "自由度计入样本内全部固定效应的秩；用 reghdfe/fixest 默认设置复算本课程默认模型时，标准误约小 11%，属于口径差异。"
)
SAMPLE_DIFFERS_NOTE = "这几列的样本不同，差异有一部分来自样本，而不只是设定。"
# Said whatever stopped the inference: the library check (regression.panel) or the design's treatment support.
SUPPRESSED_NOTE = "未通过估计检查，已隐藏推断结果（标准误、t 值、p 值、星号与区间）。"


def experiment_label(spec: ModelSpec) -> str:
    """How the page and the report name a model experiment: its preset's label, else "自定义设定" (the model itself
    is always shown beside the name, so it is not repeated in it)."""
    canonical = spec.canonical()
    for _key, label, _question, preset in PRESETS:
        if preset.canonical() == canonical:
            return label
    return CUSTOM_LABEL


def options() -> dict[str, Any]:
    """Everything the workbench offers, in page order, with the default model, the presets and the limits."""
    return {
        "version": VERSION,
        "default_spec": DEFAULT_SPEC.to_dict(),
        "presets": [
            {"key": key, "label": label, "question": question, "spec": spec.canonical().to_dict()}
            for key, label, question, spec in PRESETS
        ],
        "custom_label": CUSTOM_LABEL,
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
            # New calculations per student and minute (a model computed before does not count); said when refused.
            "runs_per_minute": config.REGRESSION_RUNS_PER_MINUTE,
        },
        "hints": list(HINTS),
        "footnote": FOOTNOTE,
        "sample_differs_note": SAMPLE_DIFFERS_NOTE,
        "suppressed_note": SUPPRESSED_NOTE,
    }


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


def experiment_problem(value: Any) -> str | None:
    """Why a step's model experiment (the one put into the report) cannot be stored, or None. ``None`` (nothing put
    into the report) is fine. Checked on every session save."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != EXPERIMENT_KEYS:
        return "放入报告的模型的字段不完整"
    spec, problem = _spec_problem(value["spec"])
    if spec is None:
        return problem
    # The page offers neither (its first column is the default model).
    if spec == DEFAULT_SPEC:
        return "默认模型就是表中第一列，不用放入报告"
    if not isinstance(value["saved_at"], str) or not 1 <= len(value["saved_at"]) <= 40:
        return "放入报告的模型的保存时间无效"
    snapshot = value["snapshot"]
    if not isinstance(snapshot, dict) or len(json.dumps(snapshot, ensure_ascii=False).encode()) > MAX_SNAPSHOT_BYTES:
        return "放入报告的模型的结果快照无效或过大"
    return None


def reported_experiment(value: Any) -> dict[str, Any] | None:
    """What a report prints and depends on of a step's experiment: its ``spec``; None without a valid one. Changing
    the snapshot, or the half-filled form (``custom_draft``), changes nothing here."""
    if experiment_problem(value) is not None or value is None:
        return None
    return {"spec": value["spec"]}
