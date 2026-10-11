"""Independent recomputation of every workbench model (steps 11–14, 自己设计模型). Does not import gvcsim.

Reads the teaching panel CSV and the production results written by ``scripts/dump_custom_regressions.py`` and
recomputes each model its own way: fixed effects as explicit sparse dummy matrices, projected out through the
pseudo-inverse of DᵀD (eigendecomposition; its rank is the fixed-effect rank r), no constant unless the model has
no fixed effects, country-clustered CR1 = G/(G−1)·(N−1)/(N−k−r), t(G−1) inference, the X terms' sum, R², adjusted
R², within R² and the clustered Wald F(q, G−1). Coefficients, SE, p, interval ends, the sum, R²s and F must agree
with production within the tolerances below; omitted regressors and errors must match.

Example (repository root):
  uv run python scripts/review_custom_regression.py --panel data/processed/panel_teaching.csv \
      --production dogfood-output/custom-regression-review/production.json \
      --output dogfood-output/custom-regression-review
"""

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import sparse, stats

X_COLUMNS = {0: "teaching_tariff_exposure", 1: "teaching_tariff_exposure_lag1", 2: "teaching_tariff_exposure_lag2"}
EFFECT_SOURCES = {
    "country": ("country",),
    "industry": ("industry",),
    "country_industry": ("entity_id",),
    "year": ("year",),
    "country_year": ("country", "year"),
}
# Relative to the number's own scale (network Ys are in the thousands); production demeans iteratively to 1e-10.
RTOL = 1e-8
ATOL = 1e-10
ABSORBED = 1e-8


