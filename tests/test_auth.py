import time
import json

import pytest
from fastapi.testclient import TestClient

from gvcsim import api as api_module
from gvcsim import artifacts, auth
from gvcsim.api import app

_REAL_RELEASE_IDENTITY = artifacts.release_identity


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


def test_long_teaching_login_survives_multiple_days_but_still_expires(teaching_db, monkeypatch):
    user = auth.authenticate("student", "gvclab2026")
    monkeypatch.setattr(auth.config, "TOKEN_TTL_SECONDS", 30 * 24 * 60 * 60)
    issued_at = int(time.time())
    monkeypatch.setattr(auth.time, "time", lambda: issued_at)
    token, expires_at = auth.issue_token(user)
    assert expires_at == issued_at + 30 * 24 * 60 * 60
    monkeypatch.setattr(auth.time, "time", lambda: issued_at + 20 * 24 * 60 * 60)
    assert auth.verify_token(token)["sub"] == "student"
    monkeypatch.setattr(auth.time, "time", lambda: expires_at)
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


def test_corrupt_artifacts_block_valid_tokens_and_new_logins(teaching_db, monkeypatch):
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})
    token = login.json()["token"]

    def corrupted(*_args, **_kwargs):
        raise artifacts.ArtifactContractError("artifact checksum mismatch")

    monkeypatch.setattr(artifacts, "validate_release_cached", corrupted)
    response = client.get("/api/classroom/session", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 503
    assert client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"}).status_code == 503
    monkeypatch.setattr(artifacts, "validate_release_cached", lambda: {"release_id": "a" * 32})
    assert client.get("/api/classroom/session", headers={"Authorization": f"Bearer {token}"}).status_code == 200


@pytest.mark.parametrize(
    "payload", [b"\xff", json.dumps({"release_id": "a" * 32, "metadata_sha256": "0" * 64, "note": "\ud800"}).encode()]
)
def test_malformed_metadata_is_dependency_failure_not_invalid_token(teaching_db, monkeypatch, tmp_path, payload):
    client = TestClient(app, raise_server_exceptions=False)
    credentials = {"username": "student", "password": "gvclab2026"}
    login = client.post("/api/auth/login", json=credentials).json()
    (tmp_path / "dataset.json").write_bytes(payload)
    monkeypatch.setattr(artifacts, "release_identity", lambda: _REAL_RELEASE_IDENTITY(tmp_path))
    headers = {"Authorization": f"Bearer {login['token']}"}
    assert client.get("/api/auth/me", headers=headers).status_code == 503
    assert client.post("/api/auth/login", json=credentials).status_code == 503


def test_demo_student_suggestion_prefers_unused_accounts_and_spreads_concurrent_loads(teaching_db, monkeypatch):
    from fastapi.testclient import TestClient

    from gvcsim import auth_routes
    from gvcsim.api import app

    monkeypatch.setattr(auth_routes, "_recent_demo_suggestions", {})
    for username in ("student02", "student03", "student04"):
        teaching_db.create_student(username, username, "valid-password-2026", "", "teacher")
    client = TestClient(app)
    # "student" has just logged in, so it is in use and never suggested; the idle accounts go one per page load.
    assert client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"}).status_code == 200
    first = client.get("/api/auth/demo-student").json()["username"]
    second = client.get("/api/auth/demo-student").json()["username"]
    assert {first, second} <= {"student02", "student03", "student04"} and first != second
    # A reload of the first tab gets its account back instead of holding another one.
    assert client.get("/api/auth/demo-student", params={"keep": first}).json()["username"] == first
    third = client.get("/api/auth/demo-student").json()["username"]
    assert third not in {first, second, "student"}
    # With every idle account just suggested, the oldest suggestion nobody logged into comes back (the reload
    # renewed the first tab's hold, so that is the second one).
    assert client.get("/api/auth/demo-student").json()["username"] == second
    # Once it is logged into, it is in use and is no longer handed out, not even to the tab that kept it.
    assert (
        client.post("/api/auth/login", json={"username": second, "password": "valid-password-2026"}).status_code == 200
    )
    assert client.get("/api/auth/demo-student", params={"keep": second}).json()["username"] == first


def test_demo_student_suggestion_is_empty_when_every_account_is_in_use(teaching_db, monkeypatch):
    from fastapi.testclient import TestClient

    from gvcsim import auth_routes
    from gvcsim.api import app

    monkeypatch.setattr(auth_routes, "_recent_demo_suggestions", {})
    client = TestClient(app)
    assert client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"}).status_code == 200
    assert client.get("/api/auth/demo-student").json() == {"username": None}


def test_demo_student_suggestion_is_rate_limited_per_source(teaching_db, monkeypatch):
    from fastapi.testclient import TestClient

    from gvcsim import auth_routes
    from gvcsim.api import app
    from gvcsim.rate_limit import SlidingWindowRateLimiter

    monkeypatch.setattr(auth_routes, "_DEMO_SUGGESTION_LIMITER", SlidingWindowRateLimiter(2))
    client = TestClient(app)
    assert client.get("/api/auth/demo-student").status_code == 200
    assert client.get("/api/auth/demo-student").status_code == 200
    limited = client.get("/api/auth/demo-student")
    assert limited.status_code == 429 and "Retry-After" in limited.headers


def test_demo_student_suggestion_does_not_exist_outside_demo_mode(teaching_db, monkeypatch):
    from fastapi.testclient import TestClient

    from gvcsim import config
    from gvcsim.api import app

    monkeypatch.setattr(config, "DEMO_MODE", False)
    assert TestClient(app).get("/api/auth/demo-student").status_code == 404
