"""教学面板(班级/学生/进度/评阅/公告)测试。

使用独立测试库 gvclab_test(GVCSIM_PG_DSN_TEST 可覆盖),本地 PostgreSQL
不可用时整模块跳过,与仓库其它数据依赖测试的 skipif 约定一致。
每个用例结束后清空全部教学表,下个用例自动重新播种。
"""

import os

import psycopg
import pytest
from fastapi.testclient import TestClient

from gvcsim import config
from gvcsim.api import app
from gvcsim.classroom import db

TEST_DSN = os.environ.get("GVCSIM_PG_DSN_TEST", "postgresql://alice:111111@127.0.0.1:5432/gvclab_test")
DEAD_DSN = "postgresql://alice:111111@127.0.0.1:59999/gvclab"

try:
    _info = psycopg.conninfo.conninfo_to_dict(TEST_DSN)
    with psycopg.connect(**{**_info, "dbname": "postgres"}, autocommit=True, connect_timeout=3) as _c:
        if not _c.execute("SELECT 1 FROM pg_database WHERE datname = %s", (_info["dbname"],)).fetchone():
            _c.execute(f'CREATE DATABASE "{_info["dbname"]}"')
except psycopg.OperationalError:
    pytest.skip("本地 PostgreSQL 不可用,跳过教学面板测试", allow_module_level=True)

client = TestClient(app)


@pytest.fixture(autouse=True)
def classroom_test_db(monkeypatch):
    monkeypatch.setattr(config, "PG_DSN", TEST_DSN)
    db._schema_ready = False
    yield
    with psycopg.connect(TEST_DSN, autocommit=True) as c:
        c.execute("DROP TABLE IF EXISTS announcements, submissions, step_progress, accounts, classes CASCADE")
    db._schema_ready = False


def _login(username: str, password: str = "gvclab2026") -> dict:
    resp = client.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def test_seeded_accounts_login_via_db():
    headers = _login("student")
    me = client.get("/api/auth/me", headers=headers).json()
    assert me == {"username": "student", "name": "同学", "role": "student"}
    # 播种数据落在测试库
    with psycopg.connect(TEST_DSN) as c:
        assert c.execute("SELECT count(*) FROM accounts").fetchone()[0] == 2


