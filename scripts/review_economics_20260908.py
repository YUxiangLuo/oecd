"""Read-only economics review witnesses; never publishes data or connects to a DB.

Run from the repository root:
    OPENBLAS_NUM_THREADS=4 PYTHONPATH=. uv run python scripts/review_economics_20260908.py
Add --raw to also recompute trade/production/length from all five original ICIO tables.
The JSON on stdout is evidence of current behavior, not a regression-test approval.
"""

from __future__ import annotations

import argparse
import gc
import json
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pandas as pd
from linearmodels.panel import PanelOLS

from gvcsim import artifacts, config, pipeline, shocks
from gvcsim.data import controls, loader, quality
from gvcsim.indicators import length, production, tradeflow
from gvcsim.indicators.core import build_arrays
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.panel import _demean_and_prune, prepare_design_model, run_design_with_benchmark
from gvcsim.regression.transforms import _apply_price_mode
from gvcsim.shock_catalog import EVENTS, TariffEvent


def small_io(A, Y, regions, sectors, tax_fraction=None):
    index = pd.MultiIndex.from_product([regions, sectors], names=["region", "sector"])
    B = np.linalg.inv(np.eye(len(A)) - A)
    x = B @ Y.sum(axis=1)
    Z = A * x[None, :]
    primary = x - Z.sum(axis=0)
    taxes = np.zeros_like(x) if tax_fraction is None else primary * tax_fraction
    return SimpleNamespace(
        Z=pd.DataFrame(Z, index=index, columns=index),
        Y=pd.DataFrame(Y, index=index, columns=pd.MultiIndex.from_product([regions, ["final"]])),
        x=pd.DataFrame({"x": x}, index=index),
        A=pd.DataFrame(A, index=index, columns=index),
        L=pd.DataFrame(B, index=index, columns=index),
        factor_inputs=SimpleNamespace(F=pd.DataFrame([taxes, primary - taxes], index=["TLS", "VA"], columns=index)),
    )


def path_oracle():
    """Classify paths by border crossings, independently of block-inverse formulas."""
    reports = []
    for seed in (91, 92, 93):
        rng = np.random.default_rng(seed)
        n = 6
        A = rng.uniform(0.005, 0.12, (n, n))
        A *= 0.4 / A.sum(axis=0)
        Y = rng.uniform(1, 20, (n, 3))
        country_of = np.repeat(np.arange(3), 2)
        arr = build_arrays(small_io(A, Y, ["AA", "BB", "CC"], ["a", "b"], rng.uniform(-0.03, 0.2, n)))
        paths = np.zeros((n, n, 3))
        paths[:, :, 0] = np.eye(n)
        amount = np.zeros((n, n, 4))
        stages = np.zeros_like(amount)
        for edge_count in range(70):
            for last in range(n):
                for borders in range(3):
                    for destination in range(3):
                        final_border = country_of[last] != destination
                        kind = int(final_border) if borders == 0 else (2 if borders == 1 and not final_border else 3)
                        contribution = arr.v * paths[:, last, borders] * Y[last, destination]
                        amount[:, last, kind] += contribution
                        stages[:, last, kind] += contribution * (edge_count + 1)
            following = np.zeros_like(paths)
            for last in range(n):
                for next_node in range(n):
                    for borders in range(3):
                        new_borders = min(2, borders + int(country_of[last] != country_of[next_node]))
                        following[:, next_node, new_borders] += paths[:, last, borders] * A[last, next_node]
            paths = following
        prod = production.sector_production(arr)
        sector, country = length.length_tables(arr)
        errors = []
        for side, prefix, axis in (("v", "VA", 1), ("y", "FGY", 0)):
            sums, counts = amount.sum(axis=axis), stages.sum(axis=axis)
            columns = [f"1_{prefix}_D", f"2_{prefix}_RT", f"3a_{prefix}_GVC_S", f"3b_{prefix}_GVC_C"]
            errors.extend(abs(sums - prod[columns].to_numpy()).ravel())
            for suffix, kinds in (("", [0, 1, 2, 3]), ("_D", [0]), ("_RT", [1]), ("_GVC", [2, 3])):
                expected = counts[:, kinds].sum(axis=1) / sums[:, kinds].sum(axis=1)
                errors.extend(abs(expected - sector[f"PL{side}{suffix}"].to_numpy()))
                for ci, name in enumerate(arr.regions):
                    take = country_of == ci
                    expected_country = counts[take][:, kinds].sum() / sums[take][:, kinds].sum()
                    errors.append(abs(expected_country - country.loc[name, f"PL{side}{suffix}"]))
        maximum = float(max(errors))
        assert maximum < 1e-10
        reports.append({"seed": seed, "orders": 70, "max_abs_error": maximum})
    return reports


