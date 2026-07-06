"""步骤5:GVC 生产分解指标(Wang-Wei-Yu-Zhu 2017 聚合口径)。

按增加值实现路径把增加值(GDP)拆成四段:
  prod_pure_domestic   纯国内:国内生产、国内最终消费,不跨境
  prod_traditional     传统贸易:以最终品形式直接出口,只跨境一次即被消费
  prod_simple_gvc      简单 GVC:以中间品出口,进口国用于生产其国内消费的产品
  prod_complex_gvc     复杂 GVC:增加值至少跨境两次(多次往返)

分解按增加值的**来源行业**记账,天然存在行业级版本:国家级 = 行业级按国
groupby 加总。四段之和恒等于增加值总额(单元测试在两个粒度上都验证)。
"""

import numpy as np
import pandas as pd

from gvcsim.indicators.core import IcioArrays

_AMOUNT_COLS = [
    "prod_pure_domestic",
    "prod_traditional",
    "prod_simple_gvc",
    "prod_complex_gvc",
    "prod_gvc_total",
]


def _add_shares(df: pd.DataFrame) -> pd.DataFrame:
    df["prod_gvc_total"] = df["prod_simple_gvc"] + df["prod_complex_gvc"]
    with np.errstate(divide="ignore", invalid="ignore"):
        for col in _AMOUNT_COLS:
            df[f"share_{col}"] = np.where(df["prod_va_total"] > 0, df[col] / df["prod_va_total"], np.nan)
    return df


def sector_production(arr: IcioArrays) -> pd.DataFrame:
    """行业级生产分解,索引 (country, sector)。金额列 + 占比列(share_*)。"""
    col_of = {r: j for j, r in enumerate(arr.regions)}

    # 每国"国内链条产出向量" L_ss @ Y_ss,简单 GVC 项要用,先算好
    dom_final = {s: arr.L_dd[s] @ arr.Yd[arr.pos[s], col_of[s]] for s in arr.regions}

    # 总增加值(基准):v ⊙ (B @ 全球最终需求),按增加值来源行业逐行记账
    total_by_row = arr.v * (arr.B @ arr.Yd.sum(axis=1))

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
        complex_gvc = total - pure_domestic - traditional - simple

        parts.append(
            pd.DataFrame(
                {
                    "prod_va_total": total,
                    "prod_pure_domestic": pure_domestic,
                    "prod_traditional": traditional,
                    "prod_simple_gvc": simple,
                    "prod_complex_gvc": complex_gvc,
                },
                index=pd.MultiIndex.from_product([[r], arr.sectors]),
            )
        )

    df = pd.concat(parts)
    df.index.names = ["country", "sector"]
    return _add_shares(df)


def country_production(arr: IcioArrays, sector_df: pd.DataFrame | None = None) -> pd.DataFrame:
    """国家级生产分解 = 行业级金额按国加总,占比重新计算。"""
    if sector_df is None:
        sector_df = sector_production(arr)
    df = (
        sector_df[
            [
                "prod_va_total",
                "prod_pure_domestic",
                "prod_traditional",
                "prod_simple_gvc",
                "prod_complex_gvc",
            ]
        ]
        .groupby(level=0)
        .sum()
    )
    df.index.name = "country"
    return _add_shares(df)
