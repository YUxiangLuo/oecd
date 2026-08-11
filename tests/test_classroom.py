"""账号 × manifest 教学工作区的数据库与 HTTP 契约。"""

from __future__ import annotations

import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import psycopg
import pytest
from fastapi.testclient import TestClient

from gvcsim import artifacts, config, data_routes, quizzes, session as session_model, trusted_evidence
from gvcsim.api import app
from gvcsim.classroom import db, records

TEST_DSN = os.environ.get("GVCSIM_PG_DSN_TEST", "postgresql://alice:111111@127.0.0.1:5432/gvclab_test")
MANIFEST = "manifest-current-v7"
client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh_database(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(config, "PG_DSN", TEST_DSN)
    monkeypatch.setattr(artifacts, "manifest_id", lambda *_args, **_kwargs: MANIFEST)
    monkeypatch.setattr(data_routes, "manifest_id", lambda *_args, **_kwargs: MANIFEST)
    info = psycopg.conninfo.conninfo_to_dict(TEST_DSN)
    with psycopg.connect(**{**info, "dbname": "postgres"}, autocommit=True) as maintenance:
        if not maintenance.execute("SELECT 1 FROM pg_database WHERE datname=%s", (info["dbname"],)).fetchone():
            maintenance.execute(f'CREATE DATABASE "{info["dbname"]}"')
    db.shutdown()
    with psycopg.connect(TEST_DSN, autocommit=True) as connection:
        connection.execute("DROP SCHEMA public CASCADE")
        connection.execute("CREATE SCHEMA public")
    db._schema_ready = False
    db.initialize_schema()
    yield
    db.shutdown()
    db._schema_ready = False


def login(username: str = "student", password: str = "gvclab2026") -> dict[str, str]:
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _valid_session(manifest: str = MANIFEST, step: int | None = None) -> dict:
    session = session_model.empty_session(manifest)
    if step is not None:
        session["steps"][str(step)] = session_model.make_record({"value": step})
    return session


def _insert_report(connection, account_id: int, manifest: str, key: str) -> int:
    return connection.execute(
        "INSERT INTO reports(account_id,manifest_id,report_key,session_revision,markdown,provenance)"
        " VALUES (%s,%s,%s,1,%s,%s) RETURNING id",
        (account_id, manifest, key, f"# {key}", json.dumps({"artifact": {"years": [2020]}, "runs": []})),
    ).fetchone()["id"]


def _insert_submission(connection, account_id: int, manifest: str, report_id: int, title: str = "实验报告") -> int:
    submission_id = connection.execute(
        "INSERT INTO submissions(account_id,manifest_id,title,year,design,markdown)"
        " VALUES (%s,%s,%s,2020,%s,'# report') RETURNING id",
        (account_id, manifest, title, json.dumps({"report_key": "report", "runs": []})),
    ).fetchone()["id"]
    connection.execute(
        "INSERT INTO submission_versions(submission_id,version_no,report_id,title,year,design,markdown)"
        " VALUES (%s,1,%s,%s,2020,%s,'# report')",
        (submission_id, report_id, title, json.dumps({"report_key": "report", "runs": []})),
    )
    return submission_id


def test_v7_schema_has_no_course_assignment_enrollment_or_attempt_tables():
    with db.conn() as connection:
        version = connection.execute("SELECT version FROM schema_meta WHERE singleton").fetchone()["version"]
        tables = {
            row["tablename"]
            for row in connection.execute("SELECT tablename FROM pg_tables WHERE schemaname='public'").fetchall()
        }
    assert version == "gvcsim-teaching-db-v7"
    assert {"accounts", "classes", "step_progress", "experiment_sessions", "reports", "submissions"} <= tables
    assert {
        "course_runs",
        "assignments",
        "enrollments",
        "experiment_attempts",
        "attempt_sessions",
        "teacher_course_access",
        "course_class_links",
    }.isdisjoint(tables)


def test_old_schema_requires_an_explicit_reset():
    db.shutdown()
    with psycopg.connect(TEST_DSN, autocommit=True) as connection:
        connection.execute("UPDATE schema_meta SET version='gvcsim-teaching-db-v6'")
    db._schema_ready = False
    with pytest.raises(db.SchemaVersionMismatch, match="classroom-init --reset"):
        db.initialize_schema()


def test_all_active_teachers_manage_the_same_classes_and_students():
    db.provision_teacher("teacher2", "教师二", "teacher2-private-password")
    teacher2 = login("teacher2", "teacher2-private-password")
    created_class = client.post(
        "/api/classroom/classes",
        headers=teacher2,
        json={"name": "全局班级", "code": "GLOBAL", "semester": "2026 秋"},
    )
    assert created_class.status_code == 200
    class_id = created_class.json()["id"]
    created_student = client.post(
        "/api/classroom/students",
        headers=teacher2,
        json={
            "username": "global_student",
            "display_name": "全局学生",
            "password": "global-student-password",
            "class_id": class_id,
        },
    )
    assert created_student.status_code == 200

    teacher1 = login("teacher")
    assert any(
        row["id"] == class_id for row in client.get("/api/classroom/classes", headers=teacher1).json()["classes"]
    )
    students = client.get("/api/classroom/students", headers=teacher1).json()["students"]
    row = next(item for item in students if item["username"] == "global_student")
    cleared = client.post(f"/api/classroom/students/{row['id']}", headers=teacher1, json={"class_id": None})
    assert cleared.status_code == 200
    assert cleared.json()["class_id"] is None


def test_class_is_optional_and_does_not_control_student_access():
    teacher = login("teacher")
    created = client.post(
        "/api/classroom/students",
        headers=teacher,
        json={
            "username": "unassigned",
            "display_name": "未分班学生",
            "password": "unassigned-private-password",
            "class_id": None,
        },
    )
    assert created.status_code == 200 and created.json()["class_id"] is None
    student = login("unassigned", "unassigned-private-password")
    assert client.get("/api/classroom/session", headers=student).status_code == 200
    assert client.post("/api/classroom/progress", headers=student, json={"step": 4}).status_code == 200


def test_student_automatically_gets_current_manifest_workspace_and_meta_is_simple():
    headers = login()
    meta = client.get("/api/meta", headers=headers)
    assert meta.status_code == 200
    assert meta.json()["manifest_id"] == MANIFEST
    assert not ({"course_run_id", "assignment_id", "attempt_id", "due_at"} & set(meta.json()))

    initial = client.get("/api/classroom/session", headers=headers)
    assert initial.status_code == 200
    assert initial.json()["revision"] == 0
    assert initial.json()["session"] == _valid_session()
    saved = client.put(
        "/api/classroom/session",
        headers=headers,
        json={"base_revision": 0, "session": _valid_session(step=2)},
    )
    assert saved.status_code == 200
    assert saved.json()["revision"] == 1


def test_quiz_route_rejects_old_versions_returns_feedback_and_signs_a_correct_answer():
    headers = login()
    correct = quizzes.correct_quiz(1)
    stale = client.post(
        "/api/classroom/quiz/submit",
        headers=headers,
        json={"step": 1, "version": "old-version", "answers": correct["answers"]},
    )
    assert stale.status_code == 422
    question = quizzes.STEP_QUIZZES[1][0]
    wrong_option = next(option["id"] for option in question["options"] if option["id"] != question["correct"])
    wrong_answers = {**correct["answers"], str(question["id"]): wrong_option}
    wrong = client.post(
        "/api/classroom/quiz/submit",
        headers=headers,
        json={"step": 1, "version": correct["version"], "answers": wrong_answers},
    )
    assert wrong.status_code == 200 and wrong.json()["passed"] is False
    passed = client.post(
        "/api/classroom/quiz/submit",
        headers=headers,
        json={"step": 1, "version": correct["version"], "answers": correct["answers"]},
    )
    assert passed.status_code == 200 and passed.json()["passed"] is True
    assert passed.json()["quiz_id"]


def test_empty_report_endpoints_expose_current_workspace_state():
    headers = login()
    gate = client.get("/api/classroom/report/gate", headers=headers)
    assert gate.status_code == 200 and len(gate.json()["blocked"]) == 15
    generated = client.get("/api/classroom/report/generated", headers=headers)
    assert generated.status_code == 200 and generated.json()["report_key"] is None
    assert client.get("/api/classroom/report/mine", headers=headers).json() == {"state": "none"}
    missing = client.post(
        "/api/classroom/report/submit", headers=headers, json={"title": "不存在", "report_key": "missing"}
    )
    assert missing.status_code == 409


def test_manifest_switch_creates_a_new_workspace_and_retains_old_records(monkeypatch: pytest.MonkeyPatch):
    headers = login()
    assert (
        client.put(
            "/api/classroom/session", headers=headers, json={"base_revision": 0, "session": _valid_session(step=3)}
        ).status_code
        == 200
    )
    monkeypatch.setattr(artifacts, "manifest_id", lambda *_args, **_kwargs: "manifest-next-v7")

    fresh = client.get("/api/classroom/session", headers=headers)
    assert fresh.status_code == 200
    assert fresh.json()["revision"] == 0
    assert fresh.json()["session"]["manifest_id"] == "manifest-next-v7"
    with db.conn() as connection:
        rows = connection.execute("SELECT manifest_id FROM experiment_sessions ORDER BY manifest_id").fetchall()
    assert rows == [{"manifest_id": MANIFEST}]


def test_direct_session_write_rejects_a_noncurrent_manifest():
    with pytest.raises(db.WorkspaceScopeMismatch):
        db.save_session("student", _valid_session("foreign-manifest"), 0, session_model.merge_sessions)


def test_concurrent_session_writes_merge_under_one_account_manifest_lock():
    def write(step: int):
        return db.save_session("student", _valid_session(step=step), 0, session_model.merge_sessions)

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(write, range(1, 9)))
    assert all(result is not None for result in results)
    stored = db.get_session("student", MANIFEST)
    assert stored and stored["revision"] == 8
    assert set(stored["session"]["steps"]) == {str(step) for step in range(1, 9)}


