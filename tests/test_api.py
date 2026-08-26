from fastapi.testclient import TestClient

from gvcsim import api as api_module
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


def test_health_checks_raw_years_before_database(monkeypatch):
    calls = []
    monkeypatch.setattr(api_module, "validate_release_cached", lambda *_args: None)
    monkeypatch.setattr(api_module, "processed_years", lambda: [2019, 2020])
    monkeypatch.setattr(api_module, "dataset_metadata", lambda *_args: {"raw_dimensions": {"bound": True}})
    monkeypatch.setattr(
        api_module,
        "validate_raw_source_bindings",
        lambda payload, years, raw_dir: calls.append(("raw", payload, years, raw_dir)),
    )
    monkeypatch.setattr(api_module.classroom_db, "readiness", lambda: calls.append("db") or {"status": "ok"})

    response = TestClient(app).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "years": [2019, 2020], "database": {"status": "ok"}}
    assert calls == [("raw", {"bound": True}, [2019, 2020], api_module.RAW_DATA_DIR), "db"]


def test_health_processed_failure_returns_error_detail(monkeypatch):
    calls = []
    monkeypatch.setattr(
        api_module,
        "validate_release_cached",
        lambda *_args: (_ for _ in ()).throw(FileNotFoundError("/srv/private/processed/release.json")),
    )
    monkeypatch.setattr(api_module, "processed_years", lambda: calls.append("years"))
    monkeypatch.setattr(api_module, "dataset_metadata", lambda *_args: calls.append("metadata"))
    monkeypatch.setattr(api_module, "validate_raw_source_bindings", lambda *_args: calls.append("raw"))
    monkeypatch.setattr(api_module.classroom_db, "readiness", lambda: calls.append("db"))

    response = TestClient(app).get("/health")

    assert response.status_code == 503
    assert response.json()["status"] == "unavailable"
    assert "/srv/private/processed/release.json" in response.json()["detail"]
    assert calls == []


def test_health_raw_failure_is_unavailable_without_database_check(monkeypatch):
    calls = []
    monkeypatch.setattr(api_module, "validate_release_cached", lambda *_args: None)
    monkeypatch.setattr(api_module, "processed_years", lambda: [2020])
    monkeypatch.setattr(api_module, "dataset_metadata", lambda *_args: {"raw_dimensions": {}})
    monkeypatch.setattr(
        api_module,
        "validate_raw_source_bindings",
        lambda *_args: (_ for _ in ()).throw(FileNotFoundError("raw missing")),
    )
    monkeypatch.setattr(api_module.classroom_db, "readiness", lambda: calls.append("db"))

    response = TestClient(app).get("/health")

    assert response.status_code == 503
    assert response.json() == {"status": "unavailable", "detail": "raw missing"}
    assert calls == []
    assert TestClient(app).get("/health/live").json() == {"status": "ok"}


def test_quiz_returns_normalized_answers(teaching_db):
    client = _client(teaching_db)
    correct = quizzes.correct_quiz(1)
    response = client.post("/api/classroom/quiz/submit", json={"step": 1, **correct})
    assert response.status_code == 200
    assert response.json()["quiz"] == correct


def test_session_contract_uses_optimistic_concurrency(teaching_db):
    client = _client(teaching_db)
    initial = client.get("/api/classroom/session").json()
    assert initial["updated_at"] is None

    first = empty_session()
    first["steps"]["16"] = make_record({"research_question": "学生自己的问题"})
    saved = client.put("/api/classroom/session", json={"session": first, "base_updated_at": initial["updated_at"]})
    assert set(saved.json()) == {"session", "updated_at", "completion"}
    assert saved.json()["session"] == first
    assert client.get("/api/classroom/session").json()["session"] == first

    second = empty_session()
    second["steps"]["2"] = make_record({"value": 2})
    replaced = client.put(
        "/api/classroom/session", json={"session": second, "base_updated_at": saved.json()["updated_at"]}
    )
    assert replaced.status_code == 200
    assert client.get("/api/classroom/session").json()["session"] == second

    stale = client.put("/api/classroom/session", json={"session": first, "base_updated_at": saved.json()["updated_at"]})
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "session_changed"
    assert client.get("/api/classroom/session").json()["session"] == second


def test_new_session_race_rejects_second_null_version_write(teaching_db):
    first_tab = _client(teaching_db)
    second_tab = _client(teaching_db)
    assert first_tab.get("/api/classroom/session").json()["updated_at"] is None
    assert second_tab.get("/api/classroom/session").json()["updated_at"] is None
    first = make_record({"compared": ["CHN"]})
    second = make_record({"compared": ["USA"]})
    first_session = {**empty_session(), "steps": {"7": first}}
    second_session = {**empty_session(), "steps": {"7": second}}

    assert (
        first_tab.put("/api/classroom/session", json={"session": first_session, "base_updated_at": None}).status_code
        == 200
    )
    rejected = second_tab.put("/api/classroom/session", json={"session": second_session, "base_updated_at": None})

    assert rejected.status_code == 409
    assert rejected.json()["detail"]["code"] == "session_changed"
    assert first_tab.get("/api/classroom/session").json()["session"] == first_session


