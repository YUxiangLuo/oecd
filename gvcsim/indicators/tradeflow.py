"""步骤4:GVC 总贸易流分解指标。

把一国毛出口拆成国内增加值(DVA)与国外增加值(FVA),并计算
前向参与度(本国增加值嵌入他国出口的比例)。

⚠ 方法论:沿用原型阶段验证过的"简化版"分解(见 gvc_indicators.py 顶部说明),
不是完整的 Koopman-Wang-Wei (2014) 分解 —— 忽略了增加值"出国转一圈又回来"
的往返项。数量级与国家排序可靠;若要论文级精度需替换为 KWW / Borin-Mancini。
"""

import numpy as np
import pandas as pd

from gvcsim.indicators.core import IcioArrays


def country_tradeflow(arr: IcioArrays) -> pd.DataFrame:
    """国家级贸易流分解。返回索引为国家的 DataFrame:

    gross_exports              毛出口
    dva_in_exports             出口中的国内增加值含量(v_r · L_rr · e_r)
    backward_fva_share         后向参与度 = 出口中外国增加值占比
    forward_share              前向参与度 = 本国增加值嵌入他国出口 / 本国毛出口
    gvc_participation          后向 + 前向,文献常用的总参与度
    """
    # T[r, s] = v_r' · B_rs · e_s:r 国增加值嵌入 s 国出口的金额(一次算完所有国家对)
    M = (arr.v[:, None] * arr.B) * arr.E[None, :]
    n_r = arr.n_regions
    T = np.zeros((n_r, n_r))
    for i, r in enumerate(arr.regions):
        rows = M[arr.pos[r], :]
        for j, s in enumerate(arr.regions):
            T[i, j] = rows[:, arr.pos[s]].sum()

    rows = {}
    for i, r in enumerate(arr.regions):
        p = arr.pos[r]
        e_r = arr.E[p]
        ex_total = float(e_r.sum())
        dva = float(arr.v[p] @ arr.L_dd[r] @ e_r)
        forward = float(T[i, :].sum() - T[i, i])
        rows[r] = {
            "gross_exports": ex_total,
            "dva_in_exports": dva,
            "backward_fva_share": 1 - dva / ex_total if ex_total > 0 else np.nan,
            "forward_share": forward / ex_total if ex_total > 0 else np.nan,
        }
    df = pd.DataFrame(rows).T
    df["gvc_participation"] = df["backward_fva_share"] + df["forward_share"]
    df.index.name = "country"
    return df


def sector_tradeflow(arr: IcioArrays) -> pd.DataFrame:
    """行业级贸易流分解。索引为 (country, sector):

    gross_exports        该行业毛出口
    dva_share            该行业出口的国内增加值率((v_r' L_rr)_j)
    backward_fva_share   1 - dva_share
    """
    records = []
    for r in arr.regions:
        p = arr.pos[r]
        va_multiplier = arr.v[p] @ arr.L_dd[r]  # 每行业单位出口的国内增加值含量
        for k, s in enumerate(arr.sectors):
            records.append({
                "country": r,
                "sector": s,
                "gross_exports": float(arr.E[p][k]),
                "dva_share": float(va_multiplier[k]),
                "backward_fva_share": float(1 - va_multiplier[k]),
            })
    return pd.DataFrame(records).set_index(["country", "sector"])