def test_equal_revision_session_write_preserves_server_only_report_step():
    generated = db.save_session("student", _valid_session(step=16), 0, session_model.merge_sessions)
    assert generated and generated["revision"] == 1

    delayed_client_snapshot = _valid_session(step=2)
    saved = db.save_session("student", delayed_client_snapshot, 1, session_model.merge_sessions)

    assert saved and saved["merged_from"] is None
    assert set(saved["session"]["steps"]) == {"2", "16"}


def test_workspace_reset_requires_exact_confirmation_and_deletes_every_current_record():
    headers = login()
    with db.conn() as connection:
        account_id = connection.execute("SELECT id FROM accounts WHERE username='student'").fetchone()["id"]
        teacher_id = connection.execute("SELECT id FROM accounts WHERE username='teacher'").fetchone()["id"]
        connection.execute(
            "INSERT INTO step_progress(account_id,manifest_id,current_step,max_step) VALUES (%s,%s,4,4)",
            (account_id, MANIFEST),
        )
        connection.execute(
            "INSERT INTO experiment_sessions(account_id,manifest_id,revision,session) VALUES (%s,%s,1,%s)",
            (account_id, MANIFEST, json.dumps(_valid_session(step=4))),
        )
        event = db.record_evidence_event("student", 4, "quiz", MANIFEST, "a" * 64, {"ok": True})
        assert event["event_id"]
        report_id = _insert_report(connection, account_id, MANIFEST, "reset-report")
        submission_id = _insert_submission(connection, account_id, MANIFEST, report_id)
        version_id = connection.execute(
            "SELECT id FROM submission_versions WHERE submission_id=%s", (submission_id,)
        ).fetchone()["id"]
        connection.execute(
            "INSERT INTO grading_events(submission_id,submission_version_id,score,graded_by_account_id)"
            " VALUES (%s,%s,88,%s)",
            (submission_id, version_id, teacher_id),
        )

    wrong = client.post(
        "/api/classroom/workspace/reset",
        headers=headers,
        json={"manifest_id": MANIFEST, "confirmation": "确认"},
    )
    assert wrong.status_code == 422
    reset = client.post(
        "/api/classroom/workspace/reset",
        headers=headers,
        json={"manifest_id": MANIFEST, "confirmation": "清空当前实验"},
    )
    assert reset.status_code == 200 and reset.json()["ok"] is True
    with db.conn() as connection:
        for table in (
            "step_progress",
            "experiment_sessions",
            "learning_evidence_events",
            "reports",
            "submissions",
            "submission_versions",
            "grading_events",
        ):
            assert connection.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"] == 0
        audit = connection.execute("SELECT action FROM audit_log WHERE action='workspace.reset'").fetchone()
    assert audit == {"action": "workspace.reset"}


