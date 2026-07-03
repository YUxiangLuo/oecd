"""预计算流水线:原始 ICIO → 质检 → 指标 → 面板。

计算一次落盘为 CSV/JSON(data/processed/),API 与前端只读产物、不碰
原始 66MB 大表,保证接口毫秒级响应。

产物(每年):
  qc_<year>.json                  质检结果(步骤3)
  indicators_country_<year>.csv   国家级指标汇总(步骤4-7)
  indicators_sector_<year>.csv    行业级指标(步骤4-7)
  network_edges_<year>.csv        双边贸易流 top 边(步骤8 网络图)
跨年:
  panel_sector.csv                国家×行业×年份长面板 + 行业异质冲击(步骤13-16 默认回归样本)
  panel_country.csv               国家×年份长面板(冲击按行业出口额加权聚合)
"""

import json

import pandas as pd

from gvcsim import shocks
from gvcsim.config import PROCESSED_DIR, available_years, processed_years
from gvcsim.data import loader, quality
from gvcsim.indicators import length, network, production, tradeflow
from gvcsim.indicators.core import build_arrays


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

    log(f"[{year}] 步骤4 贸易流分解...")
    tf_country = tradeflow.country_tradeflow(arr)
    tf_sector = tradeflow.sector_tradeflow(arr)

    log(f"[{year}] 步骤5 生产分解...")
    prod_sector = production.sector_production(arr)
    prod = production.country_production(arr, prod_sector)

    log(f"[{year}] 步骤6 长度分解...")
    len_sector = length.sector_length(arr)
    len_country = length.country_length(arr, len_sector)

    log(f"[{year}] 步骤7 网络指标(行业级介数为抽样近似)...")
    net = network.country_network(arr)
    net_sector = network.sector_network(arr)
    edges = network.network_edges(arr)

    country = tf_country.join(prod).join(len_country).join(net)
    country.insert(0, "year", year)
    country.to_csv(PROCESSED_DIR / f"indicators_country_{year}.csv")

    sector = tf_sector.join(prod_sector).join(len_sector).join(net_sector)
    sector.insert(0, "year", year)
    sector.to_csv(PROCESSED_DIR / f"indicators_sector_{year}.csv")

    edges.insert(0, "year", year)
    edges.to_csv(PROCESSED_DIR / f"network_edges_{year}.csv", index=False)
    log(f"[{year}] 完成,产物已写入 {PROCESSED_DIR}")


def build_panel() -> pd.DataFrame:
    """合并所有已计算年份为长面板,并 merge 冲击数据(演示版)。

    行业级面板(panel_sector.csv)是回归的默认样本;国家级面板的冲击变量
    由行业级冲击按该国各行业出口额加权聚合而来,保证两个粒度口径一致。
    返回行业级面板。
    """
    years = processed_years()
    if not years:
        raise RuntimeError("没有任何已预计算的年份,请先运行 gvcsim compute")

    # ---- 行业级 ----
    sector = pd.concat(
        [pd.read_csv(PROCESSED_DIR / f"indicators_sector_{y}.csv") for y in years],
        ignore_index=True,
    )
    countries = sorted(sector["country"].unique())
    sectors = sorted(sector["sector"].unique())
    shocks.write_demo(countries, sectors, years)
    shock_df = shocks.load_shocks()

    sector = sector.merge(
        shock_df[["country", "sector", "year", "tariff_shock", "treated"]],
        on=["country", "sector", "year"], how="left",
    )
    # 双向FE的个体维度:国家×行业
    sector["entity_id"] = sector["country"] + "_" + sector["sector"]
    sector.to_csv(PROCESSED_DIR / "panel_sector.csv", index=False)

    # ---- 国家级:冲击按行业出口额加权聚合 ----
    country = pd.concat(
        [pd.read_csv(PROCESSED_DIR / f"indicators_country_{y}.csv") for y in years],
        ignore_index=True,
    )
    w = sector["gross_exports"].clip(lower=0.0)
    sector_w = sector.assign(_w=w, _ws=w * sector["tariff_shock"])
    agg = sector_w.groupby(["country", "year"], as_index=False)[["_w", "_ws"]].sum()
    agg["tariff_shock"] = (agg["_ws"] / agg["_w"]).where(agg["_w"] > 0, 0.0)
    agg["treated"] = (agg["tariff_shock"] > shocks.TREATED_THRESHOLD).astype(int)
    country = country.merge(
        agg[["country", "year", "tariff_shock", "treated"]],
        on=["country", "year"], how="left",
    )
    country.to_csv(PROCESSED_DIR / "panel_country.csv", index=False)
    return sector


def run(years: list[int] | None = None) -> None:
    years = years or available_years()
    for y in years:
        compute_year(y)
    build_panel()
    print(f"面板构建完成:{PROCESSED_DIR / 'panel_sector.csv'}(行业级,回归默认)")
    print(f"            {PROCESSED_DIR / 'panel_country.csv'}(国家级)")
