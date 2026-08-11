import pytest

from gvcsim.session import SESSION_VERSION, SessionError, empty_session, make_record, validate_session


def test_minimal_session_contract():
    assert empty_session() == {"version": SESSION_VERSION, "steps": {}, "shared": {}}
    payload = empty_session()
    payload["steps"]["1"] = make_record({"quiz": {"answers": {"q": "a"}}})
    payload["shared"]["regression_settings"] = {"trade": {"method": "did"}}
    assert validate_session(payload) == payload


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
