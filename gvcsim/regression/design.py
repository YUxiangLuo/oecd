"""四类教学实证回归的稳定设计契约。

课程编号属于展示层；回归业务只使用稳定 ``outcome`` 标识，避免课程调整改变
贸易流、生产、长度与网络四类因变量的 API 含义。

**枚举值与展示文案分离**:API 只接受稳定英文键(``tariff``、``did`` 等),
中文文案放在与之配对的 ``*_LABELS`` 里,并随 /api/regression/options 一起下发。
早先的契约直接把界面文字当枚举值(``"双重差分 (DID)"``),于是改个标点、
翻译或缩短标签都会变成破坏性 API 变更——展示层的措辞不该有这种权力。
"""

from dataclasses import dataclass

from gvcsim.data.controls import CONTROL_COLUMNS, CONTROL_LABELS, MACRO_CONTROL_COLUMNS
from gvcsim.shocks import SHOCK_LABELS, SHOCK_SPECS, SHOCK_TARIFF

# 稳定 outcome → (被解释变量, 中文含义)。列名来自 pipeline 产出的指标面板。
OUTCOME_DEPVARS = {
    "trade": ("FVA_share", "出口中外国增加值份额(FVA / 毛出口,WWZ)"),
    "production": ("3b_VA_GVC_C_share", "复杂GVC生产份额(3b_VA_GVC_C / SVA,WWYZ)"),
    "length": ("PLv_GVC", "前向 GVC 生产长度(WWYZ)"),
    "network": ("betweenesscentrality", "生产网络介数中心性"),
}
OUTCOMES = list(OUTCOME_DEPVARS)

GRANULARITY_COUNTRY_INDUSTRY = "country_industry"
GRANULARITY_COUNTRY = "country"
GRANULARITIES = [GRANULARITY_COUNTRY_INDUSTRY, GRANULARITY_COUNTRY]
GRANULARITY_LABELS = {
    GRANULARITY_COUNTRY_INDUSTRY: "国家–行业级",
    GRANULARITY_COUNTRY: "国家级",
}
OUTCOME_GRANULARITIES = {
    outcome: ([GRANULARITY_COUNTRY_INDUSTRY] if outcome == "network" else list(GRANULARITIES)) for outcome in OUTCOMES
}

SHOCK_TYPES = list(SHOCK_SPECS)

METHOD_DID = "did"
METHOD_TWFE_INTENSITY = "twfe_intensity"
METHOD_EVENT_STUDY = "event_study"
METHODS = [METHOD_DID, METHOD_TWFE_INTENSITY, METHOD_EVENT_STUDY]
METHOD_LABELS = {
    METHOD_DID: "双重差分 (DID)",
    METHOD_TWFE_INTENSITY: "双向固定效应",
    METHOD_EVENT_STUDY: "事件研究",
}

CONTROL_MODE_NONE = "none"
CONTROL_MODE_ICIO = "icio_derived"
CONTROL_MODE_MACRO = "macro_sim"
CONTROL_MODES = [CONTROL_MODE_NONE, CONTROL_MODE_ICIO, CONTROL_MODE_MACRO]
CONTROL_MODE_LABELS = {
    CONTROL_MODE_NONE: "不加控制变量",
    CONTROL_MODE_ICIO: "ICIO 派生控制变量",
    CONTROL_MODE_MACRO: "模拟宏观控制",
}

PRICE_MODE_NOMINAL = "nominal"
PRICE_MODE_REAL = "real_2016"
PRICE_MODES = [PRICE_MODE_NOMINAL, PRICE_MODE_REAL]
PRICE_MODE_LABELS = {
    PRICE_MODE_NOMINAL: "名义值",
    PRICE_MODE_REAL: "实际值(2016=1)",
}

