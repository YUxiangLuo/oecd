"""Parse saved runs for the one model supported by the teaching report.

This boundary intentionally knows nothing about DID, event studies, cohorts,
interactions, or alternative controls.  Those are regression-workbench concepts,
not report-compatible teaching runs.
"""

from __future__ import annotations

import json
import math
from typing import Any, cast

from scipy import stats

from gvcsim.numeric import finite_number
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.teaching import Y_COLUMNS, default_baseline, model_snapshot, variable_catalog
from gvcsim.steps import STEPS

_STEP_OUTCOMES = {
    cast(int, item["n"]): str(item["regression_outcome"]) for item in STEPS if item.get("regression_outcome")
}
_FIXED_FIELDS = ("granularity", "shock_type", "method", "control_mode", "interaction", "scenario")


def _course_design(design: dict[str, Any]) -> RegressionDesign | None:
    """The course default design of the saved run's outcome, or None unless the run names it with the step's
    default Y."""
    outcome = design.get("outcome")
    if outcome not in Y_COLUMNS or design.get("baseline") != default_baseline(outcome).key:
        return None
    return RegressionDesign(outcome, teaching=True, baseline=design["baseline"])


def _fixed_design_matches(design: dict[str, Any]) -> bool:
    """A step's saved result must be the course default model (the workbench keeps other models separately)."""
    canonical = _course_design(design) if isinstance(design, dict) else None
    if canonical is None:
        return False
    # The model itself: a v10 run always records it (the snapshot check pins the release's teaching version).
    if design.get("spec") != canonical.spec.to_dict():  # type: ignore[union-attr]
        return False
    return all(design.get(key) == getattr(canonical, key) for key in _FIXED_FIELDS)


