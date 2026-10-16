"""Versioned fictional tariff experiment; observed ICIO columns remain untouched."""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypeVar, cast

import numpy as np
import pandas as pd

# v3 (2026-10-06): the simulated tariff rises from 10% to 25% so the taxed/untaxed gap is visible on the
# group chart (about two to three within-unit standard deviations instead of one).
# v4 (2026-10-06): each family gains alternative generation baselines (other real indicators of the same
# family) with their own preset relation; the default Y of every family is unchanged from v3.
# v5 (2026-10-07): the families mirror the shares steps 6-9 single out (traditional-trade and backward GVC
# shares added, the foreign double-counting share dropped) and the network family follows step 9: its
# fixed Y is the weighted degree, with in/out degree, betweenness and closeness as alternatives.
# v6 (2026-10-09): accounting identities hold across a family's Ys (the forward production shares add up to 1,
# the GVC total is simple + complex, weighted degree is in + out), so their estimates add up exactly; the GVC
# position index sits near 1; a backward complex-GVC share with no preset relation (β = 0) shows an interval that
# can include 0; and the imposing market (USA) is left out of the regression sample.
# v7 (2026-10-09): the taxed countries are no longer drawn at random. They are the sample economies whose goods
# trade surplus with the market (USA) was at least TAXED_SURPLUS_MIN in the first year, computed from the ICIO
# bilateral flows (goods = ICIO sectors A, B and C), so "who is taxed" follows the logic of the 2018 tariffs and can
# be checked against the data. The rate stays one flat 25% from the third year.
# v8 (2026-10-10): the tariff falls on goods only. In a taxed country τ is 25% for its goods industries (ICIO
# sectors A, B and C) and 0 for its service industries, so a service industry's X is 0 whatever its exports to the
# market; the taxed list, w and the noise draws are unchanged from v7.
# v10 (2026-10-10, docs/regression-refactor-20261010.md): designed so each choice in the steps 11–14 model workbench
# shows a result. The tariff falls in two waves (first-year goods surplus with the market ≥ 10 bn USD from the third
# year, 1–10 bn from the fourth; the 2020 X is v8's); a tariff's relation shows 60% in its year and 40% the next
# (β is the cumulative relation, v8's values); a generated exchange-rate change (first-wave economies depreciate from
# the third year) moves every Y in the tariff's direction, so a model that leaves it out overstates the relation.
# Lags of X are written from the schedule (exact zeros before the first tariff). The generated domestic-VA export
# share is calibrated lower so it and the FVA share stay within gross exports, and in/out degree higher so weighted
# degree stays non-negative with the exchange-rate term. The noise draws are v8's. (v9 was an abandoned attempt.)
# v11: country-year macro controls have separate, deterministic innovations. GDP and openness enter Y;
# population growth and FDI are negative controls. These are teaching constructions, not WDI observations.
# v12: position is the ratio of generated lengths, not an independently drawn linear outcome.
# v13 (2026-10-14, docs/regression-steps-11-14-optimization-final-2026-10-14.md): every control and fixed-effect
# change a student can make moves the estimate visibly. GDP's relation is 0.5·β with first-wave economies growing 4%
# a year faster (leaving GDP out overstates, like the exchange rate); openness relates by −0.006·β with first-wave
# openness rising 4 points a year (leaving it out understates); the common year trend is a zigzag (0, 0, −4, +2, −4
# noise units) that no control absorbs (leaving the year effects out understates); the depreciation is 8 points; seven
# calibration floors are raised so the lowest-ranked units stay in their domains. Noise draws, β, 60/40 and the tariff
# are v12's.
VERSION = "step10-tariff-teaching-v13"
# Seeds the noise draws only (policy assignment is a data rule since v7); changing it would redraw every Y.
RANDOMIZATION_VERSION = "step10-tariff-teaching-v1"
X_COLUMN = "teaching_tariff_exposure"
# Lags of X by year: w × τ(t − k), from the tariff schedule.
X_LAG_COLUMNS = {0: X_COLUMN, 1: f"{X_COLUMN}_lag1", 2: f"{X_COLUMN}_lag2"}
OUTCOMES = ("trade", "production", "length", "network")
SEED = 20260913
MARKET = "USA"
TARIFF_RATE = 0.25
# First-year goods trade surplus with the market, in ICIO units (million USD), from which a country is taxed, and
# from which it is in the first wave.
TAXED_SURPLUS_MIN = 1000.0
FIRST_WAVE_SURPLUS_MIN = 10000.0
SURPLUS_COLUMN = "teaching_market_goods_surplus"
# 0 untaxed, 1 first wave, 2 second wave.
WAVE_COLUMN = "teaching_tariff_wave"
# Start of each wave as an offset from the first release year (2018 and 2019 for the 2016–2020 release).
WAVE_START_OFFSETS = {1: 2, 2: 3}
TAXED_RULE = {
    "basis": "first-year goods trade surplus with the market (ICIO sectors A-C)",
    "min_million_usd": TAXED_SURPLUS_MIN,
    "scope": "goods industries (ICIO sectors A-C)",
    "rate": TARIFF_RATE,
    "waves": [
        {"wave": 1, "min_million_usd": FIRST_WAVE_SURPLUS_MIN, "start_year_offset": WAVE_START_OFFSETS[1]},
        {"wave": 2, "min_million_usd": TAXED_SURPLUS_MIN, "start_year_offset": WAVE_START_OFFSETS[2]},
    ],
}
# Share of a tariff's relation that shows in its year and in the next; the cumulative relation is β.
LAG_SHARES = (0.6, 0.4)
# Common year changes in noise-scale units: a zigzag (2018 down, 2019 up, 2020 down) that is not a function of the
# trending controls, so only the year effects remove it.
COMMON_YEAR_TREND = (0.0, 0.0, -4.0, 2.0, -4.0)
EXCHANGE_RATE_COLUMN = "teaching_exchange_rate_change"
# Exchange-rate change in percentage points (negative = depreciation): country × year uniform noise with this SD,
# plus this depreciation for first-wave economies from the first wave's start. Each Y moves by factor × β per point,
# in the tariff's direction (depreciation makes imported inputs dearer), so leaving it out overstates the relation.
EXCHANGE_RATE_NOISE_SD = 1.0
EXCHANGE_RATE_DEPRECIATION = -8.0
EXCHANGE_RATE_GAMMA_FACTOR = -0.0095
EXCHANGE_RATE = {
    "column": EXCHANGE_RATE_COLUMN,
    "unit": "percentage points; negative = depreciation",
    "noise_sd": EXCHANGE_RATE_NOISE_SD,
    "first_wave_depreciation": EXCHANGE_RATE_DEPRECIATION,
    "gamma_factor": EXCHANGE_RATE_GAMMA_FACTOR,
}
GDP_COLUMN = "teaching_log_gdp"
POPULATION_COLUMN = "teaching_population_growth"
OPENNESS_COLUMN = "teaching_trade_openness"
FDI_COLUMN = "teaching_fdi_gdp"
# Simulated GDP: every country's log GDP grows by COMMON_GDP_GROWTH a year; first-wave economies grow by
# WAVE1_EXTRA_GDP_GROWTH a year more from the first year on (a pre-existing path correlated with the tariff: a confounder).
COMMON_GDP_GROWTH = 0.015
WAVE1_EXTRA_GDP_GROWTH = 0.04
# Simulated trade openness (percent of GDP): a country level plus this rise a year for first-wave economies.
WAVE1_OPENNESS_RISE = 4.0
# Each Y moves by gamma_factor × β per unit of the control's change from its country level. GDP's factor is positive
# (faster growth moves Y the way the tariff does: leaving GDP out overstates the relation); openness's is negative
# (rising openness moves Y against the tariff: leaving it out understates). Population growth and FDI do not enter Y.
MACRO_CONTROLS = {
    GDP_COLUMN: {"unit": "ln(USD)", "gamma_factor": 0.5},
    POPULATION_COLUMN: {"unit": "percent per year", "gamma_factor": 0.0},
    OPENNESS_COLUMN: {"unit": "exports plus imports / GDP, percent", "gamma_factor": -0.006},
    FDI_COLUMN: {"unit": "net inflows / GDP, percent", "gamma_factor": 0.0},
}
DISCLAIMER = "课程关税实验数据集：X、模拟宏观控制变量与各 Y 按课程数据契约生成，不是 OECD 发布结果。"
# What students and readers see (step 10, the step 11–14 result card and the report); DISCLAIMER above is
# the release contract value. The frontend keeps the same sentence in regression-lessons.ts.
# Short: step 10 shows it before any control variable is introduced, so it names none of them.
GENERATED_DATA_NOTE = "关税情景、控制变量和步骤 11–14 的 Y 都由课程生成，用来练习建模，不是真实政策效应或官方统计；少数按 ICIO 计算的控制变量另有标注。"
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
    so ordering is preserved but observed levels are not. ``derived`` names (numerator, denominator)
    release columns for a share the release panel does not carry itself.

    ``combine`` makes the Y an exact linear combination of other Ys of the same family,
    constant + Σ coefficient × Y[key], instead of a drawn one, so an accounting identity holds row by row and
    the estimates add up exactly; ``beta`` is then the implied relation and ``calibration`` is unused.
    A ``derived`` numerator may be several release columns, summed. A ``hidden`` baseline is a drawn part of an
    identity only: the panel carries it, but it is not a Y a page or a regression may choose.
    """

    key: str
    label: str
    kind: str
    beta: float | None
    calibration: tuple[float, float, float]
    source: str | None = None
    derived: tuple[str | tuple[str, ...], str] | None = None
    combine: tuple[float, tuple[tuple[str, float], ...]] | None = None
    # Nonlinear identity: no constant linear generation coefficient exists.
    ratio: tuple[str, str] | None = None
    hidden: bool = False
    # A source that is a signed account (it can be slightly negative) is only ranked, so any finite value is valid;
    # the generated Y keeps its kind's domain.
    signed_source: bool = False

    @property
    def derived_columns(self) -> tuple[str, ...]:
        """Release columns a derived share is computed from (numerator parts, then the denominator)."""
        if not self.derived:
            return ()
        numerator, denominator = self.derived
        return (*((numerator,) if isinstance(numerator, str) else numerator), denominator)

    @property
    def column(self) -> str:
        return self.source or self.key

    @property
    def unit(self) -> str:
        return KIND_UNITS[self.kind]

    def source_valid(self, values: pd.Series) -> pd.Series:
        """Whether a source value may calibrate this Y (its kind's domain, or any finite value if signed)."""
        if self.signed_source:
            return pd.Series(np.isfinite(values.to_numpy(dtype=float)), index=values.index)
        return self.in_domain(values)

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
    # v10: the domestic-VA export share is 1 − FVA share − the other parts' share (returned domestic VA, double
    # counting, taxes), so the two shares never exceed gross exports; its relation is the FVA share's, reversed.
    "trade": (
        Baseline("FVA_share", "外国增加值项占比", "share", -0.55, (0.27, 0.30, 0.006)),
        Baseline(
            "DVAex_share",
            "国内增加值出口占比",
            "share",
            0.55,
            (0.0, 0.0, 0.0),
            derived=("DVAex", "gross_exports"),
            combine=(1.0, (("FVA_share", -1.0), ("trade_rest_share", -1.0))),
        ),
        Baseline(
            "trade_rest_share",
            "出口中的其余项占比（返回国内、重复计算与产品税）",
            "share",
            0.0,
            (0.02, 0.12, 0.002),
            derived=(("DVArt", "DDC", "FDC", "taxsub"), "gross_exports"),
            hidden=True,
            # taxsub is signed, so a few units' other-parts share is slightly negative: still a valid ranking.
            signed_source=True,
        ),
    ),
    # Forward shares: 3a, 3b and RT are drawn; the GVC total and the pure-domestic share follow from them, so
    # 纯国内 + 传统贸易 + 简单 GVC + 复杂 GVC = 1 and GVC = 简单 + 复杂 in every row (levels chosen so 纯国内 stays
    # inside (0, 1) at the largest exposure).
    "production": (
        Baseline("3b_VA_GVC_C_share", "复杂 GVC 生产份额", "share", -0.40, (0.19, 0.16, 0.005)),
        Baseline(
            "3_VA_GVC_share",
            "前向 GVC 生产总份额",
            "share",
            -0.70,
            (0.0, 0.0, 0.0),
            combine=(0.0, (("3a_VA_GVC_S_share", 1.0), ("3b_VA_GVC_C_share", 1.0))),
        ),
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
            (0.14, 0.14, 0.005),
            derived=("3a_VA_GVC_S", "SVA"),
        ),
        Baseline("2_VA_RT_share", "传统贸易生产份额", "share", -0.30, (0.14, 0.12, 0.004), derived=("2_VA_RT", "SVA")),
        Baseline(
            "1_VA_D_share",
            "纯国内生产份额",
            "share",
            1.00,
            (0.0, 0.0, 0.0),
            derived=("1_VA_D", "SVA"),
            combine=(1.0, (("3a_VA_GVC_S_share", -1.0), ("3b_VA_GVC_C_share", -1.0), ("2_VA_RT_share", -1.0))),
        ),
        # No preset relation: its 95% interval can include 0 (the reading steps 11–14 teach).
        Baseline(
            "3b_FGY_GVC_C_share",
            "后向复杂 GVC 生产份额",
            "share",
            0.0,
            (0.10, 0.20, 0.006),
            derived=("3b_FGY_GVC_C", "FGY"),
        ),
    ),
    "length": (
        Baseline("PLv_GVC", "前向 GVC 段长度", "length", -1.8, (3.0, 2.0, 0.030)),
        Baseline("PLy_GVC", "后向 GVC 段长度", "length", -1.5, (3.0, 2.0, 0.030)),
        Baseline("GVCPs", "GVC 位置指数", "position", None, (0.0, 0.0, 0.0), ratio=("PLv_GVC", "PLy_GVC")),
    ),
    # Weighted degree is in-degree + out-degree in every row.
    "network": (
        Baseline(
            "weighted_degree",
            "加权总度",
            "network",
            -4000.0,
            (0.0, 0.0, 0.0),
            source="weighted degree",
            combine=(0.0, (("weighted_indegree", 1.0), ("weighted_outdegree", 1.0))),
        ),
        Baseline(
            "weighted_indegree", "加权入度", "network", -2000.0, (1000.0, 1500.0, 20.0), source="weighted indegree"
        ),
        Baseline(
            "weighted_outdegree", "加权出度", "network", -2000.0, (1000.0, 1500.0, 20.0), source="weighted outdegree"
        ),
        Baseline("betweenesscentrality", "网络介数（全正边二值）", "network", -6000.0, (3000.0, 2000.0, 60.0)),
        Baseline("closnesscentrality", "接近中心性", "network", -0.50, (0.30, 0.40, 0.005)),
    ),
}


