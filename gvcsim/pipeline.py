"""预计算流水线:原始 ICIO → 质检 → 指标 → 面板。

计算一次落盘为 CSV/JSON(data/processed/),API 与前端只读产物、不碰
原始 66MB 大表,保证接口毫秒级响应。

产物(每年):
  qc_<year>.json                  输入质检结果(步骤2)
  qc_outputs_<year>.json          发布前输出语义质检(独立 contract)
  qc_regression_inputs.json       发布前回归输入质检(独立 contract)
  indicators_country_<year>.csv   国家级指标汇总(步骤3–6，并供步骤7–10可视化)
  indicators_industry_<year>.csv  国家-行业级指标(步骤3–6，并供步骤7–10可视化)
  network_edges_<year>.csv        双边贸易流 top 边(步骤10 网络图)
跨年:
  panel_industry.csv              国家×行业×年份长面板 + 行业异质冲击(四类 outcome 默认回归样本)
  panel_country.csv               国家×年份长面板(冲击按行业出口额加权聚合)
  controls_country.csv            ICIO 派生/宏观mock控制 + 平减指数(四类 outcome)
  qc_controls.json                controls_country.csv 独立质检
  export_exposure_<year>.csv      ICIO 派生出口目的地暴露度(步骤11 冲击加权)
"""

import json
import shutil
from contextlib import contextmanager
from pathlib import Path

import pandas as pd

from gvcsim import publication, shocks
from gvcsim.artifacts import validate_release, write_dataset_metadata
from gvcsim.artifacts import NETWORK_ALGORITHM
from gvcsim import config as config_module
from gvcsim.config import PROCESSED_DIR, RAW_DATA_DIR, available_years, processed_years
from gvcsim.data.citations import artifact_data_sources
from gvcsim.data.raw_icio import raw_dimensions_metadata
from gvcsim.data import controls, loader, output_quality, quality, regression_quality
from gvcsim.indicators import length, network, production, tradeflow
from gvcsim.indicators.core import build_arrays


class QualityGateError(RuntimeError):
    """A fatal QC gate stopped publication, with its override policy attached."""

    def __init__(self, scope: str, summary: dict, *, override_allowed: bool = True):
        self.scope = scope
        self.summary = summary
        self.override_allowed = override_allowed
        names = "、".join(summary.get("fatal") or [])
        policy = "" if override_allowed else "（该 scope 的 fatal 检查不可 override）"
        super().__init__(f"{scope} 存在 fatal 质检失败，已停止发布{policy}: {names}")


@contextmanager
def _using_processed_dir(path: Path):
    """让一次构建的所有写入/读取都落到同一 staging 目录。"""
    global PROCESSED_DIR
    old_pipeline = PROCESSED_DIR
    old_config = config_module.PROCESSED_DIR
    old_shocks = shocks.PROCESSED_DIR
    old_controls = controls.PROCESSED_DIR
    PROCESSED_DIR = path
    config_module.PROCESSED_DIR = path
    shocks.PROCESSED_DIR = path
    controls.PROCESSED_DIR = path
    try:
        yield
    finally:
        PROCESSED_DIR = old_pipeline
        config_module.PROCESSED_DIR = old_config
        shocks.PROCESSED_DIR = old_shocks
        controls.PROCESSED_DIR = old_controls


def _gate_qc(
    scope: str,
    checks: list[quality.QcCheck],
    allow_qc_override: bool,
    *,
    override_allowed: bool = True,
) -> dict:
    """Apply QC policy; shock fatal checks are deliberately non-overridable."""
    if type(allow_qc_override) is not bool or type(override_allowed) is not bool:
        raise ValueError("QC override 必须是布尔值")
    summary = quality.summarize_checks(
        checks,
        override=allow_qc_override and override_allowed,
    )
    if not summary["publishable"]:
        raise QualityGateError(scope, summary, override_allowed=override_allowed)
    return summary


def _release_qc_metadata(directory: Path, years: list[int], *, override: bool) -> dict:
    def read_summary(filename: str, scope: str) -> dict:
        payload = json.loads((directory / filename).read_text(encoding="utf-8"))
        checks = quality.validate_serialized_checks(payload, scope=scope)
        return quality.summarize_serialized_checks(checks, override=override)

    return {
        "years": {
            str(year): read_summary(f"qc_{year}.json", quality.QC_SCOPE_ICIO)
            for year in years
        },
        "controls": read_summary("qc_controls.json", quality.QC_SCOPE_CONTROLS),
        # Shock schema, provenance, and semantic fatal checks are a formal
        # publication boundary.  CLI teaching override never persists here.
        "shocks": quality.summarize_serialized_checks(
            quality.validate_serialized_checks(
                json.loads((directory / "qc_shocks.json").read_text(encoding="utf-8")),
                scope=quality.QC_SCOPE_SHOCKS,
            ),
            override=False,
        ),
    }


