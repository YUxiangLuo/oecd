"""The single regression design published by the teaching application."""

from dataclasses import dataclass

from gvcsim.regression import teaching as teaching_module
from gvcsim.regression.spec import (
    CONTROLS,
    DEFAULT_SPEC,
    X_LAG_COLUMNS,
    ModelSpec,
    control_column,
    control_term_label,
    x_term_label,
)
from gvcsim.regression.teaching import X_COLUMN

OUTCOME_DEPVARS = {
    "trade": ("FVA_share", "外国增加值项占比"),
    "production": ("3b_VA_GVC_C_share", "复杂 GVC 生产份额"),
    "length": ("PLv_GVC", "前向 GVC 段长度"),
    "network": ("weighted degree", "加权总度（入+出）"),
}
OUTCOMES = list(OUTCOME_DEPVARS)
GRANULARITY_COUNTRY_INDUSTRY = "country_industry"
_ESTIMATOR_GRANULARITIES = (GRANULARITY_COUNTRY_INDUSTRY, "country")
GRANULARITY_LABELS = {GRANULARITY_COUNTRY_INDUSTRY: "国家–行业级"}
OUTCOME_GRANULARITIES = {
    # Release QC still validates the country aggregates produced by the data
    # pipeline. The HTTP teaching contract exposes country_industry only.
    outcome: ([GRANULARITY_COUNTRY_INDUSTRY] if outcome == "network" else list(_ESTIMATOR_GRANULARITIES))
    for outcome in OUTCOMES
}
METHOD_TWFE_INTENSITY = "twfe_intensity"
METHOD_LABELS = {METHOD_TWFE_INTENSITY: "连续强度 TWFE（描述性）"}
CONTROL_MODE_NONE = "none"
CONTROL_MODE_SPEC = "spec"
CONTROL_MODE_LABELS = {CONTROL_MODE_NONE: "不加控制变量", CONTROL_MODE_SPEC: "自选控制变量"}
PRICE_MODE_NOMINAL = "nominal"
PRICE_MODE_LABELS = {PRICE_MODE_NOMINAL: "名义值"}
SCENARIO_CLEAN = "clean"
SCENARIO_LABELS = {SCENARIO_CLEAN: "基准场景(clean)"}


