"""登录认证测试:凭证校验、令牌签发/校验/篡改/过期。"""

import os
import stat
import time
from concurrent.futures import ThreadPoolExecutor

import psycopg
import pytest
from fastapi.testclient import TestClient

from gvcsim import auth, config
from gvcsim.api import app
from gvcsim.classroom import db

client = TestClient(app)
AUTH_TEST_DSN = os.environ.get("GVCSIM_PG_DSN_TEST", "postgresql://alice:111111@127.0.0.1:5432/gvclab_test")


@pytest.fixture(autouse=True)
def auth_test_db(monkeypatch):
    monkeypatch.setattr(config, "PG_DSN", AUTH_TEST_DSN)
    info = psycopg.conninfo.conninfo_to_dict(AUTH_TEST_DSN)
    with psycopg.connect(**{**info, "dbname": "postgres"}, autocommit=True) as maintenance:
        if not maintenance.execute("SELECT 1 FROM pg_database WHERE datname=%s", (info["dbname"],)).fetchone():
            maintenance.execute(f'CREATE DATABASE "{info["dbname"]}"')
    with psycopg.connect(AUTH_TEST_DSN, autocommit=True) as connection:
        connection.execute("DROP SCHEMA public CASCADE")
        connection.execute("CREATE SCHEMA public")
    db._schema_ready = False
    db.initialize_schema()
    yield
    db._schema_ready = False


def test_login_success_and_me():
    resp = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["user"] == {"username": "student", "name": "同学", "role": "student", "account_id": 2}
    assert body["expires_at"] > time.time()

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200
    assert me.json()["username"] == "student"
    assert me.json()["account_id"] == 2


def test_password_change_revokes_every_session_and_requires_the_new_password():
    first = client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).json()
    second = client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).json()
    headers = {"Authorization": f"Bearer {first['token']}"}

    changed = client.post(
        "/api/auth/password",
        headers=headers,
        json={"current_password": "gvclab2026", "new_password": "teacher-new-private-password"},
    )
    assert changed.status_code == 200
    assert changed.json() == {"ok": True, "reauthenticate": True}

    for token in (first["token"], second["token"]):
        assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).status_code == 401
    assert (
        client.post(
            "/api/auth/login",
            json={"username": "teacher", "password": "teacher-new-private-password"},
        ).status_code
        == 200
    )
    with db.conn() as connection:
        audit = connection.execute(
            "SELECT action,actor_name,target_type FROM audit_log WHERE action='auth.password_changed'"
        ).fetchone()
    assert audit == {"action": "auth.password_changed", "actor_name": "teacher", "target_type": "account"}


def test_password_change_rejects_a_wrong_or_reused_current_password_without_revoking_session():
    login = client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).json()
    headers = {"Authorization": f"Bearer {login['token']}"}

    wrong = client.post(
        "/api/auth/password",
        headers=headers,
        json={"current_password": "wrong-password", "new_password": "teacher-new-private-password"},
    )
    assert wrong.status_code == 400 and wrong.json()["detail"] == "当前密码不正确"
    db.provision_teacher("rotation_teacher", "轮换教师", "rotation-private-password")
    rotation = client.post(
        "/api/auth/login", json={"username": "rotation_teacher", "password": "rotation-private-password"}
    ).json()
    same = client.post(
        "/api/auth/password",
        headers={"Authorization": f"Bearer {rotation['token']}"},
        json={"current_password": "rotation-private-password", "new_password": "rotation-private-password"},
    )
    assert same.status_code == 400 and same.json()["detail"] == "新密码不能与当前密码相同"
    assert client.get("/api/auth/me", headers=headers).status_code == 200

    too_short = client.post(
        "/api/auth/password",
        headers=headers,
        json={"current_password": "gvclab2026", "new_password": "short"},
    )
    assert too_short.status_code == 422


def test_successful_password_change_survives_rate_cleanup_failure(monkeypatch, caplog):
    login = client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).json()
    headers = {"Authorization": f"Bearer {login['token']}"}

    def cleanup_failed(_key: str) -> None:
        raise db.OperationFailed("connection_lost", "08006")

    monkeypatch.setattr(db, "clear_login_attempts", cleanup_failed)
    response = client.post(
        "/api/auth/password",
        headers=headers,
        json={"current_password": "gvclab2026", "new_password": "teacher-new-private-password"},
    )

    assert response.status_code == 200
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    assert (
        client.post(
            "/api/auth/login", json={"username": "teacher", "password": "teacher-new-private-password"}
        ).status_code
        == 200
    )
    assert "post-password-change rate-limit cleanup failed" in caplog.text
    assert "08006" not in caplog.text


