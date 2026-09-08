"""Second review: independent counterexamples and negative controls, read-only.

OPENBLAS_NUM_THREADS=4 PYTHONPATH=. uv run python scripts/reconfirm_economics_20260908.py
This does not generate or activate a release, or connect to any database.
"""

from __future__ import annotations

import json
import sys
from unittest.mock import patch

import numpy as np
import pandas as pd
from fastapi import HTTPException
from linearmodels.panel import PanelOLS

from gvcsim import config, regression_routes, shocks
from gvcsim.data import loader
from gvcsim.regression import panel
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.transforms import _apply_price_mode
from gvcsim.shock_catalog import EVENTS, TariffEvent, composite_imposer_members
from scripts.review_economics_20260908 import local_release, macro_and_price_witness, small_io
from gvcsim.indicators.core import build_arrays


def covariance_countercheck():
    """Use a full dummy-variable regression, not another within transformation."""
    cases = []
    original_fit = PanelOLS.fit

    def matched_fit(self, *args, **kwargs):
        return original_fit(self, *args, **{**kwargs, "group_debias": True})

    for groups, sectors, unbalanced in ((20, 1, False), (20, 1, True), (20, 3, False), (76, 1, False)):
        rng = np.random.default_rng(151)
        rows = []
        for country in range(groups):
            for sector in range(sectors):
                for year in range(2016, 2021):
                    x = (0.04 + 0.015 * rng.random()) * (year >= 2018)
                    y = 0.2 + 0.01 * country + 0.02 * sector + 0.004 * (year - 2016) + 0.3 * x + rng.normal(0, 0.005)
                    if unbalanced and country % 3 == 0 and year == 2020:
                        continue
                    rows.append(
                        {
                            "country": f"C{country:02d}",
                            "entity_id": f"C{country:02d}_{sector}",
                            "year": year,
                            "tariff_shock": x,
                            "treated": int(x > 0),
                            "FVA_share": y,
                        }
                    )
        frame = pd.DataFrame(rows)
        design = RegressionDesign(
            "trade", granularity="country" if sectors == 1 else "country_industry", method="twfe_intensity"
        )
        model = panel.prepare_design_model(frame, design)
        own = panel._within_ols(model)
        current, benchmark = panel.run_design_with_benchmark(frame, design)
        data = model.data
        X = np.column_stack(
            (
                np.ones(len(data)),
                data.tariff_shock,
                pd.get_dummies(data[model.entity], drop_first=True, dtype=float),
                pd.get_dummies(data.year, drop_first=True, dtype=float),
            )
        )
        y = data[model.depvar].to_numpy()
        beta, _, rank, _ = np.linalg.lstsq(X, y, rcond=None)
        residual = y - X @ beta
        bread = np.linalg.inv(X.T @ X)
        scores = np.array([X[data.country.eq(c)].T @ residual[data.country.eq(c)] for c in data.country.unique()])
        correction = groups / (groups - 1) * (len(data) - 1) / (len(data) - rank)
        covariance = correction * bread @ (scores.T @ scores) @ bread
        dummy_se = float(np.sqrt(covariance[1, 1]))
        with patch.object(PanelOLS, "fit", matched_fit):
            matched, matched_benchmark = panel.run_design_with_benchmark(frame, design)
        term = benchmark["policy_coefs"][0]
        predicted_se_ratio = np.sqrt(groups / (groups - 1) * (len(data) - 1) / len(data))
        assert model.support.status == "ok"
        assert abs(own.coefs[0].coef - beta[1]) < 1e-10
        assert abs(own.coefs[0].se - dummy_se) < 1e-10
        assert abs(term["own_se"] / term["panelols_se"] - predicted_se_ratio) < 1e-10
        assert matched.status == "ok" and matched_benchmark["benchmark_passed"]
        cases.append(
            {
                "clusters": groups,
                "sectors_per_country": sectors,
                "unbalanced": unbalanced,
                "observations": len(data),
                "full_design_rank": int(rank),
                "status_before_benchmark": model.support.status,
                "status_after_benchmark": current.status,
                "own_se": own.coefs[0].se,
                "dummy_ols_cr1_se": dummy_se,
                "current_panelols_se": term["panelols_se"],
                "predicted_se_ratio": float(predicted_se_ratio),
                "status_with_same_group_correction": matched.status,
                "matched_max_abs_se_difference": matched_benchmark["max_abs_se_diff"],
            }
        )
    return cases


