import json

import pytest

from gvcsim.classroom import routes as classroom_routes
from gvcsim.config import ROOT
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


def test_put_session_returns_the_exact_normalized_snapshot_saved(monkeypatch):
    outcome = "production"
    run = {
        "design": {
            "outcome": outcome,
            "granularity": "country_industry",
            "shock_type": "tariff",
            "method": "twfe_intensity",
            "control_mode": "none",
            "interaction": False,
            "scenario": "clean",
        },
        "result": {
            "status": "ok",
            "support": {"status": "ok", "suppress_inference": False, "reasons": []},
            "diagnostics": {"study_contract": "economics-v2"},
            "coefs": [
                {
                    "name": "teaching_tariff_exposure",
                    "coef": -0.5,
                    "se": 0.1,
                    "t": -5.0,
                    "p": 0.01,
                    "ci_low": -0.7,
                    "ci_high": -0.3,
                }
            ],
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

    assert response["session"] == persisted[0][1]
    assert persisted[0][0] == "student"
    assert persisted[0][2] is None
    assert response["session"]["steps"]["12"]["data"]["qualified_run"] == run
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
