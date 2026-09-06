"""HTTP regressions from fresh-deployment dogfood, including database non-mutation."""

import json

import pytest
from fastapi.testclient import TestClient

from gvcsim.api import app
from gvcsim.classroom import db
from gvcsim.session import empty_session


def client_for(username):
    client = TestClient(app, raise_server_exceptions=False)
    login = client.post("/api/auth/login", json={"username": username, "password": "gvclab2026"})
    assert login.status_code == 200
    client.headers["Authorization"] = f"Bearer {login.json()['token']}"
    return client


@pytest.mark.parametrize("field", ["display_name", "student_no", "password"])
def test_null_student_update_is_rejected_without_mutation(teaching_db, field):
    client = client_for("teacher")
    account = db.find_account("student")
    response = client.post(f"/api/classroom/students/{account['id']}", json={field: None})
    assert response.status_code == 422, response.text
    assert db.find_account("student") == account


@pytest.mark.parametrize("operation", ["create", "update"])
def test_blank_student_name_is_rejected(teaching_db, operation):
    client = client_for("teacher")
    if operation == "create":
        response = client.post(
            "/api/classroom/students",
            json={
                "username": "blank-name",
                "display_name": " \t\n ",
                "password": "valid-password-2026",
            },
        )
        assert db.find_account("blank-name") is None
    else:
        account = db.find_account("student")
        response = client.post(f"/api/classroom/students/{account['id']}", json={"display_name": " \t\n "})
        assert db.find_account("student") == account
    assert response.status_code == 422, response.text


@pytest.mark.parametrize(
    "key,value",
    [
        ("1", float("nan")),
        ("1", float("inf")),
        ("1", -float("inf")),
        ("1", "\x00"),
        ("1", "\ud800"),
        ("²", None),
        ("01", None),
        ("１", None),
    ],
)
def test_invalid_session_is_rejected_before_writing(teaching_db, key, value):
    client = client_for("student")
    session = empty_session()
    session["steps"][key] = {"data": {"value": value}}
    response = client.put(
        "/api/classroom/session",
        content=json.dumps(
            {
                "session": session,
                "base_updated_at": None,
            }
        ),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422, response.text
    assert db.get_session("student") is None


def test_session_accepts_unicode_and_finite_numeric_boundaries(teaching_db):
    client = client_for("student")
    session = empty_session()
    session["steps"]["15"] = {"data": {"text": "中文 👩🏽‍💻\n\t", "values": [0, -1, 1e308, None, True]}}
    response = client.put("/api/classroom/session", json={"session": session, "base_updated_at": None})
    assert response.status_code == 200, response.text
    restored = client.get("/api/classroom/session").json()["session"]
    # PostgreSQL JSONB expands exponent notation; JavaScript reads both as the same number.
    restored["steps"]["15"]["data"]["values"][2] = float(restored["steps"]["15"]["data"]["values"][2])
    assert restored == session


@pytest.mark.parametrize("username,password", [("a\x00b", "password"), ("unknown", "\ud800"), ("\ud800", "password")])
def test_invalid_login_text_returns_422_without_echoing_password(teaching_db, username, password):
    response = TestClient(app, raise_server_exceptions=False).post(
        "/api/auth/login",
        content=json.dumps({"username": username, "password": password}),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422, response.text
    assert all("input" not in error and "ctx" not in error for error in response.json()["detail"])


@pytest.mark.parametrize("field", ["display_name", "student_no"])
@pytest.mark.parametrize("value", ["\x00", "\ud800"])
def test_invalid_account_text_never_reaches_database(teaching_db, field, value):
    client = client_for("teacher")
    body = {"username": "invalid-text", "password": "valid-password-2026", "display_name": "姓名", field: value}
    response = client.post(
        "/api/classroom/students", content=json.dumps(body), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422, response.text
    assert db.find_account("invalid-text") is None


@pytest.mark.parametrize(
    "fields", [{"score": float("nan")}, {"score": float("inf")}, {"score": 92, "feedback": "\x00"}]
)
def test_invalid_grade_payload_returns_validation_error(teaching_db, fields):
    client = client_for("teacher")
    response = client.post(
        "/api/classroom/reports/999/grade",
        content=json.dumps(
            {
                **fields,
                "expected_updated_at": "2026-09-07T00:00:00Z",
            }
        ),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422, response.text
    assert all("input" not in error for error in response.json()["detail"])


def test_invalid_unicode_validation_location_is_serializable(teaching_db):
    client = client_for("teacher")
    response = client.post(
        "/api/classroom/students/999", content=json.dumps({"\ud800": 1}), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"][0]["type"] == "string_unicode"