def default_baseline(outcome: str) -> Baseline:
    if outcome not in BASELINES:
        raise ValueError(f"outcome 必须是 {list(BASELINES)}")
    return BASELINES[outcome][0]


def selectable_baselines(outcome: str) -> tuple[Baseline, ...]:
    """The family's Ys a page or a regression may choose (hidden parts of identities left out)."""
    return tuple(item for item in BASELINES.get(outcome, ()) if not item.hidden)


def baseline(outcome: str, key: str | None = None, *, allow_hidden: bool = False) -> Baseline:
    """The baseline ``key`` of ``outcome``'s family (its default when ``key`` is None); a hidden part of an identity
    only with ``allow_hidden``."""
    if key is None:
        return default_baseline(outcome)
    for item in BASELINES.get(outcome, ()):
        if item.key == key and (allow_hidden or not item.hidden):
            return item
    raise ValueError("不提供的 Y 生成基线")


def y_column(outcome: str, key: str | None = None) -> str:
    item = baseline(outcome, key, allow_hidden=True)
    return f"teaching_y_{outcome}" if item is default_baseline(outcome) else f"teaching_y_{outcome}_{item.key}"


def sources_present(item: Baseline, columns) -> bool:
    """Whether a release panel carries what this baseline is calibrated from."""
    names = set(columns)
    if item.ratio:
        return set(item.ratio).issubset(names)
    return set(item.derived_columns).issubset(names) if item.derived else item.column in names


