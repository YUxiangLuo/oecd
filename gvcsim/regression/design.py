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

GRANULARITIES = ["国家级", "国家–行业级"]
SHOCK_TYPES = ["关税冲击", "制裁清单", "出口管制"]
METHODS = ["双重差分 (DID)", "双向固定效应", "事件研究"]


@dataclass
class RegressionDesign:
    step: int
    granularity: str = "国家级"
    shock_type: str = "关税冲击"
    method: str = "双向固定效应"
    regressors: tuple[str, ...] = ("tariff_shock",)

    @property
    def depvar(self) -> str:
        return STEP_DEPVARS[self.step][0]

    @property
    def depvar_label(self) -> str:
        return STEP_DEPVARS[self.step][1]

    def equation(self) -> str:
        """生成与原型界面一致的回归方程展示文本。"""
        unit = "it" if self.granularity == "国家级" else "ijt"
        y = f"{self.depvar}_{unit}"
        x = " + ".join(f"β·{r}_{unit}" for r in self.regressors)
        fe = "α_i + λ_t" if self.granularity == "国家级" else "α_ij + λ_t"
        return f"{y} = {x} + {fe} + ε_{unit}"