def test_writer_started_before_reset_cannot_recreate_workspace(monkeypatch: pytest.MonkeyPatch):
    writer_observed_reset_marker = threading.Event()
    allow_writer_to_lock = threading.Event()
    original_marker = records._workspace_reset_marker

    def pause_first_marker_read(connection, account_id: int, manifest_id: str) -> int:
        marker = original_marker(connection, account_id, manifest_id)
        if not writer_observed_reset_marker.is_set():
            writer_observed_reset_marker.set()
            assert allow_writer_to_lock.wait(timeout=5)
        return marker

    monkeypatch.setattr(records, "_workspace_reset_marker", pause_first_marker_read)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending_write = executor.submit(db.upsert_progress, "student", 6)
        try:
            assert writer_observed_reset_marker.wait(timeout=5)
            reset = db.reset_workspace("student", MANIFEST, "清空当前实验")
            assert reset and reset["ok"] is True
        finally:
            allow_writer_to_lock.set()
        with pytest.raises(db.WorkspaceScopeMismatch, match="工作区已被清空"):
            pending_write.result(timeout=5)

    assert db.get_progress("student") is None


def test_reset_rejects_an_old_manifest_and_teacher_role():
    student = login()
    old = client.post(
        "/api/classroom/workspace/reset",
        headers=student,
        json={"manifest_id": "old", "confirmation": "清空当前实验"},
    )
    assert old.status_code == 409
    teacher = login("teacher")
    forbidden = client.post(
        "/api/classroom/workspace/reset",
        headers=teacher,
        json={"manifest_id": MANIFEST, "confirmation": "清空当前实验"},
    )
    assert forbidden.status_code == 403


