"""The browser harness must exercise reportable diagnoses as well as estimates."""

from copy import deepcopy

import pytest
from scipy import stats

from scripts import seed_full_journey as journey
from gvcsim.regression.teaching import X_COLUMN, model_snapshot, variable_catalog


def _result(status):
    stopped = status in {"insufficient", "invalid_design"}
    return {
        "status": status,
        "n_obs": 20,
        "n_entities": 4,
        "n_times": 5,
        "n_clusters": 4,
        "support": {
            "status": status,
            "suppress_inference": stopped,
            "reasons": ["Insufficient treated clusters"] if stopped else [],
        },
        "diagnostics": {
            "study_contract": "economics-v2",
        },
        "coefs": [
            {
                "name": X_COLUMN,
                "coef": 0.1,
                "se": 0.025,
                "t": 4.0,
                "p": None if stopped else float(2 * stats.t.sf(4, 3)),
                "ci_low": None if stopped else float(0.1 - stats.t.ppf(0.975, 3) * 0.025),
                "ci_high": None if stopped else float(0.1 + stats.t.ppf(0.975, 3) * 0.025),
            }
        ],
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
        if path.startswith("/api/regression/teaching-panel?"):
            return {
                "version": journey.TEACHING_VERSION,
                "rows": [
                    {
                        "country": "CHN",
                        "industry": "C26",
                        "year": 2020,
                        "teaching_export_share_w": 0.2,
                        "teaching_tariff_rate_tau": 0.1,
                        "teaching_tariff_exposure": 0.02,
                    }
                ],
            }
        if path == "/api/regression/run":
            outcome = kwargs["payload"]["outcome"]
            return {
                "design": {
                    "outcome": outcome,
                    "granularity": "country_industry",
                    "shock_type": "tariff",
                    "method": "twfe_intensity",
                    "control_mode": "none",
                    "interaction": False,
                    "scenario": "clean",
                },
                "result": deepcopy(state["results"].get(outcome, _result("ok"))),
                "model_snapshot": model_snapshot(outcome),
                "variable_catalog": variable_catalog(outcome),
            }
        raise AssertionError(f"Unexpected request: {method} {path}")

    monkeypatch.setattr(journey, "_request_json_value", request)
    return state


def test_seed_json_helpers_enforce_expected_shape(api, monkeypatch):
    """The object/array wrappers must reject the wrong JSON shape.

    The seed's stub replaces the shared HTTP seam, so without this the shape
    checks that guard real requests would go untested.
    """
    monkeypatch.setattr(journey, "_request_json_value", lambda *_a, **_k: [1, 2])
    with pytest.raises(RuntimeError, match="did not return a JSON object"):
        journey._request_json("http://test", "GET", "/x")

    monkeypatch.setattr(journey, "_request_json_value", lambda *_a, **_k: {"rows": []})
    with pytest.raises(RuntimeError, match="did not return a JSON array"):
        journey._request_json_rows("http://test", "token", "/x")


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
        if step in journey._EXPLICIT_INDICATOR_UNITS:
            assert all(
                item
                == {
                    **item,
                    "unit": journey._EXPLICIT_INDICATOR_UNITS[step],
                    "release": "a" * 32,
                    "scope": "country",
                    "source": (
                        "explicit-indicator-table-comparison"
                        if step in (2, 3, 4, 5)
                        else "explicit-indicator-comparison"
                    ),
                }
                for item in data["observations"]
            )
    # Step 9 records one industry betweenness ranking row per country.
    step_nine = saved["steps"]["9"]["data"]
    assert step_nine["compared"] == ["CHN", "USA"]
    assert step_nine["metric"] == "betweenesscentrality"
    assert [item["entity"] for item in step_nine["observations"]] == ["CHN·C27", "USA·C27"]
    assert all(
        item
        == {
            **item,
            "unit": "未归一化介数",
            "release": "a" * 32,
            "scope": "country-industry",
            "source": "explicit-network-ranking",
        }
        for item in step_nine["observations"]
    )
    assert saved["steps"]["10"]["data"] == {
        "quiz": saved["steps"]["10"]["data"]["quiz"],
        "compared": ["CHN", "USA"],
        "teaching_industry": "C26",
        "teaching_country": "CHN",
        "teaching_year": 2020,
        "viewed_teaching_panel": True,
        "teaching_panel_version": journey.TEACHING_VERSION,
        "teaching_observation": {
            "country": "CHN",
            "industry": "C26",
            "year": 2020,
            "teaching_export_share_w": 0.2,
            "teaching_tariff_rate_tau": 0.1,
            "teaching_tariff_exposure": 0.02,
            "version": journey.TEACHING_VERSION,
        },
    }
    for step in range(11, 15):
        run = saved["steps"][str(step)]["data"]["run"]
        assert run["design"]["method"] == "twfe_intensity"
        assert run["model_snapshot"]["version"] == journey.TEACHING_VERSION
        assert run["variable_catalog"]


@pytest.mark.parametrize("status", ["ok", "warning", "insufficient", "invalid_design"])
def test_seed_preserves_diagnoses_without_inferential_snapshots(api, status):
    result = _result(status)
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
    api[gate] = ["Server rejected evidence"]

    with pytest.raises(RuntimeError, match="server report gate remained blocked"):
        journey.seed_full_journey("http://test", "student", "test-password")
