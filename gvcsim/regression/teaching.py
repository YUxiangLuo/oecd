"""Versioned fictional tariff experiment; observed ICIO columns remain untouched."""

from __future__ import annotations

import hashlib

import numpy as np
import pandas as pd

# v3 (2026-10-06): the simulated tariff rises from 10% to 25% so the taxed/untaxed gap is visible on the
# group chart (about two to three within-unit standard deviations instead of one); nothing else changes.
VERSION = "step10-tariff-teaching-v3"
# A contract upgrade must not silently redraw policy assignment or noise.
RANDOMIZATION_VERSION = "step10-tariff-teaching-v1"
X_COLUMN = "teaching_tariff_exposure"
Y_COLUMNS = {outcome: f"teaching_y_{outcome}" for outcome in ("trade", "production", "length", "network")}
BETAS = {"trade": -0.55, "production": -0.40, "length": -1.8, "network": -6000.0}
SEED = 20260913
MARKET = "USA"
TARIFF_PATH = (0.0, 0.0, 0.25, 0.25, 0.25)
DISCLAIMER = "虚构关税政策与模拟教学结果，不是历史事件、真实政策效果或 OECD 发布结果。"
# Rank calibration preserves ordering, not observed levels or accounting identities.
# These ranges ensure valid simulated domains without clipping generated outcomes.
CALIBRATION = {
    "trade": (0.25, 0.30, 0.006),
    "production": (0.20, 0.25, 0.005),
    "length": (3.0, 2.0, 0.030),
    "network": (2000.0, 2000.0, 60.0),
}
UNITS = {
    "trade": "比例（展示为百分点）",
    "production": "比例（展示为百分点）",
    "length": "长度单位",
    "network": "中心性单位",
}


def _unit_number(value: str, salt: str, seed: int = SEED) -> float:
    raw = hashlib.sha256(f"{RANDOMIZATION_VERSION}|{seed}|{salt}|{value}".encode()).digest()
    return int.from_bytes(raw[:8], "big") / (2**64 - 1)


def build_teaching_panel(release_panel: pd.DataFrame, exposure: pd.DataFrame, *, seed: int = SEED) -> pd.DataFrame:
    """Join fixed pre-policy destination shares and generate separate, bounded Y.

    Missing or signed/out-of-domain source observations are ineligible, not filled
    or clipped. Rank calibration is explicitly a teaching construction, not an
    estimate of the actual trajectory. Hash noise is independent of row ordering.
    """
    from gvcsim.regression.design import OUTCOME_DEPVARS

    source_columns = [value[0] for value in OUTCOME_DEPVARS.values()]
    required = {"country", "industry", "year", "entity_id", *source_columns}
    if missing := required - set(release_panel.columns):
        raise ValueError("教学面板缺少源列:" + "、".join(sorted(missing)))
    years = sorted(int(y) for y in release_panel["year"].unique())
    if len(years) != 5 or years != list(range(years[0], years[0] + 5)):
        raise ValueError("教学关税设计需要连续五年面板")
    if release_panel.duplicated(["country", "industry", "year"]).any():
        raise ValueError("教学源面板包含重复记录")
    required_exposure = {"country", "sector", "imposer", "year", "export_exposure"}
    if not required_exposure.issubset(exposure.columns):
        raise ValueError("教学关税缺少目的地出口份额")
    weights = exposure.loc[
        exposure.year.eq(years[0]) & exposure.imposer.eq(MARKET), ["country", "sector", "export_exposure"]
    ].rename(columns={"sector": "industry", "export_exposure": "teaching_export_share_w"})
    if weights.duplicated(["country", "industry"]).any():
        raise ValueError("目的地出口份额包含重复键")
    base = release_panel.loc[release_panel.year.eq(years[0]) & release_panel.country.ne("ROW")].copy()
    base = base.merge(weights, on=["country", "industry"], how="inner", validate="one_to_one")
    finite = np.isfinite(base[source_columns].to_numpy(dtype=float)).all(axis=1)
    eligible = finite & base.teaching_export_share_w.between(0, 1)
    eligible &= base.FVA_share.between(0, 1) & base["3b_VA_GVC_C_share"].between(0, 1)
    eligible &= base.PLv_GVC.gt(0) & base.betweenesscentrality.ge(0)
    base = base.loc[eligible].copy()
    if base.empty:
        raise ValueError("无有效冲击前指标与目的地份额，无法生成教学面板")
    for outcome, column in OUTCOME_DEPVARS.items():
        low, span, _ = CALIBRATION[outcome]
        base[f"_baseline_{outcome}"] = low + span * base[column[0]].rank(method="average", pct=True)
    baseline_columns = [f"_baseline_{outcome}" for outcome in Y_COLUMNS]
    out = release_panel.merge(
        base[["entity_id", "teaching_export_share_w", *baseline_columns]],
        on="entity_id",
        how="inner",
        validate="many_to_one",
    )
    out = out.sort_values(["country", "industry", "year"]).reset_index(drop=True)
    entities = out.entity_id.astype(str)
    exposed = out.country.astype(str).map(lambda value: _unit_number(value, "policy") < 0.60)
    out["teaching_tariff_rate_tau"] = out.year.map(dict(zip(years, TARIFF_PATH, strict=True))) * exposed
    out[X_COLUMN] = out.teaching_export_share_w * out.teaching_tariff_rate_tau
    out["teaching_treated"] = out[X_COLUMN].gt(0).astype(int)
    for outcome, target in Y_COLUMNS.items():
        _, _, noise_scale = CALIBRATION[outcome]
        # Include country-year noise so clustered uncertainty is meaningful.
        individual = entities + "|" + out.year.astype(str)
        cluster = out.country.astype(str) + "|" + out.year.astype(str)
        noise = individual.map(lambda value: 2 * _unit_number(value, outcome, seed) - 1)
        noise += cluster.map(lambda value: 2 * _unit_number(value, f"cluster-{outcome}", seed) - 1)
        trend = out.year.map(dict(zip(years, (-0.4, -0.2, 0.0, 0.2, 0.4), strict=True)))
        out[target] = out[f"_baseline_{outcome}"] + BETAS[outcome] * out[X_COLUMN] + noise_scale * (noise + trend)
    return out.drop(columns=baseline_columns)