def test_removed_course_assignment_endpoints_are_hard_404():
    student = login()
    teacher = login("teacher")
    for path in (
        "/api/classroom/course-runs",
        "/api/classroom/assignments",
        "/api/classroom/enrollments",
        "/api/classroom/assignment-contexts",
        "/api/classroom/assignment-context/select",
    ):
        assert client.get(path, headers=teacher).status_code == 404
    assert client.delete("/api/classroom/session", headers=student).status_code == 405


def test_teacher_routes_validate_roles_duplicates_and_missing_targets():
    student = login()
    teacher = login("teacher")
    assert client.get("/api/classroom/classes", headers=student).status_code == 403
    assert client.get("/api/classroom/session", headers=teacher).status_code == 403
    duplicate_class = client.post(
        "/api/classroom/classes",
        headers=teacher,
        json={"name": "重复", "code": "GVC-DEMO"},
    )
    assert duplicate_class.status_code == 409
    invalid_username = client.post(
        "/api/classroom/students",
        headers=teacher,
        json={"username": "坏 用户", "display_name": "坏用户名", "password": "valid-private-password"},
    )
    assert invalid_username.status_code == 400
    duplicate_student = client.post(
        "/api/classroom/students",
        headers=teacher,
        json={"username": "student", "display_name": "重复", "password": "valid-private-password"},
    )
    assert duplicate_student.status_code == 409
    missing_class = client.post(
        "/api/classroom/students",
        headers=teacher,
        json={
            "username": "missing_class",
            "display_name": "不存在班级",
            "password": "valid-private-password",
            "class_id": 999999,
        },
    )
    assert missing_class.status_code == 404
    assert client.post("/api/classroom/students/2", headers=teacher, json={}).status_code == 400
    assert (
        client.post("/api/classroom/students/999999", headers=teacher, json={"display_name": "无"}).status_code == 404
    )
    assert client.get("/api/classroom/overview?class_id=999999", headers=teacher).status_code == 404
    assert client.get("/api/classroom/students?class_id=999999", headers=teacher).status_code == 404


