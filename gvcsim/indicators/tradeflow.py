"""步骤4:GVC 总贸易流分解指标(Borin-Mancini source-based 口径)。

本模块把一国/一国行业的毛出口拆成客户资料中的 DVAex、DVArt、DDC、
FVA、FDC 与 taxsub。
实现范围是国家级与国家-行业级聚合结果;不输出 exporter-importer-sector
双边明细。

核心五项采用 Borin-Mancini (2019) source-based 出口国视角:增加值第一次越过
出口国边界记为 DVA/FVA,此前已经越过同一出口国边界的部分记为 DDC/FDC。
"""

import numpy as np
import pandas as pd

from gvcsim.indicators.core import IcioArrays

TRADE_COLUMNS = ["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub", "EXDVA"]


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


def _solve_square(lhs: np.ndarray, rhs: np.ndarray) -> np.ndarray:
    """Solve lhs @ X = rhs; fall back to least squares for near-singular toy systems."""
    try:
        out = np.linalg.solve(lhs, rhs)
    except np.linalg.LinAlgError:
        out, *_ = np.linalg.lstsq(lhs, rhs, rcond=None)
    return np.where(np.isfinite(out), out, 0.0)


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


def _bm_source_coefficients(
    arr: IcioArrays,
    country: str,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return per-unit export content coefficients under BM source-based accounting.

    For exporter s, DVA uses the domestic Leontief inverse L_ss. The full domestic
    content V_s B_ss minus that local term is DDC. For foreign content, cutting
    s's outward intermediate links gives B^cut_fs = B_fs B_ss^-1 L_ss, avoiding a
    large inverse for every exporter.
    """
    p = arr.pos[country]
    mask = np.ones(len(arr.x), dtype=bool)
    mask[p] = False
    f = np.where(mask)[0]

    Lss = arr.L_dd[country]
    Bss = arr.B[np.ix_(p, p)]
    domestic_source = arr.v[p] @ Lss
    domestic_full = arr.v[p] @ Bss

    if len(f) == 0:
        foreign_source = np.zeros_like(domestic_source)
        foreign_full = np.zeros_like(domestic_source)
    else:
        cut_bridge = _solve_square(Bss, Lss)
        Bfs = arr.B[np.ix_(f, p)]
        foreign_source = arr.v[f] @ (Bfs @ cut_bridge)
        foreign_full = arr.v[f] @ Bfs

    return domestic_source, domestic_full, foreign_source, foreign_full


def gross_exports(df: pd.DataFrame) -> pd.Series:
    return df[["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"]].sum(axis=1)


def sector_tradeflow(arr: IcioArrays) -> pd.DataFrame:
    """国家-行业级客户口径贸易流分解,索引为 (country, industry)。"""
    node_regions = _node_regions(arr)
    node_sectors = _node_sectors(arr)
    n = len(arr.x)
    idx = np.arange(n)
    region_idx = {r: i for i, r in enumerate(arr.regions)}
    home_col = np.array([region_idx[r] for r in node_regions])
    border = node_regions[:, None] != node_regions[None, :]

    Ad = _allocation_matrix(arr)
    ultimate = _ultimate_absorption(arr, Ad)

    # 最终品出口(剔除本国内销)
    final_exports = arr.Yd.sum(axis=1) - arr.Yd[idx, home_col]
    Zf = np.where(border, arr.Z, 0.0)
    importer_absorption_share = ultimate[idx, home_col]

    trade_dva_final = np.zeros(n)
    trade_dva_absorbed = np.zeros(n)
    trade_dva_reexported = np.zeros(n)
    trade_rdv = np.zeros(n)
    trade_ddc = np.zeros(n)
    trade_fva = np.zeros(n)
    trade_fdc = np.zeros(n)
    taxsub = np.zeros(n)

    for r in arr.regions:
        p = arr.pos[r]
        home = region_idx[r]
        domestic_source, domestic_full, foreign_source, foreign_full = _bm_source_coefficients(arr, r)

        returned = (Zf[p, :] * ultimate[:, home][None, :]).sum(axis=1)
        absorbed = (Zf[p, :] * importer_absorption_share[None, :]).sum(axis=1)

        trade_dva_final[p] = domestic_source * final_exports[p]
        trade_dva_absorbed[p] = domestic_source * absorbed
        trade_rdv[p] = domestic_source * returned
        trade_dva_reexported[p] = domestic_source * arr.E[p] - trade_dva_final[p] - trade_dva_absorbed[p] - trade_rdv[p]
        # Keep the split stable if tiny allocation noise makes the residual negative.
        small = np.abs(trade_dva_reexported[p]) < 1e-10
        trade_dva_reexported[p[small]] = 0.0

        trade_ddc[p] = (domestic_full - domestic_source) * arr.E[p]
        trade_fva[p] = foreign_source * arr.E[p]
        trade_fdc[p] = (foreign_full - foreign_source) * arr.E[p]
        taxsub[p] = (arr.t @ arr.B[:, p]) * arr.E[p]

    df = pd.DataFrame(
        {
            "DVAex": trade_dva_final + trade_dva_absorbed + trade_dva_reexported,
            "DVArt": trade_rdv,
            "DDC": trade_ddc,
            "FVA": trade_fva,
            "FDC": trade_fdc,
            "taxsub": taxsub,
        },
        index=pd.MultiIndex.from_arrays([node_regions, node_sectors], names=["country", "industry"]),
    )
    df["EXDVA"] = df["DVAex"] + df["DVArt"]
    return df[TRADE_COLUMNS]


def country_tradeflow(arr: IcioArrays, sector_df: pd.DataFrame | None = None) -> pd.DataFrame:
    """国家级贸易流分解 = 国家-行业级金额按国加总。"""
    if sector_df is None:
        sector_df = sector_tradeflow(arr)
    df = sector_df[TRADE_COLUMNS].groupby(level=0).sum()
    df["EXDVA"] = df["DVAex"] + df["DVArt"]
    df.index.name = "country"
    return df[TRADE_COLUMNS]
