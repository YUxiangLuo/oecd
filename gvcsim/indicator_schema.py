"""Stable indicator metadata shared by API routes and tests."""

from typing import Any, cast

PRODUCTION_LENGTH_OPERATIONAL_DEFINITION = (
    "生产长度等于某段生产活动带动的累计总产出除以这段活动的增加值（后向长度用最终产品中所含的这部分增加值），"
    "表示按增加值加权的平均生产阶段数；不是跨境次数、经过国家数或网络边数。"
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
            "label": "生产网络指标",
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
        "gross_exports": {"label": "总出口（含产品税减补贴）", "format": "amount"},
        "FVA_share": {"label": "外国增加值项占比", "format": "pct"},
        "DVAex_share": {"label": "国内增加值出口占比", "format": "pct"},
        "3_VA_GVC_share": {"label": "前向 GVC 生产总份额", "format": "pct"},
        "3_FGY_GVC_share": {"label": "后向 GVC 生产总份额", "format": "pct"},
        "3b_VA_GVC_C_share": {"label": "复杂 GVC 生产份额", "format": "pct"},
        "DVAex": {"label": "国内增加值出口", "format": "amount"},
        "DVArt": {"label": "返回国内的增加值", "format": "amount"},
        "DDC": {"label": "国内重复计算", "format": "amount"},
        "FVA": {"label": "外国增加值", "format": "amount"},
        "FDC": {"label": "外国重复计算", "format": "amount"},
        "taxsub": {"label": "产品税减补贴", "format": "amount"},
        "EXDVA": {"label": "出口国内增加值合计", "format": "amount"},
        "SVA": {"label": "总增加值", "format": "amount"},
        "1_VA_D": {"label": "纯国内增加值", "format": "amount"},
        "2_VA_RT": {"label": "传统贸易增加值", "format": "amount"},
        "3_VA_GVC": {"label": "GVC 增加值", "format": "amount"},
        "3a_VA_GVC_S": {"label": "简单 GVC 增加值", "format": "amount"},
        "3b_VA_GVC_C": {"label": "复杂 GVC 增加值", "format": "amount"},
        "FGY": {"label": "最终品生产（后向总量）", "format": "amount"},
        "1_FGY_D": {"label": "纯国内（后向）", "format": "amount"},
        "2_FGY_RT": {"label": "传统贸易（后向）", "format": "amount"},
        "3_FGY_GVC": {"label": "全部 GVC（后向）", "format": "amount"},
        "3a_FGY_GVC_S": {"label": "简单 GVC（后向）", "format": "amount"},
        "3b_FGY_GVC_C": {"label": "复杂 GVC（后向）", "format": "amount"},
        "PLv": {"label": "前向总生产长度", "format": "number"},
        "PLv_D": {"label": "前向纯国内段长度", "format": "number"},
        "PLv_RT": {"label": "前向传统贸易段长度", "format": "number"},
        "PLv_GVC": {"label": "前向 GVC 段长度", "format": "number"},
        "PLy": {"label": "后向总生产长度", "format": "number"},
        "PLy_D": {"label": "后向纯国内段长度", "format": "number"},
        "PLy_RT": {"label": "后向传统贸易段长度", "format": "number"},
        "PLy_GVC": {"label": "后向 GVC 段长度", "format": "number"},
        "Pos_TPL": {"label": "总长度位置指数（前向总长／后向总长）", "format": "number"},
        "GVCPs": {"label": "GVC 位置指数（前向 GVC 段／后向 GVC 段）", "format": "number"},
        "degree": {"label": "度", "format": "count"},
        "indegree": {"label": "入度", "format": "count"},
        "outdegree": {"label": "出度", "format": "count"},
        "weighted degree": {"label": "加权总度", "format": "amount"},
        "weighted indegree": {"label": "加权入度", "format": "amount"},
        "weighted outdegree": {"label": "加权出度", "format": "amount"},
        "Eccentricity": {"label": "离心率", "format": "count"},
        "closnesscentrality": {"label": "接近中心性", "format": "number"},
        "harmonicclosnesscentrality": {"label": "调和中心性", "format": "number"},
        "betweenesscentrality": {"label": "介数", "format": "count"},
        "eigencentrality": {"label": "特征向量中心性（软件近似）", "format": "number"},
    },
}

