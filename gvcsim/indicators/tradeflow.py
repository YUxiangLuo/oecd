"""步骤4:GVC 总贸易流分解指标(KWW 风格完整聚合口径)。

本模块把一国/一国行业的毛出口拆成国内增加值、返回国内增加值、国内重复
计算、外国增加值与外国重复计算,并派生前向/后向 GVC 参与度。实现范围是
国家级与国家-行业级聚合结果;不输出 exporter-importer-sector 双边明细。

⚠ 近似口径:重复计算项按买方节点"未来跨境期望"的启发式折算、最终吸收地
用马尔可夫吸收链近似,不是 KWW (2014) / Borin-Mancini (2019) 的精确公式;
"五项加总 = 毛出口"的闭合恒等式由单元测试保证。
"""

import numpy as np
import pandas as pd

from gvcsim.indicators.core import IcioArrays

_AMOUNT_COLS = [
    "trade_gross_exports",
    "trade_dva",
    "trade_dva_final",
    "trade_dva_intermediate_absorbed",
    "trade_dva_intermediate_reexported",
    "trade_rdv",
    "trade_ddc",
    "trade_fva",
    "trade_fdc",
    "trade_pdc",
    "trade_forward_va_in_foreign_exports",
    "trade_balance_error",
]


def _node_regions(arr: IcioArrays) -> np.ndarray:
    return arr.index.get_level_values(0).to_numpy()


def _node_sectors(arr: IcioArrays) -> np.ndarray:
    return arr.index.get_level_values(1).to_numpy()


def _allocation_matrix(arr: IcioArrays) -> np.ndarray:
    """Seller-side allocation matrix Z_ij / x_i."""
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(arr.x[:, None] > 0, arr.Z / arr.x[:, None], 0.0)


def _absorption_solve(Ad: np.ndarray, rhs: np.ndarray) -> np.ndarray:
    """求解 (I - Ad)^{-1} · rhs,奇异时退化为最小二乘,并清掉非有限/负值。"""
    eye = np.eye(Ad.shape[0])
    try:
        out = np.linalg.solve(eye - Ad, rhs)
    except np.linalg.LinAlgError:
        out, *_ = np.linalg.lstsq(eye - Ad, rhs, rcond=None)
    return np.clip(np.where(np.isfinite(out), out, 0.0), 0.0, None)


def _ultimate_absorption(arr: IcioArrays, Ad: np.ndarray) -> np.ndarray:
    """Rows: producing node, columns: final absorption country shares.

    If one unit of node i output is put into the production network, this gives the
    expected final demand country. It is the row-oriented counterpart of the
    Leontief tracing used to separate intermediate exports absorbed by the direct
    importer, re-exported to third markets, or returned home.
    """
    with np.errstate(divide="ignore", invalid="ignore"):
        final_share = np.where(arr.x[:, None] > 0, arr.Yd / arr.x[:, None], 0.0)
    # OECD balancing items can create tiny negative probabilities; _absorption_solve
    # clips them. Keep the accounting stable without changing well-behaved rows.
    out = _absorption_solve(Ad, final_share)
    row_sum = out.sum(axis=1)
    good = row_sum > 0
    out[good] = out[good] / row_sum[good, None]
    return out


def _future_border_crossings(Ad: np.ndarray, border: np.ndarray) -> np.ndarray:
    """Expected future cross-border intermediate transactions from each node.

    The first border crossing is the observed export itself. Future crossings proxy
    the pure double-counted part in a KWW-style aggregate decomposition: when an
    exported intermediate keeps crossing borders before final absorption, that
    value is repeatedly recorded in gross trade.
    """
    immediate = (Ad * border).sum(axis=1)
    return _absorption_solve(Ad, immediate)


def _origin_content(arr: IcioArrays) -> np.ndarray:
    """Country-of-origin value-added content per unit gross output.

    content[r, j] is the value added generated in country r that is embodied in
    one unit of gross output from node j. Columns sum to one when v'B=1 holds.
    """
    content = np.zeros((arr.n_regions, len(arr.x)))
    for i, r in enumerate(arr.regions):
        p = arr.pos[r]
        content[i, :] = (arr.v[p, None] * arr.B[p, :]).sum(axis=0)
    return content


def _add_trade_shares(df: pd.DataFrame) -> pd.DataFrame:
    gross = df["trade_gross_exports"]
    with np.errstate(divide="ignore", invalid="ignore"):
        df["share_trade_dva"] = np.where(gross > 0, df["trade_dva"] / gross, np.nan)
        df["share_trade_fva"] = np.where(gross > 0, df["trade_fva"] / gross, np.nan)
        df["share_trade_pdc"] = np.where(gross > 0, df["trade_pdc"] / gross, np.nan)
        df["share_trade_backward_gvc"] = np.where(
            gross > 0, (df["trade_fva"] + df["trade_fdc"]) / gross, np.nan
        )
        df["share_trade_forward_gvc"] = np.where(
            gross > 0, df["trade_forward_va_in_foreign_exports"] / gross, np.nan
        )
    df["share_trade_gvc_participation"] = (
        df["share_trade_backward_gvc"] + df["share_trade_forward_gvc"]
    )
    return df


