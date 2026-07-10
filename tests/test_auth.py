"""登录认证测试:凭证校验、令牌签发/校验/篡改/过期。"""

import time

import pytest
from fastapi.testclient import TestClient

from gvcsim import auth
from gvcsim.api import app

client = TestClient(app)


def test_login_success_and_me():
    resp = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["user"] == {"username": "student", "name": "同学", "role": "student"}
    assert body["expires_at"] > time.time()

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200
    assert me.json()["username"] == "student"


def test_login_rejects_bad_credentials(monkeypatch):
    # 这里只验证 API 将普通认证失败映射为 401，不让结果依赖运行机是否有 PostgreSQL。
    # 数据库停机时的演示账号回退与 503 语义由下方独立测试覆盖。
    monkeypatch.setattr(auth, "authenticate", lambda _username, _password: None)
    assert client.post("/api/auth/login", json={"username": "student", "password": "wrong"}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "ghost", "password": "gvclab2026"}).status_code == 401


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
    assert auth.authenticate("teacher", "gvclab2026") == {"username": "teacher", "name": "老师", "role": "teacher"}
    with pytest.raises(auth.AuthenticationUnavailable, match="请使用演示账号"):
        auth.authenticate("teacher", "wrong")
    with pytest.raises(auth.AuthenticationUnavailable, match="请使用演示账号"):
        auth.authenticate("ghost", "gvclab2026")

    bad = client.post("/api/auth/login", json={"username": "ghost", "password": "gvclab2026"})
    assert bad.status_code == 503
    assert "请使用演示账号" in bad.json()["detail"]


def test_expired_token_rejected(monkeypatch):
    monkeypatch.setattr(auth, "TOKEN_TTL_SECONDS", -10)
    token, _ = auth.issue_token({"username": "student", "name": "同学", "role": "student"})
    assert auth.verify_token(token) is None
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401
