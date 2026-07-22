"""预计算流水线:原始 ICIO → 质检 → 指标 → 面板。

计算一次落盘为 CSV/JSON(data/processed/),API 与前端只读产物、不碰
原始 66MB 大表,保证接口毫秒级响应。

产物(每年):
  qc_<year>.json                  质检结果(步骤2)
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
import os
import shutil
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path

import pandas as pd

from gvcsim import shocks
from gvcsim.artifacts import manifest_provenance, register_artifacts, validate_artifact, validate_release
from gvcsim import config as config_module
from gvcsim.config import PROCESSED_DIR, RAW_DATA_DIR, ROOT, available_years, processed_years
from gvcsim.data import controls, loader, quality
from gvcsim.indicators import length, network, production, tradeflow
from gvcsim.indicators.core import build_arrays


class QualityGateError(RuntimeError):
    """fatal QC 未获显式 override，产物不得发布。"""

    def __init__(self, scope: str, summary: dict):
        self.scope = scope
        self.summary = summary
        names = "、".join(summary.get("fatal") or [])
        super().__init__(f"{scope} 存在 fatal 质检失败，已停止发布: {names}")


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


def _validate_staged_release(staging: Path) -> str:
    provenance = manifest_provenance(staging)
    validate_release(staging, validate_sources=True)
    return str(provenance["manifest_id"])


def _normalize_release_permissions(staging: Path) -> None:
    """让发布目录可由同部署组读取；不触碰任何 legacy/既有 release。"""
    staging.chmod(0o750)
    for path in staging.rglob("*"):
        if path.is_symlink():
            continue
        path.chmod(0o750 if path.is_dir() else 0o640)


def _publish_staged_release(staging: Path, current: Path) -> tuple[str, Path]:
    """把完整 staging 固化为内容寻址版本，再原子切换 current symlink。"""
    _normalize_release_permissions(staging)
    release_id = _validate_staged_release(staging)
    versions = current.parent / "artifacts"
    versions.mkdir(parents=True, exist_ok=True)
    release = versions / release_id
    if release.exists():
        existing_id = _validate_staged_release(release)
        if existing_id != release_id:
            raise RuntimeError(f"既有版本目录 {release} 的内容 ID 不匹配: {existing_id}")
        if (release / "artifact_manifest.json").read_bytes() != (staging / "artifact_manifest.json").read_bytes():
            raise RuntimeError(f"版本目录 {release} 已存在但 manifest 内容不同")
        shutil.rmtree(staging)
    else:
        os.replace(staging, release)

    next_link = current.parent / f".processed-next-{uuid.uuid4().hex}"
    next_link.symlink_to(Path("artifacts") / release_id, target_is_directory=True)
    if current.is_symlink() or not current.exists():
        os.replace(next_link, current)
    else:
        # 首次从旧的真实目录迁移：先完整保留为 legacy，不删除任何产物。
        legacy = versions / f"legacy-{uuid.uuid4().hex[:12]}"
        os.replace(current, legacy)
        try:
            os.replace(next_link, current)
        except Exception:
            os.replace(legacy, current)
            raise
    return release_id, release


def _gate_qc(scope: str, checks: list[quality.QcCheck], allow_qc_override: bool) -> dict:
    summary = quality.summarize_checks(checks, override=allow_qc_override)
    if not summary["publishable"]:
        raise QualityGateError(scope, summary)
    return summary


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
        # 只有 CLI 显式 override 才可继续，并永久写入 manifest。
        qc_summary = _gate_qc(str(year), checks, allow_qc_override)
    except QualityGateError:
        # 诊断写入 rejected/，不覆盖仍在提供服务的 current QC/manifest。
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
    raw_sources = sorted(RAW_DATA_DIR.glob(f"ICIO*_{year}.csv"))
    register_artifacts(
        PROCESSED_DIR,
        [
            f"qc_{year}.json",
            f"export_exposure_{year}.csv",
            f"indicators_country_{year}.csv",
            f"indicators_industry_{year}.csv",
            f"network_edges_{year}.csv",
        ],
        metadata={"qc": {"years": {str(year): qc_summary}}},
        source_paths=raw_sources,
    )
    log(f"[{year}] 完成,产物已写入 {PROCESSED_DIR}")


def build_panel(*, allow_qc_override: bool = False) -> pd.DataFrame:
    """合并所有已计算年份为长面板,并 merge 冲击数据(演示版)。

    行业级面板(panel_industry.csv)是回归的默认样本;国家级面板的冲击变量
    由行业级冲击按该国各行业出口额加权聚合而来,保证两个粒度口径一致。
    返回行业级面板。
    """
    years = processed_years()
    if not years:
        raise RuntimeError("没有任何已预计算的年份,请先运行 gvcsim compute")
    for year in years:
        validate_artifact(PROCESSED_DIR / f"indicators_country_{year}.csv")
        validate_artifact(PROCESSED_DIR / f"indicators_industry_{year}.csv")

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
    shocks.write_demo(countries, sectors, years)
    shock_df = shocks.load_shocks()
    shock_checks = quality.check_shock_panel(shock_df, countries, sectors, years)
    with open(PROCESSED_DIR / "qc_shocks.json", "w", encoding="utf-8") as f:
        json.dump([c.to_dict() for c in shock_checks], f, ensure_ascii=False, indent=2)
    shocks_qc = _gate_qc("shock_panel", shock_checks, allow_qc_override)
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
    # 反向决定 treatment。面板存在前期时取首次处理前最后一年，否则取最早年。
    any_treated = sector[[treated for _, treated in shocks.SHOCK_SPECS.values()]].max(axis=1) > 0
    treated_years = sector.loc[any_treated, "year"]
    first_treated_year = int(treated_years.min()) if not treated_years.empty else min(years) + 1
    pre_years = [year for year in years if year < first_treated_year]
    weight_year = max(pre_years) if pre_years else min(years)
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
    source_paths: list[Path] = [
        *sorted(RAW_DATA_DIR.glob("ICIO*_*.csv")),
        # 受控收录整个 Python 后端：不仅指标公式，QC、报告、完成度 gate 和 API
        # 都会改变学生最终看到/提交的内容，漏登记会让 dirty 构建冒充 commit 版本。
        *sorted((ROOT / "gvcsim").rglob("*.py")),
        ROOT / "pyproject.toml",
        ROOT / "uv.lock",
    ]
    register_artifacts(
        PROCESSED_DIR,
        [
            "controls_country.csv",
            "qc_controls.json",
            "qc_shocks.json",
            shocks.DEMO_FILE,
            "panel_industry.csv",
            "panel_country.csv",
        ],
        metadata={
            "qc": {"controls": controls_qc, "shocks": shocks_qc},
            "shock_weighting": {
                "primary": shocks.EXPOSURE_MODE_FIXED_PRETREATMENT,
                "robustness": shocks.EXPOSURE_MODE_CONTEMPORANEOUS,
                "country_sector_weight_year": weight_year,
            },
        },
        source_paths=source_paths,
    )
    return sector


def run(years: list[int] | None = None, *, allow_qc_override: bool = False) -> None:
    selected_years = sorted(set(years or available_years()))
    if not selected_years:
        raise RuntimeError("没有可构建的 OECD ICIO 年份")
    current = PROCESSED_DIR
    current.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".gvcsim-staging-", dir=current.parent))
    try:
        with _using_processed_dir(staging):
            for y in selected_years:
                compute_year(y, allow_qc_override=allow_qc_override)
            build_panel(allow_qc_override=allow_qc_override)
        release_id, release = _publish_staged_release(staging, current)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    print(f"面板构建完成:{current / 'panel_industry.csv'}(行业级,回归默认)")
    print(f"            {current / 'panel_country.csv'}(国家级)")
    print(f"原子发布版本:{release_id} → {release}")
