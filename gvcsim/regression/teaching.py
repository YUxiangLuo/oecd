"""Versioned fictional tariff experiment; observed ICIO columns remain untouched."""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeVar

import numpy as np
import pandas as pd

# v3 (2026-10-06): the simulated tariff rises from 10% to 25% so the taxed/untaxed gap is visible on the
# group chart (about two to three within-unit standard deviations instead of one).
# v4 (2026-10-06): each family gains alternative generation baselines (other real indicators of the same
# family) with their own preset relation; the default Y of every family is unchanged from v3.
# v5 (2026-10-07): the families mirror the shares steps 6-9 single out (traditional-trade and backward GVC
# shares added, the foreign double-counting share dropped) and the network family follows step 9: its
# fixed Y is the weighted degree, with in/out degree, betweenness and closeness as alternatives.
VERSION = "step10-tariff-teaching-v5"
# A contract upgrade must not silently redraw policy assignment or noise.
RANDOMIZATION_VERSION = "step10-tariff-teaching-v1"
X_COLUMN = "teaching_tariff_exposure"
OUTCOMES = ("trade", "production", "length", "network")
SEED = 20260913
MARKET = "USA"
TARIFF_PATH = (0.0, 0.0, 0.25, 0.25, 0.25)
DISCLAIMER = "课程关税实验数据集：X 与四个 Y 按课程数据契约生成，不是 OECD 发布结果。"
# Display kinds: shares are shown in percentage points, the others in their own raw units.
T = TypeVar("T")
KIND_UNITS = {
    "share": "比例（展示为百分点）",
    "length": "长度单位",
    "position": "位置指数单位",
    "network": "中心性单位",
}


@dataclass(frozen=True)
class Baseline:
    """A real first-year indicator whose ranking calibrates one simulated Y of a family.

    ``calibration`` is (low, span, noise scale): the simulated level is low + span × percentile rank,
    so ordering is preserved but observed levels and accounting identities are not. ``derived`` names
    (numerator, denominator) release columns for a share the release panel does not carry itself.
    """

    key: str
    label: str
    kind: str
    beta: float
    calibration: tuple[float, float, float]
    source: str | None = None
    derived: tuple[str, str] | None = None

    @property
    def column(self) -> str:
        return self.source or self.key

    @property
    def unit(self) -> str:
        return KIND_UNITS[self.kind]

    def in_domain(self, values: pd.Series) -> pd.Series:
        finite = np.isfinite(values.to_numpy(dtype=float))
        if self.kind == "share":
            return pd.Series(finite, index=values.index) & values.between(0, 1)
        if self.kind == "length":
            return pd.Series(finite, index=values.index) & values.gt(0)
        if self.kind == "network":
            return pd.Series(finite, index=values.index) & values.ge(0)
        return pd.Series(finite, index=values.index)