def test_invalid_session_version_is_rejected(teaching_db):
    client = _client(teaching_db)
    response = client.put(
        "/api/classroom/session",
        json={"session": {"version": "old", "steps": {}, "shared": {}}, "base_updated_at": None},
    )
    assert response.status_code == 422
    assert SESSION_VERSION in response.json()["detail"]


def test_report_state_machine_and_failure_preserves_grade(teaching_db, monkeypatch):
    student = _client(teaching_db)
    teacher = _client(teaching_db, "teacher")
    assert (
        student.put("/api/classroom/session", json={"session": empty_session(), "base_updated_at": None}).status_code
        == 200
    )

    async def generated(*_args, **_kwargs):
        return TeachingReport("# 第一版", {"years": [2020], "runs": []}, "report.md")

    monkeypatch.setattr(classroom_routes.concurrency, "run_cpu_bound", generated)
    created = student.post("/api/classroom/report/generate")
    assert created.status_code == 200
    assert created.json()["report"]["state"] == "draft"
    assert student.get("/api/classroom/session").json()["report"]["markdown"] == "# 第一版"

    submitted = student.post("/api/classroom/report/submit")
    assert submitted.json()["report"]["state"] == "pending"
    account_id = db.find_account("student")["id"]
    assert teacher.get("/api/classroom/reports").json()["reports"][0]["account_id"] == account_id
    graded = teacher.post(
        f"/api/classroom/reports/{account_id}/grade",
        json={"score": 91, "feedback": "很好", "expected_updated_at": submitted.json()["report"]["updated_at"]},
    )
    assert graded.json()["state"] == "graded"

    # Repeated submit is idempotent and cannot erase a grade.
    repeated = student.post("/api/classroom/report/submit").json()["report"]
    assert repeated["state"] == "graded" and repeated["score"] == 91

    async def blocked(*_args, **_kwargs):
        raise ReportGateError([{"step": 1, "title": "数据", "missing": ["证据"]}])

    monkeypatch.setattr(classroom_routes.concurrency, "run_cpu_bound", blocked)
    denied = student.post("/api/classroom/report/generate")
    assert denied.status_code == 409
    preserved = student.get("/api/classroom/session").json()["report"]
    assert preserved["state"] == "graded" and preserved["score"] == 91

    async def regenerated(*_args, **_kwargs):
        return TeachingReport("# 第二版", {"years": [2020], "runs": []}, "report.md")

    monkeypatch.setattr(classroom_routes.concurrency, "run_cpu_bound", regenerated)
    replacement = student.post("/api/classroom/report/generate").json()["report"]
    assert replacement["state"] == "pending"
    assert replacement["markdown"] == "# 第二版"
    assert replacement["score"] is None and replacement["feedback"] == ""
    stale = teacher.post(
        f"/api/classroom/reports/{account_id}/grade",
        json={"score": 70, "feedback": "旧内容", "expected_updated_at": graded.json()["updated_at"]},
    )
    assert stale.status_code == 409
    assert "重新加载" in stale.json()["detail"]


def test_report_generation_rejects_session_changed_during_cpu_work(teaching_db, monkeypatch):
    student = _client(teaching_db)
    initial = student.put("/api/classroom/session", json={"session": empty_session(), "base_updated_at": None}).json()

    async def generated(*_args, **_kwargs):
        newer = empty_session()
        newer["steps"]["1"] = make_record({"value": "changed-during-generation"})
        db.save_session("student", newer, initial["updated_at"])
        return TeachingReport("# stale", {"years": [2020], "runs": []}, "report.md")

    monkeypatch.setattr(classroom_routes.concurrency, "run_cpu_bound", generated)
    response = student.post("/api/classroom/report/generate")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "session_changed"
    assert db.latest_report("student") is None


def test_teacher_student_management(teaching_db):
    teacher = _client(teaching_db, "teacher")
    student = _client(teaching_db)
    assert student.get("/api/classroom/students").status_code == 403
    assert teacher.get("/api/classroom/session").status_code == 403
    created = teacher.post(
        "/api/classroom/students",
        json={
            "username": "student2",
            "display_name": "学生二",
            "password": "student2-password",
            "student_no": "2",
        },
    )
    assert created.status_code == 200
    account_id = created.json()["id"]
    updated = teacher.post(
        f"/api/classroom/students/{account_id}", json={"display_name": "学生二改", "student_no": "002"}
    )
    assert updated.json()["display_name"] == "学生二改"
    cleared = teacher.post(f"/api/classroom/students/{account_id}", json={"student_no": ""})
    assert cleared.status_code == 200 and cleared.json()["student_no"] == ""
    rows = teacher.get("/api/classroom/students").json()["students"]
    assert next(row for row in rows if row["id"] == account_id)["verified_completed_count"] == 0


def test_deleted_classroom_endpoints_return_404(teaching_db):
    student = _client(teaching_db)
    teacher = _client(teaching_db, "teacher")
    for path in (
        "announcements",
        "progress",
        "classes",
        "overview",
        "submissions",
        "report/gate",
        "report/generated",
        "report/mine",
    ):
        assert student.get(f"/api/classroom/{path}").status_code == 404
    assert student.post("/api/classroom/workspace/reset", json={"confirmation": "清空当前实验"}).status_code == 404
    assert teacher.get("/api/classroom/classes").status_code == 404
