"""Evaluate the deployed teaching design on paired seeds, never by seed selection.

For every Y a page may choose, each seed regenerates the panel with the production generator and fits the course
default model (X + L1.X + exchange rate, unit and year effects, country-clustered CR1): the cumulative relation and
each term's estimate are compared with the preset values (β split 60/40 over X and L1.X; the exchange rate's slope
γ = factor × β). Run from the repository root with PYTHONPATH=. and --output <json>.

The balanced-panel NumPy calculation is checked against the production estimator and its library benchmark on the
first seed for every Y. Earlier tariff-design candidates (v2–v7) are recorded in benchmarks/teaching_design_v*.json.
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
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.panel import run_design_with_benchmark
from gvcsim.regression.spec import DEFAULT_SPEC

TERMS = ("cumulative", "x", "lag1", "exchange_rate")


def _targets(beta: float) -> dict[str, float]:
    return {
        "cumulative": beta,
        "x": teaching.LAG_SHARES[0] * beta,
        "lag1": teaching.LAG_SHARES[1] * beta,
        "exchange_rate": teaching.EXCHANGE_RATE_GAMMA_FACTOR * beta,
    }


def _fit(frame: pd.DataFrame, column: str) -> tuple[dict[str, float], dict[str, float], int]:
    """The default model on a balanced panel: two-way demeaning, OLS and CR1 with the fixed-effect rank counted."""
    entities = frame.entity_id.nunique()
    periods = frame.year.nunique()
    n = len(frame)
    codes, countries = pd.factorize(frame.country)
    groups = len(countries)
    regressors = [teaching.X_LAG_COLUMNS[0], teaching.X_LAG_COLUMNS[1], teaching.EXCHANGE_RATE_COLUMN]
    cube = frame[[column, *regressors]].to_numpy(float).reshape(entities, periods, -1)
    within = (
        cube
        - cube.mean(axis=1, keepdims=True)
        - cube.mean(axis=0, keepdims=True)
        + cube.mean(axis=(0, 1), keepdims=True)
    ).reshape(n, -1)
    y, X = within[:, 0], within[:, 1:]
    bread = np.linalg.inv(X.T @ X)
    beta = bread @ X.T @ y
    residual = y - X @ beta
    scores = np.zeros((groups, X.shape[1]))
    np.add.at(scores, codes, X * residual[:, None])
    rank = entities + periods - 1
    correction = groups / (groups - 1) * (n - 1) / (n - X.shape[1] - rank)
    covariance = correction * bread @ (scores.T @ scores) @ bread
    weights = np.array([1.0, 1.0, 0.0])
    estimates = {
        "cumulative": float(weights @ beta),
        "x": float(beta[0]),
        "lag1": float(beta[1]),
        "exchange_rate": float(beta[2]),
    }
    ses = {
        "cumulative": float(np.sqrt(weights @ covariance @ weights)),
        "x": float(np.sqrt(covariance[0, 0])),
        "lag1": float(np.sqrt(covariance[1, 1])),
        "exchange_rate": float(np.sqrt(covariance[2, 2])),
    }
    return estimates, ses, groups


def evaluate(root: Path, seeds: range) -> dict:
    # Parse and fingerprint the same bytes, including the independently supplied exposure weights and flows.
    source_bytes = (root / "panel_industry.csv").read_bytes()
    source = pd.read_csv(BytesIO(source_bytes))
    years = sorted(source.year.unique())
    exposure_path = f"export_exposure_{years[0]}.csv"
    exposure_bytes = (root / exposure_path).read_bytes()
    exposure = pd.read_csv(BytesIO(exposure_bytes))
    pairs = [(outcome, item) for outcome in teaching.OUTCOMES for item in teaching.selectable_baselines(outcome)]
    records: dict[str, list[dict]] = {f"{outcome}:{item.key}": [] for outcome, item in pairs}
    sizes: dict[str, int] = {}
    benchmark_checks: list[str] = []
    for seed in seeds:
        panel = teaching.build_teaching_panel(source, exposure, seed=seed)
        for outcome, item in pairs:
            name = f"{outcome}:{item.key}"
            column = teaching.y_column(outcome, item.key)
            if column not in panel.columns:
                # A source panel without this baseline's columns (test fixtures) skips it.
                continue
            complete = panel.groupby("entity_id")[column].transform(lambda values: values.notna().all())
            frame = panel.loc[complete].sort_values(["entity_id", "year"])
            assert len(frame) == frame.entity_id.nunique() * len(years)
            sizes[name] = int(frame.entity_id.nunique())
            estimates, ses, groups = _fit(frame, column)
            critical = stats.t.ppf(0.975, groups - 1)
            targets = _targets(item.beta)
            records[name].append(
                {
                    term: {
                        "estimate": estimates[term],
                        "se": ses[term],
                        "covered": bool(abs(estimates[term] - targets[term]) <= critical * ses[term]),
                        "significant": bool(abs(estimates[term]) > critical * ses[term]),
                    }
                    for term in TERMS
                }
            )
            if seed == seeds.start:
                design = RegressionDesign(outcome, teaching=True, baseline=item.key)
                result, reference = run_design_with_benchmark(frame, design)
                assert reference["benchmark_passed"]
                assert result.cumulative is not None
                np.testing.assert_allclose(
                    [result.cumulative.coef, result.cumulative.se],
                    [estimates["cumulative"], ses["cumulative"]],
                    rtol=1e-8,
                    atol=1e-9,
                )
                benchmark_checks.append(name)
        if (seed - seeds.start + 1) % 25 == 0:
            print(f"Evaluated {seed - seeds.start + 1}/{len(seeds)} paired seeds", flush=True)
    summary = {}
    for name, rows in records.items():
        if not rows:
            continue
        outcome, key = name.split(":", 1)
        beta = teaching.baseline(outcome, key).beta
        targets = _targets(beta)
        summary[name] = {"beta": beta, "entities": sizes[name]}
        for term in TERMS:
            estimates = np.array([row[term]["estimate"] for row in rows])
            summary[name][term] = {
                "target": targets[term],
                "mean_bias": float((estimates - targets[term]).mean()),
                "rmse": float(np.sqrt(((estimates - targets[term]) ** 2).mean())),
                "coverage_95": float(np.mean([row[term]["covered"] for row in rows])),
                # With a zero target (the weak Y) this is the false-positive rate.
                "significant_share": float(np.mean([row[term]["significant"] for row in rows])),
            }
    return {
        "seeds": list(seeds),
        "release_seed_unchanged": teaching.SEED,
        "version": teaching.VERSION,
        "model": DEFAULT_SPEC.to_dict(),
        "source_panel_sha256": hashlib.sha256(source_bytes).hexdigest(),
        "source_exposure": {"path": exposure_path, "sha256": hashlib.sha256(exposure_bytes).hexdigest()},
        "generator_snapshots": {name: teaching.model_snapshot(name) for name in teaching.OUTCOMES},
        "implementation_sha256": {
            "benchmark": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "generator": hashlib.sha256(Path(teaching.__file__).read_bytes()).hexdigest(),
        },
        "summary": summary,
        "independent_benchmark_checks": benchmark_checks,
        "notes": (
            "Paired noise draws; fixed preset relations; the course default model with country-clustered CR1 and "
            "t(G-1). Coverage is empirical, not a guarantee; significant_share of a zero target is its false-positive "
            "rate."
        ),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("data/processed"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    # Fixed before evaluation; excludes the publication seed.
    args.output.write_text(json.dumps(evaluate(args.source, range(1000, 1200)), indent=2) + "\n")