@dataclass
class RegressionDesign:
    """A tariff × industry-country teaching regression: the course default or a model a student designs.

    A teaching design carries a ``ModelSpec`` (X terms, controls, fixed effects; ``None`` means the course default
    ``DEFAULT_SPEC``). Observed-panel designs (release QC) stay the classic one-regressor (entity, year) model.
    ``granularity`` remains an estimator-test seam for disconnected FE fixtures; HTTP contracts do not expose it.
    """

    outcome: str
    granularity: str = GRANULARITY_COUNTRY_INDUSTRY
    method: str = METHOD_TWFE_INTENSITY
    teaching: bool = False
    # Which same-family indicator calibrates the simulated Y; None means the family's fixed default.
    baseline: str | None = None
    spec: ModelSpec | None = None

    def __post_init__(self) -> None:
        if self.outcome not in OUTCOMES:
            raise ValueError(f"outcome 必须是 {OUTCOMES}")
        if self.teaching:
            self.spec = (self.spec or DEFAULT_SPEC).canonical()
        elif self.spec is not None:
            raise ValueError("只有教学面板可以自选模型设定")
        self.baseline = teaching_module.baseline(self.outcome, self.baseline).key
        if not self.teaching and self._baseline.derived is not None:
            raise ValueError("观测面板没有派生份额列，只有教学面板可以选择该基线")
        if self.method != METHOD_TWFE_INTENSITY:
            raise ValueError("仅支持 twfe_intensity")
        if self.granularity not in _ESTIMATOR_GRANULARITIES:
            raise ValueError(f"granularity 必须是 {list(_ESTIMATOR_GRANULARITIES)}")
        if self.outcome == "network" and self.granularity == "country":
            raise ValueError("网络指标回归仅支持国家–行业级；国家级网络指标不是按国家×行业节点定义的")

    @property
    def _baseline(self) -> teaching_module.Baseline:
        return teaching_module.baseline(self.outcome, self.baseline)

    @property
    def is_default_baseline(self) -> bool:
        return self._baseline is teaching_module.default_baseline(self.outcome)

    @property
    def depvar(self) -> str:
        return teaching_module.y_column(self.outcome, self.baseline) if self.teaching else self._baseline.column

    @property
    def baseline_label(self) -> str:
        return OUTCOME_DEPVARS[self.outcome][1] if self.is_default_baseline else self._baseline.label

    @property
    def depvar_label(self) -> str:
        return self.baseline_label

    @property
    def depvar_kind(self) -> str:
        return self._baseline.kind

    @property
    def depvar_unit(self) -> str:
        return self._baseline.unit

    @property
    def panel_file(self) -> str:
        if self.teaching:
            return "panel_teaching.csv"
        return "panel_industry.csv" if self.granularity == GRANULARITY_COUNTRY_INDUSTRY else "panel_country.csv"

    @property
    def entity(self) -> str:
        return "entity_id" if self.granularity == GRANULARITY_COUNTRY_INDUSTRY else "country"

    @property
    def cluster(self) -> str:
        return "country"

    @property
    def shock_col(self) -> str:
        return X_COLUMN if self.teaching else "tariff_shock"

    @property
    def treated_col(self) -> str:
        return "teaching_treated" if self.teaching else "treated"

    @property
    def is_classic_model(self) -> bool:
        """X only with country × industry and year effects: the model whose wording predates the spec."""
        return self.spec is None or (
            self.spec.x_lags == (0,)
            and not self.spec.controls
            and self.spec.fixed_effects == ("country_industry", "year")
        )

    @property
    def regressors(self) -> tuple[str, ...]:
        return tuple(self.spec.x_columns) if self.spec else (self.shock_col,)

    @property
    def controls(self) -> tuple[str, ...]:
        return tuple(self.spec.control_columns) if self.spec else ()

    @property
    def control_labels(self) -> dict[str, str]:
        if not self.spec:
            return {}
        return {control_column(key, lag): control_term_label(key, lag) for key, lag in self.spec.controls}

    @property
    def granularity_label(self) -> str:
        return GRANULARITY_LABELS.get(self.granularity, self.granularity)

    @property
    def shock_type(self) -> str:
        return "tariff"

    @property
    def shock_type_label(self) -> str:
        return "关税冲击"

    @property
    def method_label(self) -> str:
        return METHOD_LABELS[METHOD_TWFE_INTENSITY]

    @property
    def control_mode(self) -> str:
        return CONTROL_MODE_SPEC if self.controls else CONTROL_MODE_NONE

    @property
    def control_mode_label(self) -> str:
        """ "不加控制变量", or the controls by name ("控制：汇率变动")."""
        if not self.controls:
            return CONTROL_MODE_LABELS[CONTROL_MODE_NONE]
        return "控制：" + "、".join(self.control_labels.values())

    @property
    def interaction(self) -> bool:
        return False

    @property
    def price_mode(self) -> str:
        return PRICE_MODE_NOMINAL

    @property
    def price_mode_label(self) -> str:
        return PRICE_MODE_LABELS[PRICE_MODE_NOMINAL]

    @property
    def scenario(self) -> str:
        return SCENARIO_CLEAN

    @property
    def scenario_label(self) -> str:
        return SCENARIO_LABELS[SCENARIO_CLEAN]

    @property
    def exclude_row(self) -> bool:
        return True

    @property
    def sample_filter(self) -> str:
        return "排除 ROW(世界其他地区聚合账户)"

    def equation_parts(self) -> list[dict[str, str]]:
        if not self.is_classic_model:
            return self._spec_equation_parts()
        unit, ent = ("ijt", "ij") if self.granularity == GRANULARITY_COUNTRY_INDUSTRY else ("it", "i")
        return [
            {
                "text": f"{self.depvar}_{unit}",
                "term": "dependent",
                "description": f"Y：结果变量，本步看的指标（{self.depvar_label}）。",
                "meta_key": "depvar",
            },
            {"text": " = "},
            {
                "text": f"β·{self.shock_col}_{unit}",
                "term": "policy",
                "description": "β·X：X 是关税暴露 = 冲击前出口份额 w × 税率 τ；β 是要估的数，即 X 每增加 1 个百分点，Y 平均变化多少。",
                "meta_key": "policy",
            },
            {"text": " + "},
            {
                "text": f"α_{ent}",
                "term": "fixed-effect",
                "description": f"α：每个{self.granularity_label if self.granularity != GRANULARITY_COUNTRY_INDUSTRY else '国家×行业'}自己的起点，扣掉。",
                "meta_key": "entity",
            },
            {"text": " + "},
            {
                "text": "λ_t",
                "term": "fixed-effect",
                "description": "λ：所有单位共同的年份变化，扣掉。",
                "meta_key": "entity",
            },
            {"text": " + "},
            {
                "text": f"ε_{unit}",
                "term": "error",
                "description": "ε：剩下的扰动；标准误按国家聚类。",
                "meta_key": "cluster",
            },
        ]

    def _spec_equation_parts(self) -> list[dict[str, str]]:
        assert self.spec is not None
        parts: list[dict[str, str]] = [
            {
                "text": f"{self.depvar}_ijt",
                "term": "dependent",
                "description": f"Y：结果变量，本步看的指标（{self.depvar_label}）。",
                "meta_key": "depvar",
            },
            {"text": " = "},
        ]
        terms: list[dict[str, str]] = []
        for index, lag in enumerate(self.spec.x_lags):
            when = "当年" if lag == 0 else f"{lag} 年前"
            terms.append(
                {
                    "text": f"β{_subscript(index + 1)}·{X_LAG_COLUMNS[lag]}_ijt",
                    "term": "policy",
                    "description": f"{x_term_label(lag)}：{when}的关税暴露（对美出口份额 w × 当年税率 τ）。",
                    "meta_key": "policy",
                }
            )
        for index, (key, lag) in enumerate(self.spec.controls):
            terms.append(
                {
                    "text": f"γ{_subscript(index + 1)}·{control_column(key, lag)}_it",
                    "term": "control",
                    "description": f"{control_term_label(key, lag)}：{CONTROLS[key].definition}。",
                    "meta_key": "controls",
                }
            )
        for key in self.spec.fixed_effects:
            symbol, description = _EFFECT_PARTS[key]
            terms.append({"text": symbol, "term": "fixed-effect", "description": description, "meta_key": "entity"})
        if not self.spec.fixed_effects:
            terms.append(
                {
                    "text": "α",
                    "term": "constant",
                    "description": "α：常数项（没有固定效应时加入）。",
                    "meta_key": "entity",
                }
            )
        terms.append(
            {
                "text": "ε_ijt",
                "term": "error",
                "description": "ε：剩下的扰动；标准误按国家聚类。",
                "meta_key": "cluster",
            }
        )
        for index, term in enumerate(terms):
            if index:
                parts.append({"text": " + "})
            parts.append(term)
        return parts

    def equation(self) -> str:
        return "".join(part["text"] for part in self.equation_parts())


_EFFECT_PARTS = {
    "country": ("α_i", "α：每个国家自己的起点，扣掉。"),
    "industry": ("α_j", "α：每个行业自己的起点，扣掉。"),
    "country_industry": ("α_ij", "α：每个国家×行业自己的起点，扣掉。"),
    "year": ("λ_t", "λ：所有单位共同的年份变化，扣掉。"),
    "country_year": ("μ_it", "μ：每个国家每年共同的变化，扣掉（国家层面的控制变量会被它吸收）。"),
}


def _subscript(number: int) -> str:
    return str(number).translate(str.maketrans("0123456789", "₀₁₂₃₄₅₆₇₈₉"))


def validate_outcome_granularity(outcome: str, granularity: str) -> None:
    RegressionDesign(outcome, granularity=granularity)