def test_password_change_has_an_account_scoped_attempt_budget(monkeypatch):
    login = client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).json()
    headers = {"Authorization": f"Bearer {login['token']}"}
    changed = False

    monkeypatch.setattr(db, "reserve_login_attempt", lambda *_args, **_kwargs: 17)

    def should_not_change(*_args, **_kwargs):
        nonlocal changed
        changed = True
        return True

    monkeypatch.setattr(db, "change_own_password", should_not_change)
    response = client.post(
        "/api/auth/password",
        headers=headers,
        json={"current_password": "gvclab2026", "new_password": "teacher-new-private-password"},
    )

    assert response.status_code == 429
    assert response.headers["retry-after"] == "17"
    assert changed is False


def test_successful_login_survives_rate_cleanup_failure(monkeypatch, caplog):
    def cleanup_failed(_key: str) -> None:
        raise auth.AuthenticationUnavailable("sensitive cleanup detail")

    monkeypatch.setattr(auth, "clear_login_rate", cleanup_failed)
    response = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})

    assert response.status_code == 200
    token = response.json()["token"]
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert "post-auth rate-limit cleanup failed" in caplog.text
    assert "sensitive cleanup detail" not in caplog.text


def test_successful_login_survives_audit_failure_and_returns_its_live_session(monkeypatch, caplog):
    def audit_failed(*_args, **_kwargs) -> None:
        raise db.OperationFailed("connection_lost", "08006")

    monkeypatch.setattr(db, "record_audit_event", audit_failed)
    response = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})

    assert response.status_code == 200
    token = response.json()["token"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["username"] == "student"
    assert "successful-login audit write failed" in caplog.text


def test_auth_session_creation_failure_remains_fail_closed_and_skips_post_commit_cleanup(monkeypatch):
    cleanup_calls: list[str] = []
    audit_calls: list[str] = []

    def issue_failed(_user):
        raise auth.AuthenticationUnavailable("session write failed")

    monkeypatch.setattr(auth, "issue_token", issue_failed)
    monkeypatch.setattr(auth, "clear_login_rate", lambda key: cleanup_calls.append(key))
    monkeypatch.setattr(db, "record_audit_event", lambda action, **_kwargs: audit_calls.append(action))

    response = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})

    assert response.status_code == 503
    assert cleanup_calls == []
    assert audit_calls == []


def test_login_rejects_bad_credentials(monkeypatch):
    # 这里只验证 API 将普通认证失败映射为 401，不让结果依赖运行机是否有 PostgreSQL。
    # 数据库停机时的演示账号回退与 503 语义由下方独立测试覆盖。
    monkeypatch.setattr(auth, "authenticate", lambda _username, _password: None)
    assert client.post("/api/auth/login", json={"username": "student", "password": "wrong"}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "ghost", "password": "gvclab2026"}).status_code == 401


def test_login_request_size_is_bounded_before_password_hashing(monkeypatch):
    called = False

    def should_not_hash(_username, _password):
        nonlocal called
        called = True
        return None

    monkeypatch.setattr(auth, "authenticate", should_not_hash)
    assert client.post("/api/auth/login", json={"username": "x" * 129, "password": "ok"}).status_code == 422
    assert client.post("/api/auth/login", json={"username": "ok", "password": "x" * 257}).status_code == 422
    assert called is False


def test_schema_mismatch_is_explicit_503_and_never_demo_fallback(monkeypatch):
    def mismatched(*_args, **_kwargs):
        raise db.SchemaVersionMismatch("sensitive schema detail")

    monkeypatch.setattr(db, "find_account", mismatched)
    login = client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"})
    assert login.status_code == 503
    assert "sensitive" not in login.text


def test_global_schema_mismatch_handler_returns_generic_503(monkeypatch):
    login = client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"})
    assert login.status_code == 200
    headers = {"Authorization": f"Bearer {login.json()['token']}"}

    def mismatched(*_args, **_kwargs):
        raise db.SchemaVersionMismatch("sensitive sql and dsn")

    monkeypatch.setattr(db, "list_course_runs", mismatched)
    response = client.get("/api/classroom/course-runs", headers=headers)
    assert response.status_code == 503
    assert response.json() == {"detail": "教学数据库 schema 未就绪；请先完成兼容迁移"}