def compute_year(year: int, verbose: bool = True, *, allow_qc_override: bool = False) -> None:
    def log(msg: str) -> None:
        if verbose:
            print(msg, flush=True)

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    log(f"[{year}] 解析 ICIO 表并计算 A/L 矩阵(最耗时的一步)...")
    io = loader.load(year)

    log(f"[{year}] 数据质检...")
    checks = quality.run_all(io)
    qc_payload = [c.to_dict() for c in checks]
    try:
        # QC 是发布门槛而非装饰。fatal 默认在任何指标/暴露度计算前中止；
        # 只有 CLI 显式 override 才可继续。
        qc_summary = _gate_qc(str(year), checks, allow_qc_override)
    except QualityGateError:
        # 诊断写入 rejected/；成功标记仍不存在，服务不会读取半成品。
        rejected = PROCESSED_DIR / "rejected"
        rejected.mkdir(exist_ok=True)
        with open(rejected / f"qc_{year}.json", "w", encoding="utf-8") as f:
            json.dump(qc_payload, f, ensure_ascii=False, indent=2)
        raise
    with open(PROCESSED_DIR / f"qc_{year}.json", "w", encoding="utf-8") as f:
        json.dump(qc_payload, f, ensure_ascii=False, indent=2)

    arr = build_arrays(io)

    log(f"[{year}] 步骤11所需出口暴露度(ICIO 双边流向)...")
    shocks.write_export_exposure(arr, year)

    log(f"[{year}] 步骤3 贸易流分解...")
    tf_sector = tradeflow.sector_tradeflow(arr)
    tf_country = tradeflow.country_tradeflow(arr, tf_sector)

    log(f"[{year}] 步骤4 生产分解...")
    prod_sector = production.sector_production(arr)
    prod = production.country_production(arr, prod_sector)

    log(f"[{year}] 步骤5 长度分解...")
    len_sector = length.sector_length(arr)
    len_country = length.country_length(arr, len_sector)

    log(f"[{year}] 步骤6 Gephi-compatible 网络指标（全部正边、精确介数）...")
    net = network.country_network(arr)
    net_sector = network.sector_network(arr)
    edges = network.network_edges(arr)

    country = tf_country.join(prod).join(len_country).join(net)
    country.insert(0, "year", year)
    country.to_csv(PROCESSED_DIR / f"indicators_country_{year}.csv")

    sector = tf_sector.join(prod_sector).join(len_sector).join(net_sector)
    sector.insert(0, "year", year)
    sector.to_csv(PROCESSED_DIR / f"indicators_industry_{year}.csv")

    edges.insert(0, "year", year)
    edges.to_csv(PROCESSED_DIR / f"network_edges_{year}.csv", index=False)
    del qc_summary
    log(f"[{year}] 完成,产物已写入 {PROCESSED_DIR}")


