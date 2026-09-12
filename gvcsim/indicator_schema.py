"""Stable indicator metadata shared by API routes and tests."""

from typing import Any, cast

PRODUCTION_LENGTH_OPERATIONAL_DEFINITION = (
    "生产长度以某段生产活动诱发的累计总产出除以该段关联增加值（后向口径为最终产品承载的关联增加值），"
    "表示增加值加权的平均生产阶段数；不是跨境次数、经过国家数或网络边数。"
)

INDICATOR_SCHEMA = {
    "groups": [
        {
            "key": "trade",
            "label": "WWZ 聚合项 + OECD TLS 扩展",
            "fields": [
                "gross_exports",
                "DVAex",
                "DVArt",
                "DDC",
                "FVA",
                "FDC",
                "taxsub",
                "EXDVA",
                "FVA_share",
                "DVAex_share",
            ],
        },
        {
            "key": "production",
            "label": "WWYZ 生产分解",
            "fields": [
                "SVA",
                "1_VA_D",
                "2_VA_RT",
                "3_VA_GVC",
                "3a_VA_GVC_S",
                "3b_VA_GVC_C",
                "FGY",
                "1_FGY_D",
                "2_FGY_RT",
                "3_FGY_GVC",
                "3a_FGY_GVC_S",
                "3b_FGY_GVC_C",
                "3_VA_GVC_share",
                "3b_VA_GVC_C_share",
            ],
        },
        {
            "key": "length",
            "label": "生产长度与位置",
            "fields": [
                "PLv",
                "PLv_D",
                "PLv_RT",
                "PLv_GVC",
                "PLy",
                "PLy_D",
                "PLy_RT",
                "PLy_GVC",
                "Pos_TPL",
                "GVCPs",
            ],
        },
        {
            "key": "network",
            "label": "生产网络指标（流量规模 + 全正边拓扑基准）",
            "fields": [
                "degree",
                "indegree",
                "outdegree",
                "weighted degree",
                "weighted indegree",
                "weighted outdegree",
                "Eccentricity",
                "closnesscentrality",
                "harmonicclosnesscentrality",
                "betweenesscentrality",
                "eigencentrality",
            ],
        },
    ],
    "fields": {
        "gross_exports": {"label": "毛出口(五类 WWZ 聚合项 + TLS)", "format": "amount"},
        "FVA_share": {"label": "外国增加值项占比", "format": "pct"},
        "DVAex_share": {"label": "DVAex 份额(DVAex/VA+TLS 账户闭合毛出口)", "format": "pct"},
        "3_VA_GVC_share": {"label": "GVC 生产份额(3_VA_GVC/SVA)", "format": "pct"},
        "3b_VA_GVC_C_share": {"label": "复杂GVC生产份额(3b/SVA)", "format": "pct"},
        "DVAex": {"label": "国内增加值出口(被国外吸收)", "format": "amount"},
        "DVArt": {"label": "出口后返回的国内增加值", "format": "amount"},
        "DDC": {"label": "国内重复计算", "format": "amount"},
        "FVA": {"label": "出口中的外国增加值", "format": "amount"},
        "FDC": {"label": "外国重复计算", "format": "amount"},
        "taxsub": {"label": "出口中的税收减补贴", "format": "amount"},
        "EXDVA": {"label": "出口国内增加值合计", "format": "amount"},
        "SVA": {"label": "总增加值", "format": "amount"},
        "1_VA_D": {"label": "纯国内生产增加值", "format": "amount"},
        "2_VA_RT": {"label": "传统贸易增加值", "format": "amount"},
        "3_VA_GVC": {"label": "GVC 生产增加值", "format": "amount"},
        "3a_VA_GVC_S": {"label": "简单 GVC 增加值", "format": "amount"},
        "3b_VA_GVC_C": {"label": "复杂 GVC 增加值", "format": "amount"},
        "FGY": {"label": "最终品生产(全球增加值)", "format": "amount"},
        "1_FGY_D": {"label": "国内最终品中的国内增加值", "format": "amount"},
        "2_FGY_RT": {"label": "最终品出口中的国内增加值", "format": "amount"},
        "3_FGY_GVC": {"label": "经中间品贸易的增加值", "format": "amount"},
        "3a_FGY_GVC_S": {"label": "简单 GVC(后向)", "format": "amount"},
        "3b_FGY_GVC_C": {"label": "复杂 GVC(后向)", "format": "amount"},
        "PLv": {"label": "前向总生产长度", "format": "number"},
        "PLv_D": {"label": "前向纯国内段长度", "format": "number"},
        "PLv_RT": {"label": "前向传统贸易段长度", "format": "number"},
        "PLv_GVC": {"label": "前向 GVC 段长度", "format": "number"},
        "PLy": {"label": "后向总生产长度", "format": "number"},
        "PLy_D": {"label": "后向纯国内段长度", "format": "number"},
        "PLy_RT": {"label": "后向传统贸易段长度", "format": "number"},
        "PLy_GVC": {"label": "后向 GVC 段长度", "format": "number"},
        "Pos_TPL": {"label": "总生产长度位置指数", "format": "number"},
        "GVCPs": {"label": "GVC 位置指数", "format": "number"},
        "degree": {"label": "度", "format": "number"},
        "indegree": {"label": "入度", "format": "number"},
        "outdegree": {"label": "出度", "format": "number"},
        "weighted degree": {"label": "加权总度(入+出；自环双计)", "format": "amount"},
        "weighted indegree": {"label": "加权入度", "format": "amount"},
        "weighted outdegree": {"label": "加权出度", "format": "amount"},
        "Eccentricity": {"label": "离心率", "format": "number"},
        "closnesscentrality": {"label": "接近中心性", "format": "number"},
        "harmonicclosnesscentrality": {"label": "调和中心性", "format": "number"},
        "betweenesscentrality": {"label": "全正边二值介数(拓扑基准)", "format": "number"},
        "eigencentrality": {"label": "Gephi 0.10.1 兼容入边分数", "format": "number"},
    },
}

