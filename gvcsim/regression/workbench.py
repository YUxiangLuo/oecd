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
    OPENNESS_COLUMN,
    POPULATION_COLUMN,
    X_LAGS,
    ModelSpec,
    x_term_label,
)
from gvcsim.regression.teaching import OUTCOMES, VERSION, selectable_baselines

# A snapshot holds one result table (about 2 KB); the bound keeps a tampered session from storing anything larger.
MAX_SNAPSHOT_BYTES = 16_000
EXPERIMENT_KEYS = frozenset({"spec", "saved_at", "snapshot"})
# The Y the experiment was run on, when it is not the step's default (a selectable Y of the step's family).
EXPERIMENT_OPTIONAL_KEYS = frozenset({"baseline"})

X_LAG_DESCRIPTIONS = {
    0: "当期：今年的 X",
    1: "滞后 1 期：上一年的 X",
    2: "滞后 2 期：两年前的 X。课程数据里没有两年后的关联，所以加上它后合计几乎不变、它自己的区间应包含 0",
}
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
    "country_year": "每个国家每年一个截距，包含国家 FE 和年份 FE；会吸收本页全部国家层面的控制变量（包括滞后项），省略这些变量但不因其缺失删样本。"
    "课程数据的混杂都在国家层面，所以它和默认模型算出的 X 合计几乎相同：吸收不等于没有控制",
}
DESIGN_VALUE_NOTE = (
    "课程数据按设定生成：每个 Y 的两年累计关联有一个设定值。模型设定对了，估计应落在设定值附近（区间包含它）；"
    "漏掉混杂或固定效应，估计会离开设定值。人口增长率、FDI 与 Y 无关，加上它们不改变合计。"
)
NO_FIXED_EFFECTS_NOTE = "都不勾时模型加常数项，表下的设定写作“无固定效应”。"


def _without(controls: tuple[tuple[str, int], ...], *names: str) -> tuple[tuple[str, int], ...]:
    return tuple(item for item in controls if item[0] not in names)


# The preset experiments, in page order, each changing one thing of the default model. The first tier is the three
# "必看" ones (a confounder left out: the estimate moves away from the course's design value, 15–20% each way on v13
# data); the second tier is "进阶". Each is a contrast the course data were built to show, and the question is asked,
# not answered. Their labels name the experiment in the report. Two changes the page also offers (country × year
# effects, L2.X) leave the estimate unchanged by design and are explained in the custom form instead.
PRESET_TIERS = {"core": "必看", "advanced": "进阶"}
PRESETS: tuple[tuple[str, str, str, str, ModelSpec], ...] = (
    (
        "no_exchange_rate",
        "core",
        "去掉汇率变动",
        "X 各项合计离课程设定值远了多少？",
        ModelSpec(
            DEFAULT_SPEC.x_lags, _without(DEFAULT_SPEC.controls, EXCHANGE_RATE_COLUMN), DEFAULT_SPEC.fixed_effects
        ),
    ),
    (
        "no_gdp",
        "core",
        "去掉 GDP 对数",
        "和去掉汇率变动偏向同一边吗？",
        ModelSpec(DEFAULT_SPEC.x_lags, _without(DEFAULT_SPEC.controls, GDP_COLUMN), DEFAULT_SPEC.fixed_effects),
    ),
    (
        "no_openness",
        "core",
        "去掉贸易开放度",
        "这次往哪边偏？",
        ModelSpec(DEFAULT_SPEC.x_lags, _without(DEFAULT_SPEC.controls, OPENNESS_COLUMN), DEFAULT_SPEC.fixed_effects),
    ),
    (
        "current_x_only",
        "advanced",
        "只放当期 X（去掉 L1.X）",
        "少了上一年那一项，合计少了多少？",
        ModelSpec((0,), DEFAULT_SPEC.controls, DEFAULT_SPEC.fixed_effects),
    ),
    (
        "no_year_effects",
        "advanced",
        "去掉年份固定效应",
        "三组一起涨跌的那部分被算到 X 上了吗？",
        ModelSpec(DEFAULT_SPEC.x_lags, DEFAULT_SPEC.controls, ("country_industry",)),
    ),
    (
        "separate_effects",
        "advanced",
        "固定效应改为国家 + 行业 + 年份",
        "不勾“国家×行业”，合计离设定值多远？",
        ModelSpec(DEFAULT_SPEC.x_lags, DEFAULT_SPEC.controls, ("country", "industry", "year")),
    ),
    (
        "extra_controls",
        "advanced",
        "加上人口增长率和 FDI 净流入占比",
        "它们的系数带星吗？合计变了吗？",
        ModelSpec(
            DEFAULT_SPEC.x_lags,
            (*DEFAULT_SPEC.controls, (POPULATION_COLUMN, 0), (FDI_COLUMN, 0)),
            DEFAULT_SPEC.fixed_effects,
        ),
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
    for _key, _tier, label, _question, preset in PRESETS:
        if preset.canonical() == canonical:
            return label
    return CUSTOM_LABEL


def options() -> dict[str, Any]:
    """Everything the workbench offers, in page order, with the default model, the presets and the limits."""
    return {
        "version": VERSION,
        "default_spec": DEFAULT_SPEC.to_dict(),
        "presets": [
            {
                "key": key,
                "tier": tier,
                "tier_label": PRESET_TIERS[tier],
                "label": label,
                "question": question,
                "spec": spec.canonical().to_dict(),
            }
            for key, tier, label, question, spec in PRESETS
        ],
        "custom_label": CUSTOM_LABEL,
        # The course's design value of each Y's two-year total (the number the data were built around; None for the
        # position ratio, 0.0 for the zero-effect Y), so the page can say how far an estimate is from it.
        "design_values": {
            outcome: {item.key: item.beta for item in selectable_baselines(outcome)} for outcome in OUTCOMES
        },
        "design_value_note": DESIGN_VALUE_NOTE,
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


def _baseline_problem(value: Any, outcome: str | None) -> str | None:
    """Why the experiment's Y cannot be stored: not a selectable Y of the step's family (``outcome``; any name when
    the step is not known)."""
    if value is None:
        return None
    if not isinstance(value, str) or not 1 <= len(value) <= 60:
        return "放入报告的模型的因变量无效"
    if outcome is not None and value not in {item.key for item in selectable_baselines(outcome)}:
        return "放入报告的模型的因变量不是本步可选的指标"
    return None


def experiment_problem(value: Any, outcome: str | None = None) -> str | None:
    """Why a step's model experiment (the one put into the report) cannot be stored, or None. ``None`` (nothing put
    into the report) is fine. Checked on every session save; ``outcome`` is the step's family, which bounds the
    experiment's optional ``baseline`` (its Y; left out = the step's default Y)."""
    if value is None:
        return None
    if (
        not isinstance(value, dict)
        or not EXPERIMENT_KEYS <= set(value)
        or not set(value) <= EXPERIMENT_KEYS | EXPERIMENT_OPTIONAL_KEYS
    ):
        return "放入报告的模型的字段不完整"
    spec, problem = _spec_problem(value["spec"])
    if spec is None:
        return problem
    problem = _baseline_problem(value.get("baseline"), outcome)
    if problem is not None:
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
    """What a report prints and depends on of a step's experiment: its ``spec`` and, when it is not the step's
    default Y, its ``baseline``; None without a valid one. Changing the snapshot, or the half-filled form
    (``custom_draft``), changes nothing here."""
    if experiment_problem(value) is not None or value is None:
        return None
    reported: dict[str, Any] = {"spec": value["spec"]}
    if value.get("baseline"):
        reported["baseline"] = value["baseline"]
    return reported
