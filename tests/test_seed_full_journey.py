"""The browser harness must exercise reportable diagnoses as well as estimates."""

from copy import deepcopy

import pytest
from scipy import stats

from scripts import seed_full_journey as journey
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression_routes import _design_info
from gvcsim.report_gate import _table_comparison_complete, check_material_gate
from gvcsim.regression.teaching import EXCHANGE_RATE_COLUMN, X_COLUMN, X_LAG_COLUMNS, model_snapshot, variable_catalog


def _result(status):
    stopped = status in {"insufficient", "invalid_design"}

    def estimate(name, coef, se=0.025):
        return {
            "name": name,
            "coef": coef,
            "se": se,
            "t": coef / se,
            "p": None if stopped else float(2 * stats.t.sf(abs(coef / se), 3)),
            "ci_low": None if stopped else float(coef - stats.t.ppf(0.975, 3) * se),
            "ci_high": None if stopped else float(coef + stats.t.ppf(0.975, 3) * se),
        }

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
        # The course model (data v10): X, L1.X and the exchange rate; the X terms' sum is the headline.
        "coefs": [
            estimate(X_COLUMN, 0.06),
            estimate(X_LAG_COLUMNS[1], 0.04),
            estimate(EXCHANGE_RATE_COLUMN, 0.01),
            estimate("teaching_log_gdp", 0.03),
            estimate("teaching_trade_openness", 0.001),
        ],
        "cumulative": estimate("cumulative", 0.1),
    }


@pytest.fixture
def api(monkeypatch):
    state = {
        "results": {},
        "saved": None,
        "report_gate": [],
        "material_gate": [],
        "requests": [],
        "quizzes": {str(step): journey.quizzes.public_quiz(step) for step in range(1, 15)},
    }

    def request(_base_url, method, path, **kwargs):
        state["requests"].append((method, path))
        if path == "/api/auth/login":
            return {"token": "test-token", "user": {"name": "Journey student"}}
        if path == "/api/meta":
            return {"years": [2016, 2020], "countries": ["CHN", "USA"], "dataset": {"release_id": "a" * 32}}
        if path == "/api/classroom/session":
            if method == "GET":
                return {"report": None, "updated_at": "initial-revision", "quizzes": state["quizzes"]}
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
                # The design exactly as the run endpoint describes the course default model.
                "design": _design_info(RegressionDesign(outcome, teaching=True)),
                "result": deepcopy(state["results"].get(outcome, _result("ok"))),
                "model_snapshot": model_snapshot(outcome),
                "variable_catalog": variable_catalog(outcome),
            }
        raise AssertionError(f"Unexpected request: {method} {path}")

    monkeypatch.setattr(journey, "_request_json_value", request)
    return state


@pytest.mark.parametrize("change", ["missing", "version", "prompt", "options", "kind", "step"])
def test_seed_rejects_nondefault_public_quizzes_before_work(api, change):
    if change == "missing":
        api["quizzes"] = None
    elif change == "step":
        api["quizzes"].pop("14")
    elif change == "version":
        # Even restored default content retains a newer step version.
        api["quizzes"]["1"]["version"] = "quiz-step-1-r2"
    else:
        question = api["quizzes"]["1"]["questions"][0]
        question[change] = {"prompt": "Changed", "options": [], "kind": "true_false"}[change]
    with pytest.raises(RuntimeError, match="requires current default quiz versions"):
        journey.seed_full_journey("http://test", "student", "test-password")
    assert api["saved"] is None
    assert api["requests"] == [
        ("POST", "/api/auth/login"),
        ("GET", "/api/meta"),
        ("GET", "/api/classroom/session"),
    ]


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
    """Steps 2-5 record one country's reading as the page does; steps 6-8 compare two countries."""
    journey.seed_full_journey("http://test", "student", "test-password")

    saved = api["saved"]
    # Steps 2-5: the shape of indicatorMaterialPatch (frontend/src/labs/steps/indicator/indicator-table.tsx).
    for step, (metric, unit) in journey._SINGLE_COUNTRY_STEPS.items():
        data = saved["steps"][str(step)]["data"]
        assert {key: data[key] for key in ("year", "country", "compared", "metric")} == {
            "year": 2020,
            "country": "CHN",
            "compared": ["CHN"],
            "metric": metric,
        }
        [observation] = data["observations"]
        assert observation == {
            "entity": "CHN",
            "country": "CHN",
            "industry": "",
            "year": 2020,
            "value": observation["value"],
            "metric": metric,
            "unit": unit,
            "release": "a" * 32,
            "scope": "country",
            "source": "auto-indicator-comparison",
        }
        assert isinstance(observation["value"], float)
        assert _table_comparison_complete(data, allow_auto=True)
    for step, (metric, unit) in journey._COMPARISON_STEPS.items():
        data = saved["steps"][str(step)]["data"]
        assert data["metric"] == metric
        assert data["compared"] == ["CHN", "USA"]
        assert [item["entity"] for item in data["observations"]] == ["CHN", "USA"]
        assert all(
            item
            == {
                **item,
                "metric": metric,
                "unit": unit,
                "release": "a" * 32,
                "scope": "country",
                "source": "explicit-indicator-comparison",
            }
            and item["value"] is not None
            for item in data["observations"]
        )
    # The server's material gate accepts steps 1-10. (The fake regression runs of steps 11-14 are not bound to
    # a release, so the gate leaves those to the live seed.)
    assert [block["step"] for block in check_material_gate(saved) if block["step"] <= 10] == []
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
