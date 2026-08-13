import pytest

from gvcsim import artifacts
from gvcsim.classroom import db
from gvcsim.session import empty_session, make_record


def test_v10_schema_contains_release_and_auth_bound_contract(teaching_db):
    with db.conn() as connection:
        names = {
            row["tablename"]
            for row in connection.execute("SELECT tablename FROM pg_tables WHERE schemaname='public'").fetchall()
        }
        account_columns = {
            row["column_name"]
            for row in connection.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name='accounts'"
            ).fetchall()
        }
        session_columns = {
            row["column_name"]
            for row in connection.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name='experiment_sessions'"
            ).fetchall()
        }
    assert names == {"schema_meta", "accounts", "experiment_sessions", "reports"}
    assert db.TEACHING_DB_VERSION == "gvcsim-teaching-db-v10"
    assert "auth_version" in account_columns
    assert "release_id" in session_columns


def test_readiness_requires_a_teacher_account(teaching_db):
    with db.conn() as connection:
        connection.execute("DELETE FROM accounts WHERE role='teacher'")
    with pytest.raises(db.Unavailable, match="缺少教师账号"):
        db.readiness()


def test_session_is_account_isolated_last_write_wins(teaching_db):
    first = empty_session()
    first["steps"]["1"] = make_record({"value": "first"})
    second = empty_session()
    second["steps"]["1"] = make_record({"value": "second"})
    db.save_session("student", first)
    db.save_session("student", second)
    assert db.get_session("student")["session"] == second
    db.create_student("student2", "学生二", "student2-password", teacher_username="teacher")
    assert db.get_session("student2") is None


def test_sessions_and_reports_are_isolated_by_release(teaching_db, monkeypatch):
    release_a = empty_session()
    release_a["steps"]["1"] = make_record({"value": "release-a"})
    db.save_session("student", release_a)
    db.save_generated_report("student", "release-a-report", {"release_id": "a" * 32})

    monkeypatch.setattr(artifacts, "release_identity", lambda _path=None: "b" * 32)
    assert db.get_session("student") is None
    assert db.latest_report("student") is None
    release_b = empty_session()
    release_b["steps"]["1"] = make_record({"value": "release-b"})
    db.save_session("student", release_b)
    db.save_generated_report("student", "release-b-report", {"release_id": "b" * 32})

    monkeypatch.setattr(artifacts, "release_identity", lambda _path=None: "a" * 32)
    assert db.get_session("student")["session"] == release_a
    assert db.latest_report("student")["markdown"] == "release-a-report"


def test_report_generation_submission_and_grading_rules(teaching_db):
    provenance = {"years": [2020], "runs": []}
    assert db.save_generated_report("student", "draft", provenance)["state"] == "draft"
    pending = db.submit_report("student")
    assert pending["state"] == "pending"
    account_id = db.find_account("student")["id"]
    assert db.grade_report(account_id, 90, "good", "teacher", pending["updated_at"])["state"] == "graded"
    assert db.submit_report("student")["score"] == 90
    regenerated = db.save_generated_report("student", "replacement", provenance)
    assert regenerated["state"] == "pending"
    assert regenerated["score"] is None and regenerated["feedback"] == ""
    assert db.get_report(account_id, "teacher")["markdown"] == "replacement"


def test_stale_teacher_view_cannot_grade_a_regenerated_report(teaching_db):
    provenance = {"years": [2020], "runs": []}
    db.save_generated_report("student", "first", provenance)
    viewed = db.submit_report("student")
    account_id = db.find_account("student")["id"]
    db.save_generated_report("student", "replacement", provenance)

    with pytest.raises(db.ReportChanged, match="重新加载"):
        db.grade_report(account_id, 70, "based on first", "teacher", viewed["updated_at"])
    current = db.get_report(account_id, "teacher")
    assert current["markdown"] == "replacement"
    assert current["state"] == "pending" and current["score"] is None


def test_student_list_uses_verified_completion_and_report_state(teaching_db):
    session = empty_session()
    session["steps"]["1"] = make_record({"quiz": {"version": "quiz-v4", "answers": {}}})
    db.save_session("student", session)
    db.save_generated_report("student", "draft", {"years": [2020], "runs": []})
    row = db.list_students("teacher")[0]
    assert row["report_state"] == "draft"
    assert "verified_completed_count" in row and "last_valid_activity" in row
