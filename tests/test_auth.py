"""登录认证测试:凭证校验、令牌签发/校验/篡改/过期。"""

import time

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


def test_login_rejects_bad_credentials():
    assert client.post("/api/auth/login", json={"username": "student", "password": "wrong"}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "ghost", "password": "gvclab2026"}).status_code == 401


def test_me_rejects_missing_or_tampered_token():
    assert client.get("/api/auth/me").status_code == 401

    token, _ = auth.issue_token({"username": "student", "name": "同学", "role": "student"})
    payload, sig = token.split(".", 1)
    tampered = payload + "x." + sig
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {tampered}"}).status_code == 401


def test_expired_token_rejected(monkeypatch):
    monkeypatch.setattr(auth, "TOKEN_TTL_SECONDS", -10)
    token, _ = auth.issue_token({"username": "student", "name": "同学", "role": "student"})
    assert auth.verify_token(token) is None
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401
