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
    current = db.latest_report(username)
    return db.save_generated_report(
        username, markdown, provenance, _session_version(username), current["updated_at"] if current else None
    )


@pytest.mark.parametrize("same_content", [True, False])
def test_concurrent_first_session_saves_are_content_idempotent(teaching_db, same_content):
    from threading import Barrier

    barrier = Barrier(2)
    first = empty_session()
    second = empty_session()
    if not same_content:
        second["steps"]["2"] = make_record({"value": 2})

    def save(payload):
        barrier.wait(timeout=5)
        try:
            return db.save_session("student", payload, None)
        except records.SessionChanged:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, (first, second)))
    successes = [result for result in results if result is not None]
    assert len(successes) == (2 if same_content else 1)
    assert all(result["updated_at"] == successes[0]["updated_at"] for result in successes)
    stored = db.get_session("student")
    assert stored["updated_at"] == successes[0]["updated_at"]
    assert stored["session"] in (first, second)


def test_v14_schema_contains_release_auth_class_and_quiz_contracts(teaching_db):
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
    assert names == {
        "schema_meta",
        "accounts",
        "academic_terms",
        "class_groups",
        "class_enrollments",
        "experiment_sessions",
        "reports",
        "quiz_config",
    }
    assert db.TEACHING_DB_VERSION == "gvcsim-teaching-db-v15"
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


def test_old_schema_is_not_silently_migrated(teaching_db):
    with db.conn() as connection:
        connection.execute("UPDATE schema_meta SET version='gvcsim-teaching-db-v11' WHERE singleton")
    db.shutdown()
    db._schema_ready = False
    with pytest.raises(db.SchemaVersionMismatch):
        db.initialize_schema()


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

    def generate(index):
        try:
            return db.save_generated_report("student", f"draft-{index}", provenance, expected_session_updated_at)
        except db.ReportChanged:
            return None

    with ThreadPoolExecutor(max_workers=6) as executor:
        reports = list(executor.map(generate, range(6)))

    winners = [report for report in reports if report is not None]
    assert len(winners) == 1 and winners[0]["state"] == "draft"
    assert db.latest_report("student")["markdown"] == winners[0]["markdown"]
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

    with pytest.raises(db.ReportChanged, match="学生刚重新提交了报告"):
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


def test_draft_submission_rejects_a_report_generated_from_an_older_session(teaching_db):
    first = empty_session()
    saved = db.save_session("student", first)
    assert saved is not None
    report = db.save_generated_report("student", "first", {}, saved["updated_at"])
    assert report is not None and report["state"] == "draft"
    changed = empty_session()
    changed["steps"]["1"] = make_record({"value": "changed after generation"})
    db.save_session("student", changed, saved["updated_at"])

    with pytest.raises(db.ReportChanged, match="重新生成"):
        db.submit_report("student")

    assert db.latest_report("student")["state"] == "draft"


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
    assert query_count == 3  # teacher authorization, one bank snapshot, and the entire roster


def test_student_list_uses_verified_completion_and_report_state(teaching_db):
    session = empty_session()
    session["steps"]["1"] = make_record({"quiz": {"version": "quiz-v4", "answers": {}}})
    db.save_session("student", session)
    _save_report("draft", {"years": [2020], "runs": []})
    row = db.list_students("teacher")[0]
    assert row["report_state"] == "draft"
    # A draft is not finished work; step 15 counts once the report is handed in.
    assert 15 not in row["verified_completed_steps"]
    assert "verified_completed_count" in row and "last_valid_activity" in row
    db.submit_report("student")
    row = db.list_students("teacher")[0]
    assert 15 in row["verified_completed_steps"] and row["report_outdated"] is False

    # Edited after handing in: still handed in (the teacher holds the submitted report), said as out of date.
    changed = empty_session()
    changed["steps"]["1"] = make_record({"value": "changed after report generation"})
    db.save_session("student", changed)
    row = db.list_students("teacher")[0]
    assert 15 in row["verified_completed_steps"]
    assert row["report_outdated"] is True


def test_teacher_reports_follow_current_record_without_blocking_grades(teaching_db):
    original = empty_session()
    db.save_session("student", original)
    _save_report("submitted version", {"years": [2020], "runs": []})
    submitted = db.submit_report("student")
    account_id = db.find_account("student")["id"]

    def check(outdated):
        listed = db.list_reports("teacher")[0]
        detail = db.get_report(account_id, "teacher")
        for row in (listed, detail):
            assert row["report_outdated"] is outdated
            assert "source_session" not in row
        assert listed == detail
        return detail

    check(False)
    changed = empty_session()
    changed["steps"]["1"] = make_record({"value": "edited"})
    db.save_session("student", changed)
    assert check(True)["markdown"] == "submitted version"
    assert db.grade_report(account_id, 88, "好", "teacher", submitted["updated_at"]) is not None
    assert check(True)["score"] == 88
    db.save_session("student", original)
    check(False)
    db.save_session("student", changed)
    check(True)
    _save_report("regenerated version", {"years": [2020], "runs": []})
    regenerated = check(False)
    assert regenerated["state"] == "pending" and regenerated["score"] is None
    db.submit_report("student")
    assert check(False)["markdown"] == "regenerated version"


