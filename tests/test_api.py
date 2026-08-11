from fastapi.testclient import TestClient

from gvcsim import quizzes
from gvcsim.api import app
from gvcsim.classroom import db, routes as classroom_routes
from gvcsim.session import SESSION_VERSION, empty_session, make_record
from gvcsim.teaching_report import ReportGateError, TeachingReport


def _client(teaching_db, username="student", password="gvclab2026"):
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": username, "password": password})
    assert login.status_code == 200, login.text
    client.headers.update({"Authorization": f"Bearer {login.json()['token']}"})
    return client


def test_api_requires_bearer(teaching_db):
    assert TestClient(app).get("/api/steps").status_code == 401


def test_quiz_returns_normalized_answers_without_receipt(teaching_db):
    client = _client(teaching_db)
    correct = quizzes.correct_quiz(1)
    response = client.post("/api/classroom/quiz/submit", json={"step": 1, **correct})
    assert response.status_code == 200
    assert response.json()["passed"] is True
    assert response.json()["quiz"] == correct
    assert "quiz_id" not in response.json()


def test_session_put_is_full_last_write_and_strips_step_16(teaching_db):
    client = _client(teaching_db)
    first = empty_session()
    first["steps"]["1"] = make_record({"value": 1})
    first["steps"]["16"] = make_record({"forged": True})
    assert client.put("/api/classroom/session", json={"session": first}).status_code == 200
    second = empty_session()
    second["steps"]["2"] = make_record({"value": 2})
    saved = client.put("/api/classroom/session", json={"session": second}).json()
    assert saved["session"] == second
    assert set(saved) == {"session", "updated_at", "completion"}


def test_complete_quizzes_can_be_supplied_without_trusted_evidence(teaching_db):
    client = _client(teaching_db)
    session = empty_session()
    session["steps"] = {
        str(step): make_record({"quiz": quizzes.correct_quiz(step)}) for step in range(1, 16)
    }
    response = client.put("/api/classroom/session", json={"session": session})
    assert response.json()["completion"]["completed"] == list(range(1, 16))
    assert client.get("/api/classroom/report/gate").json() == {"blocked": []}


def test_removed_endpoints_are_not_available(teaching_db):
    client = _client(teaching_db)
    assert client.post("/api/auth/logout").status_code == 404
    teacher = _client(teaching_db, "teacher")
    assert teacher.get("/api/classroom/submissions/1/history").status_code == 404


def test_invalid_session_version_is_rejected(teaching_db):
    client = _client(teaching_db)
    response = client.put("/api/classroom/session", json={"session": {"version": "old", "steps": {}, "shared": {}}})
    assert response.status_code == 422
    assert SESSION_VERSION in response.json()["detail"]


def test_student_workspace_and_current_report_flow(teaching_db, monkeypatch):
    client = _client(teaching_db)
    assert client.get("/api/classroom/announcements").json()["announcements"]
    assert client.get("/api/classroom/session").json()["session"] == empty_session()
    assert client.get("/api/classroom/progress").json()["current_step"] is None
    assert client.post("/api/classroom/progress", json={"step": 4}).json() == {"ok": True}
    assert client.get("/api/classroom/progress").json()["max_step"] == 4
    assert client.get("/api/classroom/report/generated").json()["markdown"] is None
    assert client.get("/api/classroom/report/mine").json() == {"state": "none"}
    assert client.post("/api/classroom/report/submit", json={"title": "尚未生成"}).status_code == 409

    async def blocked(*args, **kwargs):
        raise ReportGateError([{"step": 1, "missing": ["quiz"]}])

    monkeypatch.setattr(classroom_routes.concurrency, "run_cpu_bound", blocked)
    denied = client.post("/api/classroom/report/generate")
    assert denied.status_code == 409
    assert denied.json()["detail"]["blocked"][0]["step"] == 1

    async def generated(*args, **kwargs):
        return TeachingReport("# 当前报告", {"years": [2020], "runs": []}, "report.md")

    monkeypatch.setattr(classroom_routes.concurrency, "run_cpu_bound", generated)
    report = client.post("/api/classroom/report/generate")
    assert report.status_code == 200 and report.json()["suggested_filename"] == "report.md"
    submitted = client.post("/api/classroom/report/submit", json={"title": "我的报告"})
    assert submitted.status_code == 200 and submitted.json()["state"] == "pending"
    assert client.get("/api/classroom/report/mine").json()["title"] == "我的报告"

    assert client.post("/api/classroom/workspace/reset", json={"confirmation": "不正确"}).status_code == 422
    assert client.post("/api/classroom/workspace/reset", json={"confirmation": "清空当前实验"}).json() == {"ok": True}
    assert client.get("/api/classroom/report/mine").json() == {"state": "none"}


