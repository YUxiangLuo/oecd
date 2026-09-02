from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import pytest

from gvcsim import artifacts, auth, config, demo_accounts
from gvcsim.classroom import db, records
from gvcsim.session import empty_session, make_record


def _session_version(username: str = "student"):
    row = db.get_session(username)
    if row is None:
        saved = db.save_session(username, empty_session())
        assert saved is not None
        return saved["updated_at"]
    return row["updated_at"]


def _save_report(markdown: str, provenance: dict, username: str = "student"):
    return db.save_generated_report(username, markdown, provenance, _session_version(username))


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


def test_schema_mismatch_requires_migration_without_recommending_reset_as_upgrade(teaching_db):
    with db.conn() as connection:
        connection.execute("UPDATE schema_meta SET version='gvcsim-teaching-db-v9' WHERE singleton")

    db._schema_ready = False
    with pytest.raises(db.SchemaVersionMismatch) as exc_info:
        db.initialize_schema()

    message = str(exc_info.value)
    assert "兼容迁移" in message
    assert "不能用 `uv run gvcsim classroom-init --reset` 代替普通升级" in message


def test_readiness_requires_a_teacher_account(teaching_db):
    with db.conn() as connection:
        connection.execute("DELETE FROM accounts WHERE role='teacher'")
    with pytest.raises(db.Unavailable, match="缺少教师账号"):
        db.readiness()


def test_demo_catalog_has_fifty_unique_student_credentials():
    students = demo_accounts.demo_student_credentials("gvclab2026")
    assert len(students) == demo_accounts.DEMO_STUDENT_COUNT == 50
    assert len({student.username for student in students}) == 50
    assert len({student.password for student in students}) == 50
    assert students[0].username == "student" and students[0].password == "gvclab2026"
    assert students[-1].username == "student50" and students[-1].password == "gvclab2026-50"
    assert demo_accounts.is_demo_student_username("student")
    assert demo_accounts.is_demo_student_username("student50")
    assert not demo_accounts.is_demo_student_username("student51")


def test_existing_demo_database_is_idempotently_expanded_without_reset(teaching_db, monkeypatch):
    monkeypatch.setattr(demo_accounts, "DEMO_STUDENT_COUNT", 50)
    with db.conn() as connection:
        synced = db._sync_demo_accounts(connection)
        counts = connection.execute("SELECT role,count(*) AS n FROM accounts GROUP BY role").fetchall()
    assert synced == {"created": 49, "updated": 0}
    assert {row["role"]: row["n"] for row in counts} == {"student": 50, "teacher": 1}
    assert auth.authenticate("student50", f"{config.BOOTSTRAP_PASSWORD}-50") is not None
    with db.conn() as connection:
        assert db._sync_demo_accounts(connection) == {"created": 0, "updated": 0}


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
    _save_report("release-a-report", {"release_id": "a" * 32})

    monkeypatch.setattr(artifacts, "release_identity", lambda _path=None: "b" * 32)
    assert db.get_session("student") is None
    assert db.latest_report("student") is None
    release_b = empty_session()
    release_b["steps"]["1"] = make_record({"value": "release-b"})
    db.save_session("student", release_b)
    _save_report("release-b-report", {"release_id": "b" * 32})

    monkeypatch.setattr(artifacts, "release_identity", lambda _path=None: "a" * 32)
    assert db.get_session("student")["session"] == release_a
    assert db.latest_report("student")["markdown"] == "release-a-report"


def test_concurrent_first_report_generation_atomically_keeps_one_draft(teaching_db):
    provenance = {"years": [2020], "runs": []}
    expected_session_updated_at = _session_version()
    with ThreadPoolExecutor(max_workers=6) as executor:
        reports = list(
            executor.map(
                lambda index: db.save_generated_report(
                    "student", f"draft-{index}", provenance, expected_session_updated_at
                ),
                range(6),
            )
        )

    assert all(report is not None and report["state"] == "draft" for report in reports)
    account_id = db.find_account("student")["id"]
    with db.conn() as connection:
        rows = connection.execute(
            "SELECT state FROM reports WHERE account_id=%s AND release_id=%s",
            (account_id, db.current_release_id()),
        ).fetchall()
    assert rows == [{"state": "draft"}]


def test_report_generation_submission_and_grading_rules(teaching_db):
    provenance = {"years": [2020], "runs": []}
    assert _save_report("draft", provenance)["state"] == "draft"
    pending = db.submit_report("student")
    assert pending["state"] == "pending"
    account_id = db.find_account("student")["id"]
    assert db.grade_report(account_id, 90, "good", "teacher", pending["updated_at"])["state"] == "graded"
    assert db.submit_report("student")["score"] == 90
    regenerated = _save_report("replacement", provenance)
    assert regenerated["state"] == "pending"
    assert regenerated["score"] is None and regenerated["feedback"] == ""
    assert regenerated["graded_by"] is None and regenerated["graded_at"] is None
    assert regenerated["submitted_at"] >= pending["submitted_at"]
    assert regenerated["generated_at"] == regenerated["updated_at"]
    assert db.get_report(account_id, "teacher")["markdown"] == "replacement"


def test_stale_teacher_view_cannot_grade_a_regenerated_report(teaching_db):
    provenance = {"years": [2020], "runs": []}
    _save_report("first", provenance)
    viewed = db.submit_report("student")
    account_id = db.find_account("student")["id"]
    _save_report("replacement", provenance)

    with pytest.raises(db.ReportChanged, match="重新加载"):
        db.grade_report(account_id, 70, "based on first", "teacher", viewed["updated_at"])
    current = db.get_report(account_id, "teacher")
    assert current["markdown"] == "replacement"
    assert current["state"] == "pending" and current["score"] is None


def test_report_save_rejects_a_session_version_changed_during_generation(teaching_db):
    expected = _session_version()
    changed = empty_session()
    changed["steps"]["1"] = make_record({"value": "newer"})
    db.save_session("student", changed, expected)

    with pytest.raises(records.SessionChanged, match="生成期间"):
        db.save_generated_report("student", "stale", {"runs": []}, expected)
    assert db.latest_report("student") is None


def test_student_list_query_count_is_constant(teaching_db, monkeypatch):
    for index in range(3):
        db.create_student(
            f"bulk-student-{index}",
            f"批量学生 {index}",
            f"bulk-student-password-{index}",
            teacher_username="teacher",
        )

    original_conn = db.conn
    query_count = 0

    class CountingConnection:
        def __init__(self, connection):
            self.connection = connection

        def execute(self, *args, **kwargs):
            nonlocal query_count
            query_count += 1
            return self.connection.execute(*args, **kwargs)

    @contextmanager
    def counting_conn():
        with original_conn() as connection:
            yield CountingConnection(connection)

    monkeypatch.setattr(db, "conn", counting_conn)
    rows = db.list_students("teacher")

    assert len(rows) == 4
    assert query_count == 2


def test_student_list_uses_verified_completion_and_report_state(teaching_db):
    session = empty_session()
    session["steps"]["1"] = make_record({"quiz": {"version": "quiz-v4", "answers": {}}})
    db.save_session("student", session)
    _save_report("draft", {"years": [2020], "runs": []})
    row = db.list_students("teacher")[0]
    assert row["report_state"] == "draft"
    assert "verified_completed_count" in row and "last_valid_activity" in row