# The first baseline of each family is the fixed Y of steps 11–14; the others are the same-family
# choices offered on the page. Directions follow the indicator type (a tariff on exports to the market
# lowers foreign content, GVC participation, lengths and network centrality; raises the domestic shares);
# magnitudes are set so the preset effect is about two to three within-unit standard deviations and are
# evaluated by scripts/benchmark_teaching_design.py.
BASELINES: dict[str, tuple[Baseline, ...]] = {
    "trade": (
        Baseline("FVA_share", "外国增加值项占比", "share", -0.55, (0.25, 0.30, 0.006)),
        Baseline(
            "DVAex_share", "国内增加值出口占比", "share", 0.55, (0.55, 0.30, 0.006), derived=("DVAex", "gross_exports")
        ),
    ),
    "production": (
        Baseline("3b_VA_GVC_C_share", "复杂 GVC 生产份额", "share", -0.40, (0.20, 0.25, 0.005)),
        Baseline("3_VA_GVC_share", "前向 GVC 生产总份额", "share", -0.50, (0.35, 0.30, 0.006)),
        Baseline(
            "3_FGY_GVC_share",
            "后向 GVC 生产总份额",
            "share",
            -0.45,
            (0.30, 0.30, 0.006),
            derived=("3_FGY_GVC", "FGY"),
        ),
        Baseline(
            "3a_VA_GVC_S_share",
            "简单 GVC 生产份额",
            "share",
            -0.30,
            (0.15, 0.20, 0.005),
            derived=("3a_VA_GVC_S", "SVA"),
        ),
        Baseline("2_VA_RT_share", "传统贸易生产份额", "share", -0.30, (0.10, 0.15, 0.004), derived=("2_VA_RT", "SVA")),
        Baseline("1_VA_D_share", "纯国内生产份额", "share", 0.50, (0.40, 0.35, 0.006), derived=("1_VA_D", "SVA")),
    ),
    "length": (
        Baseline("PLv_GVC", "前向 GVC 段长度", "length", -1.8, (3.0, 2.0, 0.030)),
        Baseline("PLy_GVC", "后向 GVC 段长度", "length", -1.5, (3.0, 2.0, 0.030)),
        Baseline("GVCPs", "GVC 位置指数", "position", -0.40, (-0.30, 0.60, 0.010)),
    ),
    "network": (
        Baseline("weighted_degree", "加权总度", "network", -4000.0, (1000.0, 3000.0, 40.0), source="weighted degree"),
        Baseline(
            "weighted_indegree", "加权入度", "network", -2000.0, (500.0, 1500.0, 20.0), source="weighted indegree"
        ),
        Baseline(
            "weighted_outdegree", "加权出度", "network", -2000.0, (500.0, 1500.0, 20.0), source="weighted outdegree"
        ),
        Baseline("betweenesscentrality", "网络介数（全正边二值）", "network", -6000.0, (2000.0, 2000.0, 60.0)),
        Baseline("closnesscentrality", "接近中心性", "network", -0.50, (0.30, 0.40, 0.005)),
    ),
}


def default_baseline(outcome: str) -> Baseline:
    if outcome not in BASELINES:
        raise ValueError(f"outcome 必须是 {list(BASELINES)}")
    return BASELINES[outcome][0]


def baseline(outcome: str, key: str | None = None) -> Baseline:
    """The baseline ``key`` of ``outcome``'s family (its default when ``key`` is None)."""
    if key is None:
        return default_baseline(outcome)
    for item in BASELINES.get(outcome, ()):
        if item.key == key:
            return item
    raise ValueError(f"{outcome} 没有名为 {key} 的生成基线")


def y_column(outcome: str, key: str | None = None) -> str:
    item = baseline(outcome, key)
    return f"teaching_y_{outcome}" if item is default_baseline(outcome) else f"teaching_y_{outcome}_{item.key}"


def sources_present(item: Baseline, columns) -> bool:
    """Whether a release panel carries what this baseline is calibrated from."""
    names = set(columns)
    return set(item.derived).issubset(names) if item.derived else item.column in names


def available_baselines(outcome: str, columns) -> list[Baseline]:
    """The family's default plus every alternative whose generated Y column is in ``columns``."""
    names = set(columns)
    return [item for item in BASELINES[outcome] if y_column(outcome, item.key) in names]


def baseline_options(outcome: str, columns=None) -> list[dict[str, object]]:
    """What a page may offer as Y for one family: key, label, unit, kind and the generated column.

    With ``columns`` (a teaching panel's columns) only the baselines that panel carries are listed.
    """
    items = BASELINES[outcome] if columns is None else tuple(available_baselines(outcome, columns))
    return [
        {
            "key": item.key,
            "label": item.label,
            "kind": item.kind,
            "unit": item.unit,
            "default": index == 0,
            "column": y_column(outcome, item.key),
            "source": item.column,
        }
        for index, item in enumerate(items)
    ]


def baseline_parameters() -> dict[str, list[dict[str, object]]]:
    """Every family's baselines with their preset relation, for the release contract."""
    return {
        outcome: [
            {
                "key": item.key,
                "label": item.label,
                "kind": item.kind,
                "source": item.column,
                "derived": list(item.derived) if item.derived else None,
                "beta": item.beta,
                "calibration": list(item.calibration),
            }
            for item in items
        ]
        for outcome, items in BASELINES.items()
    }