_INDICATOR_DESCRIPTIONS = {
    "gross_exports": "五类 WWZ 聚合项与 OECD TLS（产品税减补贴）扩展项之和；这是 VA+TLS 账户闭合口径，不表示 taxsub 就是关税，也不是 WWZ 原文分解项。",
    "FVA_share": "WWZ 分解的 FVA（不含外国重复计算 FDC）占 VA+TLS 毛出口的比重；不是毛出口全部外国增加值含量。同一纯 VA 口径下全部外国含量为 FVA+FDC；OECD TiVA 另将相关 TLS 计入 VA，所以本字段不能当作官方 EXGR_FVASH。",
    "DVAex_share": "被国外最终吸收的国内增加值占 VA+TLS 账户闭合毛出口的比重；越高表示出口中由本国创造且最终被国外吸收的价值构成更高。",
    "3_VA_GVC_share": "通过中间品跨境参与 GVC 的增加值占总增加值 SVA 的比重。",
    "3b_VA_GVC_C_share": "至少经历两次跨境的复杂 GVC 增加值占总增加值 SVA 的比重。",
    "DVAex": "由本国创造、随出口离境并最终被国外吸收的增加值。",
    "DVArt": "随出口离境后又返回本国并在本国最终吸收的国内增加值。",
    "DDC": "本国增加值在跨境生产链中多次计入毛流量形成的国内重复计算。",
    "FVA": "WWZ 第 11–14 项聚合的外国增加值，不含第 15–16 项外国纯重复计算 FDC。毛出口的外国纯 VA 总含量为 FVA+FDC；OECD TiVA 的 VA 还含相关 TLS，因此不可与 EXGR_FVA 混称。",
    "FDC": "外国增加值在跨境生产链中多次计入毛流量形成的重复计算。",
    "taxsub": "由 OECD ICIO 的 TLS 账户沿投入产出链计算的出口税收减补贴含量；这是本系统为匹配 OECD 账户口径加入的扩展项，不是 WWZ 原文分解项。负值表示沿供应链累计后呈净补贴。",
    "EXDVA": "WWZ 不含国内纯重复计算 DDC 的国内增加值合计，等于 DVAex+DVArt；不要混称为 OECD 毛出口国内 VA 总含量。",
    "SVA": "从增加值来源端核算的生产活动总增加值。",
    "1_VA_D": "只在本国生产并满足本国最终需求、未发生跨境的增加值。",
    "2_VA_RT": "随最终品直接出口、只发生一次跨境的传统贸易增加值。",
    "3_VA_GVC": "随中间品贸易跨境并进入全球价值链生产的增加值。",
    "3a_VA_GVC_S": "中间品跨境一次后在国外被最终吸收的简单 GVC 增加值。",
    "3b_VA_GVC_C": "至少一次中间品跨境、最终吸收前累计跨境至少两次的复杂 GVC 增加值；后续可以是中间品或最终品出口。",
    "FGY": "从最终品生产端核算、为最终需求服务的全球增加值总量。",
    "1_FGY_D": "本国最终品中由本国生产且全程不跨境的增加值。",
    "2_FGY_RT": "最终品直接出口中包含的本国增加值。",
    "3_FGY_GVC": "经由中间品跨境贸易后进入最终品的增加值。",
    "3a_FGY_GVC_S": "从最终品端回溯、只经历一次中间品跨境的简单 GVC 增加值。",
    "3b_FGY_GVC_C": "从最终品端回溯，至少一次中间品跨境且累计跨境至少两次的增加值；后续跨境可以由最终品承载。",
    "PLv": "从增加值创造端向最终吸收端追踪的账户比值；VA 为正时可理解为增加值加权平均总生产阶段数，存在负 VA 时则是有符号账户加权，不保证普通凸加权平均的区间性质；不是跨境次数、经过国家数或网络边数。",
    "PLv_D": "前向纯国内活动诱发的累计总产出除以该段关联增加值，表示该段的平均生产阶段数。",
    "PLv_RT": "前向传统最终品贸易活动诱发的累计总产出除以该段关联增加值，表示该段的平均生产阶段数。",
    "PLv_GVC": "从增加值创造端向最终吸收端追踪：GVC 活动诱发的累计总产出除以该段关联增加值。VA 为正时可理解为增加值加权平均生产阶段数；存在负 VA 时是有符号账户比值；不是跨境次数、经过国家数或网络边数。",
    "PLy": "从最终品端向初始增加值来源回溯的账户比值；VA 为正时可理解为增加值加权平均总生产阶段数，存在负 VA 时则是有符号账户加权；不是跨境次数、经过国家数或网络边数。",
    "PLy_D": "从最终品端回溯：纯国内活动的累计总产出除以最终产品承载的该段关联增加值，表示平均生产阶段数。",
    "PLy_RT": "从最终品端回溯：传统贸易活动的累计总产出除以最终产品承载的该段关联增加值，表示平均生产阶段数。",
    "PLy_GVC": "从最终品端向初始增加值来源回溯：GVC 活动累计总产出除以最终产品承载的关联增加值。VA 为正时可理解为增加值加权平均生产阶段数；存在负 VA 时是有符号账户比值；不是跨境次数、经过国家数或网络边数。",
    "Pos_TPL": "以前向与后向总生产长度的相对关系衡量价值链位置。",
    "GVCPs": "前向与后向 GVC 生产长度之比；大于 1 通常表示更靠近上游。",
    "degree": "与该节点直接相连的入边和出边数量。",
    "indegree": "指向该节点的直接供应链连接数量。",
    "outdegree": "由该节点指向其他节点的直接供应链连接数量。",
    "weighted degree": "加权入度与加权出度之和；正自环同时属于入向和出向，因而在本字段计两次。它不是去重后的贸易额或外部联系总额。",
    "weighted indegree": "流入该节点的网络边流量之和。",
    "weighted outdegree": "由该节点流出的网络边流量之和。",
    "Eccentricity": "该节点到所有可达节点的最远最短路径距离。",
    "closnesscentrality": "从该节点沿出边可达的节点数除以最短路径距离之和，越高表示向外可达性越强。",
    "harmonicclosnesscentrality": "从该节点沿出边到可达节点的距离倒数平均值，可处理不完全连通网络。",
    "betweenesscentrality": "全部有限正流量边等长时，各有序节点对的有向最短路径经过该节点的份额之和（σ_st(v)/σ_st；未按节点对数归一化）。微小正边与大额边同权且未做边阈值敏感性检验；它只是一项拓扑基准，不是经济枢纽、瓶颈或不可替代性的证据。",
    "eigencentrality": "精确复现 Gephi Toolkit 0.10.1 的 100 次累计入边迭代并以最大值归一。该兼容分数保留软件复现性，但累计迭代不同于标准 Perron 特征向量幂迭代，不能简称为标准特征向量中心性。",
}
# 国家级贸易图在全部正流量边下是完全图,这些无权中心性因此对所有国家取同一常数
# (度=152、介数=0、接近/离心/调和/特征向量恒定),没有横截面区分度,只在国家–行业级
# 图上才有意义。加权度(=贸易量)不在此列,国家级仍可区分。前端据此在国家级隐藏这些
# 字段,回归也只允许 network outcome 用国家–行业级(见 regression/design.py)。
_COUNTRY_DEGENERATE_NETWORK_FIELDS = frozenset(
    {
        "degree",
        "indegree",
        "outdegree",
        "Eccentricity",
        "closnesscentrality",
        "harmonicclosnesscentrality",
        "betweenesscentrality",
        "eigencentrality",
    }
)
_COUNTRY_DEGENERATE_NOTE = "（国家级贸易图为完全图，该指标对所有国家恒为常数，仅在国家–行业级有区分度）"

# 用 .get 而不是下标:漏写描述应表现为测试失败(test_indicator_schema 断言
# desc 全部非空),而不是 import 时 KeyError 拖垮整个服务。
_indicator_fields = cast(dict[str, dict[str, Any]], INDICATOR_SCHEMA["fields"])
for _field, _meta in _indicator_fields.items():
    _degenerate = _field in _COUNTRY_DEGENERATE_NETWORK_FIELDS
    _desc = _INDICATOR_DESCRIPTIONS.get(_field, "")
    _meta["desc"] = _desc + _COUNTRY_DEGENERATE_NOTE if _degenerate else _desc
    # 契约字段:前端在国家级粒度隐藏被标记的字段,避免展示零信息的常数中心性。
    _meta["country_degenerate"] = _degenerate
