"""Production side of the workbench's independent review: every model the workbench offers, on the teaching panel.

Every normalised fixed-effect set × the 7 combinations of X, L1.X, L2.X × three control settings (none, all four
at lag 0, all four at lag 1) × every Y a page may choose, computed with the production estimator and written to
JSON for ``scripts/review_custom_regression.py`` (which recomputes them without importing gvcsim).

Example (repository root):
  PYTHONPATH=. uv run python scripts/dump_custom_regressions.py --source data/processed \
      --output dogfood-output/custom-regression-review/production.json
"""

import argparse
import itertools
import json
import time
from pathlib import Path

import pandas as pd

from gvcsim.regression import teaching
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.panel import run_design_with_benchmark
from gvcsim.regression.spec import CONTROLS, FIXED_EFFECTS, X_LAGS, ModelSpec

CONTROL_SETTINGS = {
    "none": (),
    "lag0": tuple((key, 0) for key in CONTROLS),
    "lag1": tuple((key, 1) for key in CONTROLS),
}


def effect_sets() -> list[tuple[str, ...]]:
    seen: dict[tuple[str, ...], None] = {}
    for size in range(len(FIXED_EFFECTS) + 1):
        for chosen in itertools.combinations(FIXED_EFFECTS, size):
            seen.setdefault(ModelSpec((0,), (), chosen).canonical().fixed_effects, None)
    return list(seen)


def x_sets() -> list[tuple[int, ...]]:
    return [combo for size in range(1, len(X_LAGS) + 1) for combo in itertools.combinations(X_LAGS, size)]


def _coef(item):
    return None if item is None else {key: item[key] for key in ("name", "coef", "se", "t", "p", "ci_low", "ci_high")}


def dump(source: Path) -> dict:
    panel = pd.read_csv(source / "panel_teaching.csv")
    models = []
    pairs = [
        (outcome, item)
        for outcome in teaching.OUTCOMES
        for item in teaching.selectable_baselines(outcome)
        if teaching.y_column(outcome, item.key) in panel.columns
    ]
    started = time.monotonic()
    for outcome, item in pairs:
        for effects in effect_sets():
            for x_lags in x_sets():
                for setting, controls in CONTROL_SETTINGS.items():
                    spec = ModelSpec(x_lags, controls, effects).canonical()
                    design = RegressionDesign(outcome, teaching=True, baseline=item.key, spec=spec)
                    entry = {
                        "outcome": outcome,
                        "baseline": item.key,
                        "depvar": design.depvar,
                        "controls_setting": setting,
                        "spec": spec.to_dict(),
                    }
                    try:
                        result, benchmark = run_design_with_benchmark(panel, design)
                    except ValueError as error:
                        entry["error"] = str(error)
                    else:
                        info = result.to_dict()
                        entry.update(
                            {
                                "coefs": [_coef(coefficient) for coefficient in info["coefs"]],
                                "cumulative": _coef(info["cumulative"]),
                                "constant": _coef(info["constant"]),
                                "omitted": [omitted["name"] for omitted in info["omitted"]],
                                **{
                                    key: info[key]
                                    for key in (
                                        "n_obs",
                                        "n_clusters",
                                        "r2",
                                        "r2_adj",
                                        "r2_within",
                                        "f_stat",
                                        "f_df",
                                        "f_p",
                                    )
                                },
                                "benchmark_passed": bool(benchmark["benchmark_passed"]),
                            }
                        )
                    models.append(entry)
        print(f"{outcome}:{item.key} done ({len(models)} models, {time.monotonic() - started:.0f}s)", flush=True)
    return {"panel": str(source / "panel_teaching.csv"), "version": teaching.VERSION, "models": models}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("data/processed"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(dump(args.source), ensure_ascii=False) + "\n")
