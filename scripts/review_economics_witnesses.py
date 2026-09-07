"""Reproduce numerical findings in docs/economics-review-20260907.md.

Run from the repository root with PYTHONPATH=. uv run python
scripts/review_economics_witnesses.py. Only synthetic, in-memory panels are used.
Assertions now reject unsupported inference; original numerical evidence remains
in docs/economics-review-20260907-evidence.json.
"""

import json
from pathlib import Path
from types import SimpleNamespace
import numpy as np
import pandas as pd
from gvcsim.indicators.core import build_arrays
from gvcsim.indicators import tradeflow, production, length
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.panel import run_design_with_benchmark


def arrays(Z, Y):
    Z = np.array(Z, dtype=float)
    Y = np.array(Y, dtype=float)
    n = len(Z)
    regions = [f"R{i}" for i in range(n)]
    idx = pd.MultiIndex.from_product([regions, ["s"]], names=["region", "sector"])
    cols = pd.MultiIndex.from_product([regions, ["final"]])
    x = Z.sum(1) + Y.sum(1)
    A = Z / x[None, :]
    io = SimpleNamespace(
        Z=pd.DataFrame(Z, index=idx, columns=idx),
        Y=pd.DataFrame(Y, index=idx, columns=cols),
        x=pd.DataFrame({"x": x}, index=idx),
        A=pd.DataFrame(A, index=idx, columns=idx),
        L=pd.DataFrame(np.linalg.inv(np.eye(n) - A), index=idx, columns=idx),
    )
    return build_arrays(io)


results = {}
for scale in [1, 7]:
    a = arrays(np.array([[0, 30], [20, 0]]) * scale, np.array([[40, 10], [10, 40]]) * scale)
    df = tradeflow.sector_tradeflow(a)
    foreign = (a.v @ a.B - np.diag(a.B) * a.v) * a.E
    assert np.allclose(foreign, df.FVA + df.FDC) and np.max(abs(foreign - df.FVA)) > 1
    results[f"fva_scale_{scale}"] = {
        "exports": a.E.tolist(),
        "TLS": a.taxsub.tolist(),
        "wwz_fva": df.FVA.tolist(),
        "wwz_fdc": df.FDC.tolist(),
        "foreign_vB_exports": foreign.tolist(),
        "course_share": (df.FVA / a.E).tolist(),
        "gross_foreign_share": (foreign / a.E).tolist(),
    }
for scale in [1, 3]:
    a = arrays(
        np.array([[0, 20, 0], [0, 0, 0], [0, 0, 0]]) * scale, np.array([[10, 0, 0], [0, 0, 40], [0, 0, 30]]) * scale
    )
    p = production.sector_production(a)
    ell = length.sector_length(a)
    assert np.isclose(p["3b_VA_GVC_C"].iloc[0], 20 * scale) and np.isclose(p["3a_VA_GVC_S"].iloc[0], 0)
    results[f"complex_one_intermediate_scale_{scale}"] = {
        "description": "R0 intermediate to R1; R1 final good to R2",
        "R0_complex_VA": float(p["3b_VA_GVC_C"].iloc[0]),
        "R0_simple_VA": float(p["3a_VA_GVC_S"].iloc[0]),
        "R0_PLv_GVC": float(ell["PLv_GVC"].iloc[0]),
    }
for seed in [41, 42]:
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(40):
        for year in range(2016, 2021):
            treated = i < 20 and year >= 2018
            y = 0.3 + 0.003 * i + 0.001 * (year - 2016) + rng.normal(0, 0.002) + (0.06 if treated else 0)
            if 2 <= i < 20 and year == 2017:
                y = np.nan
            rows.append(
                {
                    "country": f"C{i:02}",
                    "year": year,
                    "FVA_share": y,
                    "treated": int(treated),
                    "tariff_shock": 0.05 if treated else 0,
                }
            )
    frame = pd.DataFrame(rows)
    res, bench = run_design_with_benchmark(frame, RegressionDesign("trade", granularity="country"))
    d = res.to_dict()
    cells = d["diagnostics"]["cohort_time_cells"]
    results[f"paired_support_seed_{seed}"] = {
        "status": d["status"],
        "declared_treated_clusters": d["support"]["treated_clusters"],
        "actual_cell_treated_clusters": [c["treated_clusters"] for c in cells],
        "coefs": d["coefs"],
        "benchmark_passed": bench["benchmark_passed"],
    }
    assert (
        d["support"]["treated_clusters"] == 2
        and max(c["treated_clusters"] for c in cells) == 2
        and d["coefs"][0]["p"] is None
    )
for seed in [41, 42]:
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(50):
        for year in range(2016, 2021):
            treated = i < 30 and year >= 2018
            y = 0.3 + 0.003 * i + 0.001 * (year - 2016) + rng.normal(0, 0.002) + (0.06 if treated else 0)
            if i < 30 and ((i >= 16 and year == 2017) or (2 <= i < 16 and year >= 2018)):
                y = np.nan
            rows.append(
                {
                    "country": f"C{i:02}",
                    "year": year,
                    "FVA_share": y,
                    "treated": int(treated),
                    "tariff_shock": 0.05 if treated else 0,
                }
            )
    frame = pd.DataFrame(rows)
    res, bench = run_design_with_benchmark(
        frame, RegressionDesign("trade", granularity="country", method="event_study")
    )
    d = res.to_dict()
    cells = d["diagnostics"]["cohort_time_cells"]
    results[f"event_paired_support_seed_{seed}"] = {
        "status": d["status"],
        "declared_treated_clusters": d["support"]["treated_clusters"],
        "actual_cells": [{k: c[k] for k in ["event_time", "treated_clusters", "control_clusters"]} for c in cells],
        "event_support": d["event_support"],
        "coefs": d["coefs"],
    }
    assert max(c["treated_clusters"] for c in cells if c["event_time"] >= 0) == 2 and all(
        c["p"] is None for c in d["coefs"] if c["name"] in {"k=0", "k=+1", "k=+2"}
    )
did_equation = RegressionDesign("trade", method="did").equation()
event_equation = RegressionDesign("trade", method="event_study").equation()
assert did_equation.split(" = ", 1)[1] != event_equation.split(" = ", 1)[1]
results["event_equation"] = {"overall": did_equation, "dynamic": event_equation, "identical_rhs": False}
out = Path("dogfood-output/economics-review-20260907/fixed-cases.json")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(results, ensure_ascii=False, indent=2))
print(json.dumps(results, ensure_ascii=False, indent=2))