def _parse_saved_run(raw: Any, outcome: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    if not isinstance(raw, dict) or outcome not in Y_COLUMNS:
        return None
    design, result = raw.get("design"), raw.get("result")
    snapshot, catalog = raw.get("model_snapshot"), raw.get("variable_catalog")
    if not isinstance(design, dict) or design.get("outcome") != outcome or not isinstance(result, dict):
        return None
    if not _fixed_design_matches(design):
        return None
    baseline = design["baseline"]
    # JSON persistence changes calibration tuples to lists. Compare the complete
    # published model, not just its version and variable names.
    if json.loads(json.dumps(snapshot)) != json.loads(json.dumps(model_snapshot(outcome, baseline))):
        return None
    if catalog != variable_catalog(outcome, baseline):
        return None
    canonical = RegressionDesign(outcome, teaching=True, baseline=baseline)
    fields = (
        "baseline",
        "baseline_label",
        "depvar",
        "depvar_label",
        "depvar_kind",
        "depvar_unit",
        "shock_col",
        "treated_col",
        "entity",
        "cluster",
        "price_mode",
        "price_mode_label",
        "exclude_row",
        "sample_filter",
        "panel_file",
        "granularity_label",
        "shock_type_label",
        "method_label",
        "control_mode_label",
        "scenario_label",
        "control_labels",
    )
    if any(design.get(key) != getattr(canonical, key) for key in fields):
        return None
    if design.get("controls") != list(canonical.controls) or design.get("equation") != canonical.equation():
        return None
    if not _result_is_reportable(result, design):
        return None
    return design, result


def _estimate_is_consistent(coefficient: Any, n_clusters: int, inferential: bool) -> bool:
    """coef/se/t are finite with t = coef/se; with inference, p and the 95% interval follow from t(G − 1)."""
    if not isinstance(coefficient, dict) or not all(finite_number(coefficient.get(f)) for f in ("coef", "se", "t")):
        return False
    beta, se = float(coefficient["coef"]), float(coefficient["se"])
    if se <= 0 or not math.isclose(float(coefficient["t"]), beta / se, rel_tol=1e-8, abs_tol=1e-10):
        return False
    if not inferential:
        return all(coefficient.get(key) is None for key in ("p", "ci_low", "ci_high"))
    if not all(finite_number(coefficient.get(f)) for f in ("p", "ci_low", "ci_high")):
        return False
    if not (0 <= coefficient["p"] <= 1 and coefficient["ci_low"] <= beta <= coefficient["ci_high"]):
        return False
    # SciPy needs a numeric dtype; finite JSON integers above int64 otherwise become object arrays.
    degrees_of_freedom = float(n_clusters - 1)
    critical = float(stats.t.ppf(0.975, degrees_of_freedom))
    expected = {
        "p": float(2 * stats.t.sf(abs(beta / se), degrees_of_freedom)),
        "ci_low": beta - critical * se,
        "ci_high": beta + critical * se,
    }
    return all(
        math.isclose(float(coefficient[key]), value, rel_tol=1e-8, abs_tol=1e-10) for key, value in expected.items()
    )


def _result_is_reportable(result: dict[str, Any], design: dict[str, Any]) -> bool:
    """The saved result of the course default model: its X terms and controls in order, each internally consistent,
    and the cumulative relation of the X terms (the step's headline) equal to their sum."""
    if not isinstance(design, dict) or not _fixed_design_matches(design):
        return False
    canonical = _course_design(design)
    assert canonical is not None
    support = result.get("support")
    diagnostics = result.get("diagnostics")
    coefs = result.get("coefs")
    if not isinstance(support, dict) or not isinstance(diagnostics, dict) or not isinstance(coefs, list):
        return False
    status = result.get("status")
    if (
        not isinstance(status, str)
        or status not in {"ok", "warning", "insufficient", "invalid_design"}
        or support.get("status") != status
    ):
        return False
    if diagnostics.get("study_contract") != "economics-v2":
        return False
    counts = [result.get(key) for key in ("n_obs", "n_entities", "n_times", "n_clusters")]
    if any(type(value) is not int or value <= 0 or not finite_number(value) for value in counts):
        return False
    n_obs, n_entities, n_times, n_clusters = cast(list[int], counts)
    if not (2 <= n_clusters <= n_entities <= n_obs and 2 <= n_times <= n_obs <= n_entities * n_times):
        return False
    expected_names = [*canonical.regressors, *canonical.controls]
    if [item.get("name") if isinstance(item, dict) else None for item in coefs] != expected_names:
        return False
    inferential = status in {"ok", "warning"}
    if inferential and support.get("suppress_inference") is True:
        return False
    if not all(_estimate_is_consistent(item, n_clusters, inferential) for item in coefs):
        return False
    cumulative = result.get("cumulative")
    if not _estimate_is_consistent(cumulative, n_clusters, inferential):
        return False
    assert isinstance(cumulative, dict)
    x_sum = sum(float(item["coef"]) for item in coefs if item["name"] in canonical.regressors)
    if not math.isclose(float(cumulative["coef"]), x_sum, rel_tol=1e-9, abs_tol=1e-12):
        return False
    if inferential:
        return True
    reasons = support.get("reasons")
    return (
        support.get("suppress_inference") is True
        and isinstance(reasons, list)
        and bool(reasons)
        and all(isinstance(reason, str) and reason.strip() for reason in reasons)
    )


def _saved_runs(session: dict[str, Any]) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for step, outcome in sorted(_STEP_OUTCOMES.items()):
        data = session.get("steps", {}).get(str(step), {}).get("data", {})
        raw = data.get("run") if isinstance(data, dict) else None
        parsed = _parse_saved_run(raw, outcome)
        if parsed is not None:
            design, result = parsed
            assert isinstance(raw, dict)
            runs.append(
                {
                    "step": step,
                    "outcome": outcome,
                    "design": design,
                    "result": result,
                    "model_snapshot": raw["model_snapshot"],
                    "variable_catalog": raw["variable_catalog"],
                }
            )
    return runs


def server_runs(session: dict[str, Any], panel: Any, release: str) -> list[dict[str, Any]]:
    """Saved runs select completed steps/Ys, never the report's numeric values."""
    from gvcsim.regression_routes import cached_run

    runs = []
    seen = set()
    for saved in _saved_runs(session):
        design = _course_design(saved["design"])
        assert design is not None
        identity = (saved["step"], design.baseline)
        if identity in seen:
            continue
        seen.add(identity)
        payload = cached_run(panel, design, release)
        runs.append(
            {
                "step": saved["step"],
                "outcome": saved["outcome"],
                **{key: payload[key] for key in ("design", "result", "model_snapshot", "variable_catalog")},
            }
        )
    return runs


__all__ = ["_parse_saved_run", "_result_is_reportable", "_saved_runs"]
