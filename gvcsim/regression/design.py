"""步骤12-16:回归设计。

步骤12 要求在建模前与客户书面对齐三件事(粒度/冲击类型/因果推断方式),
这里把对齐结果编码成 RegressionDesign,并为步骤13-16 预置四组默认设计
(被解释变量分别对应贸易流/生产/长度/网络四组指标)。
"""

from dataclasses import dataclass

# 步骤编号 → (被解释变量, 中文含义)。列名来自 pipeline 产出的国家级面板。
STEP_DEPVARS = {
    13: ("backward_fva_share", "出口中外国增加值份额(后向GVC参与度)"),
    14: ("share_complex_gvc", "复杂GVC生产份额"),
    15: ("upstreamness_cross", "生产链跨境段长度"),
    16: ("betweenness_centrality", "生产网络介数中心性"),
}

GRANULARITIES = ["国家–行业级", "国家级"]
SHOCK_TYPES = ["关税冲击", "制裁清单", "出口管制"]
METHODS = ["双重差分 (DID)", "双向固定效应", "事件研究"]

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
    regressors: tuple[str, ...] = ("tariff_shock",)

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

    def equation(self) -> str:
        """生成与原型界面一致的回归方程展示文本(按方法渲染解释变量)。"""
        unit = "it" if self.granularity == "国家级" else "ijt"
        ent = "i" if self.granularity == "国家级" else "ij"
        y = f"{self.depvar}_{unit}"
        fe = f"α_{ent} + λ_t"
        if self.method == "双重差分 (DID)":
            x = f"β·(treated_{ent} × post_t)"
        elif self.method == "事件研究":
            x = f"Σ_k β_k·(treated_{ent} × 1[t=T₀+k])"
        else:
            x = " + ".join(f"β·{r}_{unit}" for r in self.regressors)
        return f"{y} = {x} + {fe} + ε_{unit}"