def test_query_operation_failure_has_a_sanitized_distinct_response(monkeypatch):
    login = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})
    assert login.status_code == 200
    headers = {"Authorization": f"Bearer {login.json()['token']}"}

    def query_failed(*_args, **_kwargs):
        raise db.OperationFailed("query_canceled", "57014")

    monkeypatch.setattr(db, "list_announcements", query_failed)
    response = client.get("/api/classroom/announcements", headers=headers)

    assert response.status_code == 503
    assert response.json() == {
        "detail": "教学数据库操作失败，请稍后重试",
        "code": "database_query_canceled",
    }
    assert "57014" not in response.text


def test_me_rejects_missing_or_tampered_token():
    assert client.get("/api/auth/me").status_code == 401

    token, _ = auth.issue_token({"username": "student", "name": "同学", "role": "student"})
    payload, sig = token.split(".", 1)
    tampered = payload + "x." + sig
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {tampered}"}).status_code == 401


def test_demo_login_falls_back_when_db_unavailable(monkeypatch):
    from gvcsim import config
    from gvcsim.classroom import db

    monkeypatch.setattr(config, "PG_DSN", "postgresql://alice:111111@127.0.0.1:59999/gvclab")
    monkeypatch.setattr(db, "_schema_ready", False)
    demo = auth.authenticate("teacher", "gvclab2026")
    assert demo and demo["username"] == "teacher" and demo["demo"] is True
    with pytest.raises(auth.AuthenticationUnavailable, match="认证数据库不可用"):
        auth.authenticate("teacher", "wrong")
    with pytest.raises(auth.AuthenticationUnavailable, match="认证数据库不可用"):
        auth.authenticate("ghost", "gvclab2026")

    bad = client.post("/api/auth/login", json={"username": "ghost", "password": "gvclab2026"})
    assert bad.status_code == 503
    assert "认证数据库不可用" in bad.json()["detail"]

    # 生产/default 模式绝不允许数据库故障时回退高权限演示账号。
    monkeypatch.setattr(config, "DEMO_MODE", False)
    with pytest.raises(auth.AuthenticationUnavailable):
        auth.authenticate("teacher", "gvclab2026")


def test_expired_token_rejected(monkeypatch):
    token, _ = auth.issue_token({"username": "student", "name": "同学", "role": "student"})
    now = time.time()
    monkeypatch.setattr(auth.time, "time", lambda: now + 7200)
    assert auth.verify_token(token) is None
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_login_rate_limit_is_a_sliding_window(monkeypatch):
    from gvcsim import config

    monkeypatch.setattr(config, "LOGIN_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(config, "LOGIN_WINDOW_SECONDS", 60)
    auth._attempts.clear()
    auth.record_login_result("ip|student", success=False, now=100)
    auth.record_login_result("ip|student", success=False, now=101)
    with pytest.raises(auth.TooManyLoginAttempts):
        auth.check_login_rate("ip|student", now=102)
    auth.check_login_rate("ip|student", now=161)


def test_database_login_rate_limit_is_shared_and_atomic():
    key = "203.0.113.8|student"
    assert db.reserve_login_attempt(key, 60, 2, now=100) is None
    assert db.reserve_login_attempt(key, 60, 2, now=101) is None
    assert db.reserve_login_attempt(key, 60, 2, now=102) == 59

    # 成功登录只清理自己的 IP+用户名键。
    db.clear_login_attempts(key)
    assert db.reserve_login_attempt(key, 60, 2, now=103) is None


def test_login_api_adds_an_ip_budget_that_username_rotation_cannot_bypass(monkeypatch):
    monkeypatch.setattr(config, "LOGIN_IP_MAX_ATTEMPTS", 2)
    monkeypatch.setattr(config, "LOGIN_MAX_ATTEMPTS", 8)
    monkeypatch.setattr(auth, "authenticate", lambda _username, _password: None)

    first = client.post("/api/auth/login", json={"username": "rotating-1", "password": "wrong"})
    second = client.post("/api/auth/login", json={"username": "rotating-2", "password": "wrong"})
    blocked = client.post("/api/auth/login", json={"username": "rotating-3", "password": "wrong"})

    assert first.status_code == 401
    assert second.status_code == 401
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) > 0


def test_successful_login_does_not_reset_the_shared_ip_budget(monkeypatch):
    monkeypatch.setattr(config, "LOGIN_IP_MAX_ATTEMPTS", 1)
    monkeypatch.setattr(config, "LOGIN_MAX_ATTEMPTS", 8)

    first = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})
    blocked = client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"})

    assert first.status_code == 200
    assert blocked.status_code == 429