def test_grading_does_not_count_as_student_activity(teaching_db):
    db.save_session("student", empty_session())
    _save_report("draft", {"years": [2020], "runs": []})
    submitted = db.submit_report("student")
    before = db.list_students("teacher")[0]["last_valid_activity"]
    assert before == submitted["submitted_at"]
    account_id = db.find_account("student")["id"]
    assert db.grade_report(account_id, 88, "好", "teacher", submitted["updated_at"]) is not None
    assert db.list_students("teacher")[0]["last_valid_activity"] == before


def test_academic_terms_classes_and_enrollments_group_students_without_changing_work(teaching_db):
    term = db.create_term("2026 秋", "teacher")
    first_class = db.create_class_group(term["id"], "国际商务 1 班", "teacher")
    second_class = db.create_class_group(term["id"], "国际商务 2 班", "teacher")
    assert first_class is not None and second_class is not None
    account_id = db.find_account("student")["id"]

    enrollments = db.set_student_enrollment(account_id, term["id"], first_class["id"], "teacher")
    assert enrollments == [
        {
            "term_id": term["id"],
            "term_name": "2026 秋",
            "class_id": first_class["id"],
            "class_name": "国际商务 1 班",
        }
    ]
    db.save_session("student", empty_session())
    moved = db.set_student_enrollment(account_id, term["id"], second_class["id"], "teacher")
    assert moved[0]["class_name"] == "国际商务 2 班"
    assert db.get_session("student") is not None
    assert db.list_students("teacher")[0]["enrollments"] == moved

    structure = db.list_academic_structure("teacher")
    assert structure[0]["student_count"] == 1
    assert [group["student_count"] for group in structure[0]["classes"]] == [0, 1]

    assert db.set_student_enrollment(account_id, term["id"], None, "teacher") == []
    assert db.get_session("student") is not None


def test_archived_academic_groups_keep_history_but_reject_new_activity(teaching_db):
    term = db.create_term("2025 秋", "teacher")
    first_class = db.create_class_group(term["id"], "历史班", "teacher")
    second_class = db.create_class_group(term["id"], "仍使用班", "teacher")
    assert first_class is not None and second_class is not None
    account_id = db.find_account("student")["id"]
    db.set_student_enrollment(account_id, term["id"], first_class["id"], "teacher")

    db.update_class_group(first_class["id"], {"is_active": False}, "teacher")
    existing = db.set_student_enrollment(account_id, term["id"], first_class["id"], "teacher")
    assert existing[0]["class_id"] == first_class["id"]
    db.set_student_enrollment(account_id, term["id"], None, "teacher")
    with pytest.raises(ValueError, match="已归档"):
        db.set_student_enrollment(account_id, term["id"], first_class["id"], "teacher")

    db.set_student_enrollment(account_id, term["id"], second_class["id"], "teacher")
    db.update_term(term["id"], {"is_active": False}, "teacher")
    with pytest.raises(ValueError, match="已归档学期"):
        db.create_class_group(term["id"], "不能新建", "teacher")
    with pytest.raises(ValueError, match="已归档"):
        db.create_student("archived-student", "归档学生", "archived-password", "", "teacher", second_class["id"])
    assert (
        db.set_student_enrollment(account_id, term["id"], second_class["id"], "teacher")[0]["class_id"]
        == second_class["id"]
    )
    assert db.set_student_enrollment(account_id, term["id"], None, "teacher") == []
    with pytest.raises(ValueError, match="已归档"):
        db.set_student_enrollment(account_id, term["id"], second_class["id"], "teacher")
    with pytest.raises(LookupError, match="学期不存在"):
        db.set_student_enrollment(account_id, 999_999, None, "teacher")


def test_teacher_progress_counts_step_15_only_for_a_handed_in_report(teaching_db):
    from gvcsim.classroom import management, records

    empty = {"steps": {}}
    report = {
        "provenance": {"report_fingerprint": records.report_fingerprint(empty)},
        "state": "draft",
        "generated_at": None,
        "submitted_at": None,
        "score": None,
        "graded_at": None,
        "updated_at": None,
    }
    draft = management._learning_status(None, report)
    assert 15 in draft["completion_missing"]
    submitted = management._learning_status(None, {**report, "state": "pending"})
    assert 15 not in submitted["completion_missing"]


def test_step_15_counts_once_handed_in_and_currentness_is_said_separately():
    from gvcsim.classroom import records
    from gvcsim.classroom import routes as classroom_routes

    session = empty_session()
    fingerprint = {"report_fingerprint": records.report_fingerprint(session)}
    draft = {"state": "draft", "provenance": fingerprint}
    state = classroom_routes._learning_state(session, report=draft)
    assert 15 not in state["completion"]["completed"] and state["report_current"] is True
    for handed_in in ("pending", "graded"):
        state = classroom_routes._learning_state(session, report={**draft, "state": handed_in})
        assert 15 in state["completion"]["completed"] and state["report_current"] is True
    # The record changed after handing in: step 15 stays done, the report reads as out of date.
    changed = empty_session()
    changed["steps"]["1"] = make_record({"value": "edited"})
    state = classroom_routes._learning_state(changed, report={**draft, "state": "graded"})
    assert 15 in state["completion"]["completed"] and state["report_current"] is False
    assert classroom_routes._learning_state(session, report=None)["report_current"] is False
