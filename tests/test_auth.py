import time

from fastapi.testclient import TestClient

from gvcsim import auth
from gvcsim.api import app


def test_login_me_and_bad_credentials(teaching_db):
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})
    assert login.status_code == 200
    body = login.json()
    assert body["expires_at"] > time.time()
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"}).json()["role"] == "student"
    assert client.post("/api/auth/login", json={"username": "student", "password": "wrong"}).status_code == 401


def test_token_is_stateless_signed_expiring_and_role_checked(teaching_db, monkeypatch):
    user = auth.authenticate("student", "gvclab2026")
    assert user
    token, expires_at = auth.issue_token(user)
    assert auth.verify_token(token)["sub"] == "student"
    assert auth.verify_token(token + "tampered") is None
    monkeypatch.setattr(auth.time, "time", lambda: expires_at + 1)
    assert auth.verify_token(token) is None


def test_token_is_invalidated_when_the_dataset_release_changes(teaching_db, monkeypatch):
    release = {"id": "release-a"}
    monkeypatch.setattr(auth, "_current_release_id", lambda: release["id"])
    user = auth.authenticate("student", "gvclab2026")
    assert user
    token, _expires_at = auth.issue_token(user)
    assert auth.verify_token(token)["rid"] == "release-a"

    release["id"] = "release-b"

    assert auth.verify_token(token) is None


def test_password_change_updates_credentials_but_existing_token_remains_stateless(teaching_db):
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).json()
    headers = {"Authorization": f"Bearer {login['token']}"}
    changed = client.post(
        "/api/auth/password",
        headers=headers,
        json={"current_password": "gvclab2026", "new_password": "teacher-new-private-password"},
    )
    assert changed.json() == {"ok": True, "reauthenticate": True}
    assert client.get("/api/auth/me", headers=headers).status_code == 200
    assert client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).status_code == 401
    assert (
        client.post(
            "/api/auth/login", json={"username": "teacher", "password": "teacher-new-private-password"}
        ).status_code
        == 200
    )
    assert teaching_db.change_own_password("teacher", "teacher-new-private-password", "gvclab2026-reset")


def test_role_authorization_uses_signed_claim(teaching_db):
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"}).json()
    response = client.get("/api/classroom/classes", headers={"Authorization": f"Bearer {login['token']}"})
    assert response.status_code == 403