def benchmark_witness():
    cases = []
    for cluster_count in (12, 16, 20, 24, 76):
        rng = np.random.default_rng(51)
        rows = []
        for i in range(cluster_count):
            for year in range(2016, 2021):
                shock = (0.04 + 0.01 * rng.random()) * (year >= 2018)
                rows.append(
                    {
                        "country": f"C{i}",
                        "year": year,
                        "tariff_shock": shock,
                        "treated": int(shock > 0),
                        "FVA_share": 0.2 + 0.01 * i + 0.004 * (year - 2016) + 0.3 * shock + rng.normal(0, 0.005),
                    }
                )
        frame = pd.DataFrame(rows)
        design = RegressionDesign("trade", granularity="country", method="twfe_intensity")
        model = prepare_design_model(frame, design)
        result, benchmark = run_design_with_benchmark(frame, design)
        _, _, columns, _ = _demean_and_prune(model)
        data = model.data.set_index(["country", "year"])
        matching = PanelOLS(data.FVA_share, data[columns], entity_effects=True, time_effects=True).fit(
            cov_type="clustered",
            clusters=pd.Series(model.data.country.to_numpy(), index=data.index),
            group_debias=True,
        )
        cases.append(
            {
                "clusters": cluster_count,
                "support_before_benchmark": model.support.status,
                "status_after_benchmark": result.status,
                "benchmark_passed": benchmark["benchmark_passed"],
                **benchmark["policy_coefs"][0],
                "matched_cr1_se": float(matching.std_errors.iloc[0]),
            }
        )
    return cases


def contemporaneous_witness():
    parts = []
    for year, exports in ((2017, 0.0), (2018, 10.0)):
        arr = build_arrays(
            small_io(np.zeros((2, 2)), np.array([[100.0, 0], [exports, 100.0]]), ["USA", "JPN"], ["C26"])
        )
        parts.append(shocks.build_export_exposure(arr, year))
    exposure = pd.concat(parts, ignore_index=True)
    event = TariffEvent(
        "Review-only fictional tariff", "USA", ("JPN",), "2018-01-01", "2018-01-01", {"C26": {2018: 0.2}}
    )
    output = {}
    with patch.object(shocks, "EVENTS", [event]):
        for mode in ("fixed_pretreatment", "contemporaneous"):
            frame = shocks.demo_shock_panel(["USA", "JPN"], ["C26"], [2017, 2018], exposure, exposure_mode=mode)
            row = frame.loc[frame.country.eq("JPN") & frame.year.eq(2018)].iloc[0]
            output[mode] = {
                key: float(row[key])
                for key in ("tariff_shock", "tariff_shock_contemporaneous", "treated_contemporaneous")
            }
    return output


def macro_and_price_witness():
    # Units of all source amounts: Million USD.
    country = pd.DataFrame(
        [
            {
                "country": "AAA",
                "year": 2016,
                "SVA": 1000.0,
                **{name: 1.0 for name in ("DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub")},
            }
        ]
    )
    sector = pd.DataFrame([{"country": "AAA", "industry": "C26", "year": 2016, "SVA": 1000.0}])
    generated = controls.build_controls(country, sector).iloc[0]
    scale = 0.8 + 0.4 * controls._stable_unit("AAA")
    usd_if_million_conversion = 1001.0 * 1e6 * scale
    actual = float(np.expm1(generated.macro_log_gdp_usd))
    frame = pd.DataFrame(
        {
            "country": ["AAA"] * 4,
            "industry": ["a", "b", "a", "b"],
            "year": [2016, 2016, 2017, 2017],
            "SVA": [10.0, 90.0, 20.0, 90.0],
            "gross_exports": [10.0, 90.0, 20.0, 90.0],
            "gdp_deflator": [1.0] * 4,
        }
    )
    design = RegressionDesign("trade", price_mode="real_2016", control_mode="icio_derived")
    growth = []
    for order in ([0, 1, 2, 3], [1, 0, 3, 2]):
        result = _apply_price_mode(frame.iloc[order], design)
        growth.append(float(result.loc[result.year.eq(2017), "gdp_proxy_growth"].iloc[0]))
    return {
        "source_sva_million_usd": 1000.0,
        "generated_gdp_usd": actual,
        "usd_with_same_mock_scale_and_correct_conversion": usd_if_million_conversion,
        "scale_error_factor": actual / usd_if_million_conversion,
        "growth_2017_by_row_order": growth,
        "growth_from_country_total": 0.1,
        "public_control_and_real_price_paths_disabled": True,
    }