def test_evidence_receipt_is_bound_to_account_and_manifest_event():
    payload = {"version": "course-quiz-v2", "answers": {"q1": "a"}}
    event = db.record_evidence_event(
        "student", 3, "quiz", MANIFEST, trusted_evidence.digest(payload), {"payload": payload}
    )
    token = trusted_evidence.issue_quiz_completion(
        subject="student", step=3, manifest_id=MANIFEST, payload=payload, event=event
    )
    assert trusted_evidence.verify_quiz_completion(
        token, subject="student", step=3, manifest_id=MANIFEST, payload=payload
    )
    assert not trusted_evidence.verify_quiz_completion(
        token, subject="student", step=3, manifest_id="other", payload=payload
    )


def test_teacher_lists_only_current_manifest_submissions():
    with db.conn() as connection:
        account_id = connection.execute("SELECT id FROM accounts WHERE username='student'").fetchone()["id"]
        current_report = _insert_report(connection, account_id, MANIFEST, "current")
        _insert_submission(connection, account_id, MANIFEST, current_report, "当前报告")
        old_report = _insert_report(connection, account_id, "old-manifest", "old")
        _insert_submission(connection, account_id, "old-manifest", old_report, "旧报告")
    rows = client.get("/api/classroom/submissions", headers=login("teacher")).json()["submissions"]
    assert [row["title"] for row in rows] == ["当前报告"]


def test_report_submission_revision_and_grading_history_are_manifest_scoped():
    with db.conn() as connection:
        account_id = connection.execute("SELECT id FROM accounts WHERE username='student'").fetchone()["id"]
        _insert_report(connection, account_id, MANIFEST, "report-one")
    first = db.submit_report("student", "第一版", "report-one", MANIFEST)
    assert first and first["version_no"] == 1
    graded = db.grade_submission(first["id"], 90, "很好", "teacher")
    assert graded and graded["state"] == "graded"
    with db.conn() as connection:
        _insert_report(connection, account_id, MANIFEST, "report-two")
    second = db.submit_report("student", "第二版", "report-two", MANIFEST)
    assert second and second["version_no"] == 2 and second["state"] == "pending"
    history = db.submission_history(first["id"], "teacher")
    assert history and [item["version_no"] for item in history["versions"]] == [1, 2]
    assert len(history["grades"]) == 1

    teacher = login("teacher")
    detail = client.get(f"/api/classroom/submissions/{first['id']}", headers=teacher)
    assert detail.status_code == 200 and detail.json()["title"] == "第二版"
    api_history = client.get(f"/api/classroom/submissions/{first['id']}/history", headers=teacher)
    assert api_history.status_code == 200 and len(api_history.json()["versions"]) == 2
    api_grade = client.post(
        f"/api/classroom/submissions/{first['id']}/grade",
        headers=teacher,
        json={"score": 95, "feedback": "修订很好"},
    )
    assert api_grade.status_code == 200 and api_grade.json()["score"] == 95
    assert client.get("/api/classroom/submissions/999999", headers=teacher).status_code == 404
    assert client.get("/api/classroom/submissions/999999/history", headers=teacher).status_code == 404
    assert (
        client.post("/api/classroom/submissions/999999/grade", headers=teacher, json={"score": 80}).status_code == 404
    )