def test_login_attempt_cleanup_retains_only_a_small_multiple_of_the_window(monkeypatch):
    now = 10_000.0
    old_key = db._rate_key_hash("old-identity")
    recent_key = db._rate_key_hash("recent-identity")
    with db.conn() as connection:
        connection.execute(
            "INSERT INTO auth_login_attempts(rate_key_hash,attempted_at)"
            " VALUES (%s,to_timestamp(%s)),(%s,to_timestamp(%s))",
            (old_key, now - 241, recent_key, now - 239),
        )

    monkeypatch.setattr(db.secrets, "randbelow", lambda _upper: 0)
    assert db.reserve_login_attempt("fresh", 60, 2, now=now) is None

    with db.conn() as connection:
        retained = {
            row["rate_key_hash"]
            for row in connection.execute(
                "SELECT rate_key_hash FROM auth_login_attempts WHERE rate_key_hash IN (%s,%s)",
                (old_key, recent_key),
            ).fetchall()
        }
    assert old_key not in retained
    assert recent_key in retained


def test_concurrent_database_login_reservations_cannot_overshoot_limit():
    key = "198.51.100.9|same-user"
    with ThreadPoolExecutor(max_workers=10) as executor:
        results = list(executor.map(lambda _index: db.reserve_login_attempt(key, 300, 3, now=100), range(10)))
    assert results.count(None) == 3
    assert sum(result is not None for result in results) == 7


def test_concurrent_rotating_usernames_share_one_atomic_ip_budget():
    ip_key = "ip:192.0.2.44"

    def reserve(index: int) -> int | None:
        return db.reserve_login_attempts(
            ((ip_key, 3), (f"identity:192.0.2.44|rotating-{index}", 8)),
            300,
            now=100,
        )

    with ThreadPoolExecutor(max_workers=10) as executor:
        results = list(executor.map(reserve, range(10)))
    assert results.count(None) == 3
    assert sum(result is not None for result in results) == 7


def test_login_api_preserves_retry_after_from_shared_limiter(monkeypatch):
    def saturated(_ip_key: str, _identity_key: str) -> None:
        raise auth.TooManyLoginAttempts(17)

    monkeypatch.setattr(auth, "reserve_login_attempt", saturated)
    response = client.post("/api/auth/login", json={"username": "student", "password": "wrong"})
    assert response.status_code == 429
    assert response.headers["retry-after"] == "17"


def test_login_api_namespaces_ip_and_identity_rate_keys(monkeypatch):
    observed: list[tuple[str, str]] = []

    def capture(ip_key: str, identity_key: str) -> None:
        observed.append((ip_key, identity_key))

    monkeypatch.setattr(auth, "reserve_login_attempt", capture)
    monkeypatch.setattr(auth, "authenticate", lambda _username, _password: None)
    response = client.post("/api/auth/login", json={"username": "STUDENT", "password": "wrong"})

    assert response.status_code == 401
    assert observed == [("ip:testclient", "identity:testclient|student")]


def test_security_config_rejects_an_ip_limit_below_the_identity_limit(monkeypatch):
    monkeypatch.setattr(config, "LOGIN_MAX_ATTEMPTS", 8)
    monkeypatch.setattr(config, "LOGIN_IP_MAX_ATTEMPTS", 7)
    with pytest.raises(config.ConfigurationError, match="不能小于"):
        config.validate_security_config()


def test_local_secret_is_created_with_owner_only_permissions(tmp_path, monkeypatch):
    from gvcsim import config

    target = tmp_path / "auth-secret"
    monkeypatch.setattr(auth, "SECRET_FILE", target)
    monkeypatch.setattr(config, "AUTH_SECRET", "")
    monkeypatch.setattr(config, "IS_PRODUCTION", False)
    assert len(auth._secret()) == 32
    assert stat.S_IMODE(target.stat().st_mode) == 0o600

    evidence_target = tmp_path / "evidence-secret"
    monkeypatch.setattr(auth, "EVIDENCE_SECRET_FILE", evidence_target)
    monkeypatch.setattr(config, "EVIDENCE_SECRET", "")
    evidence_key = auth.evidence_secret()
    assert len(evidence_key) == 32 and evidence_key != auth._secret()
    assert stat.S_IMODE(evidence_target.stat().st_mode) == 0o600
