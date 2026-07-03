"""步骤5:GVC 生产分解指标(Wang-Wei-Yu-Zhu 2017 框架的简化实现)。

按增加值实现路径把一国增加值(GDP)拆成四段:
  pure_domestic   纯国内:国内生产、国内最终消费,不跨境
  traditional     传统贸易:以最终品形式直接出口,只跨境一次即被消费
  simple_gvc      简单 GVC:以中间品出口,进口国用于生产其国内消费的产品(跨境一次)
  complex_gvc     复杂 GVC:其余部分,增加值至少跨境两次(多次往返)

四段之和恒等于该国增加值总额(单元测试验证这一恒等式)。
"""

import numpy as np
import pandas as pd

from gvcsim.indicators.core import IcioArrays


def country_production(arr: IcioArrays) -> pd.DataFrame:
    """国家级生产分解。返回金额与占比(share_* 列,加总为1)。"""
    col_of = {r: j for j, r in enumerate(arr.regions)}

    # 每国"国内链条产出向量" L_ss @ Y_ss,复杂/简单 GVC 项都要用,先算好
    dom_final = {}
    for s in arr.regions:
        ps = arr.pos[s]
        dom_final[s] = arr.L_dd[s] @ arr.Yd[ps, col_of[s]]

    # 总增加值(基准):v ⊙ (B @ 全球最终需求) 在本国块上求和 ≡ 本国 GDP
    total_by_row = arr.v * (arr.B @ arr.Yd.sum(axis=1))

    rows = {}
    for r in arr.regions:
        p = arr.pos[r]
        v_r = arr.v[p]
        L_rr = arr.L_dd[r]

        y_rr = arr.Yd[p, col_of[r]]                       # r 对本国产品的最终需求
        y_export = arr.Yd[p, :].sum(axis=1) - y_rr        # 最终品出口

        pure_domestic = float(v_r @ L_rr @ y_rr)
        traditional = float(v_r @ L_rr @ y_export)

        # 中间品出口给 s,s 用国内链条生产供本国消费 → 只跨境一次
        simple = 0.0
        for s in arr.regions:
            if s == r:
                continue
            A_rs = arr.A[np.ix_(p, arr.pos[s])]
            simple += float(v_r @ L_rr @ A_rs @ dom_final[s])

        total = float(total_by_row[p].sum())
        complex_gvc = total - pure_domestic - traditional - simple

        rows[r] = {
            "va_total": total,
            "pure_domestic": pure_domestic,
            "traditional": traditional,
            "simple_gvc": simple,
            "complex_gvc": complex_gvc,
        }

    df = pd.DataFrame(rows).T
    for col in ["pure_domestic", "traditional", "simple_gvc", "complex_gvc"]:
        df[f"share_{col}"] = df[col] / df["va_total"]
    df.index.name = "country"
    return df