def gate_witness():
    io = small_io(np.array([[0.2, 0.1], [0.1, 0.2]]), np.array([[10.0, 2.0], [2.0, 10.0]]), ["AA", "BB"], ["s"])
    io.L.iloc[0, 0] += 0.5
    diagnostic = quality.check_leontief_inverse(io)
    gate = pipeline._gate_integrity(
        "review_only",
        [quality.QcCheck("structure", "结构", True), diagnostic],
        artifacts.publication_policy_metadata()["blocking_kinds"]["icio"],
    )
    return {
        "inverse_check": diagnostic.to_dict(),
        "publication_input_gate": gate,
        "scope": "Gate-only witness; no data release was published.",
    }


def local_release():
    metadata = json.loads((config.PROCESSED_DIR / "dataset.json").read_text())
    result = {
        key: metadata.get(key)
        for key in ("release_id", "artifact_contract_version", "course_release", "generated_at", "shock_contract")
    }
    try:
        result["validation"] = artifacts.validate_release(config.PROCESSED_DIR)
    except artifacts.ArtifactContractError as exc:
        result["validation_error"] = str(exc)
    return result


def raw_audit():
    reports = []
    for year in range(2016, 2021):
        io = loader.load(year)
        arr = build_arrays(io)
        tf = tradeflow.sector_tradeflow(arr)
        prod = production.sector_production(arr)
        lens, country_lens = length.length_tables(arr)
        computed = tf.join(prod).join(lens)
        saved = pd.read_csv(config.PROCESSED_DIR / f"indicators_industry_{year}.csv").set_index(["country", "industry"])
        original_saved = saved.reindex(computed.index)[computed.columns].to_numpy()
        original_computed = computed.to_numpy()
        finite = np.isfinite(original_saved) & np.isfinite(original_computed)
        differences = np.abs(original_saved[finite] - original_computed[finite])
        scale = np.maximum(np.abs(original_computed[finite]), 1)
        inverse = quality.check_leontief_inverse(io)
        cases = {
            "year": year,
            "nodes": len(arr.x),
            "unit": sorted(io.unit.iloc[:, 0].unique().tolist()),
            "raw_supply_account": quality.check_accounting_identity(io).to_dict(),
            "raw_input_account": quality.check_input_accounting_identity(io).to_dict(),
            "leontief": inverse.to_dict(),
            "max_export_closure_abs_error": float(np.max(np.abs(tradeflow.gross_exports(tf).to_numpy() - arr.E))),
            "max_forward_va_closure_abs_error": float(np.max(np.abs(prod["SVA"].to_numpy() - arr.va))),
            "saved_indicator_max_abs_difference": float(differences.max()),
            "saved_indicator_max_scaled_difference": float((differences / scale).max()),
            "saved_indicator_null_support_equal": bool(
                np.array_equal(np.isnan(original_saved), np.isnan(original_computed))
            ),
            "negative_va_nodes": int((arr.va < 0).sum()),
            "negative_tls_nodes": int((arr.taxsub < 0).sum()),
        }
        if year == 2017:
            p = arr.index.get_loc(("CAN", "C27"))
            usa = arr.regions.index("USA")
            direct = float(arr.Z[p, arr.pos["USA"]].sum() + arr.Yd[p, usa])
            total_positive = sum(
                max(float(arr.Z[p, arr.pos[dest]].sum() + arr.Yd[p, j]), 0.0)
                for j, dest in enumerate(arr.regions)
                if dest != "CAN"
            )
            rate = next(event for event in EVENTS if "201保障" in event.name).rate("CAN", "C27", 2018)
            cases["canada_washers_2018_using_raw_2017_exposure"] = {
                "bilateral_million_usd": direct,
                "total_positive_exports_million_usd": total_positive,
                "exposure": direct / total_positive,
                "catalog_rate": rate,
                "wrong_positive_shock": rate * direct / total_positive,
                "policy_contribution_under_exemption": 0.0,
            }
        reports.append(cases)
        print(f"raw audit {year} complete", file=__import__("sys").stderr, flush=True)
        del io, arr, tf, prod, lens, country_lens, computed, saved
        gc.collect()
    return reports


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", action="store_true")
    args = parser.parse_args()
    event = next(event for event in EVENTS if "201保障" in event.name)
    result = {
        "local_release": local_release(),
        "independent_path_oracle": path_oracle(),
        "twfe_benchmark": benchmark_witness(),
        "contemporaneous_weights": contemporaneous_witness(),
        "macro_and_price": macro_and_price_witness(),
        "hard_math_gate": gate_witness(),
        "section_201_canada": {
            "targets": event.targets,
            "exempt": list(event.exempt),
            "canada_C27_rate_2018": event.rate("CAN", "C27", 2018),
            "source_complete": event.source_complete,
        },
    }
    if args.raw:
        result["raw_audit"] = raw_audit()
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