def available_baselines(outcome: str, columns) -> list[Baseline]:
    """The family's default plus every alternative whose generated Y column is in ``columns`` (hidden parts aside)."""
    names = set(columns)
    return [item for item in BASELINES[outcome] if not item.hidden and y_column(outcome, item.key) in names]


def baseline_options(outcome: str, columns=None) -> list[dict[str, object]]:
    """What a page may offer as Y for one family: key, label, unit, kind and the generated column.

    With ``columns`` (a teaching panel's columns) only the baselines that panel carries are listed.
    """
    items = (
        tuple(item for item in BASELINES[outcome] if not item.hidden)
        if columns is None
        else tuple(available_baselines(outcome, columns))
    )
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
                "derived": [list(part) if isinstance(part, tuple) else part for part in item.derived]
                if item.derived
                else None,
                "hidden": item.hidden,
                "beta": item.beta,
                "calibration": list(item.calibration),
                "ratio": list(item.ratio) if item.ratio else None,
                "combine": (
                    {"constant": item.combine[0], "terms": [[key, coef] for key, coef in item.combine[1]]}
                    if item.combine
                    else None
                ),
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
        if not item.hidden
    }


Y_COLUMNS = {outcome: y_column(outcome) for outcome in OUTCOMES}
BETAS = {outcome: default_baseline(outcome).beta for outcome in OUTCOMES}
CALIBRATION = {outcome: default_baseline(outcome).calibration for outcome in OUTCOMES}
UNITS = {outcome: default_baseline(outcome).unit for outcome in OUTCOMES}