def baseline_snapshots(builder: Callable[[str, str], T]) -> dict[str, T]:
    """``builder(outcome, key)`` for every alternative (non-default) baseline, keyed ``outcome:key``."""
    return {
        f"{outcome}:{item.key}": builder(outcome, item.key)
        for outcome, items in BASELINES.items()
        for item in items[1:]
    }


Y_COLUMNS = {outcome: y_column(outcome) for outcome in OUTCOMES}
BETAS = {outcome: default_baseline(outcome).beta for outcome in OUTCOMES}
CALIBRATION = {outcome: default_baseline(outcome).calibration for outcome in OUTCOMES}
UNITS = {outcome: default_baseline(outcome).unit for outcome in OUTCOMES}


def _unit_number(value: str, salt: str, seed: int = SEED) -> float:
    raw = hashlib.sha256(f"{RANDOMIZATION_VERSION}|{seed}|{salt}|{value}".encode()).digest()
    return int.from_bytes(raw[:8], "big") / (2**64 - 1)


def _noise_salt(outcome: str, item: Baseline) -> str:
    # The default Y keeps its v1–v3 draws; every alternative baseline gets its own independent draws.
    return outcome if item is default_baseline(outcome) else f"{outcome}:{item.key}"


def _baseline_column(outcome: str, item: Baseline) -> str:
    return f"_baseline_{outcome}_{item.key}"


def build_teaching_panel(release_panel: pd.DataFrame, exposure: pd.DataFrame, *, seed: int = SEED) -> pd.DataFrame:
    """Join fixed pre-policy destination shares and generate separate, bounded Y.

    Missing or signed/out-of-domain source observations are ineligible, not filled
    or clipped. Rank calibration is explicitly a teaching construction, not an
    estimate of the actual trajectory. Hash noise is independent of row ordering.
    Eligibility is decided by the default baselines (unchanged since v1); an alternative
    baseline that is out of domain for a unit leaves that unit's alternative Y missing,
    which the regression then reports as dropped rows. The default baselines' sources are
    required; an alternative whose sources the panel lacks is left out (a release insists on
    all of them, see gvcsim.pipeline).
    """
    all_baselines = [
        (outcome, item)
        for outcome, items in BASELINES.items()
        for item in items
        if item is items[0] or sources_present(item, release_panel.columns)
    ]
    source_columns = sorted({item.column for _, item in all_baselines if item.derived is None})
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
    for _, item in all_baselines:
        if item.derived:
            numerator, denominator = item.derived
            base[item.column] = (base[numerator] / base[denominator]).where(base[denominator] > 0)
    default_columns = [default_baseline(outcome).column for outcome in OUTCOMES]
    finite = np.isfinite(base[default_columns].to_numpy(dtype=float)).all(axis=1)
    eligible = finite & base.teaching_export_share_w.between(0, 1)
    for outcome in OUTCOMES:
        item = default_baseline(outcome)
        eligible &= item.in_domain(base[item.column])
    base = base.loc[eligible].copy()
    if base.empty:
        raise ValueError("无有效冲击前指标与目的地份额，无法生成教学面板")
    baseline_columns = []
    for outcome, item in all_baselines:
        low, span, _ = item.calibration
        values = base[item.column].where(item.in_domain(base[item.column]))
        # Percentile ranks among the units whose source value is valid; invalid units stay missing.
        base[_baseline_column(outcome, item)] = low + span * values.rank(method="average", pct=True)
        baseline_columns.append(_baseline_column(outcome, item))
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
    individual = entities + "|" + out.year.astype(str)
    cluster = out.country.astype(str) + "|" + out.year.astype(str)
    trend = out.year.map(dict(zip(years, (-0.4, -0.2, 0.0, 0.2, 0.4), strict=True)))
    for outcome, item in all_baselines:
        salt = _noise_salt(outcome, item)
        noise_scale = item.calibration[2]
        # Include country-year noise so clustered uncertainty is meaningful.
        noise = individual.map(lambda value, salt=salt: 2 * _unit_number(value, salt, seed) - 1)
        noise += cluster.map(lambda value, salt=salt: 2 * _unit_number(value, f"cluster-{salt}", seed) - 1)
        target = y_column(outcome, item.key)
        out[target] = out[_baseline_column(outcome, item)] + item.beta * out[X_COLUMN] + noise_scale * (noise + trend)
    return out.drop(columns=baseline_columns)


