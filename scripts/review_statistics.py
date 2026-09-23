"""Reproduce the read-only statistics audit against the current teaching panel.

Example (from repository root):
  OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2 .venv/bin/python scripts/review_statistics.py \
    --replications 10000 --output dogfood-output/statistics-review-20260924

The coverage experiment holds the released X and sample fixed and draws new
independent uniform entity-year plus country-year innovations. It studies this
specific teaching DGP, not real-world tariff identification or all possible errors.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.estimation import within_ols
from gvcsim.regression.model import prepare_design_model
from gvcsim.regression.panel import run_design_with_benchmark


def demean_balanced(array):
    return (
        array
        - array.mean(axis=1, keepdims=True)
        - array.mean(axis=0, keepdims=True)
        + array.mean(axis=(0, 1), keepdims=True)
    )


def audit_coverage(panel, replications, seed):
    model = prepare_design_model(panel, RegressionDesign("trade", teaching=True))
    d = model.data
    entities, years, countries = pd.unique(d.entity_id), pd.unique(d.year), pd.unique(d.country)
    e, t, g = len(entities), len(years), len(countries)
    if not (
        d.groupby("entity_id").size().eq(t).all()
        and np.array_equal(d.year.to_numpy().reshape(e, t), np.tile(years, (e, 1)))
    ):
        raise ValueError("This coverage experiment requires the released balanced, entity-major panel")
    groups = pd.factorize(d.country)[0].reshape(e, t)
    if not np.all(groups == groups[:, :1]):
        raise ValueError("Each entity must remain in one country")
    ec = groups[:, 0]
    x = demean_balanced(d.teaching_tariff_exposure.to_numpy().reshape(e, t))
    sxx = np.sum(x * x)
    information = np.bincount(ec, weights=np.sum(x * x, axis=1)) / sxx
    # Exact variance under the specified independent Uniform[-1,1] innovations.
    country_year_x = np.zeros((g, t))
    np.add.at(country_year_x, ec, x)
    variance_parts = (np.bincount(ec, weights=np.sum(x * x, axis=1)) + np.sum(country_year_x**2, axis=1)) / (3 * sxx**2)
    variance_shares = variance_parts / variance_parts.sum()
    correction = g / (g - 1) * (len(d) - 1) / (len(d) - e - t)
    rng = np.random.default_rng(seed)
    deltas, standard_errors = [], []
    for start in range(0, replications, 100):
        size = min(100, replications - start)
        error = rng.uniform(-1, 1, (e, t, size)) + rng.uniform(-1, 1, (g, t, size))[ec]
        error = demean_balanced(error)
        delta = np.einsum("et,etr->r", x, error) / sxx
        residual = error - x[:, :, None] * delta
        scores = np.zeros((g, size))
        np.add.at(scores, ec, np.einsum("et,etr->er", x, residual))
        se = np.sqrt(correction * np.sum(scores * scores, axis=0)) / sxx
        if start == 0:
            # Check the optimized simulation kernel against the actual estimator.
            model.data = d.assign(**{model.depvar: error[:, :, 0].ravel()})
            actual = within_ols(model).coefs[0]
            np.testing.assert_allclose([delta[0], se[0]], [actual.coef, actual.se], rtol=1e-10)
        deltas.extend(delta.tolist())
        standard_errors.extend(se.tolist())
    deltas, standard_errors = np.array(deltas), np.array(standard_errors)
    critical = stats.t.ppf(0.975, g - 1)
    covered = np.abs(deltas) <= critical * standard_errors
    coverage = covered.mean()
    mc_interval = stats.binomtest(int(covered.sum()), replications).proportion_ci(method="wilson")
    return {
        "replications": replications,
        "seed": seed,
        "coverage": float(coverage),
        "coverage_monte_carlo_95_interval": [float(mc_interval.low), float(mc_interval.high)],
        "mc_standard_error": float(np.sqrt(coverage * (1 - coverage) / replications)),
        "mean_bias_noise_units": float(deltas.mean()),
        "empirical_sd": float(deltas.std(ddof=1)),
        "exact_dgp_sd": float(np.sqrt(variance_parts.sum())),
        "rms_se": float(np.sqrt(np.mean(standard_errors**2))),
        "information_concentration_inverse_hhi": float(1 / (information @ information)),
        "top_information_shares": sorted(zip(countries.tolist(), information.tolist()), key=lambda item: -item[1])[:10],
        "top_dgp_variance_shares": sorted(zip(countries.tolist(), variance_shares.tolist()), key=lambda item: -item[1])[
            :10
        ],
        "note": "Inverse HHI is a concentration diagnostic, not adjusted degrees of freedom or a validity threshold.",
    }


def audit_regressions(panel):
    results = {}
    for outcome in ["trade", "production", "length", "network"]:
        design = RegressionDesign(outcome, teaching=True)
        own, benchmark = run_design_with_benchmark(panel, design)
        d = prepare_design_model(panel, design).data
        deleted = {}
        for country in d.country.unique():
            retained = d.loc[d.country != country]
            t = retained.year.nunique()
            x = demean_balanced(retained[design.shock_col].to_numpy().reshape(-1, t))
            y = demean_balanced(retained[design.depvar].to_numpy().reshape(-1, t))
            deleted[country] = float(np.sum(x * y) / np.sum(x * x))
        results[outcome] = {
            "coefs": [coefficient.__dict__ for coefficient in own.coefs],
            "n": own.n_obs,
            "clusters": own.n_clusters,
            "support": own.support,
            "r2": own.r2_within,
            "benchmark": benchmark,
            "leave_one_country_out": deleted,
        }
    return results


def audit_indicator_exports(root):
    checks = {}
    for year in range(2016, 2021):
        sector = pd.read_csv(root / f"indicators_industry_{year}.csv")
        country = pd.read_csv(root / f"indicators_country_{year}.csv").set_index("country")
        amounts = [
            "DVAex",
            "DVArt",
            "DDC",
            "FVA",
            "FDC",
            "taxsub",
            "EXDVA",
            "SVA",
            "1_VA_D",
            "2_VA_RT",
            "3_VA_GVC",
            "3a_VA_GVC_S",
            "3b_VA_GVC_C",
            "FGY",
            "1_FGY_D",
            "2_FGY_RT",
            "3_FGY_GVC",
            "3a_FGY_GVC_S",
            "3b_FGY_GVC_C",
        ]
        grouped = sector.groupby("country")[amounts].sum().reindex(country.index)
        np.testing.assert_allclose(grouped, country[amounts], atol=1e-6, rtol=1e-10)
        errors = []
        for frame in [sector, country]:
            for total, parts in [
                ("EXDVA", ["DVAex", "DVArt"]),
                ("SVA", ["1_VA_D", "2_VA_RT", "3_VA_GVC"]),
                ("3_VA_GVC", ["3a_VA_GVC_S", "3b_VA_GVC_C"]),
                ("FGY", ["1_FGY_D", "2_FGY_RT", "3_FGY_GVC"]),
                ("3_FGY_GVC", ["3a_FGY_GVC_S", "3b_FGY_GVC_C"]),
            ]:
                difference = frame[total] - frame[parts].sum(axis=1)
                np.testing.assert_allclose(frame[total], frame[parts].sum(axis=1), rtol=1e-9, atol=1e-6)
                errors.append(float((difference.abs() / (1 + frame[total].abs())).max()))
        # Country length must use activity-specific VA weights, not equal industries.
        length_errors = {}
        for prefix, total, domestic, traditional, gvc in [
            ("PLv", "SVA", "1_VA_D", "2_VA_RT", "3_VA_GVC"),
            ("PLy", "FGY", "1_FGY_D", "2_FGY_RT", "3_FGY_GVC"),
        ]:
            for suffix, weight in [("", total), ("_D", domestic), ("_RT", traditional), ("_GVC", gvc)]:
                col = prefix + suffix
                numerator = (sector[col] * sector[weight]).groupby(sector.country).sum().reindex(country.index)
                denominator = sector.groupby("country")[weight].sum().reindex(country.index)
                expected = numerator / denominator
                np.testing.assert_allclose(country[col], expected, atol=1e-8, rtol=1e-9, equal_nan=True)
                length_errors[col] = float((country[col] - expected).abs().max())
        checks[str(year)] = {
            "sector_rows": len(sector),
            "country_rows": len(country),
            "max_scaled_closure_error": max(errors),
            "country_length_max_absolute_errors": length_errors,
        }
    return checks


def audit_raw_accounts(root, raw_root):
    """Read the original wide tables directly, without the application IO loader."""
    checks = {}
    panels = {scope: pd.read_csv(root / f"panel_{scope}.csv") for scope in ["country", "industry"]}
    for year in range(2016, 2021):
        path = raw_root / f"ICIO2023_{year}.csv"
        raw = pd.read_csv(path, index_col=0)
        nodes = raw.index.drop(["TLS", "VA", "OUT"])
        countries = np.array([node.split("_", 1)[0] for node in nodes])
        final_columns = [
            c for c in raw.columns if c.rsplit("_", 1)[-1] in {"HFCE", "NPISH", "GGFC", "GFCF", "INVNT", "DPABR"}
        ]
        assert len(nodes) == 3465 and len(final_columns) == 462
        z, y = raw.loc[nodes, nodes].to_numpy(), raw.loc[nodes, final_columns].to_numpy()
        final_countries = np.array([c.split("_", 1)[0] for c in final_columns])
        exports = np.sum(np.where(countries[:, None] != countries[None, :], z, 0), axis=1)
        exports += np.sum(np.where(countries[:, None] != final_countries[None, :], y, 0), axis=1)
        out = raw.loc["OUT", nodes].to_numpy()
        output_gap = np.abs(z.sum(axis=1) + y.sum(axis=1) - out)
        # Source accounts are not exact. Report their discrepancies explicitly;
        # the release's published rule fails only above BOTH 1 million USD and 1%.
        assert not np.any((output_gap > 1.0) & (output_gap / np.maximum(np.abs(out), 1.0) > 0.01))
        industry = panels["industry"].loc[lambda d: d.year == year].copy()
        industry.index = industry.country + "_" + industry.industry
        industry = industry.reindex(nodes)
        export_gap = np.abs(industry.gross_exports.to_numpy() - exports)
        assert not np.any((export_gap > 1.0) & (export_gap / np.maximum(np.abs(exports), 1.0) > 0.01))
        np.testing.assert_allclose(industry.SVA, raw.loc["VA", nodes], rtol=1e-8, atol=1e-6)
        for scope, panel in panels.items():
            d = panel.loc[panel.year == year]
            for target, numerator, denominator in [
                ("FVA_share", "FVA", "gross_exports"),
                ("3b_VA_GVC_C_share", "3b_VA_GVC_C", "SVA"),
                ("3_VA_GVC_share", "3_VA_GVC", "SVA"),
            ]:
                expected = (d[numerator] / d[denominator]).where(d[denominator] > 0)
                np.testing.assert_allclose(d[target], expected, rtol=1e-10, atol=1e-12, equal_nan=True)
        checks[str(year)] = {
            "raw_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "exports_max_absolute_error": float(np.max(np.abs(industry.gross_exports.to_numpy() - exports))),
            "sva_max_absolute_error": float(np.max(np.abs(industry.SVA.to_numpy() - raw.loc["VA", nodes].to_numpy()))),
            "raw_output_max_absolute_gap": float(output_gap.max()),
            "raw_output_max_scaled_relative_gap": float((output_gap / np.maximum(np.abs(out), 1.0)).max()),
            "exports_max_scaled_relative_gap": float((export_gap / np.maximum(np.abs(exports), 1.0)).max()),
        }
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("data/processed"))
    parser.add_argument("--raw", type=Path, default=Path("OECD_ICIO"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--replications", type=int, default=10000)
    parser.add_argument("--seed", type=int, default=20260924)
    args = parser.parse_args()
    if args.replications < 100:
        parser.error("Use at least 100 replications")
    args.output.mkdir(parents=True, exist_ok=True)
    panel_path = args.data / "panel_teaching.csv"
    panel = pd.read_csv(panel_path)
    provenance = {
        "panel_sha256": hashlib.sha256(panel_path.read_bytes()).hexdigest(),
        "release_id": json.loads((args.data / "dataset.json").read_text())["release_id"],
    }
    for name, audit in [
        ("raw-accounts", lambda: audit_raw_accounts(args.data, args.raw)),
        ("release-indicators", lambda: audit_indicator_exports(args.data)),
        ("actual-regressions", lambda: audit_regressions(panel)),
        ("coverage-experiment", lambda: audit_coverage(panel, args.replications, args.seed)),
    ]:
        result = {"provenance": provenance, "results": audit()}
        (args.output / f"{name}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(f"Completed {name}", flush=True)


if __name__ == "__main__":
    main()