def simulation_parameters() -> dict:
    """The generator's parameters as a release's ``simulation_contract.parameters`` records them (JSON form)."""
    return {
        "market": MARKET,
        "tariff_rate": TARIFF_RATE,
        "lag_shares": list(LAG_SHARES),
        "exchange_rate": EXCHANGE_RATE,
        "macro_controls": MACRO_CONTROLS,
        "macro_paths": {
            "common_gdp_growth": COMMON_GDP_GROWTH,
            "first_wave_extra_gdp_growth": WAVE1_EXTRA_GDP_GROWTH,
            "first_wave_openness_rise": WAVE1_OPENNESS_RISE,
        },
        "taxed_rule": TAXED_RULE,
        "common_year_trend": {
            "values": list(COMMON_YEAR_TREND),
            "multiplier": "baseline calibration noise scale",
            "order": "ascending release years",
        },
        "betas": BETAS,
        "calibration": {name: list(values) for name, values in CALIBRATION.items()},
        "baselines": baseline_parameters(),
    }


def _unit_number(value: str, salt: str, seed: int = SEED) -> float:
    raw = hashlib.sha256(f"{RANDOMIZATION_VERSION}|{seed}|{salt}|{value}".encode()).digest()
    return int.from_bytes(raw[:8], "big") / (2**64 - 1)


# The Y with no preset relation (β = 0) is the course's example of an interval that includes 0. With the v7 taxed
# countries its first draw happened to land at p ≈ 0.04 (a 1-in-20 outcome for β = 0); the course uses the next
# draw instead (p ≈ 0.41), and the release build checks that the interval still includes 0 (WEAK_Y below).
WEAK_Y = ("production", "3b_FGY_GVC_C_share")
WEAK_Y_DRAW = "|draw2"


def _noise_salt(outcome: str, item: Baseline) -> str:
    # The default Y keeps its v1–v3 draws; every alternative baseline gets its own independent draws.
    if (outcome, item.key) == WEAK_Y:
        return f"{outcome}:{item.key}{WEAK_Y_DRAW}"
    return outcome if item is default_baseline(outcome) else f"{outcome}:{item.key}"


def _baseline_column(outcome: str, item: Baseline) -> str:
    return f"_baseline_{outcome}_{item.key}"


def _is_goods_sector(sector: pd.Series) -> pd.Series:
    """ICIO goods sectors: agriculture (A), mining (B) and manufacturing (C); tariffs fall on goods."""
    return sector.astype(str).str[0].isin(["A", "B", "C"])


def market_goods_surplus(exposure: pd.DataFrame, year: int) -> pd.Series:
    """Each economy's goods trade surplus with the market in ``year``: goods exports to it minus goods imports from
    it, both from the ICIO bilateral flows (``bilateral_exports`` of country→imposer), in million USD."""
    if "bilateral_exports" not in exposure.columns:
        raise ValueError("教学关税缺少双边出口额，无法按对美顺差确定被加税国家")
    rows = exposure.loc[exposure.year.eq(year) & _is_goods_sector(exposure.sector)]
    to_market = rows.loc[rows.imposer.eq(MARKET) & rows.country.ne(MARKET)].groupby("country").bilateral_exports.sum()
    from_market = rows.loc[rows.country.eq(MARKET) & rows.imposer.ne(MARKET)].groupby("imposer").bilateral_exports.sum()
    return to_market.sub(from_market, fill_value=0.0).astype(float)


def tariff_wave(surplus: pd.Series) -> pd.Series:
    """0 untaxed, 1 first wave (surplus ≥ FIRST_WAVE_SURPLUS_MIN), 2 second wave (≥ TAXED_SURPLUS_MIN)."""
    return pd.Series(
        np.where(surplus.ge(FIRST_WAVE_SURPLUS_MIN), 1, np.where(surplus.ge(TAXED_SURPLUS_MIN), 2, 0)),
        index=surplus.index,
        dtype=int,
    )