def independent_raw_exposures():
    """Sum original CSV rows by destination, without loading old exposure artifacts."""
    frames = []
    for year in range(2016, 2021):
        print(f"Reconfirm: reading original ICIO {year}", file=sys.stderr, flush=True)
        raw = pd.read_csv(loader._source_csv(year), index_col=0)
        raw = raw.loc[raw.index.astype(str).str.contains("_")]
        names = [str(label).split("_", 1) for label in raw.index]
        countries = sorted({name[0] for name in names})
        destinations = np.array([str(column).split("_", 1)[0] for column in raw.columns])
        values = raw.to_numpy(dtype=float)
        positive_flows = np.column_stack([values[:, destinations == c].sum(axis=1) for c in countries])
        origin = np.array([name[0] for name in names])
        for i, c in enumerate(countries):
            positive_flows[origin == c, i] = 0
        positive_flows = np.maximum(positive_flows, 0)
        totals = positive_flows.sum(axis=1)
        flows_by_destination = {c: positive_flows[:, i] for i, c in enumerate(countries)}
        for composite, members in composite_imposer_members(year).items():
            flows_by_destination[composite] = positive_flows[
                :, [i for i, c in enumerate(countries) if c in members]
            ].sum(axis=1)
        for destination, flow in flows_by_destination.items():
            frame = pd.DataFrame(
                {
                    "country": origin,
                    "sector": [name[1] for name in names],
                    "imposer": destination,
                    "year": year,
                    "bilateral_exports": flow,
                    "total_exports": totals,
                    "export_exposure": np.divide(flow, totals, out=np.zeros(len(flow)), where=totals > 0),
                }
            )
            frames.append(frame)
    return pd.concat(frames, ignore_index=True)


def raw_policy_countercheck(exposure):
    """Enumerate every current catalogue event, including exempt/override schedules."""
    years = list(range(2016, 2021))
    countries = sorted(exposure.country.unique())
    lookup = exposure.set_index(["country", "sector", "imposer", "year"]).export_exposure.to_dict()
    active = []
    for event in EVENTS:
        for country in countries:
            if country in event.exempt:
                continue
            if not (
                (event.targets == "ALL" and country != event.imposer)
                or (event.targets != "ALL" and country in event.targets)
            ):
                continue
            for sector, schedule in event.overrides.get(country, event.rates).items():
                for year, rate in schedule.items():
                    if year in years and rate > 0:
                        active.append((event.name, country, sector, event.imposer, year, rate))
    first = {}
    for _, country, sector, imposer, year, _ in active:
        key = (country, sector, imposer)
        first[key] = min(first.get(key, year), year)
    missed = []
    canada = []
    for name, country, sector, imposer, year, rate in active:
        baseline = max(y for y in years if y < first[country, sector, imposer])
        before = lookup[country, sector, imposer, baseline]
        current = lookup[country, sector, imposer, year]
        if before == 0 and current > 0:
            missed.append(
                {
                    "event": name,
                    "country": country,
                    "sector": sector,
                    "imposer": imposer,
                    "year": year,
                    "baseline_year": baseline,
                    "baseline_exposure": before,
                    "current_exposure": current,
                    "omitted_current_shock": rate * current,
                }
            )
        if country == "CAN" and sector == "C27":
            canada.append(
                {"event": name, "year": year, "fixed_weight": before, "rate": rate, "contribution": rate * before}
            )
    # Test the unmodified production generator using the complete destination grid
    # for C27; also remove only Canada's washer contribution in memory as a control.
    scope = exposure[exposure.sector.eq("C27")].copy()
    generated = shocks.demo_shock_panel(countries, ["C27"], years, scope)
    event_201 = next(event for event in EVENTS if "201保障" in event.name)
    revised = [
        TariffEvent(**{**event.__dict__, "overrides": {**event.overrides, "CAN": {**event.rates, "C27": {}}}})
        if event is event_201
        else event
        for event in EVENTS
    ]
    with patch.object(shocks, "EVENTS", revised):
        counterfactual = shocks.demo_shock_panel(countries, ["C27"], years, scope)
    c24_scope = exposure[exposure.sector.eq("C24")].copy()
    c24_fixed = shocks.demo_shock_panel(countries, ["C24"], years, c24_scope).set_index(["country", "sector", "year"])
    c24_current = shocks.demo_shock_panel(
        countries, ["C24"], years, c24_scope, exposure_mode="contemporaneous"
    ).set_index(["country", "sector", "year"])
    for row in missed:
        key = (row["country"], row["sector"], row["year"])
        row["generator_current_column_in_fixed_mode"] = float(c24_fixed.loc[key, "tariff_shock_contemporaneous"])
        row["generator_current_column_in_current_mode"] = float(c24_current.loc[key, "tariff_shock_contemporaneous"])
        assert row["generator_current_column_in_fixed_mode"] == 0
        assert np.isclose(
            row["generator_current_column_in_current_mode"], row["omitted_current_shock"], rtol=1e-12, atol=1e-15
        )
    differences = c24_current.tariff_shock_contemporaneous - c24_fixed.tariff_shock_contemporaneous
    assert int((differences.abs() > 1e-15).sum()) == len(missed) == 8
    assert not counterfactual.loc[counterfactual.country.eq("CAN"), "treated"].any()
    keep = ["year", "tariff_shock", "treated", "tariff_shock_contemporaneous", "treated_contemporaneous"]
    return {
        "source": "Five original ICIO CSVs, read afresh; no old release exposure files used",
        "exposure_rows": len(exposure),
        "active_event_country_sector_years": len(active),
        "zero_baseline_positive_current_event_cases": missed,
        "unique_affected_entity_years": len({(r["country"], r["sector"], r["year"]) for r in missed}),
        "canada_C27_catalogue_contributions": canada,
        "canada_C27_current_generator": generated.loc[generated.country.eq("CAN"), keep].to_dict("records"),
        "canada_C27_with_washer_exclusion_only": counterfactual.loc[counterfactual.country.eq("CAN"), keep].to_dict(
            "records"
        ),
    }


