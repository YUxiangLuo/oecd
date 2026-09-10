"""The browser harness must exercise reportable diagnoses as well as estimates."""

from copy import deepcopy

import pytest

from scripts import seed_full_journey as journey


def _result(status, *, no_pairs=False):
    stopped = status in {"insufficient", "invalid_design"}
    return {
        "status": status,
        "support": {
            "status": status,
            "suppress_inference": stopped,
            "reasons": ["No paired comparisons" if no_pairs else "Insufficient paired control countries"]
            if stopped
            else [],
        },
        "diagnostics": {
            "study_contract": "economics-v2",
            "diagnostic_only": no_pairs,
            "cohort_time_cells": [] if no_pairs else [{"cohort": 2018, "year": 2019}],
        },
        "coefs": []
        if no_pairs
        else [{"name": "ATT", "coef": 0.1, "p": None if stopped else 0.04, "ci_low": None, "ci_high": None}],
    }


@pytest.fixture
def api(monkeypatch):
    state = {"results": {}, "saved": None, "report_gate": [], "material_gate": []}

    def request(_base_url, method, path, **kwargs):
        if path == "/api/auth/login":
            return {"token": "test-token", "user": {"name": "Journey student"}}
        if path == "/api/meta":
            return {"years": [2016, 2020], "countries": ["CHN", "USA"], "dataset": {"release_id": "a" * 32}}
        if path == "/api/classroom/session":
            if method == "GET":
                return {"report": None, "updated_at": "initial-revision"}
            assert kwargs["payload"]["base_updated_at"] == "initial-revision"
            state["saved"] = deepcopy(kwargs["payload"]["session"])
            return {
                "completion": {"completed_count": 14},
                "report_gate": state["report_gate"],
                "material_gate": state["material_gate"],
            }
        if path.startswith("/api/db/slice?"):
            return {"rows": [{"row": "CHN_C26", "USA_C26": 1.2}], "columns": ["row", "USA_C26"]}
        if path.startswith("/api/indicators/country/"):
            return [
                {"country": "CHN", "FVA_share": 0.11, "3b_VA_GVC_C_share": 0.02, "GVCPs": 0.9, "weighted degree": 10.0},
                {"country": "USA", "FVA_share": 0.12, "3b_VA_GVC_C_share": 0.03, "GVCPs": 1.1, "weighted degree": 20.0},
            ]
        if path.startswith("/api/indicators/industry/"):
            return {"rows": [{"industry": "C26"}, {"industry": "C27", "betweenesscentrality": 12.5}], "total": 2}
        if path == "/api/shocks/events":
            return {"events": [{"shock_type": "tariff", "name": "Tariff event"}]}
        if path == "/api/regression/run":
            outcome = kwargs["payload"]["outcome"]
            return {
                "design": {"outcome": outcome, "method": "did", "interaction": False},
                "result": deepcopy(state["results"].get(outcome, _result("ok"))),
            }
        raise AssertionError(f"Unexpected request: {method} {path}")

    monkeypatch.setattr(journey, "_request_json_value", request)
    return state


def test_seed_records_step_observations_like_the_ui(api):
    """Steps 2-8 carry their metric and country values, not just ``compared``."""
    journey.seed_full_journey("http://test", "student", "test-password")

    saved = api["saved"]
    for step, metric in journey._STEP_METRICS.items():
        data = saved["steps"][str(step)]["data"]
        assert data["metric"] == metric
        assert data["compared"] == ["CHN", "USA"]
        assert [item["entity"] for item in data["observations"]] == ["CHN", "USA"]
        assert all(item["metric"] == metric and item["value"] is not None for item in data["observations"])
    # Step 9 records an industry betweenness row instead of a country value.
    step_nine = saved["steps"]["9"]["data"]
    assert step_nine["compared"] == ["CHN", "USA"]
    assert step_nine["metric"] == "betweenesscentrality"
    assert step_nine["observations"][0]["entity"] == "CHN·C27"


@pytest.mark.parametrize("status", ["ok", "warning", "insufficient", "invalid_design", "no_pairs"])
def test_seed_preserves_diagnoses_without_inferential_snapshots(api, status):
    result = _result("insufficient" if status == "no_pairs" else status, no_pairs=status == "no_pairs")
    api["results"]["trade"] = result

    summary = journey.seed_full_journey("http://test", "student", "test-password")

    assert summary["regression_statuses"]["trade"] == result["status"]
    assert summary["completed_steps"] == 14 and summary["report_gate"] == []
    data = api["saved"]["steps"]["11"]["data"]
    assert data["run"]["result"] == result
    if status in {"ok", "warning"}:
        assert data["qualified_run"] == data["run"]
    else:
        assert "qualified_run" not in data
    # Other, inferential families keep their real reference snapshots.
    for step in (12, 13, 14):
        data = api["saved"]["steps"][str(step)]["data"]
        assert data["qualified_run"] == data["run"]


@pytest.mark.parametrize("invalid", ["missing_contract", "missing_reason", "unsuppressed", "forbidden_p", "bad_result"])
def test_seed_rejects_incomplete_or_inconsistent_diagnosis(api, invalid):
    result = _result("insufficient")
    if invalid == "missing_contract":
        result["diagnostics"].pop("study_contract")
    elif invalid == "missing_reason":
        result["support"]["reasons"] = []
    elif invalid == "unsuppressed":
        result["support"]["suppress_inference"] = False
    elif invalid == "forbidden_p":
        result["coefs"][0]["p"] = 0.01
    else:
        result = None
    api["results"]["trade"] = result

    with pytest.raises(RuntimeError, match="trade default regression is not reportable"):
        journey.seed_full_journey("http://test", "student", "test-password")
    assert api["saved"] is None


@pytest.mark.parametrize("gate", ["report_gate", "material_gate"])
def test_seed_still_requires_server_report_gates(api, gate):
    api["results"]["trade"] = _result("insufficient", no_pairs=True)
    api[gate] = ["Server rejected evidence"]

    with pytest.raises(RuntimeError, match="server report gate remained blocked"):
        journey.seed_full_journey("http://test", "student", "test-password")
