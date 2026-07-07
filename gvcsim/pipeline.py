"""预计算流水线:原始 ICIO → 质检 → 指标 → 面板。

计算一次落盘为 CSV/JSON(data/processed/),API 与前端只读产物、不碰
原始 66MB 大表,保证接口毫秒级响应。

产物(每年):
  qc_<year>.json                  质检结果(步骤3)
  indicators_country_<year>.csv   国家级指标汇总(步骤4-7)
  indicators_industry_<year>.csv  行业级指标(步骤4-7)
  network_edges_<year>.csv        双边贸易流 top 边(步骤8 网络图)
跨年:
  panel_industry.csv              国家×行业×年份长面板 + 行业异质冲击(步骤13-16 默认回归样本)
  panel_country.csv               国家×年份长面板(冲击按行业出口额加权聚合)
  controls_country.csv            ICIO 派生/宏观mock控制 + 平减指数(步骤13-16)
  qc_controls.json                controls_country.csv 独立质检
  export_exposure_<year>.csv      ICIO 派生出口目的地暴露度(步骤2 冲击加权)
"""

import json

import pandas as pd

from gvcsim import shocks
from gvcsim.config import PROCESSED_DIR, available_years, processed_years
from gvcsim.data import controls, loader, quality
from gvcsim.indicators import length, network, production, tradeflow
from gvcsim.indicators.core import build_arrays

TRADE_PARTS = ["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"]


