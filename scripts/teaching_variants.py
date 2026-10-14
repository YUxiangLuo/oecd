#!/usr/bin/env python3
"""Rebuild the teaching panel under candidate generator settings and show what the steps 11–14 experiments would read.

A variant overrides a few constants of gvcsim.regression.teaching (the GDP and openness confounders, the GDP growth
paths, the exchange-rate depreciation, the common year trend, calibration floors) while the panel is built from the release's source panel and exposure
weights by the production generator; nothing else changes. The estimates come from the production estimator. This is
the reproduction path for docs/regression-steps-11-14-optimization-final-2026-10-14.md.

Run from the repository root:

    PYTHONPATH=. uv run python scripts/teaching_variants.py list
    PYTHONPATH=. uv run python scripts/teaching_variants.py table --variant v12 --variant v13
    PYTHONPATH=. uv run python scripts/teaching_variants.py seeds --variant v13 --seeds 1 2 3

``table`` prints, per variant and per Y, the two-year total of the named model settings (偏差 = estimate size relative to
β, + overstated), the three-group trend in the last year, the generation-rule decomposition of the first wave's change,
the domain check and the sanity checks (60/40 split, L2.X and the null controls read as zero, the library benchmark).
``seeds`` repeats the default / no-exchange-rate / no-GDP fits on other noise seeds.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import json
import sys
from collections.abc import Iterator
from typing import Any

import numpy as np
import pandas as pd

from gvcsim import config
from gvcsim.regression import teaching
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.panel import run_design_with_benchmark
from gvcsim.regression.spec import DEFAULT_SPEC, ModelSpec


@dataclasses.dataclass(frozen=True)
class Variant:
    """One generator setting. The defaults are the published generator (v13 = the document's P17)."""

    key: str
    title: str
    gdp_gamma: float = 0.5
    wave1_extra_growth: float = 0.04
    common_growth: float = 0.015
    fx_depreciation: float = -8.0
    openness_gamma: float = -0.006
    wave1_openness_rise: float = 4.0
    year_trend: tuple[float, ...] = (0.0, 0.0, -4.0, 2.0, -4.0)
    # Calibration floors (``low``) by baseline key; span and noise scale stay.
    lows: tuple[tuple[str, float], ...] = ()


# v12's floors; v13 raised seven of them so the lowest-ranked units stay in their domains once the three
# same-direction terms (tariff, depreciation, GDP) add up (P9/P11 in the document).
V12_LOWS = (
    ("FVA_share", 0.25),
    ("3b_VA_GVC_C_share", 0.14),
    ("3a_VA_GVC_S_share", 0.12),
    ("2_VA_RT_share", 0.10),
    ("weighted_indegree", 650.0),
    ("weighted_outdegree", 650.0),
    ("betweenesscentrality", 2000.0),
)
V12_TREND = (-0.4, -0.2, 0.0, 0.2, 0.4)
# The v12 generator, and the candidates the document explored on the way from it to v13 (P17), each spelled out in
# full so the table stays reproducible whatever the published defaults become.
V12 = dict(
    gdp_gamma=0.08,
    wave1_extra_growth=0.012,
    common_growth=0.025,
    fx_depreciation=-6.0,
    openness_gamma=0.0015,
    wave1_openness_rise=2.0,
    year_trend=V12_TREND,
    lows=V12_LOWS,
)
VARIANTS: dict[str, Variant] = {
    item.key: item
    for item in (
        Variant("v12", "v12（2026-10-14 之前的发布）", **V12),
        Variant(
            "P1", "v12 + GDP 反向 γ=−0.5，第一批增长差 3%/年", **{**V12, "gdp_gamma": -0.5, "wave1_extra_growth": 0.03}
        ),
        Variant(
            "P4", "v12 + GDP 同向 γ=+0.5，第一批增长差 3%/年", **{**V12, "gdp_gamma": 0.5, "wave1_extra_growth": 0.03}
        ),
        Variant(
            "P9",
            "P4 + 校准下限上调",
            **{**V12, "gdp_gamma": 0.5, "wave1_extra_growth": 0.03, "lows": ()},
        ),
        Variant(
            "P11",
            "P9 + 共同 GDP 增长 1.5%/年",
            **{**V12, "gdp_gamma": 0.5, "wave1_extra_growth": 0.03, "common_growth": 0.015, "lows": ()},
        ),
        Variant(
            "P12",
            "γ=+0.4，第一批增长差 3%/年，校准下限上调",
            **{**V12, "gdp_gamma": 0.4, "wave1_extra_growth": 0.03, "lows": ()},
        ),
        Variant(
            "P13",
            "P11 + 开放度反向混杂（γ=−0.006，第一批每年 +4）",
            gdp_gamma=0.5,
            wave1_extra_growth=0.03,
            fx_depreciation=-6.0,
            year_trend=V12_TREND,
        ),
        Variant(
            "P14",
            "P11 + 共同年份台阶（2018 起 −4 噪声单位）",
            gdp_gamma=0.5,
            wave1_extra_growth=0.03,
            fx_depreciation=-6.0,
            openness_gamma=0.0015,
            wave1_openness_rise=2.0,
            year_trend=(0.0, 0.0, -4.0, -4.0, -4.0),
        ),
        Variant(
            "P15",
            "P11 + 共同年份锯齿（0, 0, −4, +2, −4）",
            gdp_gamma=0.5,
            wave1_extra_growth=0.03,
            fx_depreciation=-6.0,
            openness_gamma=0.0015,
            wave1_openness_rise=2.0,
        ),
        Variant("P16", "P13 + 共同年份锯齿", gdp_gamma=0.5, wave1_extra_growth=0.03, fx_depreciation=-6.0),
        Variant("v13", "v13 = P17：P16 + 汇率贬值 8、第一批增长差 4%/年（当前发布）"),
    )
}
VARIANTS["P17"] = VARIANTS["v13"]


# The model settings a page names (presets) and the two the document discusses besides them.
SETTINGS: dict[str, ModelSpec] = {}


def _settings() -> dict[str, ModelSpec]:
    if SETTINGS:
        return SETTINGS
    controls = DEFAULT_SPEC.controls
    effects = DEFAULT_SPEC.fixed_effects

    def without(*names: str) -> tuple[tuple[str, int], ...]:
        return tuple(item for item in controls if item[0] not in names)

    SETTINGS.update(
        {
            "默认": DEFAULT_SPEC,
            "去掉汇率": ModelSpec((0, 1), without(teaching.EXCHANGE_RATE_COLUMN), effects),
            "去掉GDP": ModelSpec((0, 1), without(teaching.GDP_COLUMN), effects),
            "去掉开放度": ModelSpec((0, 1), without(teaching.OPENNESS_COLUMN), effects),
            "只放当期X": ModelSpec((0,), controls, effects),
            "去掉年份FE": ModelSpec((0, 1), controls, ("country_industry",)),
            "国家+行业+年份": ModelSpec((0, 1), controls, ("country", "industry", "year")),
            "国家×年份FE": ModelSpec((0, 1), controls, ("country_industry", "country_year")),
            "加人口FDI": ModelSpec(
                (0, 1), (*controls, (teaching.POPULATION_COLUMN, 0), (teaching.FDI_COLUMN, 0)), effects
            ),
            "加L2.X": ModelSpec((0, 1, 2), controls, effects),
            "无FE": ModelSpec((0, 1), controls, ()),
        }
    )
    return SETTINGS


# The Ys the document follows: the four default Ys, the zero-effect Y and one identity Y.
YS: tuple[tuple[str, str], ...] = (
    ("trade", "FVA_share"),
    ("production", "3b_VA_GVC_C_share"),
    ("length", "PLv_GVC"),
    ("network", "weighted_degree"),
    ("production", "3b_FGY_GVC_C_share"),
    ("production", "1_VA_D_share"),
)


@contextlib.contextmanager
def applied(variant: Variant) -> Iterator[None]:
    """Patch the generator's constants for the variant and restore them afterwards."""
    saved = {
        "gamma": teaching.MACRO_CONTROLS[teaching.GDP_COLUMN]["gamma_factor"],
        "wave1": teaching.WAVE1_EXTRA_GDP_GROWTH,
        "common": teaching.COMMON_GDP_GROWTH,
        "fx": teaching.EXCHANGE_RATE_DEPRECIATION,
        "openness_gamma": teaching.MACRO_CONTROLS[teaching.OPENNESS_COLUMN]["gamma_factor"],
        "openness_rise": teaching.WAVE1_OPENNESS_RISE,
        "year_trend": teaching.COMMON_YEAR_TREND,
        "baselines": dict(teaching.BASELINES),
    }
    lows = dict(variant.lows)
    try:
        teaching.MACRO_CONTROLS[teaching.GDP_COLUMN]["gamma_factor"] = variant.gdp_gamma
        teaching.WAVE1_EXTRA_GDP_GROWTH = variant.wave1_extra_growth
        teaching.COMMON_GDP_GROWTH = variant.common_growth
        teaching.EXCHANGE_RATE_DEPRECIATION = variant.fx_depreciation
        teaching.MACRO_CONTROLS[teaching.OPENNESS_COLUMN]["gamma_factor"] = variant.openness_gamma
        teaching.WAVE1_OPENNESS_RISE = variant.wave1_openness_rise
        teaching.COMMON_YEAR_TREND = variant.year_trend
        for outcome, items in saved["baselines"].items():
            teaching.BASELINES[outcome] = tuple(
                dataclasses.replace(item, calibration=(lows[item.key], item.calibration[1], item.calibration[2]))
                if item.key in lows
                else item
                for item in items
            )
        yield
    finally:
        teaching.MACRO_CONTROLS[teaching.GDP_COLUMN]["gamma_factor"] = saved["gamma"]
        teaching.WAVE1_EXTRA_GDP_GROWTH = saved["wave1"]
        teaching.COMMON_GDP_GROWTH = saved["common"]
        teaching.EXCHANGE_RATE_DEPRECIATION = saved["fx"]
        teaching.MACRO_CONTROLS[teaching.OPENNESS_COLUMN]["gamma_factor"] = saved["openness_gamma"]
        teaching.WAVE1_OPENNESS_RISE = saved["openness_rise"]
        teaching.COMMON_YEAR_TREND = saved["year_trend"]
        teaching.BASELINES.clear()
        teaching.BASELINES.update(saved["baselines"])


def source_tables() -> tuple[pd.DataFrame, pd.DataFrame]:
    root = config.PROCESSED_DIR.resolve()
    source = pd.read_csv(root / "panel_industry.csv", float_precision="round_trip")
    years = sorted(int(year) for year in source.year.unique())
    exposure = pd.read_csv(root / f"export_exposure_{years[0]}.csv")
    return source, exposure


def build_panel(variant: Variant, seed: int = teaching.SEED) -> pd.DataFrame:
    """The teaching panel the variant would publish. The panel is complete once built; checks that read the generator's
    constants afterwards (``generated_problems``, ``group_trends``, ``decomposition``) run inside ``applied(variant)``."""
    source, exposure = source_tables()
    with applied(variant):
        return teaching.build_teaching_panel(source, exposure, seed=seed)


def _coef(payload: dict[str, Any], name: str) -> dict[str, Any] | None:
    return next((item for item in payload["coefs"] if item["name"] == name), None)


def _contains(stat: dict[str, Any] | None, target: float) -> bool:
    return bool(stat and stat.get("ci_low") is not None and stat["ci_low"] <= target <= stat["ci_high"])


def _rel(value: float, beta: float) -> float:
    """Estimate size relative to β (+ overstated, − understated; a sign flip counts as fully understated and more)."""
    return (
        (abs(value) - abs(beta)) / abs(beta)
        if np.sign(value) == np.sign(beta)
        else -(abs(value) + abs(beta)) / abs(beta)
    )


def fit(panel: pd.DataFrame, outcome: str, key: str, spec: ModelSpec) -> tuple[dict[str, Any], dict[str, Any]]:
    result, benchmark = run_design_with_benchmark(
        panel, RegressionDesign(outcome, teaching=True, baseline=key, spec=spec)
    )
    return result.to_dict(), benchmark


def decomposition(panel: pd.DataFrame, outcome: str, key: str) -> dict[str, float]:
    """The first wave's last-year change by the generation rule's terms (what F3 in the document would print)."""
    item = teaching.baseline(outcome, key)
    beta = item.beta
    if beta is None:
        return {}
    years = sorted(int(year) for year in panel.year.unique())
    first = panel[teaching.WAVE_COLUMN].eq(1)
    pre = panel.year.lt(teaching.wave_start_years(years[0])[1])
    last = panel.year.eq(years[-1])
    gdp = teaching.MACRO_CONTROLS[teaching.GDP_COLUMN]["gamma_factor"]
    openness = teaching.MACRO_CONTROLS[teaching.OPENNESS_COLUMN]["gamma_factor"]
    terms = {
        "关税 X": beta
        * (
            teaching.LAG_SHARES[0] * panel[teaching.X_COLUMN]
            + teaching.LAG_SHARES[1] * panel[teaching.X_LAG_COLUMNS[1]]
        ),
        "汇率": teaching.EXCHANGE_RATE_GAMMA_FACTOR * beta * panel[teaching.EXCHANGE_RATE_COLUMN],
        "GDP": beta * gdp * panel[teaching.GDP_COLUMN],
        "开放度": beta * openness * panel[teaching.OPENNESS_COLUMN],
    }
    return {name: float(series[first & last].mean() - series[first & pre].mean()) for name, series in terms.items()}


def evaluate_variant(variant: Variant, seed: int = teaching.SEED) -> dict[str, Any]:
    source, exposure = source_tables()
    with applied(variant):
        panel = teaching.build_teaching_panel(source, exposure, seed=seed)
        problems = teaching.generated_problems(panel)
        trends = teaching.group_trends(panel)
        out: dict[str, Any] = {
            "variant": variant.key,
            "title": variant.title,
            "seed": seed,
            "problems": problems,
            "ys": {},
        }
        for outcome, key in YS:
            item = teaching.baseline(outcome, key)
            beta = item.beta
            series = trends["series"][outcome][key]
            entry: dict[str, Any] = {
                "beta": beta,
                "trend_last_year": {group: series[group][-1]["change"] for group in ("first", "second", "untaxed")},
                "decomposition": decomposition(panel, outcome, key),
                "settings": {},
            }
            for name, spec in _settings().items():
                payload, benchmark = fit(panel, outcome, key, spec)
                total = payload["cumulative"] or _coef(payload, teaching.X_COLUMN)
                cell: dict[str, Any] = {
                    "coef": total["coef"],
                    "ci_low": total["ci_low"],
                    "ci_high": total["ci_high"],
                    "rel": None if not beta else _rel(total["coef"], beta),
                    "contains_beta": _contains(total, beta) if beta is not None else None,
                    "benchmark_passed": bool(benchmark.get("coef_check_passed")),
                }
                if name == "默认":
                    x0, x1 = _coef(payload, teaching.X_COLUMN), _coef(payload, teaching.X_LAG_COLUMNS[1])
                    cell["split_ok"] = (
                        None
                        if not beta
                        else _contains(x0, teaching.LAG_SHARES[0] * beta)
                        and _contains(x1, teaching.LAG_SHARES[1] * beta)
                    )
                    cell["n_obs"] = payload["n_obs"]
                if name == "加L2.X":
                    cell["l2_contains_zero"] = _contains(_coef(payload, teaching.X_LAG_COLUMNS[2]), 0.0)
                if name == "加人口FDI":
                    cell["null_controls_contain_zero"] = all(
                        _contains(_coef(payload, column), 0.0)
                        for column in (teaching.POPULATION_COLUMN, teaching.FDI_COLUMN)
                    )
                entry["settings"][name] = cell
            out["ys"][key] = entry
    return out


def _fmt(value: float, kind_hint: float | None) -> str:
    return f"{value:+,.0f}" if kind_hint is not None and abs(kind_hint) >= 100 else f"{value:+.4g}"


def print_table(summary: dict[str, Any]) -> None:
    print(f"\n## {summary['variant']} · {summary['title']} · seed {summary['seed']}")
    print(f"定义域检查：{'；'.join(summary['problems']) if summary['problems'] else '通过'}")
    names = list(_settings())
    print("\n| Y（β） | " + " | ".join(names) + " |")
    print("|" + " --- |" * (len(names) + 1))
    for key, entry in summary["ys"].items():
        beta = entry["beta"]
        cells = []
        for name in names:
            cell = entry["settings"][name]
            text = _fmt(cell["coef"], beta)
            if cell["rel"] is not None:
                text += f" ({cell['rel']:+.0%})"
            cells.append(text)
        print(f"| {key}（{beta if beta is not None else '比值'}） | " + " | ".join(cells) + " |")
    print(
        "\n| Y | 走势图最后一年：第一批 / 第二批 / 未加税 | 第一批的变化按生成规则拆分 | 默认恢复 β | 60/40 | L2.X 含 0 | 人口 FDI 含 0 | 库对照 |"
    )
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for key, entry in summary["ys"].items():
        beta = entry["beta"]
        trend = entry["trend_last_year"]
        parts = entry["decomposition"]
        default = entry["settings"]["默认"]
        print(
            f"| {key} | {_fmt(trend['first'], beta)} / {_fmt(trend['second'], beta)} / {_fmt(trend['untaxed'], beta)} | "
            + ("、".join(f"{name} {_fmt(value, beta)}" for name, value in parts.items()) if parts else "—")
            + f" | {'✓' if default['contains_beta'] else ('—' if beta is None else '✗')}"
            + f" | {'✓' if default['split_ok'] else ('—' if default['split_ok'] is None else '✗')}"
            + f" | {'✓' if entry['settings']['加L2.X']['l2_contains_zero'] else '✗'}"
            + f" | {'✓' if entry['settings']['加人口FDI']['null_controls_contain_zero'] else '✗'}"
            + f" | {'✓' if all(cell['benchmark_passed'] for cell in entry['settings'].values()) else '✗'} |"
        )


def command_table(args: argparse.Namespace) -> None:
    results = []
    for key in args.variant:
        summary = evaluate_variant(VARIANTS[key], seed=args.seed)
        print_table(summary)
        results.append(summary)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(results, handle, ensure_ascii=False, indent=1)


def command_seeds(args: argparse.Namespace) -> None:
    variant = VARIANTS[args.variant]
    source, exposure = source_tables()
    settings = _settings()
    print(f"\n## {variant.key} · {variant.title} · seeds {args.seeds}")
    print("\n| 种子 | Y | 默认（含 β） | 去掉汇率 | 去掉GDP | 定义域 |")
    print("| --- | --- | --- | --- | --- | --- |")
    for seed in args.seeds:
        with applied(variant):
            panel = teaching.build_teaching_panel(source, exposure, seed=seed)
            problems = teaching.generated_problems(panel)
            for outcome, key in YS[:5]:
                beta = teaching.baseline(outcome, key).beta
                cells = []
                for name in ("默认", "去掉汇率", "去掉GDP"):
                    payload, _ = fit(panel, outcome, key, settings[name])
                    total = payload["cumulative"]
                    text = _fmt(total["coef"], beta)
                    if beta:
                        text += f" ({_rel(total['coef'], beta):+.0%})"
                    if name == "默认" and beta is not None:
                        text += " ✓" if _contains(total, beta) else " ✗"
                    cells.append(text)
                print(
                    f"| {seed} | {key} | "
                    + " | ".join(cells)
                    + f" | {'通过' if not problems else '；'.join(problems)} |"
                )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list")
    table = sub.add_parser("table")
    table.add_argument("--variant", action="append", required=True, choices=list(VARIANTS))
    table.add_argument("--seed", type=int, default=teaching.SEED)
    table.add_argument("--json")
    seeds = sub.add_parser("seeds")
    seeds.add_argument("--variant", required=True, choices=list(VARIANTS))
    seeds.add_argument("--seeds", type=int, nargs="+", default=[1, 2, 3])
    args = parser.parse_args()
    if args.command == "list":
        for item in VARIANTS.values():
            print(
                f"{item.key}: {item.title} (γ_GDP={item.gdp_gamma}, 第一批增长差={item.wave1_extra_growth}, 共同增长={item.common_growth}, 贬值={item.fx_depreciation}, 下限={dict(item.lows) or '不变'})"
            )
    elif args.command == "table":
        command_table(args)
    else:
        command_seeds(args)


if __name__ == "__main__":
    sys.exit(main())