SCENARIO_CLEAN = "clean"
SCENARIO_NOISY = "noisy"
SCENARIO_CONFOUNDED = "confounded"
SCENARIOS = [SCENARIO_CLEAN, SCENARIO_NOISY, SCENARIO_CONFOUNDED]
SCENARIO_LABELS = {
    SCENARIO_CLEAN: "基准场景(clean)",
    SCENARIO_NOISY: "测量误差(noisy)",
    SCENARIO_CONFOUNDED: "前趋势混杂(confounded)",
}

# 粒度 → (面板文件, 个体列, 聚类列)。冲击在国家层面高度相关,
# 行业级回归的标准误也按国家聚类,避免组内相关低估标准误。
_PANEL_SPECS = {
    GRANULARITY_COUNTRY: ("panel_country.csv", "country", "country"),
    GRANULARITY_COUNTRY_INDUSTRY: ("panel_industry.csv", "entity_id", "country"),
}


@dataclass
class RegressionDesign:
    outcome: str
    granularity: str = GRANULARITY_COUNTRY_INDUSTRY
    shock_type: str = SHOCK_TARIFF
    # 默认用 DID 展示处理组相对对照组的处理后变化；因果解释仍依赖识别假设。
    method: str = METHOD_DID
    control_mode: str = CONTROL_MODE_NONE
    interaction: bool = False
    price_mode: str = PRICE_MODE_NOMINAL
    scenario: str = SCENARIO_CLEAN
    # ROW(Rest of World)是投入产出表闭合用的剩余地区,不是可解释的政策处理对象。
    # 指标计算仍保留 ROW;回归估计默认剔除,避免 DID/事件研究把聚合残差当成真实国家。
    exclude_row: bool = True

    def __post_init__(self) -> None:
        validate_outcome_granularity(self.outcome, self.granularity)

    @property
    def depvar(self) -> str:
        return OUTCOME_DEPVARS[self.outcome][0]

    @property
    def depvar_label(self) -> str:
        return OUTCOME_DEPVARS[self.outcome][1]

    @property
    def panel_file(self) -> str:
        return _PANEL_SPECS[self.granularity][0]

    @property
    def entity(self) -> str:
        return _PANEL_SPECS[self.granularity][1]

    @property
    def cluster(self) -> str:
        return _PANEL_SPECS[self.granularity][2]

    @property
    def controls(self) -> tuple[str, ...]:
        if self.control_mode == CONTROL_MODE_ICIO:
            return tuple(CONTROL_COLUMNS)
        if self.control_mode == CONTROL_MODE_MACRO:
            return tuple(MACRO_CONTROL_COLUMNS)
        return ()

    @property
    def shock_col(self) -> str:
        return SHOCK_SPECS[self.shock_type][0]

    @property
    def treated_col(self) -> str:
        return SHOCK_SPECS[self.shock_type][1]

    @property
    def regressors(self) -> tuple[str, ...]:
        return (self.shock_col,)

    @property
    def control_labels(self) -> dict[str, str]:
        return {c: CONTROL_LABELS[c] for c in self.controls}

    @property
    def scenario_label(self) -> str:
        return SCENARIO_LABELS.get(self.scenario, self.scenario)

    # 展示文案由设计对象自己提供,调用方(API/报告/CLI)不各自维护一份映射。
    @property
    def granularity_label(self) -> str:
        return GRANULARITY_LABELS.get(self.granularity, self.granularity)

    @property
    def shock_type_label(self) -> str:
        return SHOCK_LABELS.get(self.shock_type, self.shock_type)

    @property
    def method_label(self) -> str:
        return METHOD_LABELS.get(self.method, self.method)

    @property
    def control_mode_label(self) -> str:
        return CONTROL_MODE_LABELS.get(self.control_mode, self.control_mode)

    @property
    def price_mode_label(self) -> str:
        return PRICE_MODE_LABELS.get(self.price_mode, self.price_mode)

    @property
    def sample_filter(self) -> str:
        return "排除 ROW(世界其他地区聚合账户)" if self.exclude_row else "包含 ROW"

    def equation_parts(self) -> list[dict[str, str]]:
        """返回可交互渲染的结构化方程片段。

        ``text`` 连接后与 :meth:`equation` 完全一致；``term`` 和
        ``meta_key`` 供前端把符号与回归设定摘要联动高亮。
        """
        unit = "it" if self.granularity == GRANULARITY_COUNTRY else "ijt"
        ent = "i" if self.granularity == GRANULARITY_COUNTRY else "ij"
        y = f"{self.depvar}_{unit}"
        if self.method == METHOD_DID:
            x = f"β·({self.treated_col}_{ent} × 1[t≥G_{ent}])"
            policy_desc = "曾受处理个体自首次冲击年起、相对对照组的平均变化；因果解释依赖识别假设。"
            interaction_text = f"θ·({self.treated_col}_{ent} × 1[t≥G_{ent}] × (BaseGVC_{ent},0−mean(BaseGVC_0)))"
        elif self.method == METHOD_EVENT_STUDY:
            x = f"Σ_k β_k·1[t-G_{ent}=k]"
            policy_desc = "相对首次冲击年的动态主效应；k=-1 为省略基期。"
            interaction_text = f"Σ_k θ_k·(1[t-G_{ent}=k] × (BaseGVC_{ent},0−mean(BaseGVC_0)))"
        else:
            x = " + ".join(f"β·{r}_{unit}" for r in self.regressors)
            policy_desc = f"连续冲击强度 {self.shock_col} 的主效应。"
            interaction_text = f"θ·({self.shock_col}_{unit} × (BaseGVC_{ent},0−mean(BaseGVC_0)))"

        parts: list[dict[str, str]] = [
            {
                "text": y,
                "term": "dependent",
                "description": self.depvar_label,
                "meta_key": "depvar",
            },
            {"text": " = "},
            {
                "text": x,
                "term": "policy",
                "description": policy_desc,
                "meta_key": "policy",
            },
        ]
        if self.interaction:
            parts.extend(
                [
                    {"text": " + "},
                    {
                        "text": interaction_text,
                        "term": "interaction",
                        "description": "冲击效应随个体基期 GVC 参与度变化的异质性；基期 GVC 按样本个体均值中心化，因此 β 表示均值处效应。",
                        "meta_key": "interaction",
                    },
                ]
            )
        if self.controls:
            labels = "、".join(self.control_labels.values())
            parts.extend(
                [
                    {"text": " + "},
                    {
                        "text": "γ·Controls_ct",
                        "term": "controls",
                        "description": f"国家-年份控制变量：{labels}。",
                        "meta_key": "controls",
                    },
                ]
            )
        parts.extend(
            [
                {"text": " + "},
                {
                    "text": f"α_{ent}",
                    "term": "fixed-effect",
                    "description": f"{self.entity} 个体固定效应。",
                    "meta_key": "entity",
                },
                {"text": " + "},
                {
                    "text": "λ_t",
                    "term": "fixed-effect",
                    "description": "年份固定效应，吸收同期公共冲击。",
                    "meta_key": "entity",
                },
                {"text": " + "},
                {
                    "text": f"ε_{unit}",
                    "term": "error",
                    "description": f"误差项；统计推断的标准误按 {self.cluster} 聚类。",
                    "meta_key": "cluster",
                },
            ]
        )
        return parts

    def equation(self) -> str:
        """生成与原型界面一致的回归方程展示文本(按方法渲染解释变量)。"""
        return "".join(part["text"] for part in self.equation_parts())


def validate_outcome_granularity(outcome: str, granularity: str) -> None:
    """校验 outcome 与可识别的面板粒度组合。"""
    if outcome not in OUTCOMES:
        raise ValueError(f"outcome 必须是 {OUTCOMES}")
    if granularity not in GRANULARITIES:
        raise ValueError(f"granularity 必须是 {GRANULARITIES}")
    supported = OUTCOME_GRANULARITIES[outcome]
    if granularity not in supported:
        raise ValueError(
            "网络介数中心性回归仅支持国家–行业级；国家级贸易图在全部正流量边下为完全图，"
            "Gephi 介数中心性恒为 0，不能用于回归。"
        )