def variable_catalog(outcome: str) -> list[dict[str, str]]:
    return [
        {
            "name": X_COLUMN,
            "label": "模拟关税暴露强度",
            "unit": "比例（展示为百分点）",
            "source": "首年销往美国的 ICIO 出口份额 × 虚构税率；并非美国真实政策",
            "role": "X",
        },
        {
            "name": Y_COLUMNS[outcome],
            "label": f"教学模拟{outcome}",
            "unit": UNITS[outcome],
            "source": "首年真实指标排名校准基准 + 预设关系 + 固定种子扰动；不保留真实水平",
            "role": "Y",
        },
    ]


def model_snapshot(outcome: str) -> dict:
    return {
        "version": VERSION,
        "randomization_version": RANDOMIZATION_VERSION,
        "x_columns": [X_COLUMN],
        "y_column": Y_COLUMNS[outcome],
        "entity": "entity_id",
        "time": "year",
        "fixed_effects": ["entity_id", "year"],
        "controls": [],
        "interactions": [],
        "seed": SEED,
        "beta": BETAS[outcome],
        "tariff_path": list(TARIFF_PATH),
        "market": MARKET,
        "calibration": CALIBRATION[outcome],
        "disclaimer": DISCLAIMER,
    }


def group_trends(panel: pd.DataFrame) -> dict:
    """Mean change of each simulated Y for taxed vs untaxed countries, relative to the pre-policy years.

    This is the descriptive comparison behind the TWFE estimate: after the fictional tariff
    starts, does the taxed group's Y move away from the untaxed group's Y? Countries are grouped by
    whether their simulated tariff is ever positive; each group's line is its yearly mean minus its
    own pre-policy mean, so different baseline levels do not hide the post-policy gap.
    """
    years = sorted(int(year) for year in panel["year"].unique())
    rates = panel.groupby("year")["teaching_tariff_rate_tau"].max()
    policy_years = [year for year in years if rates.get(year, 0) > 0]
    if not policy_years:
        raise ValueError("教学面板没有模拟加税年份")
    policy_year = policy_years[0]
    pre_years = [year for year in years if year < policy_year]
    taxed_country = panel.groupby("country")["teaching_tariff_rate_tau"].transform("max").gt(0)
    group = np.where(taxed_country, "taxed", "untaxed")
    outcomes: dict[str, dict[str, list[dict[str, float | int]]]] = {}
    for outcome, column in Y_COLUMNS.items():
        means = panel.groupby([group, "year"])[column].mean()
        series: dict[str, list[dict[str, float | int]]] = {}
        for name in ("taxed", "untaxed"):
            if name not in means.index.get_level_values(0):
                series[name] = []
                continue
            values = means.loc[name]
            baseline = float(values.loc[pre_years].mean())
            series[name] = [{"year": int(year), "change": float(values.loc[year] - baseline)} for year in years]
        outcomes[outcome] = series
    countries = panel.loc[taxed_country, "country"].nunique(), panel.loc[~taxed_country, "country"].nunique()
    # Mean exposure of taxed-country units in the policy years: β × this is the gap the regression implies
    # between the two group lines, which the page draws back onto the chart after the run.
    policy_rows = panel.loc[taxed_country & panel["year"].isin(policy_years), X_COLUMN]
    mean_exposure_taxed = float(policy_rows.mean()) if len(policy_rows) else 0.0
    return {
        "version": VERSION,
        "years": years,
        "policy_year": policy_year,
        "sample": {
            "rows": int(len(panel)),
            "entities": int(panel["entity_id"].nunique()),
            "countries": int(panel["country"].nunique()),
            "industries": int(panel["industry"].nunique()),
            "taxed_countries": int(countries[0]),
            "untaxed_countries": int(countries[1]),
        },
        # Industries with at least one retained unit: step 10 offers only these as examples.
        "industries": sorted(str(code) for code in panel["industry"].unique()),
        "mean_exposure_taxed": mean_exposure_taxed,
        "outcomes": outcomes,
    }
