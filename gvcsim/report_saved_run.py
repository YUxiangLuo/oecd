"""Parse saved runs for the one model supported by the teaching report.

This boundary intentionally knows nothing about DID, event studies, cohorts,
interactions, or alternative controls.  Those are regression-workbench concepts,
not report-compatible teaching runs.
"""

from __future__ import annotations

import json
import math
from typing import Any, cast

from gvcsim.regression.teaching import X_COLUMN, Y_COLUMNS
from gvcsim.steps import STEPS

_STEP_OUTCOMES = {
    cast(int, item["n"]): str(item["regression_outcome"])
    for item in STEPS
    if item.get("regression_outcome")
}
_FIXED_DESIGN = {
    "granularity": "country_industry",
    "shock_type": "tariff",
    "method": "twfe_intensity",
    "control_mode": "none",
    "interaction": False,
    "scenario": "clean",
}


def _parse_saved_run(raw: Any, outcome: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    if not isinstance(raw, dict) or outcome not in Y_COLUMNS:
        return None
    design, result = raw.get("design"), raw.get("result")
    snapshot, catalog = raw.get("model_snapshot"), raw.get("variable_catalog")
    if not isinstance(design, dict) or design.get("outcome") != outcome or not isinstance(result, dict):
        return None
    if any(design.get(key) != value for key, value in _FIXED_DESIGN.items()):
        return None
    if not isinstance(snapshot, dict) or snapshot.get("version") != "step10-tariff-teaching-v1":
        return None
    if snapshot.get("x_columns") != [X_COLUMN] or snapshot.get("y_column") != Y_COLUMNS[outcome]:
        return None
    if snapshot.get("controls") != [] or snapshot.get("interactions") != []:
        return None
    if not isinstance(catalog, list):
        return None
    roles = {(item.get("role"), item.get("name")) for item in catalog if isinstance(item, dict)}
    if ("X", X_COLUMN) not in roles or ("Y", Y_COLUMNS[outcome]) not in roles:
        return None
    if not _result_is_reportable(result, design):
        return None
    return design, result


def _result_is_qualified(result: dict[str, Any], design: dict[str, Any] | None = None) -> bool:
    if not isinstance(design, dict) or not _result_is_reportable(result, design):
        return False
    support = result.get("support")
    support = support if isinstance(support, dict) else {}
    statuses = [value for value in (result.get("status"), support.get("status")) if isinstance(value, str)]
    return bool(statuses) and all(value in {"ok", "warning"} for value in statuses) and support.get("suppress_inference") is not True


def _result_is_reportable(result: dict[str, Any], design: dict[str, Any]) -> bool:
    if not isinstance(design, dict) or any(design.get(key) != value for key, value in _FIXED_DESIGN.items()):
        return False
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
    if len(coefs) != 1 or not isinstance(coefs[0], dict) or coefs[0].get("name") != X_COLUMN:
        return False
    coefficient = coefs[0]
    numeric_fields = ("coef", "se", "t")
    if any(
        isinstance(coefficient.get(field), bool)
        or not isinstance(coefficient.get(field), (int, float))
        or not math.isfinite(float(coefficient[field]))
        for field in numeric_fields
    ):
        return False
    if float(coefficient["se"]) <= 0:
        return False
    if status in {"ok", "warning"}:
        inference = ("p", "ci_low", "ci_high")
        if support.get("suppress_inference") is True or any(
            isinstance(coefficient.get(field), bool)
            or not isinstance(coefficient.get(field), (int, float))
            or not math.isfinite(float(coefficient[field]))
            for field in inference
        ):
            return False
        return (
            0 <= float(coefficient["p"]) <= 1
            and float(coefficient["ci_low"]) <= float(coefficient["ci_high"])
        )
    reasons = support.get("reasons")
    return (
        support.get("suppress_inference") is True
        and isinstance(reasons, list)
        and bool(reasons)
        and all(coefficient.get(key) is None for key in ("p", "ci_low", "ci_high"))
    )


def _saved_runs(session: dict[str, Any]) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for step, outcome in sorted(_STEP_OUTCOMES.items()):
        data = session.get("steps", {}).get(str(step), {}).get("data", {})
        seen: set[str] = set()
        for key in ("run", "qualified_run"):
            raw = data.get(key) if isinstance(data, dict) else None
            parsed = _parse_saved_run(raw, outcome)
            if parsed is None:
                continue
            design, result = parsed
            identity = json.dumps({"design": design, "result": result}, sort_keys=True, ensure_ascii=False)
            if identity in seen:
                continue
            seen.add(identity)
            assert isinstance(raw, dict)
            runs.append({"step": step, "outcome": outcome, "design": design, "result": result,
                         "model_snapshot": raw["model_snapshot"], "variable_catalog": raw["variable_catalog"]})
    return runs


def _gate_qualified_runs(session: dict[str, Any]) -> list[dict[str, Any]]:
    return [run for run in _saved_runs(session) if _result_is_qualified(run["result"], run["design"])]


__all__ = ["_gate_qualified_runs", "_parse_saved_run", "_result_is_qualified", "_result_is_reportable", "_saved_runs"]
