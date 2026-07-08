"""国家-年份控制变量。

包含两组口径:
  1. ICIO 派生控制变量:从已预计算的 OECD ICIO 指标产物生成。
  2. WDI/IMF 风格宏观 mock:按真实宏观面板 schema 生成确定性拟真列。

金额列仍是名义口径;指数列只表达相对基期变化,不等同于真实平减值。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from gvcsim.config import PROCESSED_DIR, processed_years
from gvcsim.indicators import tradeflow

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

MACRO_CONTROL_COLUMNS = [
    "macro_log_gdp_usd",
    "macro_log_population",
    "macro_log_gdp_per_capita",
    "macro_exchange_rate_change",
    "macro_fdi_inflow_gdp",
]

PRICE_COLUMNS = [
    "gdp_deflator",
    "inflation_rate",
]

ALL_CONTROL_COLUMNS = [
    *CONTROL_COLUMNS,
    *INDEX_COLUMNS,
    *MACRO_CONTROL_COLUMNS,
    *PRICE_COLUMNS,
]

CONTROL_LABELS = {
    "log_gdp_proxy": "增加值规模(log, ICIO GDP proxy)",
    "gdp_proxy_growth": "增加值增长率",
    "log_exports_proxy": "出口规模(log)",
    "exports_proxy_growth": "出口增长率",
    "export_intensity": "出口强度(毛出口/增加值)",
    "manufacturing_va_share": "制造业增加值份额",
    "services_va_share": "服务业增加值份额",
    "macro_log_gdp_usd": "GDP规模(log, WDI风格mock)",
    "macro_log_population": "人口规模(log, WDI风格mock)",
    "macro_log_gdp_per_capita": "人均收入(log, WDI风格mock)",
    "macro_exchange_rate_change": "汇率变动率(IMF风格mock)",
    "macro_fdi_inflow_gdp": "FDI流入/GDP(WDI风格mock)",
}

MANUFACTURING_PREFIXES = ("C",)
SERVICE_SECTORS = {
    "G",
    "H49",
    "H50",
    "H51",
    "H52",
    "H53",
    "I",
    "J58T60",
    "J61",
    "J62_63",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "Q",
    "R",
    "S",
    "T",
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


def _stable_unit(code: str) -> float:
    """把国家代码稳定映射到 [0, 1],避免 Python hash 随进程变化。"""
    checksum = sum((i + 1) * ord(ch) for i, ch in enumerate(str(code)))
    return (checksum % 1000) / 999.0


def build_controls(
    country_panel: pd.DataFrame | None = None,
    sector_panel: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """生成国家-年份控制变量。

    参数允许测试直接传入小面板;生产路径默认从 data/processed 下读取
    indicators_country_<year>.csv 与 indicators_industry_<year>.csv。
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
            [pd.read_csv(PROCESSED_DIR / f"indicators_industry_{y}.csv") for y in years],
            ignore_index=True,
        )

    country = country_panel.copy()
    sector = sector_panel.copy()
    country = country.sort_values(["country", "year"]).reset_index(drop=True)
    # 客户口径字段:GDP proxy = SVA(WWYZ 总增加值),毛出口 = WWZ 六项闭合之和
    country["_va"] = country["SVA"]
    country["_exports"] = tradeflow.gross_exports(country)

    out = country[["country", "year"]].copy()
    out["log_gdp_proxy"] = _safe_log(country["_va"])
    out["log_exports_proxy"] = _safe_log(country["_exports"])
    out["export_intensity"] = _safe_div(country["_exports"], country["_va"])

    out["gdp_proxy_growth"] = country.groupby("country", group_keys=False)["_va"].apply(_growth).to_numpy()
    out["exports_proxy_growth"] = country.groupby("country", group_keys=False)["_exports"].apply(_growth).to_numpy()
    out["trade_gross_exports_index"] = (
        country.groupby("country", group_keys=False)["_exports"].apply(_index_to_base).to_numpy()
    )
    out["prod_va_total_index"] = country.groupby("country", group_keys=False)["_va"].apply(_index_to_base).to_numpy()

    score = country["country"].map(_stable_unit).astype(float)
    t = country.groupby("country").cumcount().astype(float)
    gdp_proxy = country["_va"].clip(lower=0.0).astype(float)
    # WDI/IMF 风格 mock:锚定 ICIO 规模,但加入国家异质和趋势,避免与 ICIO 控制完全同列。
    gdp_usd = (gdp_proxy + 1.0) * 1_000_000_000.0 * (0.80 + 0.40 * score) * (1.0 + 0.025 * t)
    income_usd = 4_000.0 + 45_000.0 * score + 600.0 * t
    population = gdp_usd / income_usd
    phase = 2 * np.pi * score + 0.8 * t
    inflation = pd.Series(
        np.clip(0.012 + 0.025 * score + 0.006 * np.sin(phase + 0.7), 0.0, 0.08),
        index=country.index,
    )
    inflation = inflation.where(t > 0, 0.0)

    out["macro_log_gdp_usd"] = _safe_log(pd.Series(gdp_usd, index=country.index))
    out["macro_log_population"] = _safe_log(pd.Series(population, index=country.index))
    out["macro_log_gdp_per_capita"] = out["macro_log_gdp_usd"] - out["macro_log_population"]
    out["macro_exchange_rate_change"] = np.clip(
        (score - 0.5) * 0.04 + np.sin(phase) * 0.025,
        -0.12,
        0.12,
    )
    out["macro_fdi_inflow_gdp"] = np.clip(
        0.012 + 0.050 * score + 0.010 * np.cos(phase + 0.3),
        0.0,
        0.15,
    )
    out["inflation_rate"] = inflation
    out["gdp_deflator"] = (1.0 + inflation).groupby(country["country"], group_keys=False).cumprod()

    sector["is_manufacturing"] = sector["industry"].astype(str).str.startswith(MANUFACTURING_PREFIXES)
    sector["is_services"] = sector["industry"].isin(SERVICE_SECTORS)
    totals = sector.groupby(["country", "year"], as_index=False)["SVA"].sum()
    manu = (
        sector[sector["is_manufacturing"]]
        .groupby(["country", "year"], as_index=False)["SVA"]
        .sum()
        .rename(columns={"SVA": "_manufacturing_va"})
    )
    serv = (
        sector[sector["is_services"]]
        .groupby(["country", "year"], as_index=False)["SVA"]
        .sum()
        .rename(columns={"SVA": "_services_va"})
    )
    shares = totals.merge(manu, on=["country", "year"], how="left").merge(serv, on=["country", "year"], how="left")
    shares[["_manufacturing_va", "_services_va"]] = shares[["_manufacturing_va", "_services_va"]].fillna(0.0)
    shares["manufacturing_va_share"] = _safe_div(shares["_manufacturing_va"], shares["SVA"])
    shares["services_va_share"] = _safe_div(shares["_services_va"], shares["SVA"])

    out = out.merge(
        shares[["country", "year", "manufacturing_va_share", "services_va_share"]],
        on=["country", "year"],
        how="left",
    )
    out[ALL_CONTROL_COLUMNS] = out[ALL_CONTROL_COLUMNS].replace([np.inf, -np.inf], 0.0).fillna(0.0)
    return out[["country", "year", *ALL_CONTROL_COLUMNS]].sort_values(["country", "year"]).reset_index(drop=True)


def write_controls(
    country_panel: pd.DataFrame | None = None,
    sector_panel: pd.DataFrame | None = None,
) -> pd.DataFrame:
    controls = build_controls(country_panel, sector_panel)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    controls.to_csv(PROCESSED_DIR / "controls_country.csv", index=False)
    return controls