def wave_start_years(first_year: int) -> dict[int, int]:
    return {wave: first_year + offset for wave, offset in WAVE_START_OFFSETS.items()}


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
    # A default Y computed from others (network: in + out) makes those parts required too.
    required_parts = {
        (outcome, key)
        for outcome in OUTCOMES
        if (item := default_baseline(outcome)).combine
        for key, _ in item.combine[1]
    }
    drawn = {
        (outcome, item.key)
        for outcome, items in BASELINES.items()
        for item in items
        if item.combine is None
        and item.ratio is None
        and (item is items[0] or (outcome, item.key) in required_parts or sources_present(item, release_panel.columns))
    }
    all_baselines = [
        (outcome, item)
        for outcome, items in BASELINES.items()
        for item in items
        if (outcome, item.key) in drawn
        or (item.combine is not None and all((outcome, key) in drawn for key, _ in item.combine[1]))
        or (item.ratio is not None and all((outcome, key) in drawn for key in item.ratio))
    ]
    source_columns = sorted({item.column for _, item in all_baselines if item.derived is None and item.ratio is None})
    required = {"country", "industry", "year", "entity_id", "log_gdp_proxy", *source_columns}
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
    # ROW is not a country; the imposing market exports nothing to itself, so its X would be 0 by construction
    # and it would wrongly serve as an "untaxed" comparison. Both stay out of the sample.
    base = release_panel.loc[
        release_panel.year.eq(years[0]) & release_panel.country.ne("ROW") & release_panel.country.ne(MARKET)
    ].copy()
    base = base.merge(weights, on=["country", "industry"], how="inner", validate="one_to_one")
    for _, item in all_baselines:
        if item.derived and item.combine is None:
            *numerator, denominator = item.derived_columns
            base[item.column] = (base[numerator].sum(axis=1, min_count=len(numerator)) / base[denominator]).where(
                base[denominator] > 0
            )
    default_columns = [default_baseline(outcome).column for outcome in OUTCOMES]
    finite = np.isfinite(base[default_columns].to_numpy(dtype=float)).all(axis=1)
    eligible = finite & base.teaching_export_share_w.between(0, 1)
    for outcome in OUTCOMES:
        item = default_baseline(outcome)
        eligible &= item.source_valid(base[item.column])
    # A default computed from parts needs every part valid, or the default Y would be missing for that unit.
    for outcome, key in required_parts:
        part = baseline(outcome, key, allow_hidden=True)
        eligible &= part.source_valid(base[part.column])
    base = base.loc[eligible].copy()
    if base.empty:
        raise ValueError("无有效冲击前指标与目的地份额，无法生成教学面板")
    baseline_columns = []
    for outcome, item in all_baselines:
        if item.combine is not None or item.ratio is not None:
            continue
        low, span, _ = item.calibration
        values = base[item.column].where(item.source_valid(base[item.column]))
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
    # Taxed = a first-year goods surplus with the market of at least TAXED_SURPLUS_MIN (a data rule, not a draw), in
    # two waves by the size of that surplus; the tariff falls on the taxed countries' goods industries only.
    surplus = market_goods_surplus(exposure, years[0])
    out[SURPLUS_COLUMN] = out.country.map(surplus).fillna(0.0).astype(float)
    out[WAVE_COLUMN] = tariff_wave(out[SURPLUS_COLUMN])
    start = out[WAVE_COLUMN].map(wave_start_years(years[0]))
    goods = _is_goods_sector(out.industry)

    def rate(year: pd.Series) -> pd.Series:
        """τ in ``year`` (rows whose wave has not started, services and untaxed countries: 0)."""
        return TARIFF_RATE * (goods & start.notna() & year.ge(start)).astype(float)

    out["teaching_tariff_rate_tau"] = rate(out.year)
    for lag, column in X_LAG_COLUMNS.items():
        out[column] = out.teaching_export_share_w * rate(out.year - lag)
    out["teaching_treated"] = out[X_COLUMN].gt(0).astype(int)
    individual = entities + "|" + out.year.astype(str)
    cluster = out.country.astype(str) + "|" + out.year.astype(str)
    first_wave_start = wave_start_years(years[0])[1]
    out[EXCHANGE_RATE_COLUMN] = cluster.map(
        lambda value: (2 * _unit_number(value, "exchange-rate", seed) - 1) * EXCHANGE_RATE_NOISE_SD * 3**0.5
    ) + EXCHANGE_RATE_DEPRECIATION * (out[WAVE_COLUMN].eq(1) & out.year.ge(first_wave_start))
    # GDP is anchored to first-year national VA, not to an industry's scale. No policy outcome is used to
    # generate controls. A pre-existing, wave-correlated growth path is a confounder, not a response to tariffs.
    anchors = release_panel.loc[release_panel.year.eq(years[0]), ["country", "log_gdp_proxy"]].drop_duplicates()
    if anchors.country.duplicated().any() or not np.isfinite(anchors.log_gdp_proxy).all():
        raise ValueError("GDP 教学校准要求每国唯一且有限的首年增加值总额对数")
    gdp_base = out.country.map(anchors.set_index("country").log_gdp_proxy) + np.log(1_000_000.0)
    t = out.year - years[0]

    def draw(keys: pd.Series, salt: str) -> pd.Series:
        return keys.map(lambda value: 2 * _unit_number(value, salt, seed) - 1)

    growth = (
        COMMON_GDP_GROWTH * t
        + WAVE1_EXTRA_GDP_GROWTH * t * out[WAVE_COLUMN].eq(1)
        + 0.025 * draw(cluster, "macro-growth")
    )
    openness_base = 80 + 45 * draw(out.country, "openness-level")
    out[GDP_COLUMN] = gdp_base + growth
    out[POPULATION_COLUMN] = (
        0.8 + 1.2 * draw(out.country, "population-level") + 0.5 * draw(cluster, "population-growth")
    )
    out[OPENNESS_COLUMN] = (
        openness_base + WAVE1_OPENNESS_RISE * t * out[WAVE_COLUMN].eq(1) + 4 * draw(cluster, "openness")
    )
    out[FDI_COLUMN] = 2 + 3 * draw(out.country, "fdi-level") + 4 * draw(cluster, "fdi-flow")
    macro_effect = MACRO_CONTROLS[GDP_COLUMN]["gamma_factor"] * (out[GDP_COLUMN] - gdp_base) + MACRO_CONTROLS[
        OPENNESS_COLUMN
    ]["gamma_factor"] * (out[OPENNESS_COLUMN] - openness_base)
    effect = LAG_SHARES[0] * out[X_LAG_COLUMNS[0]] + LAG_SHARES[1] * out[X_LAG_COLUMNS[1]]
    trend = out.year.map(dict(zip(years, COMMON_YEAR_TREND, strict=True)))
    generated: dict[str, pd.Series] = {}
    for outcome, item in all_baselines:
        if item.combine is not None or item.ratio is not None:
            continue
        assert item.beta is not None
        salt = _noise_salt(outcome, item)
        noise_scale = item.calibration[2]
        # Include country-year noise so clustered uncertainty is meaningful.
        noise = individual.map(lambda value, salt=salt: 2 * _unit_number(value, salt, seed) - 1)
        noise += cluster.map(lambda value, salt=salt: 2 * _unit_number(value, f"cluster-{salt}", seed) - 1)
        target = y_column(outcome, item.key)
        generated[target] = (
            out[_baseline_column(outcome, item)]
            + item.beta * effect
            + EXCHANGE_RATE_GAMMA_FACTOR * item.beta * out[EXCHANGE_RATE_COLUMN]
            + item.beta * macro_effect
            + noise_scale * (noise + trend)
        )
    # Identity Ys are computed from the drawn ones, row by row (missing when any part is missing).
    for outcome, item in all_baselines:
        if item.ratio is not None:
            numerator, denominator = (generated[y_column(outcome, key)] for key in item.ratio)
            generated[y_column(outcome, item.key)] = numerator / denominator.where(denominator.gt(0))
            continue
        if item.combine is None:
            continue
        constant, terms = item.combine
        combined = pd.Series(constant, index=out.index, dtype=float)
        for key, coefficient in terms:
            combined = combined + coefficient * generated[y_column(outcome, key)]
        generated[y_column(outcome, item.key)] = combined
    # Added in one step (not column by column) and in BASELINES order, so the panel's columns stay stable.
    ordered = [y_column(outcome, item.key) for outcome, item in all_baselines]
    return pd.concat(
        [out.drop(columns=baseline_columns), pd.DataFrame({name: generated[name] for name in ordered})], axis=1
    )


