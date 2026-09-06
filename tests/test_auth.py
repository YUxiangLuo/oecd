import time

import pytest
from fastapi.testclient import TestClient

from gvcsim import api as api_module
from gvcsim import artifacts, auth
from gvcsim.api import app


def test_login_me_and_bad_credentials(teaching_db):
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})
    assert login.status_code == 200
    body = login.json()
    assert body["expires_at"] > time.time()
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"}).json()["role"] == "student"
    assert client.post("/api/auth/login", json={"username": "student", "password": "wrong"}).status_code == 401


def test_token_is_signed_expiring_and_role_checked(teaching_db, monkeypatch):
    user = auth.authenticate("student", "gvclab2026")
    assert user
    token, expires_at = auth.issue_token(user)
    assert auth.verify_token(token)["sub"] == "student"
    assert auth.verify_token(token + "tampered") is None
    monkeypatch.setattr(auth.time, "time", lambda: expires_at + 1)
    assert auth.verify_token(token) is None


def test_token_is_bound_to_dataset_release(teaching_db, monkeypatch):
    user = auth.authenticate("student", "gvclab2026")
    assert user
    token, _expires_at = auth.issue_token(user)
    payload = auth.verify_token(token)
    assert payload["sub"] == "student"
    assert payload["rid"] == "a" * 32
    monkeypatch.setattr(artifacts, "release_identity", lambda _path=None: "b" * 32)
    assert auth.verify_token(token) is None


def test_token_issue_and_verification_require_release_identity(teaching_db, monkeypatch):
    user = auth.authenticate("student", "gvclab2026")
    assert user
    token, _expires_at = auth.issue_token(user)

    def invalid_release(*_args, **_kwargs):
        raise artifacts.ArtifactContractError("dataset metadata checksum mismatch")

    monkeypatch.setattr(artifacts, "release_identity", invalid_release)
    with pytest.raises(auth.AuthenticationUnavailable, match="数据发布"):
        auth.issue_token(user)
    with pytest.raises(auth.AuthenticationUnavailable, match="数据发布"):
        auth.verify_token(token)


def test_missing_release_identity_blocks_login_and_protected_api(teaching_db, monkeypatch):
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})
    assert login.status_code == 200

    def invalid_release(*_args, **_kwargs):
        raise artifacts.ArtifactContractError("dataset metadata checksum mismatch")

    monkeypatch.setattr(artifacts, "release_identity", invalid_release)
    denied_login = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})
    assert denied_login.status_code == 503
    denied_api = client.get(
        "/api/steps",
        headers={"Authorization": f"Bearer {login.json()['token']}"},
    )
    assert denied_api.status_code == 503
    assert "数据发布" in denied_api.json()["detail"]


def test_password_change_updates_credentials_and_revokes_existing_token(teaching_db):
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).json()
    headers = {"Authorization": f"Bearer {login['token']}"}
    changed = client.post(
        "/api/auth/password",
        headers=headers,
        json={"current_password": "gvclab2026", "new_password": "teacher-new-private-password"},
    )
    assert changed.json() == {"ok": True, "reauthenticate": True}
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    assert client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).status_code == 401
    assert (
        client.post(
            "/api/auth/login", json={"username": "teacher", "password": "teacher-new-private-password"}
        ).status_code
        == 200
    )
    assert teaching_db.change_own_password("teacher", "teacher-new-private-password", "gvclab2026-reset")


def test_teacher_password_reset_revokes_student_token(teaching_db):
    client = TestClient(app)
    teacher_login = client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).json()
    teaching_db.create_student("reset-target", "改密目标", "reset-target-password", teacher_username="teacher")
    student_login = client.post(
        "/api/auth/login", json={"username": "reset-target", "password": "reset-target-password"}
    ).json()
    account_id = teaching_db.find_account("reset-target")["id"]
    response = client.post(
        f"/api/classroom/students/{account_id}",
        headers={"Authorization": f"Bearer {teacher_login['token']}"},
        json={"password": "student-reset-private-password"},
    )
    assert response.status_code == 200
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {student_login['token']}"}).status_code == 401


def test_demo_seed_password_cannot_be_changed_by_teacher(teaching_db):
    client = TestClient(app)
    teacher_login = client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).json()
    account_id = teaching_db.find_account("student")["id"]
    response = client.post(
        f"/api/classroom/students/{account_id}",
        headers={"Authorization": f"Bearer {teacher_login['token']}"},
        json={"password": "student-reset-private-password"},
    )
    assert response.status_code == 409
    assert "固定轮换口令" in response.json()["detail"]
    assert client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"}).status_code == 200


def test_demo_seed_student_cannot_change_own_password(teaching_db):
    client = TestClient(app)
    student_login = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"}).json()
    response = client.post(
        "/api/auth/password",
        headers={"Authorization": f"Bearer {student_login['token']}"},
        json={"current_password": "gvclab2026", "new_password": "student-new-private-password"},
    )
    assert response.status_code == 400
    assert "固定轮换口令" in response.json()["detail"]
    assert client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"}).status_code == 200


def test_existing_token_uses_current_display_name_after_teacher_rename(teaching_db):
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"}).json()
    account_id = teaching_db.find_account("student")["id"]

    updated = teaching_db.update_student(
        account_id,
        {"display_name": "改名后的同学"},
        teacher_username="teacher",
    )

    assert updated is not None
    assert updated["display_name"] == "改名后的同学"
    response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {login['token']}"})
    assert response.status_code == 200
    assert response.json()["name"] == "改名后的同学"
    assert auth.verify_token(login["token"])["name"] == "改名后的同学"


def test_role_authorization_uses_signed_claim(teaching_db):
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"}).json()
    response = client.get("/api/classroom/students", headers={"Authorization": f"Bearer {login['token']}"})
    assert response.status_code == 403


def test_authenticated_middleware_offloads_database_check(teaching_db, monkeypatch):
    original = api_module.anyio.to_thread.run_sync
    calls = []

    async def recording_run_sync(function, *args, **kwargs):
        calls.append(function)
        return await original(function, *args, **kwargs)

    monkeypatch.setattr(api_module.anyio.to_thread, "run_sync", recording_run_sync)
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"}).json()
    response = client.get("/api/steps", headers={"Authorization": f"Bearer {login['token']}"})

    assert response.status_code == 200
    assert auth.verify_token in calls


def test_workspace_reports_the_authenticated_release_for_draft_recovery(teaching_db):
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"}).json()
    workspace = client.get("/api/classroom/session", headers={"Authorization": f"Bearer {login['token']}"})
    assert workspace.status_code == 200
    assert workspace.json()["release_id"] == "a" * 32
    assert workspace.json()["updated_at"] is None
