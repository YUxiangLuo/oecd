"""Deterministic report races against real PostgreSQL transactions."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from gvcsim import teaching_report
from gvcsim.api import app
from gvcsim.classroom import db
from gvcsim.session import empty_session, make_record


def client(username="student", password="gvclab2026"):
    result = TestClient(app, raise_server_exceptions=False)
    login = result.post("/api/auth/login", json={"username": username, "password": password})
    assert login.status_code == 200
    result.headers["Authorization"] = "Bearer " + login.json()["token"]
    return result


def seed_report():
    saved = db.save_session("student", empty_session())
    report = db.save_generated_report("student", "old report", {}, saved["updated_at"])
    db.submit_report("student")
    return saved, report, db.find_account("student")["id"]


@pytest.mark.parametrize("grade_during_build", [False, True])
def test_stale_student_generation_preserves_grade_and_allows_confirmed_retry(
    teaching_db, monkeypatch, grade_during_build
):
    _, _, account_id = seed_report()
    student = client()
    viewed = student.get("/api/classroom/session").json()["report"]
    graded = None

    def grade():
        nonlocal graded
        graded = db.grade_report(account_id, 96, "preserve this feedback", "teacher", viewed["updated_at"])

    def build(_session, _name, *, quiz_bank):
        if grade_during_build and graded is None:
            grade()
        return teaching_report.TeachingReport("replacement", {}, "test.md")

    monkeypatch.setattr(teaching_report, "build", build)
    if not grade_during_build:
        grade()
    rejected = student.post("/api/classroom/report/generate", json={"expected_report_updated_at": viewed["updated_at"]})
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["detail"]["code"] == "report_changed"
    assert db.latest_report("student") == graded
    refreshed = student.get("/api/classroom/session").json()["report"]
    accepted = student.post(
        "/api/classroom/report/generate", json={"expected_report_updated_at": refreshed["updated_at"]}
    )
    assert accepted.status_code == 200, accepted.text
    replacement = accepted.json()["report"]
    assert replacement["state"] == "pending" and replacement["markdown"] == "replacement"
    assert replacement["score"] is None and replacement["feedback"] == ""


@pytest.mark.parametrize("existing_report", [False, True])
def test_session_saved_during_report_build_rejects_stale_source(teaching_db, monkeypatch, existing_report):
    student = client()
    saved = db.save_session("student", empty_session())
    if existing_report:
        db.save_generated_report("student", "previous report", {}, saved["updated_at"])
    original = db.latest_report("student")
    entered, release = threading.Event(), threading.Event()

    def blocked_build(_session, _name, *, quiz_bank):
        entered.set()
        assert release.wait(10)
        return teaching_report.TeachingReport("stale report", {}, "test.md")

    monkeypatch.setattr(teaching_report, "build", blocked_build)
    with ThreadPoolExecutor(max_workers=1) as executor:
        generation = executor.submit(
            student.post,
            "/api/classroom/report/generate",
            json={"expected_report_updated_at": original["updated_at"].isoformat() if original else None},
        )
        try:
            assert entered.wait(5)
            updated = empty_session()
            updated["steps"]["15"] = make_record({"research_question": "newer evidence"})
            response = student.put(
                "/api/classroom/session",
                json={
                    "session": updated,
                    "base_updated_at": saved["updated_at"].isoformat(),
                },
            )
            assert response.status_code == 200
        finally:
            release.set()
        response = generation.result(timeout=10)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "session_changed"
    assert db.latest_report("student") == original
    assert db.get_session("student")["session"] == updated


@contextmanager
def hold_after_write(monkeypatch, query_prefix):
    original_conn = db.conn
    entered, release = threading.Event(), threading.Event()

    class ControlledConnection:
        def __init__(self, connection):
            self.connection = connection

        def execute(self, query, *args, **kwargs):
            cursor = self.connection.execute(query, *args, **kwargs)
            if isinstance(query, str) and query.startswith(query_prefix):
                entered.set()
                assert release.wait(10), "test failed to release transaction"
            return cursor

        def __getattr__(self, key):
            return getattr(self.connection, key)

    @contextmanager
    def controlled_conn():
        with original_conn() as connection:
            yield ControlledConnection(connection)

    monkeypatch.setattr(db, "conn", controlled_conn)

    def wait_for_blocked():
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with original_conn() as connection:
                waiting = connection.execute(
                    "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database()"
                    " AND wait_event_type='Lock' AND query LIKE '%reports%'"
                ).fetchone()["n"]
            if waiting:
                return
            time.sleep(0.01)
        raise AssertionError("competing report transaction did not wait for the row lock")

    try:
        yield entered, release, wait_for_blocked
    finally:
        release.set()


@pytest.mark.parametrize("first", ["grade", "regenerate"])
def test_grade_and_regeneration_have_a_legal_serial_outcome(teaching_db, monkeypatch, first):
    _, _, account_id = seed_report()
    pending = db.latest_report("student")
    teacher = client("teacher")
    student = client()
    monkeypatch.setattr(
        teaching_report, "build", lambda *_args, quiz_bank: teaching_report.TeachingReport("new report", {}, "test.md")
    )

    def grade():
        return teacher.post(
            f"/api/classroom/reports/{account_id}/grade",
            json={
                "score": 88,
                "feedback": "old report feedback",
                "expected_updated_at": pending["updated_at"].isoformat(),
            },
        )

    def regenerate():
        return student.post(
            "/api/classroom/report/generate",
            json={"expected_report_updated_at": pending["updated_at"].isoformat()},
        )

    prefix = "UPDATE reports SET state='graded'" if first == "grade" else "INSERT INTO reports"
    with (
        hold_after_write(monkeypatch, prefix) as (entered, release, wait_for_blocked),
        ThreadPoolExecutor(max_workers=2) as executor,
    ):
        first_job = executor.submit(grade if first == "grade" else regenerate)
        try:
            assert entered.wait(5)
            second_job = executor.submit(regenerate if first == "grade" else grade)
            wait_for_blocked()
        finally:
            release.set()
        first_result, second_result = first_job.result(timeout=10), second_job.result(timeout=10)
    grading = first_result if first == "grade" else second_result
    generation = second_result if first == "grade" else first_result
    assert grading.status_code == (200 if first == "grade" else 409), grading.text
    assert generation.status_code == (409 if first == "grade" else 200), generation.text
    final = db.latest_report("student")
    if first == "grade":
        assert generation.json()["detail"]["code"] == "report_changed"
        assert final["markdown"] == "old report" and final["state"] == "graded"
        assert final["score"] == 88 and final["feedback"] == "old report feedback"
    else:
        assert final["markdown"] == "new report" and final["state"] == "pending"
        assert final["score"] is None and final["feedback"] == "" and final["graded_by"] is None


def test_two_teacher_views_cannot_both_grade_the_same_version(teaching_db, monkeypatch):
    _, _, account_id = seed_report()
    db.provision_teacher("second-teacher", "Second teacher", "second-teacher-2026")
    first, second = client("teacher"), client("second-teacher", "second-teacher-2026")
    pending = db.latest_report("student")
    payload = {"score": 91, "feedback": "first", "expected_updated_at": pending["updated_at"].isoformat()}
    with hold_after_write(monkeypatch, "UPDATE reports SET state='graded'") as (entered, release, wait_for_blocked):
        with ThreadPoolExecutor(max_workers=2) as executor:
            one = executor.submit(first.post, f"/api/classroom/reports/{account_id}/grade", json=payload)
            try:
                assert entered.wait(5)
                two = executor.submit(
                    second.post,
                    f"/api/classroom/reports/{account_id}/grade",
                    json={
                        **payload,
                        "score": 12,
                        "feedback": "stale",
                    },
                )
                wait_for_blocked()
            finally:
                release.set()
            assert one.result(timeout=10).status_code == 200
            assert two.result(timeout=10).status_code == 409
    report = db.latest_report("student")
    assert report["score"] == 91 and report["feedback"] == "first"