def variable_catalog(outcome: str, baseline_key: str | None = None) -> list[dict[str, str]]:
    item = baseline(outcome, baseline_key)
    return [
        {
            "name": X_COLUMN,
            "label": "关税暴露强度",
            "unit": "比例（展示为百分点）",
            "source": "首年销往美国的 ICIO 出口份额 × 课程税率路径",
            "role": "X",
        },
        {
            "name": y_column(outcome, item.key),
            "label": item.label,
            "unit": item.unit,
            "source": f"按首年指标 {item.column} 的排名校准生成",
            "role": "Y",
            "baseline": item.key,
        },
    ]


def model_snapshot(outcome: str, baseline_key: str | None = None) -> dict:
    item = baseline(outcome, baseline_key)
    return {
        "version": VERSION,
        "randomization_version": RANDOMIZATION_VERSION,
        "x_columns": [X_COLUMN],
        "y_column": y_column(outcome, item.key),
        "baseline": item.key,
        "baseline_label": item.label,
        "baseline_source": item.column,
        "baseline_kind": item.kind,
        "entity": "entity_id",
        "time": "year",
        "fixed_effects": ["entity_id", "year"],
        "controls": [],
        "interactions": [],
        "seed": SEED,
        "beta": item.beta,
        "tariff_path": list(TARIFF_PATH),
        "market": MARKET,
        "calibration": item.calibration,
        "disclaimer": DISCLAIMER,
    }


def group_trends(panel: pd.DataFrame) -> dict:
    """Mean change of each simulated Y for taxed vs untaxed countries, relative to the pre-policy years.

    This is the descriptive comparison behind the TWFE estimate: after the fictional tariff
    starts, does the taxed group's Y move away from the untaxed group's Y? Countries are grouped by
    whether their simulated tariff is ever positive; each group's line is its yearly mean minus its
    own pre-policy mean, so different baseline levels do not hide the post-policy gap.
    ``outcomes`` holds each family's default Y; ``series`` holds every baseline of every family.
    """
    years = sorted(int(year) for year in panel["year"].unique())
    rates = panel.groupby("year")["teaching_tariff_rate_tau"].max()
    policy_years = [year for year in years if rates.get(year, 0) > 0]
    if not policy_years:
        raise ValueError("关税面板没有加税年份")
    policy_year = policy_years[0]
    pre_years = [year for year in years if year < policy_year]
    taxed_country = panel.groupby("country")["teaching_tariff_rate_tau"].transform("max").gt(0)
    group = np.where(taxed_country, "taxed", "untaxed")

    def trend_of(column: str) -> dict[str, list[dict[str, float | int]]]:
        means = panel.groupby([group, "year"])[column].mean()
        series: dict[str, list[dict[str, float | int]]] = {}
        for name in ("taxed", "untaxed"):
            if name not in means.index.get_level_values(0):
                series[name] = []
                continue
            values = means.loc[name]
            base = float(values.loc[pre_years].mean())
            series[name] = [{"year": int(year), "change": float(values.loc[year] - base)} for year in years]
        return series

    outcomes = {outcome: trend_of(Y_COLUMNS[outcome]) for outcome in OUTCOMES}
    series = {
        outcome: {
            item.key: trend_of(y_column(outcome, item.key)) for item in available_baselines(outcome, panel.columns)
        }
        for outcome in OUTCOMES
    }
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
        "baselines": {outcome: baseline_options(outcome, panel.columns) for outcome in OUTCOMES},
        "series": series,
    }
