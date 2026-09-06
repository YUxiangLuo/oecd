"""预计算流水线:原始 ICIO → 质检 → 指标 → 面板。

计算一次落盘为 CSV/JSON(data/processed/),API 与前端只读产物、不碰
原始 66MB 大表,保证接口毫秒级响应。

产物(每年):
  qc_<year>.json                  输入诊断结果（系统自动运行）
  qc_outputs_<year>.json          发布前输出语义质检(独立 contract)
  qc_regression_inputs.json       发布前回归输入质检(独立 contract)
  indicators_country_<year>.csv   国家级指标汇总(步骤2–5，并供步骤6–9可视化)
  indicators_industry_<year>.csv  国家-行业级指标(步骤2–5，并供步骤6–9可视化)
  network_edges_<year>.csv        双边贸易流 top 边(步骤9 网络图)
跨年:
  panel_industry.csv              国家×行业×年份长面板 + 行业异质冲击(四类 outcome 默认回归样本)
  panel_country.csv               国家×年份长面板(冲击按行业出口额加权聚合)
  controls_country.csv            ICIO 派生/宏观mock控制 + 平减指数(四类 outcome)
  qc_controls.json                controls_country.csv 独立质检
  export_exposure_<year>.csv      ICIO 派生国家–行业出口目的地暴露度(步骤10 冲击加权)
  tariff_exposure_lookup.csv      仅含事件目录加征方的 API 紧凑查询表
"""

import json
import shutil
from contextlib import contextmanager
from pathlib import Path

import pandas as pd

from gvcsim import publication, shocks
from gvcsim.artifacts import (
    NETWORK_ALGORITHM,
    integrity_check_summary,
    publication_policy_metadata,
    release_integrity_metadata,
    validate_release,
    write_dataset_metadata,
)
from gvcsim import config as config_module
from gvcsim.config import PROCESSED_DIR, RAW_DATA_DIR, available_years, processed_years
from gvcsim.data.citations import artifact_data_sources
from gvcsim.data.raw_icio import raw_dimensions_metadata
from gvcsim.data import controls, loader, output_quality, quality, regression_quality
from gvcsim.indicators import length, network, production, tradeflow
from gvcsim.indicators.core import build_arrays


class QualityGateError(RuntimeError):
    """An integrity failure stopped publication."""

    def __init__(self, scope: str, summary: dict):
        self.scope = scope
        self.summary = summary
        names = "、".join(summary.get("failures") or [])
        super().__init__(f"{scope} 存在完整性检查失败，已停止发布: {names}")


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


def _gate_integrity(scope: str, checks: list[quality.QcCheck], blocking_kinds: list[str]) -> dict:
    """Block malformed inputs while leaving economic/numeric findings as disclosure."""
    summary = integrity_check_summary([check.to_dict() for check in checks], blocking_kinds)
    if not summary["passed"]:
        raise QualityGateError(scope, summary)
    return summary


def _release_qc_metadata(directory: Path, years: list[int]) -> dict:
    def read_summary(filename: str, scope: str) -> dict:
        payload = json.loads((directory / filename).read_text(encoding="utf-8"))
        checks = quality.validate_serialized_checks(payload, scope=scope)
        return quality.summarize_serialized_checks(checks, override=False)

    return {
        "years": {str(year): read_summary(f"qc_{year}.json", quality.QC_SCOPE_ICIO) for year in years},
        "controls": read_summary("qc_controls.json", quality.QC_SCOPE_CONTROLS),
        "shocks": read_summary("qc_shocks.json", quality.QC_SCOPE_SHOCKS),
    }


def compute_year(year: int, verbose: bool = True) -> None:
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
        _gate_integrity(str(year), checks, publication_policy_metadata()["blocking_kinds"]["icio"])
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

    log(f"[{year}] 步骤10所需国家–行业出口暴露度(ICIO 双边流向)...")
    shocks.write_export_exposure(arr, year)

    log(f"[{year}] 步骤2 贸易流分解...")
    tf_sector = tradeflow.sector_tradeflow(arr)
    tf_country = tradeflow.country_tradeflow(arr, tf_sector)

    log(f"[{year}] 步骤3 生产分解...")
    prod_sector = production.sector_production(arr)
    prod = production.country_production(arr, prod_sector)

    log(f"[{year}] 步骤4 长度分解...")
    len_sector, len_country = length.length_tables(arr)

    log(f"[{year}] 步骤5 Gephi-compatible 网络指标（全部正边、精确介数）...")
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
    log(f"[{year}] 完成,产物已写入 {PROCESSED_DIR}")


def build_panel(
    *,
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

    shocks.write_runtime_exposure_lookup(years)

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
    _gate_integrity(
        "controls_country",
        controls_checks,
        publication_policy_metadata()["blocking_kinds"]["controls"],
    )

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
    _gate_integrity(
        "shock_panel",
        shock_checks,
        publication_policy_metadata()["blocking_kinds"]["shocks"],
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
            f"国家面板固定处理前权重要求首次处理年 {first_treated_year} 之前至少有一个发布年份；不得回退到最早处理年"
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
    return sector


def _build_staged_release(
    staging: Path,
    selected_years: list[int],
    *,
    release_id: str,
) -> None:
    """Build and validate one complete release without touching the live pointer."""
    with _using_processed_dir(staging):
        for year in selected_years:
            compute_year(year)
        print("[release] 构建跨年面板、控制变量与冲击面板...", flush=True)
        build_panel()
        print("[release] 执行逐年输出语义 QC...", flush=True)
        output_qc_years = {
            str(year): output_quality.write_output_qc(
                staging,
                year,
                expected_years=selected_years,
            )[1]
            for year in selected_years
        }
        print("[release] 执行回归输入 QC...", flush=True)
        regression_input_qc = regression_quality.write_regression_input_qc(
            staging,
            expected_years=selected_years,
        )[1]
        print("[release] 生成 release metadata 与完整 artifact manifest...", flush=True)
        release_qc = _release_qc_metadata(staging, selected_years)
        publication_policy = publication_policy_metadata()
        integrity = release_integrity_metadata(staging, selected_years)
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
                "publication_policy": publication_policy,
                "integrity": integrity,
            },
        )
        print("[release] 校验完整 release 的哈希、结构与 QC contract...", flush=True)
        validate_release(staging)
        print("[release] 暂存 release 已通过全部发布门禁。", flush=True)


def run(years: list[int] | None = None) -> None:
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
