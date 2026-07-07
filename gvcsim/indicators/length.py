"""步骤6:GVC 长度分解指标。

上游度(Antras-Chor 2012):一单位产出到达最终消费者平均还要经过几个
生产阶段。U=1 表示产出全部直接卖给最终消费者(最下游);越大越上游。

分解:保留原有 upstreamness / domestic / cross 字段,并补充客户资料中的
PLv/PLy/位置指数兼容字段。PLv 表示前向联系(到最终吸收端),PLy 表示后向联系
(到初始投入端)。
"""

import numpy as np
import pandas as pd

from gvcsim.indicators.core import IcioArrays


def _allocation_matrix(arr: IcioArrays) -> np.ndarray:
    """分摊矩阵 Ad_ij = Z_ij / x_i(按卖方产出分摊,与技术系数 A 方向相反)。"""
    with np.errstate(divide="ignore", invalid="ignore"):
        Ad = np.where(arr.x[:, None] > 0, arr.Z / arr.x[:, None], 0.0)
    return Ad


def _solve_or_lstsq(lhs: np.ndarray, rhs: np.ndarray) -> np.ndarray:
    try:
        out = np.linalg.solve(lhs, rhs)
    except np.linalg.LinAlgError:
        out, *_ = np.linalg.lstsq(lhs, rhs, rcond=None)
    return np.where(np.isfinite(out), out, np.nan)


def _safe_div(num: np.ndarray, den: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.where(np.abs(den) > 1e-12, num / den, np.nan)
    return np.where(np.isfinite(out), out, np.nan)


def sector_length(arr: IcioArrays) -> pd.DataFrame:
    """行业级长度指标,索引 (country, sector):

    upstreamness           总上游度 U = (I-Ad)^-1 · 1
    upstreamness_domestic  只走国内环节的长度
    upstreamness_cross     跨境段 = 总长度 - 国内段

    plv* / ply* / pos_tpl / gvcps 是客户资料字段:
    plv = 前向总生产长度,ply = 后向总生产长度,pos_tpl = plv/ply。
    当前系统没有落地 WWYZ 的 GN×GN 细分长度矩阵,因此 D/RT/GVC 段在现有
    上游度框架下做可解释兼容:纯国内/传统贸易使用国内段,GVC 使用存在跨境段
    时的总长度。
    """
    Ad = _allocation_matrix(arr)
    n = Ad.shape[0]
    eye_n = np.eye(n)

    U = _solve_or_lstsq(eye_n - Ad, np.ones(n))
    # 后向长度:一单位最终产品沿 Leontief 逆追溯到初始投入端的总阶段数。
    D = arr.B.sum(axis=0)

    # 国内段:每国单独解一个 S×S 小系统
    U_dom = np.zeros(n)
    D_dom = np.zeros(n)
    eye_s = np.eye(len(arr.sectors))
    for r in arr.regions:
        p = arr.pos[r]
        Ad_rr = Ad[np.ix_(p, p)]
        U_dom[p] = _solve_or_lstsq(eye_s - Ad_rr, np.ones(len(p)))
        D_dom[p] = arr.L_dd[r].sum(axis=0)

    U_cross = U - U_dom
    D_cross = D - D_dom
    plv_gvc = np.where(U_cross > 1e-12, U, np.nan)
    ply_gvc = np.where(D_cross > 1e-12, D, np.nan)

    df = pd.DataFrame(
        {
            "upstreamness": U,
            "upstreamness_domestic": U_dom,
            "upstreamness_cross": U_cross,
            "plv": U,
            "plv_d": U_dom,
            "plv_rt": U_dom,
            "plv_gvc": plv_gvc,
            "ply": D,
            "ply_d": D_dom,
            "ply_rt": D_dom,
            "ply_gvc": ply_gvc,
            "pos_tpl": _safe_div(U, D),
            "gvcps": _safe_div(plv_gvc, ply_gvc),
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
        valid = sector_df[col].notna()
        weighted = (sector_df[col].where(valid) * w).groupby(level=0).sum(min_count=1)
        weight_sum = w.where(valid).groupby(level=0).sum(min_count=1)
        out[col] = weighted / weight_sum
    df = pd.DataFrame(out)
    df.index.name = "country"
    return df
