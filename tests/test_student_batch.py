import os
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from gvcsim.api import app
from gvcsim.classroom import db, management


@pytest.fixture
def batch(teaching_db):
    client = TestClient(app)
    login = client.post(
        "/api/auth/login",
        json={
            "username": "teacher",
            "password": os.environ["GVCSIM_BOOTSTRAP_PASSWORD"],
        },
    )
    assert login.status_code == 200
    client.headers["Authorization"] = "Bearer " + login.json()["token"]
    term = db.create_term("导入测试", "teacher")
    group = db.create_class_group(term["id"], "一班", "teacher")
    body = {
        "class_id": group["id"],
        "students": [
            {"username": "00123", "display_name": "张 三", "password": "initial-pass-one"},
            {"username": "00987", "display_name": "李四", "password": "initial-pass-two"},
        ],
        "preview": True,
    }
    return client, body, term


def test_preview_commit_login_and_existing_accounts_unchanged(batch):
    client, body, _ = batch
    endpoint = "/api/classroom/students/batch"
    assert client.post(endpoint, json=body).json() == {"existing": [], "created": 0}
    assert db.find_account("00123") is None
    body["preview"] = False
    assert client.post(endpoint, json=body).json() == {"existing": [], "created": 2}
    before = db.find_account("00123")
    assert before["student_no"] == "00123"
    with db.conn() as c:
        assert (
            c.execute("SELECT count(*) AS n FROM class_enrollments WHERE class_id=%s", (body["class_id"],)).fetchone()[
                "n"
            ]
            == 2
        )
    for row in body["students"]:
        response = TestClient(app).post(
            "/api/auth/login",
            json={
                "username": row["username"],
                "password": row["password"],
            },
        )
        assert response.status_code == 200
        student = TestClient(app)
        student.headers["Authorization"] = "Bearer " + response.json()["token"]
        assert student.post(endpoint, json=body).status_code == 403
    body["students"][0]["password"] = "replacement-password"
    assert client.post(endpoint, json=body).status_code == 409
    assert db.find_account("00123")["pw_hash"] == before["pw_hash"]
    body["preview"] = True
    assert set(client.post(endpoint, json=body).json()["existing"]) == {"00123", "00987"}
    assert TestClient(app).post(endpoint, json=body).status_code == 401


def test_concurrent_batches_do_not_partially_create(batch):
    client, body, _ = batch
    body["preview"] = False
    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(
            pool.map(
                lambda students: client.post(
                    "/api/classroom/students/batch", json={**body, "students": students}
                ).status_code,
                [body["students"], list(reversed(body["students"]))],
            )
        )
    assert sorted(statuses) == [200, 409]
    with db.conn() as c:
        assert (
            c.execute("SELECT count(*) AS n FROM class_enrollments WHERE class_id=%s", (body["class_id"],)).fetchone()[
                "n"
            ]
            == 2
        )


def test_late_failure_rolls_back_first_student(batch, monkeypatch):
    _, body, _ = batch
    original = db.hash_password

    def fail_second(password, salt):
        if password == "initial-pass-two":
            raise ValueError("injected failure")
        return original(password, salt)

    monkeypatch.setattr(db, "hash_password", fail_second)
    with pytest.raises(ValueError, match="injected"):
        management.create_student_batch(body["students"], body["class_id"], "teacher", False)
    assert db.find_account("00123") is None
    assert db.find_account("00987") is None


def test_archived_group_and_duplicate_and_size_rejected(batch):
    client, body, term = batch
    endpoint = "/api/classroom/students/batch"
    body["students"][1]["username"] = "00123"
    assert client.post(endpoint, json=body).status_code == 400
    body["students"] = body["students"][:1]
    assert client.post(endpoint, json={**body, "students": []}).status_code == 422
    assert client.post(endpoint, json={**body, "students": body["students"] * 201}).status_code == 422
    assert client.post(endpoint, json={**body, "class_id": 999999}).status_code == 409
    db.update_term(term["id"], {"is_active": False}, "teacher")
    body["preview"] = False
    assert client.post(endpoint, json=body).status_code == 409
    assert db.find_account("00123") is None


def test_full_class_limit(batch):
    client, body, _ = batch
    body["students"] = [
        {"username": f"s{i:04}", "display_name": f"学生{i}", "password": f"initial-password-{i}"}
        for i in range(200)
    ]
    body["preview"] = False
    result = client.post("/api/classroom/students/batch", json=body)
    assert result.status_code == 200
    assert result.json()["created"] == 200
    assert db.find_account("s0000")["student_no"] == "s0000"
    assert db.find_account("s0199")["display_name"] == "学生199"


@pytest.mark.parametrize("field,value", [("username", "中文"), ("display_name", "  "), ("password", "short")])
def test_invalid_row_prevents_entire_batch(batch, field, value):
    client, body, _ = batch
    body["preview"] = False
    body["students"][1][field] = value
    assert client.post("/api/classroom/students/batch", json=body).status_code in (400, 422)
    assert db.find_account("00123") is None