def _combine_text(outcome: str, item: Baseline) -> str:
    """ "1 − 简单 GVC 生产份额 − 复杂 GVC 生产份额 − 传统贸易生产份额" for a Y computed from others."""
    assert item.combine is not None
    constant, terms = item.combine
    parts = [f"{constant:g}"] if constant else []
    for key, coefficient in terms:
        label = baseline(outcome, key, allow_hidden=True).label
        sign = "+" if coefficient > 0 else "−"
        parts.append(f"{sign} {label}" if parts else (label if coefficient > 0 else f"−{label}"))
    return " ".join(parts)


def variable_catalog(outcome: str, baseline_key: str | None = None, spec: Any = None) -> list[dict[str, str]]:
    """The variables of a model (``spec``: a ModelSpec; None is the course default): its X terms, controls and Y."""
    from gvcsim.regression.spec import CONTROLS, DEFAULT_SPEC, control_column, control_term_label

    item = baseline(outcome, baseline_key)
    model = (spec or DEFAULT_SPEC).canonical()
    entries: list[dict[str, str]] = [
        {
            "name": X_LAG_COLUMNS[lag],
            "label": "关税暴露强度" if lag == 0 else f"关税暴露强度（滞后 {lag} 期）",
            "unit": "比例（展示为百分点）",
            "source": "首年销往美国的 ICIO 出口份额 × 课程税率（两批加征）",
            "role": "X",
        }
        for lag in model.x_lags
    ]
    entries += [
        {
            "name": control_column(key, lag),
            "label": control_term_label(key, lag),
            "unit": CONTROLS[key].definition,
            "source": "课程生成" if CONTROLS[key].source == "generated" else "按 ICIO 计算",
            "role": "control",
        }
        for key, lag in model.controls
    ]
    entries.append(
        {
            "name": y_column(outcome, item.key),
            "label": item.label,
            "unit": item.unit,
            "source": (
                "由模拟前向 GVC 段长度 ÷ 模拟后向 GVC 段长度计算；没有预设的恒定线性系数"
                if item.ratio
                else "由同家族其他 Y 按核算恒等式算出：" + _combine_text(outcome, item)
                if item.combine
                else f"按首年指标 {item.column} 的排名校准生成"
            ),
            "role": "Y",
            "baseline": item.key,
        }
    )
    return entries


# How a model's fixed effects are named in its snapshot (the classic pair keeps its column names).
_SNAPSHOT_EFFECTS = {
    "country": "country",
    "industry": "industry",
    "country_industry": "entity_id",
    "year": "year",
    "country_year": "country_year",
}


def model_snapshot(outcome: str, baseline_key: str | None = None, spec: Any = None) -> dict:
    """The published model of a run (``spec``: a ModelSpec; None is the course default) and the generator's
    parameters, so a saved run can be checked against the release it came from."""
    from gvcsim.regression.spec import DEFAULT_SPEC

    item = baseline(outcome, baseline_key)
    model = (spec or DEFAULT_SPEC).canonical()
    return {
        "version": VERSION,
        "randomization_version": RANDOMIZATION_VERSION,
        "x_columns": model.x_columns,
        "y_column": y_column(outcome, item.key),
        "baseline": item.key,
        "baseline_label": item.label,
        "baseline_source": item.column,
        "baseline_kind": item.kind,
        "entity": "entity_id",
        "time": "year",
        "fixed_effects": [_SNAPSHOT_EFFECTS[key] for key in model.fixed_effects],
        "controls": model.control_columns,
        "interactions": [],
        "spec": model.to_dict(),
        "seed": SEED,
        "beta": item.beta,
        "ratio": list(item.ratio) if item.ratio else None,
        "lag_shares": list(LAG_SHARES),
        "tariff_rate": TARIFF_RATE,
        "market": MARKET,
        "taxed_rule": TAXED_RULE,
        "exchange_rate": EXCHANGE_RATE,
        "macro_controls": MACRO_CONTROLS,
        "calibration": item.calibration,
        "common_year_trend": list(COMMON_YEAR_TREND),
        "disclaimer": DISCLAIMER,
    }


