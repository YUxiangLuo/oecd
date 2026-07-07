"""步骤5:GVC 生产分解指标(Wang-Wei-Yu-Zhu 2017 聚合口径)。

按客户资料字段把生产活动拆成四段:
  1_VA_D / 1_FGY_D              纯国内
  2_VA_RT / 2_FGY_RT            传统贸易
  3a_*_GVC_S                    简单 GVC
  3b_*_GVC_C                    复杂 GVC

VA 字段按行方向(增加值来源)汇总,FGY 字段按列方向(最终产品生产)汇总。
"""

import numpy as np
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


def _cleanup_residual(total: np.ndarray, *parts: np.ndarray) -> np.ndarray:
    out = total.copy()
    for part in parts:
        out = out - part
    tiny = np.abs(out) < 1e-8
    out[tiny] = 0.0
    return out


def sector_production(arr: IcioArrays) -> pd.DataFrame:
    """行业级生产分解,索引 (country, industry)。"""
    col_of = {r: j for j, r in enumerate(arr.regions)}
    y_total = arr.Yd.sum(axis=1)

    # 每国"国内链条产出向量" L_ss @ Y_ss,简单 GVC 项要用,先算好
    dom_final = {s: arr.L_dd[s] @ arr.Yd[arr.pos[s], col_of[s]] for s in arr.regions}

    # 总增加值(基准):v ⊙ (B @ 全球最终需求),按增加值来源行业逐行记账
    total_by_row = arr.v * (arr.B @ y_total)
    total_by_col = (arr.v @ arr.B) * y_total

    parts = []
    for r in arr.regions:
        p = arr.pos[r]
        v_r = arr.v[p]
        L_rr = arr.L_dd[r]

        y_rr = arr.Yd[p, col_of[r]]  # r 对本国产品的最终需求
        y_export = arr.Yd[p, :].sum(axis=1) - y_rr  # 最终品出口

        pure_domestic = v_r * (L_rr @ y_rr)
        traditional = v_r * (L_rr @ y_export)

        # 中间品出口给 s,s 用国内链条生产供本国消费 → 只跨境一次
        z_simple = np.zeros(len(p))
        for s in arr.regions:
            if s == r:
                continue
            A_rs = arr.A[np.ix_(p, arr.pos[s])]
            z_simple += A_rs @ dom_final[s]
        simple = v_r * (L_rr @ z_simple)

        total = total_by_row[p]
        complex_gvc = _cleanup_residual(total, pure_domestic, traditional, simple)

        local_coeff = v_r @ L_rr
        fgy_d = local_coeff * y_rr
        fgy_rt = local_coeff * y_export
        fgy_gvc_s = np.zeros(len(p))
        local_dom_by_final = L_rr @ np.diag(y_rr)
        for s in arr.regions:
            if s == r:
                continue
            q = arr.pos[s]
            simple_matrix = np.diag(arr.v[q]) @ arr.L_dd[s] @ arr.A[np.ix_(q, p)] @ local_dom_by_final
            fgy_gvc_s += simple_matrix.sum(axis=0)
        fgy_total = total_by_col[p]
        fgy_gvc_c = _cleanup_residual(fgy_total, fgy_d, fgy_rt, fgy_gvc_s)

        parts.append(
            pd.DataFrame(
                {
                    "SVA": total,
                    "1_VA_D": pure_domestic,
                    "2_VA_RT": traditional,
                    "3a_VA_GVC_S": simple,
                    "3b_VA_GVC_C": complex_gvc,
                    "FGY": fgy_total,
                    "1_FGY_D": fgy_d,
                    "2_FGY_RT": fgy_rt,
                    "3a_FGY_GVC_S": fgy_gvc_s,
                    "3b_FGY_GVC_C": fgy_gvc_c,
                },
                index=pd.MultiIndex.from_product([[r], arr.sectors]),
            )
        )

    df = pd.concat(parts)
    df.index.names = ["country", "industry"]
    df["3_VA_GVC"] = df["3a_VA_GVC_S"] + df["3b_VA_GVC_C"]
    df["3_FGY_GVC"] = df["3a_FGY_GVC_S"] + df["3b_FGY_GVC_C"]
    return df[PRODUCTION_COLUMNS]


def country_production(arr: IcioArrays, sector_df: pd.DataFrame | None = None) -> pd.DataFrame:
    """国家级生产分解 = 行业级金额按国加总。"""
    if sector_df is None:
        sector_df = sector_production(arr)
    df = sector_df[PRODUCTION_COLUMNS].groupby(level=0).sum()
    df["3_VA_GVC"] = df["3a_VA_GVC_S"] + df["3b_VA_GVC_C"]
    df["3_FGY_GVC"] = df["3a_FGY_GVC_S"] + df["3b_FGY_GVC_C"]
    df.index.name = "country"
    return df[PRODUCTION_COLUMNS]
