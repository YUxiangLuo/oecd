"""步骤12-16:回归设计。

步骤12 要求在建模前与客户书面对齐三件事(粒度/冲击类型/因果推断方式),
这里把对齐结果编码成 RegressionDesign,并为步骤13-16 预置四组默认设计
(被解释变量分别对应贸易流/生产/长度/网络四组指标)。
"""

from dataclasses import dataclass

from gvcsim.data.controls import CONTROL_COLUMNS, CONTROL_LABELS, MACRO_CONTROL_COLUMNS
from gvcsim.shocks import SHOCK_SPECS

# 步骤编号 → (被解释变量, 中文含义)。列名来自 pipeline 产出的国家级面板。
STEP_DEPVARS = {
    13: ("share_trade_fva", "出口中外国增加值份额(FVA share,BM source)"),
    14: ("share_prod_complex_gvc", "复杂GVC生产份额(WWYZ)"),
    15: ("upstreamness_cross", "生产链跨境段长度"),
    16: ("betweenness_centrality", "生产网络介数中心性"),
}

GRANULARITIES = ["国家–行业级", "国家级"]
SHOCK_TYPES = list(SHOCK_SPECS)
METHODS = ["双重差分 (DID)", "双向固定效应", "事件研究"]
CONTROL_MODE_NONE = "不加控制变量"
CONTROL_MODE_ICIO = "ICIO 派生控制变量"
CONTROL_MODE_MACRO = "模拟宏观控制"
CONTROL_MODES = [CONTROL_MODE_NONE, CONTROL_MODE_ICIO, CONTROL_MODE_MACRO]

PRICE_MODE_NOMINAL = "名义值"
PRICE_MODE_REAL = "实际值(2016=1)"
PRICE_MODES = [PRICE_MODE_NOMINAL, PRICE_MODE_REAL]

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
    "国家级": ("panel_country.csv", "country", "country"),
    "国家–行业级": ("panel_sector.csv", "entity_id", "country"),
}


@dataclass
class RegressionDesign:
    step: int
    granularity: str = "国家–行业级"
    shock_type: str = "关税冲击"
    # 冲击数据自带宣布/生效时间线,默认用能识别因果的 DID(见步骤12 文案)
    method: str = "双重差分 (DID)"
    control_mode: str = CONTROL_MODE_NONE
    interaction: bool = False
    price_mode: str = PRICE_MODE_NOMINAL
    scenario: str = SCENARIO_CLEAN

    @property
    def depvar(self) -> str:
        return STEP_DEPVARS[self.step][0]

    @property
    def depvar_label(self) -> str:
        return STEP_DEPVARS[self.step][1]

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

    def equation(self) -> str:
        """生成与原型界面一致的回归方程展示文本(按方法渲染解释变量)。"""
        unit = "it" if self.granularity == "国家级" else "ijt"
        ent = "i" if self.granularity == "国家级" else "ij"
        y = f"{self.depvar}_{unit}"
        fe = f"α_{ent} + λ_t"
        controls = " + γ·Controls_ct" if self.controls else ""
        interaction = ""
        if self.method == "双重差分 (DID)":
            x = f"β·({self.treated_col}_{ent} × 1[t≥G_{ent}])"
            if self.interaction:
                interaction = f" + θ·({self.treated_col}_{ent} × 1[t≥G_{ent}] × BaseGVC_{ent},0)"
        elif self.method == "事件研究":
            x = f"Σ_k β_k·1[t-G_{ent}=k]"
            if self.interaction:
                interaction = f" + Σ_k θ_k·(1[t-G_{ent}=k] × BaseGVC_{ent},0)"
        else:
            x = " + ".join(f"β·{r}_{unit}" for r in self.regressors)
            if self.interaction:
                interaction = f" + θ·({self.shock_col}_{unit} × BaseGVC_{ent},0)"
        return f"{y} = {x}{interaction}{controls} + {fe} + ε_{unit}"