def zero_exposure_controls():
    rows = []
    event = TariffEvent("Fictional validation event", "USA", ("JPN",), "2018-01-01", "2018-01-01", {"C26": {2018: 0.2}})
    for before, after in ((0, 10), (10, 0), (10, 10), (0, 0)):
        frames = []
        for year, flow in ((2017, before), (2018, after)):
            arr = build_arrays(
                small_io(np.zeros((2, 2)), np.array([[100.0, 0], [float(flow), 100.0]]), ["USA", "JPN"], ["C26"])
            )
            frames.append(shocks.build_export_exposure(arr, year))
        with patch.object(shocks, "EVENTS", [event]):
            result = shocks.demo_shock_panel(
                ["USA", "JPN"], ["C26"], [2017, 2018], pd.concat(frames, ignore_index=True)
            )
        row = result.loc[result.country.eq("JPN") & result.year.eq(2018)].iloc[0]
        public = regression_routes._panel_for_weight_mode(result, RegressionDesign("trade"), "contemporaneous")
        public_row = public.loc[public.country.eq("JPN") & public.year.eq(2018)].iloc[0]
        rows.append(
            {
                "before_export": before,
                "after_export": after,
                "fixed_shock": float(row.tariff_shock),
                "contemporaneous_column": float(row.tariff_shock_contemporaneous),
                "expected_contemporaneous": 0.2 if after > 0 else 0,
                "public_weight_switch_shock": float(public_row.tariff_shock),
            }
        )
    return rows


def growth_and_reachability():
    frame = pd.DataFrame(
        {
            "country": ["AAA"] * 4,
            "industry": ["a", "b", "a", "b"],
            "year": [2016, 2016, 2017, 2017],
            "SVA": [10.0, 90.0, 20.0, 90.0],
            "gross_exports": [10.0, 90.0, 20.0, 90.0],
            "gdp_deflator": [1.0, 1.0, 1.1, 1.1],
        }
    )
    design = RegressionDesign("trade", price_mode="real_2016", control_mode="icio_derived")
    result = []
    for order in ([0, 1, 2, 3], [1, 0, 3, 2]):
        # Reset indices explicitly, ruling out pandas assignment alignment as the
        # cause of the order dependence in the original minimal example.
        altered = _apply_price_mode(frame.iloc[order].reset_index(drop=True), design)
        result.append({"order": order, "growth_2017": altered.loc[altered.year.eq(2017), "gdp_proxy_growth"].tolist()})
    country = frame.groupby(["country", "year"], as_index=False).agg(
        SVA=("SVA", "sum"), gross_exports=("gross_exports", "sum"), gdp_deflator=("gdp_deflator", "first")
    )
    correct_grain = _apply_price_mode(country, design)
    public = []
    for controls, prices in (
        ("none", "nominal"),
        ("icio_derived", "nominal"),
        ("macro_sim", "nominal"),
        ("none", "real_2016"),
    ):
        try:
            regression_routes._validate_design(
                "trade", "country_industry", "tariff", "twfe_intensity", control_mode=controls, price_mode=prices
            )
            public.append({"controls": controls, "price_mode": prices, "accepted": True})
        except HTTPException as exc:
            public.append(
                {
                    "controls": controls,
                    "price_mode": prices,
                    "accepted": False,
                    "status": exc.status_code,
                    "reason": exc.detail,
                }
            )
    return {
        "sector_permutations_with_reset_index": result,
        "country_total_growth_2017_expected": 0.0,
        "country_grain_positive_control": float(
            correct_grain.loc[correct_grain.year.eq(2017), "gdp_proxy_growth"].iloc[0]
        ),
        "public_design_validation": public,
    }


def main():
    macro = macro_and_price_witness()
    macro["hypothetical_gdp_usd_with_million_conversion"] = macro.pop("usd_with_same_mock_scale_and_correct_conversion")
    macro["ratio_to_hypothetical_conversion"] = macro.pop("scale_error_factor")
    result = {
        "covariance_independent_dummy_ols": covariance_countercheck(),
        "zero_exposure_controls": zero_exposure_controls(),
        "growth_and_public_reachability": growth_and_reachability(),
        "macro_counterfactual_scale": {
            **macro,
            "interpretation": "A comparison conditional on treating the scale as million-to-USD conversion; the code contract explicitly calls this a deterministic teaching mock. It does not prove an unintended unit conversion.",
        },
        "local_default_release": local_release(),
        "resolved_processed_path": str(config.PROCESSED_DIR.resolve()),
    }
    result["raw_policy_countercheck"] = raw_policy_countercheck(independent_raw_exposures())
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
