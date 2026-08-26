import pytest

from gvcsim.classroom import routes as classroom_routes
from gvcsim.config import ROOT
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
    run = {
        "design": {"outcome": "trade", "method": "did", "interaction": False},
        "result": {"status": "ok"},
    }
    requested = empty_session()
    requested["steps"]["12"] = make_record({"run": run, "qualified_run": run})
    persisted = []
    monkeypatch.setattr(
        classroom_routes.db,
        "save_session",
        lambda username, session, expected: persisted.append((username, session, expected))
        or {"updated_at": "saved-at"},
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
