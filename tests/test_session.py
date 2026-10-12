import json

import pytest
from scipy import stats

from gvcsim.classroom import routes as classroom_routes
from gvcsim.config import ROOT
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression_routes import _design_info
from gvcsim.regression.teaching import model_snapshot, variable_catalog
from gvcsim.session import SESSION_VERSION, SessionError, empty_session, make_record, validate_session


def test_minimal_session_contract():
    assert empty_session() == {"version": SESSION_VERSION, "steps": {}, "shared": {}}
    payload = empty_session()
    payload["steps"]["1"] = make_record({"quiz": {"answers": {"q": "a"}}})
    payload["shared"]["regression_settings"] = {"trade": {"method": "did"}}
    assert validate_session(payload) == payload


def test_frontend_and_backend_use_the_same_session_version():
    frontend_types = (ROOT / "frontend" / "src" / "types.ts").read_text()
    assert f'export const SESSION_VERSION = "{SESSION_VERSION}";' in frontend_types


def _estimate(name: str, coef: float, se: float = 0.1) -> dict:
    critical = stats.t.ppf(0.975, 3)
    return {
        "name": name,
        "coef": coef,
        "se": se,
        "t": coef / se,
        "p": float(2 * stats.t.sf(abs(coef / se), 3)),
        "ci_low": float(coef - critical * se),
        "ci_high": float(coef + critical * se),
    }


def test_put_session_acknowledges_without_echoing_the_saved_snapshot(monkeypatch):
    outcome = "production"
    run = {
        "design": _design_info(RegressionDesign(outcome, teaching=True)),
        "result": {
            "status": "ok",
            "n_obs": 20,
            "n_entities": 4,
            "n_times": 5,
            "n_clusters": 4,
            "support": {"status": "ok", "suppress_inference": False, "reasons": []},
            "diagnostics": {"study_contract": "economics-v2"},
            # The course model (data v10): X, L1.X and the exchange rate; the X terms' sum is the headline.
            "coefs": [
                _estimate("teaching_tariff_exposure", -0.3),
                _estimate("teaching_tariff_exposure_lag1", -0.2),
                _estimate("teaching_exchange_rate_change", 0.05),
            ],
            "cumulative": _estimate("cumulative", -0.5),
        },
        "model_snapshot": json.loads(json.dumps(model_snapshot(outcome))),
        "variable_catalog": variable_catalog(outcome),
    }
    requested = empty_session()
    requested["steps"]["12"] = make_record({"run": run, "qualified_run": run})
    persisted = []
    monkeypatch.setattr(
        classroom_routes.db,
        "save_session",
        lambda username, session, expected: (
            persisted.append((username, session, expected)) or {"updated_at": "saved-at"}
        ),
    )
    monkeypatch.setattr(classroom_routes.db, "latest_report", lambda _username: None)

    response = classroom_routes.put_session(
        classroom_routes.SessionRequest(session=requested, base_updated_at=None),
        {"sub": "student"},
    )

    assert "session" not in response
    assert requested == persisted[0][1]
    assert persisted[0][0] == "student"
    assert persisted[0][2] is None
    assert persisted[0][1]["steps"]["12"]["data"]["qualified_run"] == run
    assert response["updated_at"] == "saved-at"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"version": SESSION_VERSION, "steps": {"17": {"data": {}}}, "shared": {}},
        {"version": SESSION_VERSION, "steps": {}, "shared": {"regression_history": {}}},
        {"version": SESSION_VERSION, "steps": {"1": {"data": {}, "updated_at": "old"}}, "shared": {}},
    ],
)
def test_rejects_old_or_unknown_session_shapes(payload):
    with pytest.raises(SessionError):
        validate_session(payload)
