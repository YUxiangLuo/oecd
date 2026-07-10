"""步骤12-16:回归设计。

步骤12 要求在建模前与客户书面对齐三件事(粒度/冲击类型/因果推断方式),
这里把对齐结果编码成 RegressionDesign,并为步骤13-16 预置四组默认设计
(被解释变量分别对应贸易流/生产/长度/网络四组指标)。
"""

from dataclasses import dataclass

from gvcsim.data.controls import CONTROL_COLUMNS, CONTROL_LABELS, MACRO_CONTROL_COLUMNS
from gvcsim.shocks import SHOCK_SPECS

# 步骤编号 → (被解释变量, 中文含义)。列名来自 pipeline 产出的客户口径面板。
STEP_DEPVARS = {
    13: ("FVA_share", "出口中外国增加值份额(FVA / 毛出口,WWZ)"),
    14: ("3b_VA_GVC_C_share", "复杂GVC生产份额(3b_VA_GVC_C / SVA,WWYZ)"),
    15: ("PLv_GVC", "前向 GVC 生产长度(WWYZ)"),
    16: ("betweenesscentrality", "生产网络介数中心性"),
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
    "国家–行业级": ("panel_industry.csv", "entity_id", "country"),
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
    # ROW(Rest of World)是投入产出表闭合用的剩余地区,不是可解释的政策处理对象。
    # 指标计算仍保留 ROW;回归估计默认剔除,避免 DID/事件研究把聚合残差当成真实国家。
    exclude_row: bool = True

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

    @property
    def sample_filter(self) -> str:
        return "排除 ROW(世界其他地区聚合账户)" if self.exclude_row else "包含 ROW"

    def equation_parts(self) -> list[dict[str, str]]:
        """返回可交互渲染的结构化方程片段。

        ``text`` 连接后与 :meth:`equation` 完全一致；``term`` 和
        ``meta_key`` 供前端把符号与回归设定摘要联动高亮。
        """
        unit = "it" if self.granularity == "国家级" else "ijt"
        ent = "i" if self.granularity == "国家级" else "ij"
        y = f"{self.depvar}_{unit}"
        if self.method == "双重差分 (DID)":
            x = f"β·({self.treated_col}_{ent} × 1[t≥G_{ent}])"
            policy_desc = "曾受处理个体自首次冲击年起的 DID 处理效应。"
            interaction_text = f"θ·({self.treated_col}_{ent} × 1[t≥G_{ent}] × BaseGVC_{ent},0)"
        elif self.method == "事件研究":
            x = f"Σ_k β_k·1[t-G_{ent}=k]"
            policy_desc = "相对首次冲击年的动态主效应；k=-1 为省略基期。"
            interaction_text = f"Σ_k θ_k·(1[t-G_{ent}=k] × BaseGVC_{ent},0)"
        else:
            x = " + ".join(f"β·{r}_{unit}" for r in self.regressors)
            policy_desc = f"连续冲击强度 {self.shock_col} 的主效应。"
            interaction_text = f"θ·({self.shock_col}_{unit} × BaseGVC_{ent},0)"

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
                        "description": "冲击效应随个体基期 GVC 参与度变化的异质性。",
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