def sector_tradeflow(arr: IcioArrays) -> pd.DataFrame:
    """国家-行业级 KWW 风格贸易流分解,索引为 (country, sector)。

    全部按节点向量/矩阵一次算完(N ≈ 3,465 时逐节点双重循环有 ~1200 万次
    Python 迭代,向量化后每年秒级)。口径:

    - 最终品出口直接在进口国被吸收:国内含量记 DVA,外国含量记 FVA。
    - 中间品出口先按买方节点的"未来跨境期望"折出重复计算部分
      (国内含量→DDC,外国含量→FDC),净额再按最终吸收地分类:
      返回本国→RDV,进口国吸收/再出口→DVA 两个子项,外国含量→FVA。
    """
    node_regions = _node_regions(arr)
    node_sectors = _node_sectors(arr)
    n = len(arr.x)
    idx = np.arange(n)
    region_idx = {r: i for i, r in enumerate(arr.regions)}
    home_col = np.array([region_idx[r] for r in node_regions])
    border = node_regions[:, None] != node_regions[None, :]

    Ad = _allocation_matrix(arr)
    ultimate = _ultimate_absorption(arr, Ad)
    future_cross = _future_border_crossings(Ad, border)
    content = _origin_content(arr)

    domestic = content[home_col, idx]   # 本节点单位产出中的国内增加值含量
    foreign = 1.0 - domestic

    # 最终品出口(剔除本国内销)
    final_exports = arr.Yd.sum(axis=1) - arr.Yd[idx, home_col]

    # 中间品出口:pf_j 是卖给买方 j 的价值中归入纯重复计算的比例
    pf = future_cross / (1.0 + future_cross)
    net_w = 1.0 - pf
    Zf = np.where(border, arr.Z, 0.0)              # 跨境中间品流
    pdc_in = Zf @ pf                               # Σ_j Z_ij · pf_j
    net_sum = Zf @ net_w                           # Σ_j 净额
    # 净额按买方节点的最终吸收地分类:回到出口国 / 进口国自身 / 第三国
    returned = (Zf @ (net_w[:, None] * ultimate))[idx, home_col]
    absorbed = Zf @ (net_w * ultimate[idx, home_col])
    reexported = np.clip(net_sum - returned - absorbed, 0.0, None)

    trade_dva_final = domestic * final_exports
    trade_dva_absorbed = domestic * absorbed
    trade_dva_reexported = domestic * reexported
    trade_rdv = domestic * returned
    trade_ddc = domestic * pdc_in
    trade_fva = foreign * (final_exports + net_sum)
    trade_fdc = foreign * pdc_in
    trade_dva = trade_dva_final + trade_dva_absorbed + trade_dva_reexported
    trade_pdc = trade_ddc + trade_fdc

    gross = arr.E  # 毛出口 = 跨境中间品 + 最终品出口,core 已按同口径算好
    accounted = trade_dva + trade_rdv + trade_ddc + trade_fva + trade_fdc
    # 前向:本节点增加值嵌入外国节点毛出口的金额 v_i · Σ_{j 外国} B_ij · E_j
    forward = arr.v * (np.where(border, arr.B, 0.0) @ arr.E)

    df = pd.DataFrame(
        {
            "trade_gross_exports": gross,
            "trade_dva": trade_dva,
            "trade_dva_final": trade_dva_final,
            "trade_dva_intermediate_absorbed": trade_dva_absorbed,
            "trade_dva_intermediate_reexported": trade_dva_reexported,
            "trade_rdv": trade_rdv,
            "trade_ddc": trade_ddc,
            "trade_fva": trade_fva,
            "trade_fdc": trade_fdc,
            "trade_pdc": trade_pdc,
            "trade_forward_va_in_foreign_exports": forward,
            "trade_balance_error": gross - accounted,
        },
        index=pd.MultiIndex.from_arrays(
            [node_regions, node_sectors], names=["country", "sector"]
        ),
    )
    return _add_trade_shares(df)


def country_tradeflow(arr: IcioArrays, sector_df: pd.DataFrame | None = None) -> pd.DataFrame:
    """国家级贸易流分解 = 国家-行业级金额按国加总,占比重新计算。"""
    if sector_df is None:
        sector_df = sector_tradeflow(arr)
    amount_cols = [c for c in _AMOUNT_COLS if c in sector_df.columns]
    df = sector_df[amount_cols].groupby(level=0).sum()
    df.index.name = "country"
    return _add_trade_shares(df)