def generated_problems(panel: pd.DataFrame) -> list[str]:
    """Rows where a generated Y leaves its domain, or the two trade shares exceed gross exports (release build check).

    Shares must lie in [0, 1], lengths be positive, network values non-negative; FVA + DVAex shares ≤ 1.
    """
    problems = []
    for outcome, items in BASELINES.items():
        for item in items:
            column = y_column(outcome, item.key)
            if column not in panel:
                continue
            values = panel[column].dropna()
            bad = int((~item.in_domain(values)).sum())
            if bad:
                problems.append(f"{column}: {bad} 行越出定义域（{item.unit}）")
    fva, dva = y_column("trade"), y_column("trade", "DVAex_share")
    if fva in panel and dva in panel:
        total = (panel[fva] + panel[dva]).dropna()
        over = int(total.gt(1 + 1e-12).sum())
        if over:
            problems.append(f"外国增加值项占比 + 国内增加值出口占比：{over} 行超过 1（最大 {float(total.max()):.4f}）")
    return problems


def _taxed_countries(panel: pd.DataFrame) -> pd.Series:
    """Per row, whether its country is on the taxed list. The data rule decides, not τ: since v8 a taxed country's
    services have τ = 0, so a country whose sampled industries are all services is still taxed. A panel without the
    surplus column (before v7) falls back to the country's highest τ."""
    if SURPLUS_COLUMN in panel.columns:
        return panel[SURPLUS_COLUMN].ge(TAXED_SURPLUS_MIN)
    return panel.groupby("country")["teaching_tariff_rate_tau"].transform("max").gt(0)


def _waves(panel: pd.DataFrame) -> pd.Series:
    """Per row, its country's tariff wave (0 untaxed). A panel without the wave column (before v10) had one wave."""
    if WAVE_COLUMN in panel.columns:
        return panel[WAVE_COLUMN].astype(int)
    return _taxed_countries(panel).astype(int)


def _wave_starts_present(panel: pd.DataFrame, years: list[int]) -> tuple[pd.Series, dict[int, int], list[int]]:
    waves = _waves(panel)
    starts = wave_start_years(years[0])
    present = sorted({starts[int(wave)] for wave in waves.unique() if int(wave) in starts})
    return waves, starts, present


def country_exposure_overview(panel: pd.DataFrame) -> dict:
    """Every sample country's tariff exposure in the last year: what step 10 shows before any single example.

    The tariff falls on goods (v8), so ``mean_exposure`` and ``max_exposure`` are over the country's goods
    industries in the sample (``goods_industries``; one flat τ in the last year, so mean X = mean w × τ; untaxed
    countries are 0); ``industries`` counts all its industries in the sample, services included (their X is always 0);
    ``exposed_industries`` counts the industries with X > 0 (a taxed goods industry with w = 0 has X = 0).
    ``wave``/``start_year`` say when the country's tariff starts (v10: two waves). The imposing market is not in the
    sample and is reported separately.
    """
    years = sorted(int(year) for year in panel["year"].unique())
    last = years[-1]
    rows = panel.loc[panel["year"].eq(last)]
    taxed = _taxed_countries(panel).groupby(panel["country"]).max()
    waves, starts, present = _wave_starts_present(panel, years)
    country_wave = waves.groupby(panel["country"]).max()
    goods = rows.loc[_is_goods_sector(rows["industry"])].groupby("country")[X_COLUMN]
    goods_values = {str(country): values for country, values in goods}
    empty = pd.Series(dtype=float)
    grouped = rows.groupby("country")[X_COLUMN]
    countries = []
    for country, values in grouped:
        wave = int(country_wave.get(country, 0))
        countries.append(
            {
                "country": str(country),
                "taxed": bool(taxed.get(country, False)),
                "wave": wave,
                "start_year": starts.get(wave),
                "mean_exposure": float(goods_values.get(str(country), empty).mean())
                if str(country) in goods_values
                else 0.0,
                "max_exposure": float(goods_values.get(str(country), empty).max())
                if str(country) in goods_values
                else 0.0,
                "industries": int(values.size),
                "goods_industries": int(goods_values.get(str(country), empty).size),
                "exposed_industries": int(values.gt(0).sum()),
                "market_goods_surplus": (
                    float(rows.loc[rows.country.eq(country), SURPLUS_COLUMN].iloc[0])
                    if SURPLUS_COLUMN in rows
                    else None
                ),
            }
        )
    countries.sort(key=lambda item: (-float(cast(float, item["mean_exposure"])), str(item["country"])))
    return {
        "version": VERSION,
        "year": last,
        "market": MARKET,
        "tariff_rate": TARIFF_RATE,
        "policy_year": present[0] if present else None,
        "policy_years": present,
        "waves": [
            {
                "wave": wave,
                "start_year": starts[wave],
                "min_million_usd": FIRST_WAVE_SURPLUS_MIN if wave == 1 else TAXED_SURPLUS_MIN,
                "countries": sum(1 for item in countries if item["wave"] == wave),
            }
            for wave in sorted(starts)
        ],
        "taxed_rule": {**TAXED_RULE, "year": years[0]},
        "taxed_countries": sum(1 for item in countries if item["taxed"]),
        "untaxed_countries": sum(1 for item in countries if not item["taxed"]),
        "entities": int(rows[["country", "industry"]].drop_duplicates().shape[0]),
        "countries": countries,
    }