def _add_panel_derivatives(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    gross = out[TRADE_PARTS].sum(axis=1)
    out["_gross_exports"] = gross
    out["FVA_share"] = (out["FVA"] / gross.where(gross.abs() > 1e-12)).fillna(0.0)
    out["3b_VA_GVC_C_share"] = (out["3b_VA_GVC_C"] / out["SVA"].where(out["SVA"].abs() > 1e-12)).fillna(0.0)
    out["GVC_participation"] = (
        (out["3a_VA_GVC_S"] + out["3b_VA_GVC_C"]) / out["SVA"].where(out["SVA"].abs() > 1e-12)
    ).fillna(0.0)
    return out


def compute_year(year: int, verbose: bool = True) -> None:
    def log(msg: str) -> None:
        if verbose:
            print(msg, flush=True)

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    log(f"[{year}] 解析 ICIO 表并计算 A/L 矩阵(最耗时的一步)...")
    io = loader.load(year)

    log(f"[{year}] 数据质检...")
    checks = quality.run_all(io)
    with open(PROCESSED_DIR / f"qc_{year}.json", "w", encoding="utf-8") as f:
        json.dump([c.to_dict() for c in checks], f, ensure_ascii=False, indent=2)

    arr = build_arrays(io)

    log(f"[{year}] 步骤2 出口暴露度(ICIO 双边流向)...")
    shocks.write_export_exposure(arr, year)

    log(f"[{year}] 步骤4 贸易流分解...")
    tf_industry = tradeflow.sector_tradeflow(arr)
    tf_country = tradeflow.country_tradeflow(arr, tf_industry)

    log(f"[{year}] 步骤5 生产分解...")
    prod_industry = production.sector_production(arr)
    prod = production.country_production(arr, prod_industry)

    log(f"[{year}] 步骤6 长度分解...")
    len_industry = length.sector_length(arr)
    len_country = length.country_length(arr, len_industry)

    log(f"[{year}] 步骤7 网络指标(行业级介数精确优先)...")
    net = network.country_network(arr)
    net_industry = network.sector_network(arr)
    edges = network.network_edges(arr)

    country = tf_country.join(prod).join(len_country).join(net)
    country.insert(0, "year", year)
    country.to_csv(PROCESSED_DIR / f"indicators_country_{year}.csv")

    industry = tf_industry.join(prod_industry).join(len_industry).join(net_industry)
    industry.insert(0, "year", year)
    industry.to_csv(PROCESSED_DIR / f"indicators_industry_{year}.csv")

    edges.insert(0, "year", year)
    edges.to_csv(PROCESSED_DIR / f"network_edges_{year}.csv", index=False)
    log(f"[{year}] 完成,产物已写入 {PROCESSED_DIR}")


def build_panel() -> pd.DataFrame:
    """合并所有已计算年份为长面板,并 merge 冲击数据(演示版)。

    行业级面板(panel_industry.csv)是回归的默认样本;国家级面板的冲击变量
    由行业级冲击按该国各行业出口额加权聚合而来,保证两个粒度口径一致。
    返回行业级面板。
    """
    years = processed_years()
    if not years:
        raise RuntimeError("没有任何已预计算的年份,请先运行 gvcsim compute")

    industry = pd.concat(
        [pd.read_csv(PROCESSED_DIR / f"indicators_industry_{y}.csv") for y in years],
        ignore_index=True,
    )
    country = pd.concat(
        [pd.read_csv(PROCESSED_DIR / f"indicators_country_{y}.csv") for y in years],
        ignore_index=True,
    )
    country = _add_panel_derivatives(country)
    industry = _add_panel_derivatives(industry)
    controls_df = controls.write_controls(country, industry)
    controls_checks = quality.check_controls_country(
        controls_df,
        countries=sorted(country["country"].unique()),
        years=years,
    )
    with open(PROCESSED_DIR / "qc_controls.json", "w", encoding="utf-8") as f:
        json.dump([c.to_dict() for c in controls_checks], f, ensure_ascii=False, indent=2)

    # ---- 行业级 ----
    countries = sorted(industry["country"].unique())
    industries = sorted(industry["industry"].unique())
    shocks.write_demo(countries, industries, years)
    shock_df = shocks.load_shocks().rename(columns={"sector": "industry"})
    shock_checks = quality.check_shock_panel(
        shock_df.rename(columns={"industry": "sector"}),
        countries,
        industries,
        years,
    )
    with open(PROCESSED_DIR / "qc_shocks.json", "w", encoding="utf-8") as f:
        json.dump([c.to_dict() for c in shock_checks], f, ensure_ascii=False, indent=2)
    shock_cols = list(dict.fromkeys(col for pair in shocks.SHOCK_SPECS.values() for col in pair))

    industry = industry.merge(
        shock_df[["country", "industry", "year", *shock_cols]],
        on=["country", "industry", "year"],
        how="left",
    ).merge(
        controls_df,
        on=["country", "year"],
        how="left",
    )
    # 双向FE的个体维度:国家×行业
    industry["entity_id"] = industry["country"] + "_" + industry["industry"]
    industry.to_csv(PROCESSED_DIR / "panel_industry.csv", index=False)

    # ---- 国家级:冲击按行业出口额加权聚合 ----
    w = industry["_gross_exports"].clip(lower=0.0)
    industry_w = industry.assign(_w=w)
    agg = industry_w.groupby(["country", "year"], as_index=False)["_w"].sum()
    for _shock_type, (shock_col, treated_col) in shocks.SHOCK_SPECS.items():
        tmp = industry_w.assign(_ws=industry_w["_w"] * industry_w[shock_col])
        ws = tmp.groupby(["country", "year"], as_index=False)["_ws"].sum()
        agg = agg.merge(ws, on=["country", "year"], how="left")
        agg[shock_col] = (agg["_ws"] / agg["_w"]).where(agg["_w"] > 0, 0.0)
        agg[treated_col] = (agg[shock_col] > shocks.TREATED_THRESHOLD).astype(int)
        agg = agg.drop(columns=["_ws"])
    country = country.merge(
        agg[["country", "year", *shock_cols]],
        on=["country", "year"],
        how="left",
    ).merge(
        controls_df,
        on=["country", "year"],
        how="left",
    )
    country.to_csv(PROCESSED_DIR / "panel_country.csv", index=False)
    return industry


def run(years: list[int] | None = None) -> None:
    years = years or available_years()
    for y in years:
        compute_year(y)
    build_panel()
    print(f"面板构建完成:{PROCESSED_DIR / 'panel_industry.csv'}(行业级,回归默认)")
    print(f"            {PROCESSED_DIR / 'panel_country.csv'}(国家级)")
