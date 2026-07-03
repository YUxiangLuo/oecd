"""步骤6:GVC 长度分解指标。

上游度(Antras-Chor 2012):一单位产出到达最终消费者平均还要经过几个
生产阶段。U=1 表示产出全部直接卖给最终消费者(最下游);越大越上游。

分解:用"只保留国内块"的分摊矩阵算出国内段长度 U_dom,
跨境段 = 总长度 − 国内段,衡量对国际分工的依赖深度。
"""

import numpy as np
import pandas as pd

from gvcsim.indicators.core import IcioArrays


def _allocation_matrix(arr: IcioArrays) -> np.ndarray:
    """分摊矩阵 Ad_ij = Z_ij / x_i(按卖方产出分摊,与技术系数 A 方向相反)。"""
    with np.errstate(divide="ignore", invalid="ignore"):
        Ad = np.where(arr.x[:, None] > 0, arr.Z / arr.x[:, None], 0.0)
    return Ad


def sector_length(arr: IcioArrays) -> pd.DataFrame:
    """行业级长度指标,索引 (country, sector):

    upstreamness           总上游度 U = (I-Ad)^-1 · 1
    upstreamness_domestic  只走国内环节的长度
    upstreamness_cross     跨境段 = 总长度 - 国内段
    """
    Ad = _allocation_matrix(arr)
    n = Ad.shape[0]
    eye_n = np.eye(n)

    try:
        U = np.linalg.solve(eye_n - Ad, np.ones(n))
    except np.linalg.LinAlgError:
        # 存在总产出为0的行业时 (I-Ad) 可能奇异,退化为最小二乘近似
        U, *_ = np.linalg.lstsq(eye_n - Ad, np.ones(n), rcond=None)

    # 国内段:每国单独解一个 S×S 小系统
    U_dom = np.zeros(n)
    eye_s = np.eye(len(arr.sectors))
    for r in arr.regions:
        p = arr.pos[r]
        Ad_rr = Ad[np.ix_(p, p)]
        U_dom[p] = np.linalg.solve(eye_s - Ad_rr, np.ones(len(p)))

    df = pd.DataFrame(
        {
            "upstreamness": U,
            "upstreamness_domestic": U_dom,
            "upstreamness_cross": U - U_dom,
        },
        index=arr.index,
    )
    df.index.names = ["country", "sector"]
    return df


def country_length(arr: IcioArrays, sector_df: pd.DataFrame | None = None) -> pd.DataFrame:
    """国家级长度指标:行业指标按产出份额加权平均。

    产出加权而非简单平均,避免一堆产出趋近于0的小行业稀释主导行业的信号
    (例如尼日利亚的石油开采业)。
    """
    if sector_df is None:
        sector_df = sector_length(arr)
    w = pd.Series(arr.x, index=arr.index)
    out = {}
    for col in sector_df.columns:
        weighted = (sector_df[col] * w).groupby(level=0).sum()
        out[col] = weighted / w.groupby(level=0).sum()
    df = pd.DataFrame(out)
    df.index.name = "country"
    return df