def test_announcements_use_optional_class_only_as_audience_filter():
    global_notice = db.create_announcement("全体", "全员可见", "teacher")
    class_notice = db.create_announcement("本班", "班级可见", "teacher", 1)
    student_notices = db.list_announcements("student")
    assert {global_notice["id"], class_notice["id"]} <= {row["id"] for row in student_notices}
    db.create_student("unassigned", "未分班", "unassigned-private-password", teacher_username="teacher")
    assert global_notice["id"] in {row["id"] for row in db.list_announcements("unassigned")}
    assert class_notice["id"] not in {row["id"] for row in db.list_announcements("unassigned")}
    assert {global_notice["id"], class_notice["id"]} <= {row["id"] for row in db.list_announcements("teacher")}


def test_announcement_http_create_list_and_delete_contract():
    teacher = login("teacher")
    created = client.post(
        "/api/classroom/announcements",
        headers=teacher,
        json={"title": "API 公告", "body": "正文", "class_id": None},
    )
    assert created.status_code == 200
    student = login()
    assert created.json()["id"] in {
        row["id"] for row in client.get("/api/classroom/announcements", headers=student).json()["announcements"]
    }
    assert client.delete(f"/api/classroom/announcements/{created.json()['id']}", headers=teacher).status_code == 200
    assert client.delete(f"/api/classroom/announcements/{created.json()['id']}", headers=teacher).status_code == 404
    invalid_class = client.post(
        "/api/classroom/announcements",
        headers=teacher,
        json={"title": "不存在班级", "body": "", "class_id": 999999},
    )
    assert invalid_class.status_code == 404


def test_overview_includes_unassigned_students_and_current_manifest_progress():
    db.create_student("unassigned", "未分班", "unassigned-private-password", teacher_username="teacher")
    db.upsert_progress("unassigned", 7)
    overview = db.overview_stats(None, "teacher")
    assert overview["student_count"] == 2
    assert overview["step_reach"][6] == {"step": 7, "reached": 1}
    assert any(row["name"] == "未分班" and row["student_count"] == 1 for row in overview["class_breakdown"])


def test_overview_trends_filter_by_class_and_use_grading_date():
    other_class = db.create_class("另一个班", "OTHER", teacher_username="teacher")
    other_student = db.create_student(
        "other_student",
        "其他班学生",
        "other-student-password",
        class_id=other_class["id"],
        teacher_username="teacher",
    )
    with db.conn() as connection:
        student_id = connection.execute("SELECT id FROM accounts WHERE username='student'").fetchone()["id"]
        selected_report = _insert_report(connection, student_id, MANIFEST, "selected-class")
        selected_submission = _insert_submission(connection, student_id, MANIFEST, selected_report)
        other_report = _insert_report(connection, other_student["id"], MANIFEST, "other-class")
        _insert_submission(connection, other_student["id"], MANIFEST, other_report)
        connection.execute(
            "UPDATE submissions SET state='graded',score=91,submitted_at=current_date-10+time '12:00',"
            " graded_at=current_date+time '12:00' WHERE id=%s",
            (selected_submission,),
        )

    overview = db.overview_stats(1, "teacher")
    trend = {row["date"]: row for row in overview["submission_trend"]}
    submitted_day = (date.today() - timedelta(days=10)).strftime("%m-%d")
    graded_day = date.today().strftime("%m-%d")

    assert overview["submitted"] == 1 and overview["graded"] == 1
    assert trend[submitted_day] == {"date": submitted_day, "submitted": 1, "graded": 0}
    assert trend[graded_day] == {"date": graded_day, "submitted": 0, "graded": 1}