# Shown to students under each chart (steps 6–9) and in the step 5 table headers: plain words, no formulas.
# The accounting caveats (WWZ items, TLS, negative value added, the Gephi algorithm) live in 技术手册.md
# and the report's method notes.
_INDICATOR_DESCRIPTIONS = {
    "gross_exports": "出口总额，等于五类价值来源（国内增加值出口、返回国内的增加值、国内重复计算、外国增加值、外国重复计算）加上产品税减补贴。",
    "FVA_share": "出口额中由外国创造的价值（外国增加值）所占的比例。不含被重复计算的部分，所以和 OECD TiVA 公布的“出口中外国增加值占比”不完全相同。",
    "DVAex_share": "出口额中由本国创造、最终在国外被使用的价值所占的比例。",
    "3_VA_GVC_share": "本国增加值中，随中间品跨境、进入全球价值链生产的部分所占的比例（前向，分母是本国总增加值）。",
    "3_FGY_GVC_share": "本国生产的最终品中，经过中间品跨境而来的增加值所占的比例（后向，分母是最终品总值）。",
    "3b_VA_GVC_C_share": "本国增加值中，被最终使用前至少跨境两次的部分（复杂 GVC）所占的比例。",
    "DVAex": "由本国创造、随出口离开本国、最终在国外被使用的增加值。",
    "DVArt": "随出口离开本国、又回到本国并在本国被最终使用的增加值。",
    "DDC": "中间品多次过境时，本国的同一份价值被重复计入出口额的部分。",
    "FVA": "出口中由外国创造的价值（不含被重复计算的部分）。",
    "FDC": "中间品多次过境时，外国的同一份价值被重复计入出口额的部分。",
    "taxsub": "出口中含的产品税减去补贴；负数表示补贴更多。它不是步骤 10 的关税。",
    "EXDVA": "出口中由本国创造的价值合计，等于国内增加值出口 + 返回国内的增加值。",
    "SVA": "本国生产活动创造的全部增加值（前向份额的分母）。",
    "1_VA_D": "只在本国生产、满足本国最终需求、不跨境的增加值。",
    "2_VA_RT": "随最终品直接出口、只跨境一次的增加值（传统贸易）。",
    "3_VA_GVC": "随中间品跨境、进入全球价值链生产的增加值。",
    "3a_VA_GVC_S": "随中间品跨境一次、在进口国被最终使用的增加值（简单 GVC）。",
    "3b_VA_GVC_C": "被最终使用前至少跨境两次的增加值（复杂 GVC）；其中至少一次是中间品跨境。",
    "FGY": "本国生产的最终品总值，其中的增加值可以来自各国（后向份额的分母）。",
    "1_FGY_D": "本国最终品中，由本国生产、全程不跨境的增加值。",
    "2_FGY_RT": "本国直接出口的最终品中含的本国增加值。",
    "3_FGY_GVC": "本国最终品中，经过中间品跨境而来的增加值。",
    "3a_FGY_GVC_S": "从最终品端回溯，只经过一次中间品跨境的增加值（简单 GVC）。",
    "3b_FGY_GVC_C": "从最终品端回溯，累计跨境至少两次的增加值（复杂 GVC）；后面的跨境可以是最终品。",
    "PLv": "从增加值的产地往最终使用方向追踪，全部生产活动平均经过几道生产工序。它不是跨境次数。",
    "PLv_D": "前向追踪时，纯国内这一段平均经过几道生产工序。",
    "PLv_RT": "前向追踪时，传统贸易这一段平均经过几道生产工序。",
    "PLv_GVC": "从增加值的产地往最终使用方向追踪，GVC 这一段平均经过几道生产工序。它不是跨境次数。",
    "PLy": "从最终品向上游回溯至增加值的来源地，全部生产活动平均经过几道生产工序。它不是跨境次数。",
    "PLy_D": "后向追踪时，纯国内这一段平均经过几道生产工序。",
    "PLy_RT": "后向追踪时，传统贸易这一段平均经过几道生产工序。",
    "PLy_GVC": "从最终品向上游回溯至增加值的来源地，GVC 这一段平均经过几道生产工序。它不是跨境次数。",
    "Pos_TPL": "前向总生产长度 ÷ 后向总生产长度；大于 1 表示相对更上游。",
    "GVCPs": "前向 GVC 段长度 ÷ 后向 GVC 段长度；大于 1 表示相对更上游。",
    "degree": "与这个节点直接相连的连接条数（买入和卖出都算）。",
    "indegree": "向这个节点供货的直接连接条数。",
    "outdegree": "这个节点向其他节点供货的直接连接条数。",
    "weighted degree": "这个节点买入和卖出的金额之和（买入 + 卖出，百万美元）。行业级只算中间品；自环（行业卖给自己的部分，例如钢铁卖给钢铁）在买、卖两边各计一次。",
    "weighted indegree": "这个节点买入的金额之和（流入的流量）。",
    "weighted outdegree": "这个节点卖出的金额之和（流出的流量）。",
    "Eccentricity": "从该节点出发，到可达节点的最短路线中最长的一条所含步数。",
    "closnesscentrality": "从这个节点沿供货方向出发，到其他节点平均有多近；越高表示越容易到达其他节点。",
    "harmonicclosnesscentrality": "和接近中心性类似：把到每个能到达的节点的距离取倒数再平均；越高表示离其他节点越近。",
    "betweenesscentrality": "只看连接、不看金额：将每条供货关系视为等长，计算经过该行业的最短路线所占比例，对所有节点对求和（未归一化）；数值越大，中转位置越突出；但它不看金额，不能证明这个行业是经济枢纽或瓶颈。",
    "eigencentrality": "被重要节点连接的节点得分更高。这里按 Gephi 网络软件的算法近似计算（最高为 1），只作参考。",
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

# 用 .get 而不是下标:漏写描述应表现为测试失败(test_indicator_schema 断言
# desc 全部非空),而不是 import 时 KeyError 拖垮整个服务。
_indicator_fields = cast(dict[str, dict[str, Any]], INDICATOR_SCHEMA["fields"])
for _field, _meta in _indicator_fields.items():
    _meta["desc"] = _INDICATOR_DESCRIPTIONS.get(_field, "")
    # 契约字段:前端在国家级粒度隐藏被标记的字段,避免展示零信息的常数中心性。这些字段的说明
    # 因此只在行业级页面出现,不再附加“国家级为常数”的提示。
    _meta["country_degenerate"] = _field in _COUNTRY_DEGENERATE_NETWORK_FIELDS
