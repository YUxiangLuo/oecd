"""步骤2:WWZ 总贸易核算聚合项与 OECD TLS 扩展。

先把 WWZ 公开文献的 16 个双边明细项聚合为五类:

  DVAex   国内增加值出口并被其他地区最终吸收(WWZ 16 项中的第 1-5 项,VAX_G)
  DVArt   国内增加值出口但最终返回国内(第 6-8 项,RDV)
  DDC     纯国内重复计算(第 9-10 项)
  FVA     总出口中的外国增加值(第 11-14 项)
  FDC     总出口中来自外国的纯重复计算(第 15-16 项)
再增加一个 OECD ICIO 账户扩展:

  taxsub  总出口中的产品税减补贴(TLS)含量；不是 WWZ 原文的分解项
并派生 EXDVA = DVAex + DVArt(出口的国内增加值总额)。

实现说明:WWZ 的 16 项定义在双边 (s→r) 层面;本模块对进口伙伴求和,输出
出口国×行业与出口国两级聚合，不落盘双边明细。
对伙伴求和后各组有紧凑的闭合形式(推导自 WWZ Table A2,逐项加总化简):

  设出口国 s 的行块为 p,v/t 为纯增加值/税收系数,B 为全球逆,L_ss 为国内逆,
  A^F 为跨境技术系数,W = B @ Yd(各国最终需求诱发的产出),
  P_s = B[:, p] @ yexp_s(s 的最终品出口诱发的各国产出),eint 为中间品出口:

  DVAex = (v_s B_ss) ⊙ yfin_s + (v_s L_ss) ⊙ [A^F_s (x − W[:,s] − P_s)]
  DVArt = (v_s L_ss) ⊙ [A^F_s W[:,s]]
  DDC   = (v_s L_ss) ⊙ [A^F_s P_s] + (v_s B_ss − v_s L_ss) ⊙ eint
  FVA   = f ⊙ (yfin_s + A^F_s [L_rr ydom_r])      f = (vB)[p] − v_s B_ss
  FDC   = f ⊙ (A^F_s [L_rr E_r])
  taxsub = (tB)[p] ⊙ E_s

五个 WWZ 聚合项与 taxsub 扩展项加总恒等于 OECD 总出口 E
(由 (v+t)'B = 1 保证),单元测试与全量重算均校验。
"""

import numpy as np
import pandas as pd

from gvcsim.indicators.core import IcioArrays

TRADE_COLUMNS = ["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub", "EXDVA"]

# 六个闭合项(EXDVA 是派生项,不参与闭合)
_CLOSURE_COLS = ["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"]


def gross_exports(df: pd.DataFrame) -> pd.Series:
    """总出口 = 五个 WWZ 聚合项 + OECD TLS 扩展项；任一闭合项缺失则总量未定义。"""
    return df[_CLOSURE_COLS].sum(axis=1, min_count=len(_CLOSURE_COLS))


def sector_tradeflow(arr: IcioArrays) -> pd.DataFrame:
    """国家-行业级 WWZ 聚合项与 OECD TLS 扩展,索引为 (country, industry)。"""
    n = len(arr.x)
    node_regions = arr.index.get_level_values(0).to_numpy()
    node_sectors = arr.index.get_level_values(1).to_numpy()
    region_idx = {r: i for i, r in enumerate(arr.regions)}

    ydom = arr.y_domestic()
    yexp = arr.y_export()

    # 全局量,只算一次
    W = arr.B @ arr.Yd  # N×R:各目的国最终需求诱发的产出
    vB = arr.v @ arr.B  # 全球增加值系数(行向量)
    tB = arr.t @ arr.B  # 全球税收含量系数
    mL_dom = arr.apply_L(ydom)  # L_rr @ Y_rr,分国块
    mL_exp = arr.apply_L(arr.E)  # L_rr @ E_r*,分国块

    dvaex = np.zeros(n)
    dvart = np.zeros(n)
    ddc = np.zeros(n)
    fva = np.zeros(n)
    fdc = np.zeros(n)

    for s in arr.regions:
        p = arr.pos[s]
        c = region_idx[s]
        L_ss = arr.L_dd[s]
        B_ss = arr.B[np.ix_(p, p)]
        vB_ss = arr.v[p] @ B_ss
        vL_ss = arr.v[p] @ L_ss
        f = vB[p] - vB_ss  # 外国增加值系数(全部 t≠s 来源)

        yfin = yexp[p]  # 最终品出口
        eint = arr.E[p] - yfin  # 中间品出口

        # s 的最终品出口诱发的各国产出(用于第 5 项排除与第 9 项返回)
        P_s = arr.B[:, p] @ yexp[p]

        # A^F_s(·):s 行块的跨境技术系数乘以分国块向量,home 块列置零
        A_row = arr.A[p, :].copy()
        A_row[:, p] = 0.0

        m_dvaex = arr.x - W[:, c] - P_s
        m_dvaex[p] = 0.0
        m_rdv = W[:, c].copy()
        m_rdv[p] = 0.0
        m_ddc = P_s.copy()
        m_ddc[p] = 0.0
        m_fva = mL_dom.copy()
        m_fva[p] = 0.0
        m_fdc = mL_exp.copy()
        m_fdc[p] = 0.0

        dvaex[p] = vB_ss * yfin + vL_ss * (A_row @ m_dvaex)
        dvart[p] = vL_ss * (A_row @ m_rdv)
        ddc[p] = vL_ss * (A_row @ m_ddc) + (vB_ss - vL_ss) * eint
        fva[p] = f * yfin + f * (A_row @ m_fva)
        fdc[p] = f * (A_row @ m_fdc)

    taxsub = tB * arr.E

    df = pd.DataFrame(
        {
            "DVAex": dvaex,
            "DVArt": dvart,
            "DDC": ddc,
            "FVA": fva,
            "FDC": fdc,
            "taxsub": taxsub,
            "EXDVA": dvaex + dvart,
        },
        index=pd.MultiIndex.from_arrays([node_regions, node_sectors], names=["country", "industry"]),
    )
    return df


def country_tradeflow(arr: IcioArrays, sector_df: pd.DataFrame | None = None) -> pd.DataFrame:
    """国家级贸易流分解 = 国家-行业级金额按国加总。"""
    if sector_df is None:
        sector_df = sector_tradeflow(arr)
    df = sector_df[TRADE_COLUMNS].groupby(level=0).sum()
    df.index.name = "country"
    return df