def build_panel(
    *,
    allow_qc_override: bool = False,
    allow_stylized_shock_fallback: bool = False,
) -> pd.DataFrame:
    """合并所有已计算年份为长面板,并 merge 冲击数据(演示版)。

    行业级面板(panel_industry.csv)是回归的默认样本;国家级面板的冲击变量
    由行业级冲击按该国各行业出口额加权聚合而来,保证两个粒度口径一致。
    返回行业级面板。
    """
    years = processed_years()
    if not years:
        raise RuntimeError("没有任何已预计算的年份,请先运行 gvcsim compute")
    for year in years:
        if not (PROCESSED_DIR / f"indicators_country_{year}.csv").is_file():
            raise FileNotFoundError(PROCESSED_DIR / f"indicators_country_{year}.csv")
        if not (PROCESSED_DIR / f"indicators_industry_{year}.csv").is_file():
            raise FileNotFoundError(PROCESSED_DIR / f"indicators_industry_{year}.csv")

    sector = pd.concat(
        [pd.read_csv(PROCESSED_DIR / f"indicators_industry_{y}.csv") for y in years],
        ignore_index=True,
    )
    country = pd.concat(
        [pd.read_csv(PROCESSED_DIR / f"indicators_country_{y}.csv") for y in years],
        ignore_index=True,
    )
    controls_df = controls.write_controls(country, sector)
    controls_checks = quality.check_controls_country(
        controls_df,
        countries=sorted(country["country"].unique()),
        years=years,
    )
    with open(PROCESSED_DIR / "qc_controls.json", "w", encoding="utf-8") as f:
        json.dump([c.to_dict() for c in controls_checks], f, ensure_ascii=False, indent=2)
    controls_qc = _gate_qc("controls_country", controls_checks, allow_qc_override)

    # 回归用派生列：毛出口与文献指标份额（作为四类 outcome 因变量/交互基线）。
    for df in (sector, country):
        df["gross_exports"] = tradeflow.gross_exports(df)
        gross = df["gross_exports"]
        df["FVA_share"] = (df["FVA"] / gross).where(gross > 0)
        df["3b_VA_GVC_C_share"] = (df["3b_VA_GVC_C"] / df["SVA"]).where(df["SVA"] > 0)
        df["3_VA_GVC_share"] = (df["3_VA_GVC"] / df["SVA"]).where(df["SVA"] > 0)

    # ---- 行业级 ----
    countries = sorted(sector["country"].unique())
    sectors = sorted(sector["industry"].unique())
    shocks.write_demo(
        countries,
        sectors,
        years,
        allow_stylized_fallback=allow_stylized_shock_fallback,
    )
    shock_df = shocks.load_shocks()
    shock_checks = quality.check_shock_panel(shock_df, countries, sectors, years)
    with open(PROCESSED_DIR / "qc_shocks.json", "w", encoding="utf-8") as f:
        json.dump([c.to_dict() for c in shock_checks], f, ensure_ascii=False, indent=2)
    shocks_qc = _gate_qc(
        "shock_panel",
        shock_checks,
        allow_qc_override,
        override_allowed=False,
    )
    shock_cols = list(dict.fromkeys(col for pair in shocks.SHOCK_SPECS.values() for col in pair))
    robustness_cols = ["tariff_shock_contemporaneous", "treated_contemporaneous"]

    # 冲击 mock 面板保持 country×sector×year 结构不变,合并时把行业列名对齐为 industry
    shock_merge = shock_df[["country", "sector", "year", *shock_cols, *robustness_cols]].rename(
        columns={"sector": "industry"}
    )
    sector = sector.merge(
        shock_merge,
        on=["country", "industry", "year"],
        how="left",
    ).merge(
        controls_df,
        on=["country", "year"],
        how="left",
    )
    # 双向FE的个体维度:国家×行业
    sector["entity_id"] = sector["country"] + "_" + sector["industry"]
    sector.to_csv(PROCESSED_DIR / "panel_industry.csv", index=False)

    # ---- 国家级:主口径使用首次处理前固定行业出口权重 ----
    # 当期 gross_exports 本身可能已被政策改变；再用它给处理强度加权会让结果
    # 反向决定 treatment。固定权重必须来自首次处理前发布年，不能回退到处理年。
    any_treated = sector[[treated for _, treated in shocks.SHOCK_SPECS.values()]].max(axis=1) > 0
    treated_years = sector.loc[any_treated, "year"]
    first_treated_year = int(treated_years.min()) if not treated_years.empty else None
    pre_years = [year for year in years if first_treated_year is None or year < first_treated_year]
    if not pre_years:
        raise ValueError(
            f"国家面板固定处理前权重要求首次处理年 {first_treated_year} 之前至少有一个发布年份；"
            "不得回退到最早处理年"
        )
    weight_year = max(pre_years)
    base_weights = (
        sector.loc[sector["year"] == weight_year, ["country", "industry", "gross_exports"]]
        .rename(columns={"gross_exports": "_baseline_w"})
        .assign(_baseline_w=lambda frame: frame["_baseline_w"].clip(lower=0.0))
    )
    sector_w = sector.merge(base_weights, on=["country", "industry"], how="left")
    sector_w["_w"] = sector_w["_baseline_w"].fillna(0.0)
    agg = sector_w.groupby(["country", "year"], as_index=False)["_w"].sum()
    for _shock_type, (shock_col, treated_col) in shocks.SHOCK_SPECS.items():
        tmp = sector_w.assign(_ws=sector_w["_w"] * sector_w[shock_col])
        ws = tmp.groupby(["country", "year"], as_index=False)["_ws"].sum()
        agg = agg.merge(ws, on=["country", "year"], how="left")
        agg[shock_col] = (agg["_ws"] / agg["_w"]).where(agg["_w"] > 0, 0.0)
        agg[treated_col] = (agg[shock_col] > shocks.TREATED_THRESHOLD).astype(int)
        agg = agg.drop(columns=["_ws"])
    # 稳健性列保留旧的当期出口结构口径，名称明确标注 contemporaneous。
    current = sector.assign(_current_w=sector["gross_exports"].clip(lower=0.0))
    current_agg = current.groupby(["country", "year"], as_index=False)["_current_w"].sum()
    current_ws = current.assign(_current_ws=current["_current_w"] * current["tariff_shock_contemporaneous"])
    current_ws = current_ws.groupby(["country", "year"], as_index=False)["_current_ws"].sum()
    current_agg = current_agg.merge(current_ws, on=["country", "year"], how="left")
    current_agg["tariff_shock_contemporaneous"] = (current_agg["_current_ws"] / current_agg["_current_w"]).where(
        current_agg["_current_w"] > 0, 0.0
    )
    current_agg["treated_contemporaneous"] = (
        current_agg["tariff_shock_contemporaneous"] > shocks.TREATED_THRESHOLD
    ).astype(int)
    agg = agg.merge(current_agg[["country", "year", *robustness_cols]], on=["country", "year"], how="left")
    country = country.merge(
        agg[["country", "year", *shock_cols, *robustness_cols]],
        on=["country", "year"],
        how="left",
    ).merge(
        controls_df,
        on=["country", "year"],
        how="left",
    )
    country.to_csv(PROCESSED_DIR / "panel_country.csv", index=False)
    del controls_qc, shocks_qc
    return sector


