"""ICIO 派生控制变量。

优先级 2 的第一版不接外部 WDI/IMF/价格指数,只从已预计算的 OECD ICIO
指标产物生成国家-年份级控制变量。金额列仍是名义口径;指数列只表达相对
基期变化,不等同于真实平减值。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from gvcsim.config import PROCESSED_DIR, processed_years

CONTROL_COLUMNS = [
    "log_gdp_proxy",
    "gdp_proxy_growth",
    "log_exports_proxy",
    "exports_proxy_growth",
    "export_intensity",
    "manufacturing_va_share",
    "services_va_share",
]

INDEX_COLUMNS = [
    "trade_gross_exports_index",
    "prod_va_total_index",
]

ALL_CONTROL_COLUMNS = [*CONTROL_COLUMNS, *INDEX_COLUMNS]

CONTROL_LABELS = {
    "log_gdp_proxy": "增加值规模(log, ICIO GDP proxy)",
    "gdp_proxy_growth": "增加值增长率",
    "log_exports_proxy": "出口规模(log)",
    "exports_proxy_growth": "出口增长率",
    "export_intensity": "出口强度(毛出口/增加值)",
    "manufacturing_va_share": "制造业增加值份额",
    "services_va_share": "服务业增加值份额",
}

MANUFACTURING_PREFIXES = ("C",)
SERVICE_SECTORS = {
    "G", "H49", "H50", "H51", "H52", "H53", "I", "J58T60", "J61", "J62_63",
    "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T",
}


def _safe_log(s: pd.Series) -> pd.Series:
    return np.log(s.clip(lower=0.0) + 1.0)


def _safe_div(num: pd.Series, den: pd.Series) -> pd.Series:
    out = (num / den).where(den.abs() > 1e-12, 0.0)
    return out.replace([np.inf, -np.inf], 0.0).fillna(0.0)


def _growth(s: pd.Series) -> pd.Series:
    prev = s.shift(1)
    return _safe_div(s - prev, prev).fillna(0.0)


def _index_to_base(s: pd.Series) -> pd.Series:
    base = float(s.iloc[0]) if len(s) else 0.0
    if abs(base) <= 1e-12:
        return pd.Series(np.zeros(len(s)), index=s.index)
    return s / base


def build_controls(
    country_panel: pd.DataFrame | None = None,
    sector_panel: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """生成国家-年份控制变量。

    参数允许测试直接传入小面板;生产路径默认从 data/processed 下读取
    indicators_country_<year>.csv 与 indicators_sector_<year>.csv。
    """
    if country_panel is None or sector_panel is None:
        years = processed_years()
        if not years:
            raise RuntimeError("没有任何已预计算的年份,无法生成控制变量")
        country_panel = pd.concat(
            [pd.read_csv(PROCESSED_DIR / f"indicators_country_{y}.csv") for y in years],
            ignore_index=True,
        )
        sector_panel = pd.concat(
            [pd.read_csv(PROCESSED_DIR / f"indicators_sector_{y}.csv") for y in years],
            ignore_index=True,
        )

    country = country_panel.copy()
    sector = sector_panel.copy()
    country = country.sort_values(["country", "year"]).reset_index(drop=True)

    out = country[["country", "year"]].copy()
    out["log_gdp_proxy"] = _safe_log(country["prod_va_total"])
    out["log_exports_proxy"] = _safe_log(country["trade_gross_exports"])
    out["export_intensity"] = _safe_div(country["trade_gross_exports"], country["prod_va_total"])

    out["gdp_proxy_growth"] = (
        country.groupby("country", group_keys=False)["prod_va_total"].apply(_growth).to_numpy()
    )
    out["exports_proxy_growth"] = (
        country.groupby("country", group_keys=False)["trade_gross_exports"].apply(_growth).to_numpy()
    )
    out["trade_gross_exports_index"] = (
        country.groupby("country", group_keys=False)["trade_gross_exports"].apply(_index_to_base).to_numpy()
    )
    out["prod_va_total_index"] = (
        country.groupby("country", group_keys=False)["prod_va_total"].apply(_index_to_base).to_numpy()
    )

    sector["is_manufacturing"] = sector["sector"].astype(str).str.startswith(MANUFACTURING_PREFIXES)
    sector["is_services"] = sector["sector"].isin(SERVICE_SECTORS)
    totals = sector.groupby(["country", "year"], as_index=False)["prod_va_total"].sum()
    manu = (
        sector[sector["is_manufacturing"]]
        .groupby(["country", "year"], as_index=False)["prod_va_total"]
        .sum()
        .rename(columns={"prod_va_total": "_manufacturing_va"})
    )
    serv = (
        sector[sector["is_services"]]
        .groupby(["country", "year"], as_index=False)["prod_va_total"]
        .sum()
        .rename(columns={"prod_va_total": "_services_va"})
    )
    shares = totals.merge(manu, on=["country", "year"], how="left").merge(
        serv, on=["country", "year"], how="left"
    )
    shares[["_manufacturing_va", "_services_va"]] = shares[
        ["_manufacturing_va", "_services_va"]
    ].fillna(0.0)
    shares["manufacturing_va_share"] = _safe_div(shares["_manufacturing_va"], shares["prod_va_total"])
    shares["services_va_share"] = _safe_div(shares["_services_va"], shares["prod_va_total"])

    out = out.merge(
        shares[["country", "year", "manufacturing_va_share", "services_va_share"]],
        on=["country", "year"], how="left",
    )
    out[ALL_CONTROL_COLUMNS] = out[ALL_CONTROL_COLUMNS].replace([np.inf, -np.inf], 0.0).fillna(0.0)
    return out[["country", "year", *ALL_CONTROL_COLUMNS]].sort_values(
        ["country", "year"]
    ).reset_index(drop=True)


def write_controls(
    country_panel: pd.DataFrame | None = None,
    sector_panel: pd.DataFrame | None = None,
) -> pd.DataFrame:
    controls = build_controls(country_panel, sector_panel)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    controls.to_csv(PROCESSED_DIR / "controls_country.csv", index=False)
    return controls
