"""步骤5:GVC 生产分解指标（Wang-Wei-Yu-Zhu 2017a 公开文献口径）。

按式 V̂BŶ = V̂LŶ^D + V̂LŶ^F + V̂LA^F LŶ^D + V̂LA^F(BŶ − LŶ^D) 把生产活动
分为四类,并输出前向(增加值去向,沿行加总)与后向(增加值来源,沿列加总)
两个视角:

前向(供给视角,按增加值来源行业记账):
  SVA           国家-行业总增加值 = v ⊙ (B @ y) = v ⊙ x
  1_VA_D        纯国内生产活动的增加值        v ⊙ (L @ y_dom)
  2_VA_RT       传统贸易生产活动的增加值      v ⊙ (L @ y_exp)
  3_VA_GVC      GVC 生产活动的增加值          v ⊙ (L @ A^F @ x)
  3a_VA_GVC_S   简单 GVC(只跨境一次)        v ⊙ (L @ A^F @ L @ y_dom)
  3b_VA_GVC_C   复杂 GVC(跨境两次及以上)    3_VA_GVC − 3a_VA_GVC_S

后向(需求视角,按最终产品完成地记账):
  FGY           最终产品生产中的全球增加值    (v'B) ⊙ y
  1_FGY_D       国内最终品中的国内增加值      (v'L) ⊙ y_dom
  2_FGY_RT      最终品出口中的国内增加值      (v'L) ⊙ y_exp
  3_FGY_GVC     经由中间品贸易的增加值        (v'L A^F B) ⊙ y
  3a_FGY_GVC_S  简单 GVC 部分                 (v'L A^F L) ⊙ y_dom
  3b_FGY_GVC_C  复杂 GVC 部分                 3_FGY_GVC − 3a_FGY_GVC_S

恒等式(测试守护):1+2+3 = SVA,3a+3b = 3;FGY 同理。封闭经济时 GVC 段为 0。
"""

import pandas as pd

from gvcsim.indicators.core import IcioArrays

PRODUCTION_COLUMNS = [
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
]


def sector_production(arr: IcioArrays) -> pd.DataFrame:
    """行业级生产分解，索引 ``(country, industry)``，输出 12 个既有字段。"""
    ydom = arr.y_domestic()
    yexp = arr.y_export()
    ytot = ydom + yexp

    # ---- 前向:按增加值来源行业(沿行加总)----
    sva = arr.v * (arr.B @ ytot)  # = v ⊙ x(B@y = x)
    va_d = arr.v * arr.apply_L(ydom)
    va_rt = arr.v * arr.apply_L(yexp)
    va_gvc = arr.v * arr.apply_L(arr.apply_AF(arr.x))
    va_gvc_s = arr.v * arr.apply_L(arr.apply_AF(arr.apply_L(ydom)))
    va_gvc_c = va_gvc - va_gvc_s

    # ---- 后向:按最终产品完成地(沿列加总)----
    vB = arr.v @ arr.B
    vL = arr.apply_L_T(arr.v)
    vLAF = arr.apply_AF_T(vL)
    fgy = vB * ytot
    fgy_d = vL * ydom
    fgy_rt = vL * yexp
    fgy_gvc = (vLAF @ arr.B) * ytot
    fgy_gvc_s = arr.apply_L_T(vLAF) * ydom
    fgy_gvc_c = fgy_gvc - fgy_gvc_s

    df = pd.DataFrame(
        {
            "SVA": sva,
            "1_VA_D": va_d,
            "2_VA_RT": va_rt,
            "3_VA_GVC": va_gvc,
            "3a_VA_GVC_S": va_gvc_s,
            "3b_VA_GVC_C": va_gvc_c,
            "FGY": fgy,
            "1_FGY_D": fgy_d,
            "2_FGY_RT": fgy_rt,
            "3_FGY_GVC": fgy_gvc,
            "3a_FGY_GVC_S": fgy_gvc_s,
            "3b_FGY_GVC_C": fgy_gvc_c,
        },
        index=arr.index,
    )
    df.index.names = ["country", "industry"]
    return df


def country_production(arr: IcioArrays, sector_df: pd.DataFrame | None = None) -> pd.DataFrame:
    """国家级生产分解 = 行业级金额按国加总。"""
    if sector_df is None:
        sector_df = sector_production(arr)
    df = sector_df[PRODUCTION_COLUMNS].groupby(level=0).sum()
    df.index.name = "country"
    return df