def test_teacher_administration_and_grading_flow(teaching_db):
    teacher = _client(teaching_db, "teacher")
    student = _client(teaching_db)
    assert student.get("/api/classroom/classes").status_code == 403
    assert teacher.get("/api/classroom/session").status_code == 403

    created_class = teacher.post(
        "/api/classroom/classes",
        json={"name": "新班", "code": "NEW", "semester": "2026", "note": ""},
    )
    assert created_class.status_code == 200
    class_id = created_class.json()["id"]
    assert teacher.post(
        "/api/classroom/classes",
        json={"name": "重复", "code": "NEW", "semester": "", "note": ""},
    ).status_code == 409
    assert teacher.get("/api/classroom/classes").json()["classes"]

    assert teacher.post(
        "/api/classroom/students",
        json={"username": "bad name", "display_name": "坏用户名", "password": "password-1234"},
    ).status_code == 400
    created_student = teacher.post(
        "/api/classroom/students",
        json={
            "username": "student2",
            "display_name": "学生二",
            "password": "student2-password",
            "student_no": "2",
            "class_id": class_id,
        },
    )
    assert created_student.status_code == 200
    account_id = created_student.json()["id"]
    assert teacher.post(
        "/api/classroom/students",
        json={"username": "student2", "display_name": "重复", "password": "student2-password"},
    ).status_code == 409
    assert teacher.post(f"/api/classroom/students/{account_id}", json={}).status_code == 400
    updated = teacher.post(
        f"/api/classroom/students/{account_id}",
        json={"display_name": "学生二改", "student_no": "002"},
    )
    assert updated.status_code == 200 and updated.json()["display_name"] == "学生二改"
    assert "active" not in updated.json()
    assert teacher.post(f"/api/classroom/students/{account_id}", json={"active": False}).status_code == 422
    assert teacher.post("/api/classroom/students/999999", json={"display_name": "无"}).status_code == 404
    assert teacher.get("/api/classroom/students", params={"class_id": class_id}).json()["students"][0]["username"] == "student2"
    overview = teacher.get("/api/classroom/overview", params={"class_id": class_id}).json()
    assert overview["student_count"] == 1 and "disabled_count" not in overview
    assert teacher.get("/api/classroom/overview", params={"class_id": 999999}).status_code == 404

    assert teacher.post(
        "/api/classroom/announcements",
        json={"title": "无效", "body": "", "class_id": 999999},
    ).status_code == 404
    announcement = teacher.post(
        "/api/classroom/announcements",
        json={"title": "新班公告", "body": "欢迎", "class_id": class_id},
    )
    assert announcement.status_code == 200
    announcement_id = announcement.json()["id"]
    assert any(row["id"] == announcement_id for row in teacher.get("/api/classroom/announcements").json()["announcements"])
    assert teacher.delete(f"/api/classroom/announcements/{announcement_id}").json() == {"ok": True}
    assert teacher.delete(f"/api/classroom/announcements/{announcement_id}").status_code == 404

    db.save_generated_report("student2", "# 报告", {"years": [2020], "runs": []})
    submission = db.submit_report("student2", "学生二报告")
    submission_id = submission["id"]
    assert teacher.get("/api/classroom/submissions").json()["submissions"][0]["id"] == submission_id
    assert teacher.get(f"/api/classroom/submissions/{submission_id}").json()["markdown"] == "# 报告"
    grade = teacher.post(
        f"/api/classroom/submissions/{submission_id}/grade",
        json={"score": 88, "feedback": "完成"},
    )
    assert grade.status_code == 200 and grade.json()["state"] == "graded"
    assert teacher.get("/api/classroom/submissions/999999").status_code == 404
    assert teacher.post(
        "/api/classroom/submissions/999999/grade", json={"score": 80, "feedback": ""}
    ).status_code == 404
