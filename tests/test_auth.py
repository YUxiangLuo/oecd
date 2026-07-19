"""登录认证测试:凭证校验、令牌签发/校验/篡改/过期。"""

import os
import stat
import time

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