def first_wave_decomposition(panel: pd.DataFrame, depvar: str, coefs: dict[str, float]) -> dict | None:
    """What a fitted model says the first wave's change in Y since before its tariff is made of.

    For the first-wave rows, the mean of Y in the last year minus its mean before the first tariff year (what the
    three-group chart shows), and each regressor's share of it: its coefficient times the same change in that
    regressor (X terms summed into one part). The remainder is what the model's fixed effects and residual carry: the
    year changes common to every group, and noise. None when the panel has no first wave or no pre-period.
    """
    columns = getattr(panel, "columns", None)
    if columns is None or not {"year", "entity_id", WAVE_COLUMN, SURPLUS_COLUMN, depvar}.issubset(columns):
        return None
    years = sorted(int(year) for year in panel["year"].unique())
    try:
        waves, _, present = _wave_starts_present(panel, years)
    except (KeyError, ValueError):
        return None
    if not present:
        return None
    start = wave_start_years(years[0]).get(1)
    first = waves.eq(1)
    if start is None or not first.any():
        return None
    ordered = panel.sort_values(["entity_id", "year"])
    pre = ordered.year.lt(start) & first.loc[ordered.index]
    last = ordered.year.eq(years[-1]) & first.loc[ordered.index]
    if not pre.any() or not last.any():
        return None

    def series(name: str) -> pd.Series | None:
        if name in ordered.columns:
            return ordered[name]
        base, separator, lag = name.partition("__lag")
        if separator and lag == "1" and base in ordered.columns:
            return ordered.groupby("entity_id")[base].shift(1)
        return None

    def change(values: pd.Series) -> float:
        return float(values[last].mean() - values[pre].mean())

    from gvcsim.regression.spec import control_term_label

    def label(name: str) -> str:
        base, separator, lag = name.partition("__lag")
        try:
            return control_term_label(base, int(lag) if separator else 0)
        except (KeyError, ValueError):
            return name

    observed = change(ordered[depvar])
    x_part = 0.0
    explained = 0.0
    parts: list[dict[str, float | str]] = []
    for name, coef in coefs.items():
        values = series(name)
        if values is None:
            continue
        contribution = coef * change(values)
        explained += contribution
        if name in X_LAG_COLUMNS.values():
            x_part += contribution
        else:
            parts.append({"name": name, "label": label(name), "change": contribution})
    terms: list[dict[str, float | str]] = [{"name": "x_terms", "label": "关税 X", "change": x_part}, *parts]
    return {
        "group": "first",
        "wave_start": int(start),
        "year": years[-1],
        "pre_years": [year for year in years if year < start],
        "observed": observed,
        "terms": terms,
        "remainder": observed - explained,
    }


def group_trends(panel: pd.DataFrame) -> dict:
    """Mean change of each simulated Y for the first wave, the second wave and the untaxed countries, each relative
    to its own mean before the first tariff year (so different baseline levels do not hide the gaps).

    This is the descriptive comparison behind the estimate: after a wave's tariff starts, does its Y move away from
    the untaxed group's Y? ``taxed`` pools both waves (the two-line chart before v10). ``outcomes`` holds each
    family's default Y; ``series`` holds every baseline of every family.
    """
    years = sorted(int(year) for year in panel["year"].unique())
    waves, _, present = _wave_starts_present(panel, years)
    if not present:
        raise ValueError("关税面板没有加税年份")
    policy_year = present[0]
    pre_years = [year for year in years if year < policy_year]
    taxed_country = _taxed_countries(panel)
    by_wave = np.select([waves.eq(1), waves.eq(2)], ["first", "second"], "untaxed")
    pooled = np.where(taxed_country, "taxed", "untaxed")

    def trend_of(column: str) -> dict[str, list[dict[str, float | int]]]:
        means = {
            "waves": panel.groupby([by_wave, "year"])[column].mean(),
            "pooled": panel.groupby([pooled, "year"])[column].mean(),
        }
        series: dict[str, list[dict[str, float | int]]] = {}
        for name, source in (("first", "waves"), ("second", "waves"), ("untaxed", "waves"), ("taxed", "pooled")):
            frame = means[source]
            if name not in frame.index.get_level_values(0):
                series[name] = []
                continue
            values = frame.loc[name]
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
    # Mean exposure of taxed-country units in the tariff years (kept for the two-line chart before v10).
    policy_rows = panel.loc[taxed_country & panel["year"].ge(policy_year), X_COLUMN]
    mean_exposure_taxed = float(policy_rows.mean()) if len(policy_rows) else 0.0
    return {
        "version": VERSION,
        "years": years,
        "policy_year": policy_year,
        "policy_years": present,
        "sample": {
            "rows": int(len(panel)),
            "entities": int(panel["entity_id"].nunique()),
            "countries": int(panel["country"].nunique()),
            "industries": int(panel["industry"].nunique()),
            "taxed_countries": int(countries[0]),
            "untaxed_countries": int(countries[1]),
            "first_wave_countries": int(panel.loc[waves.eq(1), "country"].nunique()),
            "second_wave_countries": int(panel.loc[waves.eq(2), "country"].nunique()),
        },
        # Industries with at least one retained unit: step 10 offers only these as examples.
        "industries": sorted(str(code) for code in panel["industry"].unique()),
        "mean_exposure_taxed": mean_exposure_taxed,
        "outcomes": outcomes,
        "baselines": {outcome: baseline_options(outcome, panel.columns) for outcome in OUTCOMES},
        "series": series,
    }
