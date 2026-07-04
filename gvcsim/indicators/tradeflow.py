"""步骤4:GVC 总贸易流分解指标(KWW 风格完整聚合口径)。

本模块把一国/一国行业的毛出口拆成国内增加值、返回国内增加值、国内重复
计算、外国增加值与外国重复计算,并派生前向/后向 GVC 参与度。实现范围是
国家级与国家-行业级聚合结果;不输出 exporter-importer-sector 双边明细。
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


def _ultimate_absorption(arr: IcioArrays) -> np.ndarray:
    """Rows: producing node, columns: final absorption country shares.

    If one unit of node i output is put into the production network, this gives the
    expected final demand country. It is the row-oriented counterpart of the
    Leontief tracing used to separate intermediate exports absorbed by the direct
    importer, re-exported to third markets, or returned home.
    """
    Ad = _allocation_matrix(arr)
    with np.errstate(divide="ignore", invalid="ignore"):
        final_share = np.where(arr.x[:, None] > 0, arr.Yd / arr.x[:, None], 0.0)
    eye = np.eye(len(arr.x))
    try:
        out = np.linalg.solve(eye - Ad, final_share)
    except np.linalg.LinAlgError:
        out, *_ = np.linalg.lstsq(eye - Ad, final_share, rcond=None)
    out = np.where(np.isfinite(out), out, 0.0)
    # OECD balancing items can create tiny negative probabilities. Keep the
    # accounting stable without changing well-behaved rows.
    out = np.clip(out, 0.0, None)
    row_sum = out.sum(axis=1)
    good = row_sum > 0
    out[good] = out[good] / row_sum[good, None]
    return out


def _future_border_crossings(arr: IcioArrays, node_regions: np.ndarray) -> np.ndarray:
    """Expected future cross-border intermediate transactions from each node.

    The first border crossing is the observed export itself. Future crossings proxy
    the pure double-counted part in a KWW-style aggregate decomposition: when an
    exported intermediate keeps crossing borders before final absorption, that
    value is repeatedly recorded in gross trade.
    """
    Ad = _allocation_matrix(arr)
    border = node_regions[:, None] != node_regions[None, :]
    immediate = (Ad * border).sum(axis=1)
    eye = np.eye(len(arr.x))
    try:
        out = np.linalg.solve(eye - Ad, immediate)
    except np.linalg.LinAlgError:
        out, *_ = np.linalg.lstsq(eye - Ad, immediate, rcond=None)
    return np.clip(np.where(np.isfinite(out), out, 0.0), 0.0, None)


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


def _gross_exports_by_node(arr: IcioArrays, node_regions: np.ndarray) -> np.ndarray:
    gross = np.zeros(len(arr.x))
    region_col = {r: i for i, r in enumerate(arr.regions)}
    for r in arr.regions:
        p = arr.pos[r]
        foreign_cols = node_regions != r
        gross[p] = arr.Z[np.ix_(p, foreign_cols)].sum(axis=1)
        gross[p] += arr.Yd[p, :].sum(axis=1) - arr.Yd[p, region_col[r]]
    return gross


def _forward_va(arr: IcioArrays, gross_by_node: np.ndarray, node_regions: np.ndarray) -> np.ndarray:
    """Domestic VA from each country-sector embedded in foreign countries' exports."""
    out = np.zeros(len(arr.x))
    for i, home in enumerate(node_regions):
        foreign_export_rows = node_regions != home
        out[i] = arr.v[i] * (arr.B[i, foreign_export_rows] @ gross_by_node[foreign_export_rows])
    return out


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
    """国家-行业级 KWW 风格贸易流分解,索引为 (country, sector)。"""
    node_regions = _node_regions(arr)
    node_sectors = _node_sectors(arr)
    region_idx = {r: i for i, r in enumerate(arr.regions)}
    ultimate = _ultimate_absorption(arr)
    future_cross = _future_border_crossings(arr, node_regions)
    content = _origin_content(arr)
    gross_by_node = _gross_exports_by_node(arr, node_regions)
    forward_by_node = _forward_va(arr, gross_by_node, node_regions)

    records = []
    for i, (home, sector) in enumerate(zip(node_regions, node_sectors)):
        h = region_idx[home]
        domestic_share = content[h, i]
        foreign_share = 1.0 - domestic_share

        trade_dva_final = 0.0
        trade_dva_intermediate_absorbed = 0.0
        trade_dva_intermediate_reexported = 0.0
        trade_rdv = 0.0
        trade_ddc = 0.0
        trade_fva = 0.0
        trade_fdc = 0.0

        # Final goods exports are absorbed directly abroad.
        for d, dest in enumerate(arr.regions):
            if dest == home:
                continue
            amount = float(arr.Yd[i, d])
            trade_dva_final += domestic_share * amount
            trade_fva += foreign_share * amount

        # Intermediate exports are traced through the buyer's future production
        # path. A positive future-crossing expectation is assigned to pure double
        # counting; the remaining net part is classified by ultimate absorption.
        foreign_buyers = np.where(node_regions != home)[0]
        for j in foreign_buyers:
            amount = float(arr.Z[i, j])
            if amount == 0:
                continue
            importer = node_regions[j]
            importer_idx = region_idx[importer]
            pdc_factor = future_cross[j] / (1.0 + future_cross[j])
            pdc_amount = amount * pdc_factor
            net_amount = amount - pdc_amount

            trade_ddc += domestic_share * pdc_amount
            trade_fdc += foreign_share * pdc_amount
            trade_fva += foreign_share * net_amount

            shares = ultimate[j]
            return_share = shares[h]
            absorbed_share = shares[importer_idx]
            reexport_share = max(0.0, 1.0 - return_share - absorbed_share)

            trade_rdv += domestic_share * net_amount * return_share
            trade_dva_intermediate_absorbed += (
                domestic_share * net_amount * absorbed_share
            )
            trade_dva_intermediate_reexported += (
                domestic_share * net_amount * reexport_share
            )

        trade_dva = (
            trade_dva_final
            + trade_dva_intermediate_absorbed
            + trade_dva_intermediate_reexported
        )
        trade_pdc = trade_ddc + trade_fdc
        gross = float(gross_by_node[i])
        accounted = trade_dva + trade_rdv + trade_ddc + trade_fva + trade_fdc
        records.append({
            "country": home,
            "sector": sector,
            "trade_gross_exports": gross,
            "trade_dva": trade_dva,
            "trade_dva_final": trade_dva_final,
            "trade_dva_intermediate_absorbed": trade_dva_intermediate_absorbed,
            "trade_dva_intermediate_reexported": trade_dva_intermediate_reexported,
            "trade_rdv": trade_rdv,
            "trade_ddc": trade_ddc,
            "trade_fva": trade_fva,
            "trade_fdc": trade_fdc,
            "trade_pdc": trade_pdc,
            "trade_forward_va_in_foreign_exports": float(forward_by_node[i]),
            "trade_balance_error": gross - accounted,
        })

    df = pd.DataFrame(records).set_index(["country", "sector"])
    return _add_trade_shares(df)


def country_tradeflow(arr: IcioArrays, sector_df: pd.DataFrame | None = None) -> pd.DataFrame:
    """国家级贸易流分解 = 国家-行业级金额按国加总,占比重新计算。"""
    if sector_df is None:
        sector_df = sector_tradeflow(arr)
    amount_cols = [c for c in _AMOUNT_COLS if c in sector_df.columns]
    df = sector_df[amount_cols].groupby(level=0).sum()
    df.index.name = "country"
    return _add_trade_shares(df)
