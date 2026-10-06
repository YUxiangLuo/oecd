"""Compare prespecified teaching designs using paired seeds, never seed selection.

Run from the repository root with PYTHONPATH=. and --output <json>.
The balanced-panel NumPy CR1 calculation is checked against both production
TWFE and PanelOLS on the first evaluation seed for every candidate.
"""

import argparse
import hashlib
import json
from io import BytesIO
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

from gvcsim.regression import teaching
from gvcsim.regression.design import OUTCOME_DEPVARS, RegressionDesign
from gvcsim.regression.panel import run_design_with_benchmark


# name -> (flat tariff rate from the third year, noise multiplier); "legacy" keeps the v1 rate schedule.
CANDIDATES = {
    "legacy": (None, 1.0),
    "flat_10pct": (0.10, 1.0),
    "flat_half_noise": (0.10, 0.5),
    "flat_quarter_noise": (0.10, 0.25),
    "flat_25pct_half_noise": (0.25, 0.5),
}
LEGACY_NOISE = np.array([0.012, 0.010, 0.060, 120.0])


def evaluate(root: Path, seeds: range) -> dict:
    # Parse and fingerprint the same bytes, including the independently supplied
    # exposure weights. A panel hash alone cannot identify this experiment.
    source_bytes = (root / "panel_industry.csv").read_bytes()
    source = pd.read_csv(BytesIO(source_bytes))
    years = sorted(source.year.unique())
    exposure_path = f"export_exposure_{years[0]}.csv"
    exposure_bytes = (root / exposure_path).read_bytes()
    exposure = pd.read_csv(BytesIO(exposure_bytes))
    outcomes = list(teaching.Y_COLUMNS)
    ys = list(teaching.Y_COLUMNS.values())
    beta = np.array([teaching.BETAS[name] for name in outcomes])
    records = {name: [] for name in CANDIDATES}
    domain_failures = dict.fromkeys(CANDIDATES, 0)
    benchmark_checks = []
    for seed in seeds:
        panel = teaching.build_teaching_panel(source, exposure, seed=seed)
        sizes = panel.groupby("entity_id").size()
        assert sizes.eq(5).all() and panel.groupby("entity_id").year.nunique().eq(5).all()
        n, entities = len(panel), len(sizes)
        codes, countries = pd.factorize(panel.country)
        groups = len(countries)
        baseline = np.column_stack(
            [
                np.repeat(
                    teaching.CALIBRATION[name][0]
                    + teaching.CALIBRATION[name][1]
                    * panel.loc[panel.year.eq(years[0]), OUTCOME_DEPVARS[name][0]].rank(pct=True).to_numpy(),
                    5,
                )
                for name in outcomes
            ]
        )
        # Recover identical unit-noise draws, regardless of the deployed design.
        noise = panel[ys].to_numpy() - baseline - panel[teaching.X_COLUMN].to_numpy()[:, None] * beta
        noise /= np.array([teaching.CALIBRATION[name][2] for name in outcomes])
        treated = panel.country.map(lambda value: teaching._unit_number(value, "policy") < 0.60).to_numpy()
        legacy_rate = panel.industry.map(lambda value: 0.06 if teaching._unit_number(value, "rate") < 0.5 else 0.18)
        legacy_path = panel.year.map(dict(zip(years, (0, 0, 0.65, 1, 0.55), strict=True)))
        weights = panel.teaching_export_share_w.to_numpy()

        def within(values):
            cube = values.reshape(entities, 5, -1)
            return (
                cube
                - cube.mean(axis=1, keepdims=True)
                - cube.mean(axis=0, keepdims=True)
                + cube.mean(axis=(0, 1), keepdims=True)
            ).reshape(n, -1)

        for name, (rate, multiplier) in CANDIDATES.items():
            tau = (
                legacy_rate.to_numpy() * legacy_path.to_numpy()
                if rate is None
                else rate * panel.year.ge(years[2]).to_numpy()
            ) * treated
            x = weights * tau
            y = baseline + x[:, None] * beta + noise * LEGACY_NOISE * multiplier
            domain_failures[name] += int(np.any((y[:, :2] < 0) | (y[:, :2] > 1)) or np.any(y[:, 2:] <= 0))
            xw, yw = within(x).ravel(), within(y)
            xx = xw @ xw
            estimate = xw @ yw / xx
            residual = yw - xw[:, None] * estimate
            scores = np.zeros((groups, 4))
            np.add.at(scores, codes, xw[:, None] * residual)
            correction = groups / (groups - 1) * (n - 1) / (n - entities - 5)
            se = np.sqrt(correction * (scores**2).sum(axis=0)) / xx
            critical = stats.t.ppf(0.975, groups - 1)
            records[name].append(
                {
                    "estimate": estimate.tolist(),
                    "se": se.tolist(),
                    "covered": (np.abs(estimate - beta) <= critical * se).tolist(),
                    "significant": (np.abs(estimate) > critical * se).tolist(),
                    "null_rejected": (np.abs(estimate - beta) > critical * se).tolist(),
                }
            )
            if seed == seeds.start:
                candidate = panel.copy()
                candidate[teaching.X_COLUMN] = x
                candidate["teaching_tariff_rate_tau"] = tau
                candidate["teaching_treated"] = (x > 0).astype(int)
                candidate[ys] = y
                for index, outcome in enumerate(outcomes):
                    result, reference = run_design_with_benchmark(candidate, RegressionDesign(outcome, teaching=True))
                    assert reference["benchmark_passed"]
                    np.testing.assert_allclose(
                        [result.coefs[0].coef, result.coefs[0].se], [estimate[index], se[index]], rtol=1e-8, atol=1e-9
                    )
                benchmark_checks.append(name)
        if (seed - seeds.start + 1) % 25 == 0:
            print(f"Evaluated {seed - seeds.start + 1}/{len(seeds)} paired seeds", flush=True)
    summary = {}
    for name, rows in records.items():
        estimates = np.array([row["estimate"] for row in rows])
        summary[name] = {
            outcome: {
                "mean_bias": float((estimates[:, index] - beta[index]).mean()),
                "rmse": float(np.sqrt(((estimates[:, index] - beta[index]) ** 2).mean())),
                "coverage_95": float(np.mean([row["covered"][index] for row in rows])),
                "power": float(np.mean([row["significant"][index] for row in rows])),
                "null_false_positive_rate": float(np.mean([row["null_rejected"][index] for row in rows])),
            }
            for index, outcome in enumerate(outcomes)
        }
    return {
        "seeds": list(seeds),
        "release_seed_unchanged": teaching.SEED,
        "source_panel_sha256": hashlib.sha256(source_bytes).hexdigest(),
        "source_exposure": {"path": exposure_path, "sha256": hashlib.sha256(exposure_bytes).hexdigest()},
        "generator_snapshots": {name: teaching.model_snapshot(name) for name in outcomes},
        "legacy_noise_scales": dict(zip(outcomes, LEGACY_NOISE.tolist(), strict=True)),
        "implementation_sha256": {
            "benchmark": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "generator": hashlib.sha256(Path(teaching.__file__).read_bytes()).hexdigest(),
        },
        "candidates": {
            name: {"tariff_rate": rate, "noise_multiplier": multiplier}
            for name, (rate, multiplier) in CANDIDATES.items()
        },
        "summary": summary,
        "domain_failures": domain_failures,
        "independent_benchmark_checks": benchmark_checks,
        "notes": "Paired noise draws; fixed beta; country-clustered CR1 and t(G-1). Null uses the same residuals with beta=0. Coverage is empirical, not a guarantee.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("data/processed"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    # Fixed before evaluation; excludes the publication seed.
    args.output.write_text(json.dumps(evaluate(args.source, range(1000, 1200)), indent=2) + "\n")
