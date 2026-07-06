"""步骤4:GVC 总贸易流分解指标(Borin-Mancini source-based 口径)。

本模块把一国/一国行业的毛出口拆成国内增加值、返回国内增加值(reflection)、
国内重复计算、外国增加值与外国重复计算,并派生前向/后向 GVC 参与度。
实现范围是国家级与国家-行业级聚合结果;不输出 exporter-importer-sector
双边明细。

核心五项采用 Borin-Mancini (2019) source-based 出口国视角:增加值第一次越过
出口国边界记为 DVA/FVA,此前已经越过同一出口国边界的部分记为 DDC/FDC。
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


# 占比指标除以毛出口,只有当该实体"确实出口"时才有意义。分两档下限:
_EXPORT_NOISE_FLOOR = 1e-9  # 相对本帧最大毛出口:剔除非贸易行业在小经济体里 ~1e-13 的机器精度噪声
# 国家-行业级、仅用于前向/总参与度这类"无界"指标的额外相对下限:毛出口不足本国总出口
# 0.5% 的行业不是主要出口部门(多为电力/供水/建筑/房地产/公共管理等非贸易品),
# 其前向参与度会被自身很小的出口分母放大到数倍甚至几十倍,记为缺失比记一个爆表百分数更诚实。
_EXPORT_SECTOR_FLOOR = 5e-3


def _exports_above_noise(gross: pd.Series) -> pd.Series:
    """毛出口是否高于机器精度噪声(所有占比指标共用的最低门槛)。"""
    if not len(gross):
        return gross > 0
    return gross > float(gross.max()) * _EXPORT_NOISE_FLOOR


def _meaningful_exporter(df: pd.DataFrame) -> pd.Series:
    """在噪声门槛之上,再要求是本国"有意义的出口部门"(仅用于无界的前向/总参与度)。

    DVA/FVA/PDC/后向占比都是毛出口的组成项,天然 ∈[0,1],即便行业出口很小也有意义、
    不需要这道相对下限——收窄到前向/总参与度,既修好爆表显示,又不无谓丢弃步骤13
    (depvar=share_trade_fva)等回归的有效样本。
    """
    gross = df["trade_gross_exports"]
    valid = _exports_above_noise(gross)
    if isinstance(gross.index, pd.MultiIndex):  # (country, sector) 粒度
        country_total = gross.groupby(level=0).transform("sum")
        valid = valid & (gross > country_total * _EXPORT_SECTOR_FLOOR)
    elif {"country", "sector"}.issubset(df.columns):  # 扁平化后的国家-行业表
        country_total = gross.groupby(df["country"]).transform("sum")
        valid = valid & (gross > country_total * _EXPORT_SECTOR_FLOOR)
    return valid


def _add_trade_shares(df: pd.DataFrame) -> pd.DataFrame:
    gross = df["trade_gross_exports"]
    noise_ok = _exports_above_noise(gross)  # 有界占比:只剔机器精度噪声
    export_ok = _meaningful_exporter(df)  # 无界的前向/总参与度:再加相对下限
    with np.errstate(divide="ignore", invalid="ignore"):
        df["share_trade_dva"] = np.where(noise_ok, df["trade_dva"] / gross, np.nan)
        df["share_trade_fva"] = np.where(noise_ok, df["trade_fva"] / gross, np.nan)
        df["share_trade_pdc"] = np.where(noise_ok, df["trade_pdc"] / gross, np.nan)
        df["share_trade_backward_gvc"] = np.where(noise_ok, (df["trade_fva"] + df["trade_fdc"]) / gross, np.nan)
        df["share_trade_forward_gvc"] = np.where(export_ok, df["trade_forward_va_in_foreign_exports"] / gross, np.nan)
    # 总参与度含前向项,前向对非"有意义出口部门"已是缺失,后向 + 缺失 = 缺失,口径自然一致
    df["share_trade_gvc_participation"] = df["share_trade_backward_gvc"] + df["share_trade_forward_gvc"]
    return df


def sector_tradeflow(arr: IcioArrays) -> pd.DataFrame:
    """国家-行业级 Borin-Mancini source-based 贸易流分解,索引为 (country, sector)。

    五个闭合项(DVA/RDV/DDC/FVA/FDC)使用 BM 精确公式。DVA 的最终吸收
    子项仍按输出流向追踪拆成最终品、进口国吸收、第三国再出口与返回本国,
    以保持前端教学字段稳定。
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
        index=pd.MultiIndex.from_arrays([node_regions, node_sectors], names=["country", "sector"]),
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
