"""Saved evidence must describe one internally consistent fixed-model result."""

from copy import deepcopy
import json
import math

import pytest

from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.teaching import EXCHANGE_RATE_COLUMN, X_COLUMN, X_LAG_COLUMNS, model_snapshot, variable_catalog
from gvcsim.regression_routes import _design_info
from gvcsim.report_saved_run import _parse_saved_run


def saved_run(outcome="trade"):
    # With G=2, t(1) is Cauchy: derive p and the 97.5% quantile
    # independently of scipy and the production estimator.
    critical = math.tan(math.pi * (0.975 - 0.5))

    def estimate(name, coef, se):
        t = coef / se
        return {
            "name": name,
            "coef": coef,
            "se": se,
            "t": t,
            "p": 1 - 2 * math.atan(abs(t)) / math.pi,
            "ci_low": coef - critical * se,
            "ci_high": coef + critical * se,
        }

    return {
        "design": _design_info(RegressionDesign(outcome, teaching=True)),
        "model_snapshot": model_snapshot(outcome),
        "variable_catalog": variable_catalog(outcome),
        "result": {
            "status": "warning",
            "support": {"status": "warning", "suppress_inference": False},
            "diagnostics": {"study_contract": "economics-v2"},
            "n_obs": 9,
            "n_entities": 3,
            "n_times": 4,
            "n_clusters": 2,
            # The course model (data v10): X, L1.X and the exchange rate; the headline is the X terms' sum.
            "coefs": [
                estimate(X_COLUMN, -1.25, 0.5),
                estimate(X_LAG_COLUMNS[1], -0.75, 0.5),
                estimate(EXCHANGE_RATE_COLUMN, 0.25, 0.5),
                estimate("teaching_log_gdp", 0.03, 0.5),
                estimate("teaching_trade_openness", 0.001, 0.5),
            ],
            "cumulative": estimate("cumulative", -2.0, 0.5),
        },
    }


@pytest.mark.parametrize("outcome", ["trade", "production", "length", "network"])
def test_valid_unbalanced_snapshot_survives_json(outcome):
    assert _parse_saved_run(json.loads(json.dumps(saved_run(outcome))), outcome) is not None


def test_browser_integer_serialization_preserves_numeric_snapshot_identity():
    run = json.loads(json.dumps(saved_run("network")))
    # JSON.stringify in the browser serializes -6000.0 as -6000.
    run["model_snapshot"]["beta"] = int(run["model_snapshot"]["beta"])
    assert _parse_saved_run(run, "network") is not None


@pytest.mark.parametrize(
    "section,key,value",
    [
        ("result", "n_obs", -123),
        ("result", "n_entities", -4),
        ("result", "n_clusters", -2),
        ("result", "n_times", 0),
        ("result", "n_clusters", True),
        ("result", "n_clusters", 4),
        ("result", "n_obs", 13),
        ("result", "n_entities", 10),
        ("model_snapshot", "beta", 123456),
        ("model_snapshot", "seed", 1),
        ("model_snapshot", "fixed_effects", []),
        ("model_snapshot", "market", "CHN"),
        ("design", "depvar", "wrong_y"),
        ("design", "cluster", "entity_id"),
        ("design", "controls", ["gdp"]),
        ("design", "equation", "y=x"),
    ],
)
def test_rejects_inconsistent_counts_and_metadata(section, key, value):
    run = saved_run()
    run[section][key] = value
    assert _parse_saved_run(run, "trade") is None


@pytest.mark.parametrize(
    "key,value",
    [
        ("coef", 9),
        ("se", 1),
        ("t", 0),
        ("p", 0.5),
        ("ci_low", -2),
        ("ci_high", -1),
        ("ci_low", None),
    ],
)
def test_rejects_inconsistent_inference(key, value):
    run = saved_run()
    run["result"]["coefs"][0][key] = value
    assert _parse_saved_run(run, "trade") is None


@pytest.mark.parametrize("status", ["insufficient", "invalid_design"])
def test_complete_stopped_diagnosis_remains_reportable(status):
    run = saved_run()
    run["result"].update(
        status=status,
        support={
            "status": status,
            "suppress_inference": True,
            "reasons": ["支持不足"],
        },
    )
    for coefficient in [*run["result"]["coefs"], run["result"]["cumulative"]]:
        coefficient.update(p=None, ci_low=None, ci_high=None)
    assert _parse_saved_run(deepcopy(run), "trade") is not None
    run["result"]["n_entities"] = -4
    assert _parse_saved_run(run, "trade") is None


@pytest.mark.parametrize("key,value", [("coef", -1.5), ("t", -2.0), ("p", 0.5), ("ci_low", None)])
def test_rejects_a_cumulative_estimate_that_is_not_the_x_terms_sum_or_is_inconsistent(key, value):
    run = saved_run()
    run["result"]["cumulative"][key] = value
    assert _parse_saved_run(run, "trade") is None


def test_rejects_a_result_without_the_course_models_terms():
    run = saved_run()
    run["result"]["coefs"] = run["result"]["coefs"][:1]
    assert _parse_saved_run(run, "trade") is None
    run = saved_run()
    del run["result"]["cumulative"]
    assert _parse_saved_run(run, "trade") is None