def test_teacher_creates_student_who_can_login():
    t = _login("teacher")
    resp = client.post(
        "/api/classroom/students",
        headers=t,
        json={
            "username": "s001",
            "display_name": "王小明",
            "password": "abc12345",
            "student_no": "2026002",
            "class_id": 1,
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["username"] == "s001"
    # 新账号立即可登录
    s = _login("s001", "abc12345")
    assert client.get("/api/auth/me", headers=s).json()["name"] == "王小明"
    # 重名 409;非法用户名 400
    assert (
        client.post(
            "/api/classroom/students",
            headers=t,
            json={"username": "s001", "display_name": "x", "password": "abc12345"},
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/classroom/students",
            headers=t,
            json={"username": "空 格", "display_name": "x", "password": "abc12345"},
        ).status_code
        == 400
    )


def test_disabled_student_rejected():
    t = _login("teacher")
    sid = client.get("/api/classroom/students", headers=t).json()["students"][0]["id"]
    resp = client.post(f"/api/classroom/students/{sid}", headers=t, json={"active": False})
    assert resp.status_code == 200 and resp.json()["active"] is False
    assert client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"}).status_code == 401
    # 重新启用后恢复
    client.post(f"/api/classroom/students/{sid}", headers=t, json={"active": True})
    _login("student")


def test_submit_review_roundtrip_and_resubmit_resets():
    s, t = _login("student"), _login("teacher")
    body = {"year": 2020, "title": "我的实验报告", "design": {"method": "DID"}, "markdown": "## 正文"}
    sub = client.post("/api/classroom/report/submit", headers=s, json=body).json()
    assert sub["state"] == "pending"

    listed = client.get("/api/classroom/submissions", headers=t).json()["submissions"]
    assert len(listed) == 1 and listed[0]["username"] == "student"
    detail = client.get(f"/api/classroom/submissions/{sub['id']}", headers=t).json()
    assert detail["markdown"] == "## 正文" and detail["design"] == {"method": "DID"}

    graded = client.post(
        f"/api/classroom/submissions/{sub['id']}/grade", headers=t, json={"score": 92, "feedback": "很好"}
    ).json()
    assert graded["state"] == "graded" and graded["score"] == 92

    mine = client.get("/api/classroom/report/mine", headers=s).json()
    assert mine["score"] == 92 and mine["feedback"] == "很好" and mine["graded_by"] == "teacher"

    # 重交:覆盖内容并重置评阅
    client.post("/api/classroom/report/submit", headers=s, json={**body, "title": "修订版"})
    mine = client.get("/api/classroom/report/mine", headers=s).json()
    assert mine["state"] == "pending" and mine["score"] is None and mine["title"] == "修订版"

    # 越界分数被 Pydantic 拒绝
    assert (
        client.post(
            f"/api/classroom/submissions/{sub['id']}/grade", headers=t, json={"score": 101, "feedback": ""}
        ).status_code
        == 422
    )


def test_progress_keeps_max_step():
    s, t = _login("student"), _login("teacher")
    for step in (5, 9, 3):
        assert client.post("/api/classroom/progress", headers=s, json={"step": step}).status_code == 200
    row = client.get("/api/classroom/students", headers=t).json()["students"][0]
    assert row["current_step"] == 3 and row["max_step"] == 9
    overview = client.get("/api/classroom/overview", headers=t).json()
    reached = {r["step"]: r["reached"] for r in overview["step_completion"]}
    assert reached[9] == 1 and reached[10] == 0


def test_announcements_scoped_by_class():
    s, t = _login("student"), _login("teacher")
    # 种子里已有一条全局公告;再发一条仅其它班级可见的
    other = client.post("/api/classroom/classes", headers=t, json={"name": "另一个班", "code": "GVC-B"}).json()
    client.post("/api/classroom/announcements", headers=t, json={"title": "只给B班", "class_id": other["id"]})
    client.post("/api/classroom/announcements", headers=t, json={"title": "全体注意"})

    titles = [a["title"] for a in client.get("/api/classroom/announcements", headers=s).json()["announcements"]]
    assert "全体注意" in titles and "只给B班" not in titles
    teacher_titles = [a["title"] for a in client.get("/api/classroom/announcements", headers=t).json()["announcements"]]
    assert "只给B班" in teacher_titles

    # 删除
    aid = client.get("/api/classroom/announcements", headers=t).json()["announcements"][0]["id"]
    assert client.delete(f"/api/classroom/announcements/{aid}", headers=t).status_code == 200
    # 班级代码重复 409
    assert client.post("/api/classroom/classes", headers=t, json={"name": "x", "code": "GVC-B"}).status_code == 409


def test_student_forbidden_from_teacher_endpoints():
    s = _login("student")
    for path in ("/api/classroom/overview", "/api/classroom/students", "/api/classroom/submissions"):
        assert client.get(path, headers=s).status_code == 403
    assert client.post("/api/classroom/announcements", headers=s, json={"title": "x"}).status_code == 403


def test_db_down_degrades_gracefully(monkeypatch):
    # 先在可用库拿到令牌,再把 DSN 指向死端口
    s = _login("student")
    monkeypatch.setattr(config, "PG_DSN", DEAD_DSN)
    db._schema_ready = False
    # 核心接口不受影响;教学接口 503;演示账号回退登录可用
    assert client.get("/api/meta", headers=s).status_code == 200
    assert client.get("/api/classroom/announcements", headers=s).status_code == 503
    assert client.post("/api/auth/login", json={"username": "teacher", "password": "gvclab2026"}).status_code == 200
    assert client.post("/api/auth/login", json={"username": "teacher", "password": "wrong"}).status_code == 401