def _build_staged_release(
    staging: Path,
    selected_years: list[int],
    *,
    allow_qc_override: bool,
    release_id: str,
) -> None:
    """Build and validate one complete release without touching the live pointer."""
    with _using_processed_dir(staging):
        for year in selected_years:
            compute_year(year, allow_qc_override=allow_qc_override)
        build_panel(allow_qc_override=allow_qc_override)
        # Output QC is a separate release gate, run only after every yearly output
        # and both cross-year panels exist. It is never covered by the input-QC override.
        output_qc_years = {
            str(year): output_quality.write_output_qc(
                staging,
                year,
                expected_years=selected_years,
            )[1]
            for year in selected_years
        }
        regression_input_qc = regression_quality.write_regression_input_qc(
            staging,
            expected_years=selected_years,
        )[1]
        release_qc = _release_qc_metadata(staging, selected_years, override=allow_qc_override)
        write_dataset_metadata(
            staging,
            {
                "release_id": release_id,
                "years": selected_years,
                "generated_at": pd.Timestamp.now(tz="UTC").isoformat(),
                "course_release": config_module.COURSE_RELEASE,
                "network_algorithm": NETWORK_ALGORITHM,
                "data_sources": artifact_data_sources(RAW_DATA_DIR),
                "raw_dimensions": raw_dimensions_metadata(selected_years, RAW_DATA_DIR),
                "qc_contract": quality.qc_contract_metadata(),
                "shock_contract": shocks.shock_contract_metadata(),
                "qc": release_qc,
                "output_qc_contract": output_quality.output_qc_contract_metadata(),
                "output_qc": {"years": output_qc_years},
                "regression_input_qc_contract": regression_quality.regression_input_qc_contract_metadata(),
                "regression_input_qc": regression_input_qc,
            },
        )
        validate_release(staging)


def run(years: list[int] | None = None, *, allow_qc_override: bool = False) -> None:
    """Build in staging, validate it, then atomically switch the data pointer."""
    selected_years = sorted(set(years or available_years()))
    if not selected_years:
        raise RuntimeError("没有可构建的 OECD ICIO 年份")
    current = PROCESSED_DIR
    with publication.compute_lock(current):
        staging, final = publication.create_staging_release(current)
        try:
            _build_staged_release(
                staging,
                selected_years,
                allow_qc_override=allow_qc_override,
                release_id=final.name,
            )
            publication.promote_staging(staging, final)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        previous = publication.publish_release(current, final)
        retained = [final]
        if previous is not None:
            retained.append(previous)
        for warning in publication.cleanup_old_releases(current, retained):
            print(f"警告:{warning}")
    print(f"面板构建完成:{current / 'panel_industry.csv'}(行业级,回归默认)")
    print(f"            {current / 'panel_country.csv'}(国家级)")
    print("已耐久、原子切换固定产物并保留上一发布；教学记录按新 release 自动隔离")