def close(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(float(a) - float(b)) <= ATOL + RTOL * max(abs(float(a)), abs(float(b)))


class Projector:
    """Residuals after the fixed effects: x − D (DᵀD)⁺ Dᵀ x, with r = rank(DᵀD)."""

    def __init__(self, frame: pd.DataFrame, effects: list[str]):
        blocks = []
        for key in effects:
            labels = frame[list(EFFECT_SOURCES[key])].astype(str).agg("|".join, axis=1)
            codes, levels = pd.factorize(labels)
            blocks.append(
                sparse.csr_matrix(
                    (np.ones(len(frame)), (np.arange(len(frame)), codes)), shape=(len(frame), len(levels))
                )
            )
        self.dummies = sparse.hstack(blocks).tocsr()
        gram = (self.dummies.T @ self.dummies).toarray()
        values, vectors = np.linalg.eigh(gram)
        keep = values > 1e-9 * values.max()
        self.rank = int(keep.sum())
        self.inverse = (vectors[:, keep] / values[keep]) @ vectors[:, keep].T

    def residual(self, values: np.ndarray) -> np.ndarray:
        return values - self.dummies @ (self.inverse @ (self.dummies.T @ values))


def sample(panel: pd.DataFrame, entry: dict) -> tuple[pd.DataFrame, list[str], list[str]]:
    spec = entry["spec"]
    data = panel.loc[panel["country"].astype(str).ne("ROW")].copy()
    x_columns = [X_COLUMNS[lag] for lag in spec["x_lags"]]
    controls = []
    for item in spec["controls"]:
        name, lag = item["name"], item["lag"]
        if lag == 0:
            controls.append(name)
            continue
        column = f"{name}__lag{lag}"
        earlier = data[["entity_id", "year", name]].assign(year=data["year"] + lag).rename(columns={name: column})
        data = data.merge(earlier, on=["entity_id", "year"], how="left")
        controls.append(column)
    data = data.dropna(subset=[entry["depvar"], *x_columns, *controls]).reset_index(drop=True)
    return data, x_columns, controls


def recompute(data: pd.DataFrame, x_columns: list[str], controls: list[str], entry: dict, projectors: dict) -> dict:
    effects = entry["spec"]["fixed_effects"]
    names = [*x_columns, *controls]
    y_raw = data[entry["depvar"]].to_numpy(float)
    X_raw = data[names].to_numpy(float)
    if effects:
        key = (
            tuple(effects),
            hashlib.sha256(pd.util.hash_pandas_object(data[["entity_id", "year"]], index=False).values).hexdigest(),
        )
        if key not in projectors:
            projectors.clear()  # One sample at a time: the matrices are large.
            projectors[key] = Projector(data, effects)
        projector = projectors[key]
        y, X, rank = projector.residual(y_raw), projector.residual(X_raw), projector.rank
    else:
        y, X, rank = y_raw - y_raw.mean(), X_raw - X_raw.mean(axis=0), 0
    kept, omitted = [], []
    for index, name in enumerate(names):
        raw_norm = float(np.linalg.norm(X_raw[:, index]))
        if raw_norm == 0 or float(np.linalg.norm(X[:, index])) <= ABSORBED * max(1.0, raw_norm):
            omitted.append(name)
        elif np.linalg.matrix_rank(X[:, [*kept, index]]) < len(kept) + 1:
            omitted.append(name)
        else:
            kept.append(index)
    if not any(names[index] in x_columns for index in kept):
        return {"error": True, "omitted": omitted}
    X = X[:, kept]
    kept_names = [names[index] for index in kept]
    if not effects:
        # Without fixed effects the constant is estimated: back to raw levels with a column of ones.
        X = np.column_stack([X_raw[:, kept], np.ones(len(data))])
        y = y_raw
        kept_names.append("_constant")
    n, k = X.shape
    beta = np.linalg.solve(X.T @ X, X.T @ y)
    residual = y - X @ beta
    clusters, groups = pd.factorize(data["country"])
    g = len(groups)
    scores = np.zeros((g, k))
    np.add.at(scores, clusters, X * residual[:, None])
    bread = np.linalg.inv(X.T @ X)
    covariance = g / (g - 1) * (n - 1) / (n - k - rank) * bread @ (scores.T @ scores) @ bread
    critical = stats.t.ppf(0.975, g - 1)

    def stat(name: str, value: float, se: float) -> dict:
        t = value / se
        return {
            "name": name,
            "coef": value,
            "se": se,
            "t": t,
            "p": float(2 * stats.t.sf(abs(t), g - 1)),
            "ci_low": value - critical * se,
            "ci_high": value + critical * se,
        }

    coefs = [stat(name, float(beta[i]), float(math.sqrt(covariance[i, i]))) for i, name in enumerate(kept_names)]
    weights = np.array([1.0 if name in x_columns else 0.0 for name in kept_names])
    cumulative = stat("cumulative", float(weights @ beta), float(math.sqrt(weights @ covariance @ weights)))
    slopes = [i for i, name in enumerate(kept_names) if name != "_constant"]
    b, v = beta[slopes], covariance[np.ix_(slopes, slopes)]
    f_stat = float(b @ np.linalg.solve(v, b)) / len(slopes)
    rss = float(residual @ residual)
    total = float(((y_raw - y_raw.mean()) ** 2).sum())
    within = float(y @ y) if effects else total
    r2 = 1 - rss / total
    return {
        "coefs": [item for item in coefs if item["name"] != "_constant"],
        "constant": next((item for item in coefs if item["name"] == "_constant"), None),
        "cumulative": cumulative,
        "omitted": omitted,
        "n_obs": n,
        "n_clusters": g,
        "r2": r2,
        "r2_adj": 1 - (1 - r2) * (n - 1) / (n - k - rank),
        "r2_within": 1 - rss / within,
        "f_stat": f_stat,
        "f_df": [len(slopes), g - 1],
        "f_p": float(stats.f.sf(f_stat, len(slopes), g - 1)),
    }


def compare(mine: dict, theirs: dict) -> list[str]:
    problems = []
    if "error" in theirs or "error" in mine:
        if ("error" in theirs) != ("error" in mine):
            problems.append(f"error: production {theirs.get('error')!r}, review {mine.get('error')!r}")
        return problems
    if sorted(mine["omitted"]) != sorted(theirs["omitted"]):
        problems.append(f"omitted {theirs['omitted']} vs {mine['omitted']}")
    if [item["name"] for item in mine["coefs"]] != [item["name"] for item in theirs["coefs"]]:
        return [*problems, "coefficient names differ"]
    pairs = [*zip(mine["coefs"], theirs["coefs"]), (mine["cumulative"], theirs["cumulative"])]
    if mine["constant"] or theirs["constant"]:
        pairs.append((mine["constant"], theirs["constant"]))
    for a, b in pairs:
        if a is None or b is None:
            problems.append("missing coefficient")
            continue
        for field in ("coef", "se", "t", "p", "ci_low", "ci_high"):
            if not close(a[field], b[field]):
                problems.append(f"{a['name']}.{field}: production {b[field]!r}, review {a[field]!r}")
    for field in ("n_obs", "n_clusters", "f_df"):
        if mine[field] != theirs[field]:
            problems.append(f"{field}: production {theirs[field]!r}, review {mine[field]!r}")
    for field in ("r2", "r2_adj", "r2_within", "f_stat", "f_p"):
        if not close(mine[field], theirs[field]):
            problems.append(f"{field}: production {theirs[field]!r}, review {mine[field]!r}")
    return problems


def largest_relative_difference(mine: dict, theirs: dict) -> float:
    if "error" in mine or "error" in theirs:
        return 0.0
    values = []
    for a, b in [*zip(mine["coefs"], theirs["coefs"]), (mine["cumulative"], theirs["cumulative"])]:
        for field in ("coef", "se"):
            values.append(abs(a[field] - b[field]) / max(1.0, abs(b[field])))
    return max(values, default=0.0)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--panel", type=Path, required=True)
    parser.add_argument("--production", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    panel = pd.read_csv(args.panel)
    production = json.loads(args.production.read_text())
    # Group by sample and fixed effects so each projector is built once.
    entries = sorted(
        production["models"],
        key=lambda entry: (entry["controls_setting"] == "lag1", entry["depvar"], entry["spec"]["fixed_effects"]),
    )
    projectors: dict = {}
    failures, worst = [], 0.0
    for index, entry in enumerate(entries, 1):
        data, x_columns, controls = sample(panel, entry)
        mine = recompute(data, x_columns, controls, entry, projectors)
        problems = compare(mine, entry)
        worst = max(worst, largest_relative_difference(mine, entry))
        if problems:
            failures.append({"model": {k: entry[k] for k in ("outcome", "baseline", "spec")}, "problems": problems[:8]})
        if index % 250 == 0:
            print(f"{index}/{len(entries)} reviewed, {len(failures)} failing", flush=True)
    summary = {
        "panel_sha256": hashlib.sha256(args.panel.read_bytes()).hexdigest(),
        "models": len(entries),
        "errors_in_production": sum("error" in entry for entry in entries),
        "benchmark_failures_in_production": sum(entry.get("benchmark_passed") is False for entry in entries),
        "failures": len(failures),
        "largest_relative_difference_coef_se": worst,
        "tolerance": {"rtol": RTOL, "atol": ATOL},
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (args.output / "failures.json").write_text(json.dumps(failures, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
