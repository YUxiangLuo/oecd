"""Verify the rebuilt release against pre-fix raw-data counterexamples.

Read-only: validates source/file bindings, recomputes output QC and exercises the
public regression engine. Does not touch classroom data or publish a release.
"""

from __future__ import annotations

import json
import sys

import numpy as np
import pandas as pd

from gvcsim import artifacts, config, regression_routes, shock_catalog
from gvcsim.data import output_quality, raw_icio
from gvcsim.regression.design import OUTCOME_GRANULARITIES
from gvcsim.regression.panel import run_design_with_benchmark


def tariff_oracle(root):
    """DataFrame joins and aggregation, independent of the generator's loops."""
    exposure = pd.read_csv(root / "tariff_exposure_lookup.csv")
    countries, sectors, years = map(set, (exposure.country, exposure.sector, exposure.year))
    rows = []
    for event in shock_catalog.EVENTS:
        targets = countries - {event.imposer} if event.targets == "ALL" else countries.intersection(event.targets)
        for country in targets - set(event.exempt):
            for sector, schedule in event.overrides.get(country, event.rates).items():
                for year, rate in schedule.items():
                    if sector in sectors and year in years and rate > 0:
                        rows.append((country, sector, event.imposer, year, rate))
    keys = ["country", "sector", "imposer"]
    rates = pd.DataFrame(rows, columns=[*keys, "year", "rate"])
    first = rates.groupby(keys, as_index=False).year.min().rename(columns={"year": "first"})
    available = exposure.merge(first, on=keys, validate="many_to_one")
    baseline = available[available.year < available["first"]].sort_values("year").groupby(keys, as_index=False).tail(1)
    baseline = baseline[[*keys, "export_exposure"]].rename(columns={"export_exposure": "fixed_exposure"})
    weighted = rates.merge(baseline, on=keys, validate="many_to_one").merge(
        exposure, on=[*keys, "year"], validate="many_to_one"
    )
    assert len(weighted) == len(rates)
    weighted["tariff_shock"] = weighted.rate * weighted.fixed_exposure
    weighted["tariff_shock_contemporaneous"] = weighted.rate * weighted.export_exposure
    return weighted.groupby(["country", "sector", "year"])[["tariff_shock", "tariff_shock_contemporaneous"]].sum()


def main():
    root = config.PROCESSED_DIR
    metadata = artifacts.dataset_metadata(root)
    report = {"release_validation": artifacts.validate_release(root), "resolved_release": str(root.resolve())}
    raw_icio.validate_raw_source_bindings(metadata["raw_dimensions"], metadata["years"], config.RAW_DATA_DIR)
    report["raw_source_bindings_valid"] = True
    report["artifact_contract_version"] = metadata["artifact_contract_version"]
    report["publication_policy"] = metadata["publication_policy"]
    report["output_checks"] = {}
    for year in metadata["years"]:
        checks = output_quality.recompute_output_checks(root, year, expected_years=metadata["years"])
        summary = output_quality.summarize_output_checks(checks)
        assert summary["publishable"], (year, summary)
        report["output_checks"][str(year)] = summary

    shock = pd.read_csv(root / "demo_trade_war_tariffs.csv").set_index(["country", "sector", "year"])
    expected = tariff_oracle(root).reindex(shock.index, fill_value=0.0)
    max_errors = {}
    for column in expected:
        max_errors[column] = float((expected[column] - shock[column]).abs().max())
        np.testing.assert_allclose(shock[column], expected[column], atol=1e-14, rtol=1e-12)
    report["all_rows_independent_tariff_oracle"] = {"rows": len(shock), "max_abs_errors": max_errors}
    canada = shock.loc[("CAN", "C27")].sort_index()
    assert canada.tariff_shock.eq(0).all() and canada.treated.eq(0).all()
    report["canada_C27_washer_exemption"] = canada[["tariff_shock", "treated"]].reset_index().to_dict("records")
    prior = json.loads((config.ROOT / "docs/economics-reconfirmation-20260908-evidence.json").read_text())
    repaired = []
    for witness in prior["raw_policy_countercheck"]["zero_baseline_positive_current_event_cases"]:
        key = (witness["country"], witness["sector"], witness["year"])
        row = shock.loc[key]
        assert row.tariff_shock == 0 and row.treated == 0
        assert np.isclose(row.tariff_shock_contemporaneous, witness["omitted_current_shock"], atol=1e-14, rtol=1e-12)
        assert row.treated_contemporaneous == 1
        repaired.append(
            {
                "country": key[0],
                "industry": key[1],
                "year": key[2],
                "fixed_shock": float(row.tariff_shock),
                "current_shock": float(row.tariff_shock_contemporaneous),
            }
        )
    report["repaired_raw_counterexamples"] = repaired

    panels = {
        level: pd.read_csv(root / f"panel_{'industry' if level == 'country_industry' else 'country'}.csv")
        for level in ("country", "country_industry")
    }
    runs = []
    for outcome, levels in OUTCOME_GRANULARITIES.items():
        for level in levels:
            modes = (
                ("fixed_pretreatment", "contemporaneous") if level == "country_industry" else ("fixed_pretreatment",)
            )
            for mode in modes:
                for method in ("did", "twfe_intensity", "event_study"):
                    design = regression_routes._validate_design(outcome, level, "tariff", method)
                    data = regression_routes._panel_for_weight_mode(panels[level], design, mode)
                    print(f"Verify {outcome}/{level}/{mode}/{method}", file=sys.stderr, flush=True)
                    result, benchmark = run_design_with_benchmark(data, design)
                    if method == "twfe_intensity":
                        assert benchmark["benchmark_passed"], (outcome, level, mode, benchmark)
                    payload = result.to_dict()
                    # JSON and finite-output boundaries must hold even when the
                    # real policy path appropriately suppresses causal inference.
                    json.dumps(payload, allow_nan=False)
                    runs.append(
                        {
                            "outcome": outcome,
                            "granularity": level,
                            "weight_mode": mode,
                            "method": method,
                            "status": result.status,
                            "n_obs": result.n_obs,
                            "n_clusters": result.n_clusters,
                            "benchmark_passed": benchmark["benchmark_passed"],
                            "max_abs_se_diff": benchmark.get("max_abs_se_diff"),
                            "policy_coefficients": payload["coefs"],
                        }
                    )
    report["public_engine_runs"] = runs
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
