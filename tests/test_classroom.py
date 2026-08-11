from gvcsim.classroom import db
from gvcsim.session import empty_session, make_record


def test_v8_schema_contains_only_minimal_tables(teaching_db):
    with db.conn() as connection:
        names = {row["tablename"] for row in connection.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname='public'"
        ).fetchall()}
    assert names == {
        "schema_meta", "classes", "accounts", "step_progress", "experiment_sessions",
        "reports", "submissions", "announcements",
    }


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


def test_current_submission_overwrite_resets_grade(teaching_db):
    provenance = {"years": [2019, 2020], "runs": [{"step": 12, "outcome": "trade"}]}
    db.save_generated_report("student", "first report", provenance)
    first = db.submit_report("student", "first")
    db.grade_submission(first["id"], 90, "good", "teacher")
    assert db.my_submission("student")["state"] == "graded"

    db.save_generated_report("student", "second report", provenance)
    second = db.submit_report("student", "second")
    assert second["id"] == first["id"]
    mine = db.my_submission("student")
    assert mine["state"] == "pending"
    assert mine["score"] is None and mine["feedback"] == ""
    assert db.get_submission(first["id"], "teacher")["markdown"] == "second report"


def test_workspace_reset_only_deletes_learning_records(teaching_db):
    db.upsert_progress("student", 4)
    db.save_session("student", empty_session())
    db.save_generated_report("student", "report", {"years": [2020], "runs": []})
    db.submit_report("student", "report")
    assert db.reset_workspace("student", "清空当前实验") == {"ok": True}
    assert db.get_progress("student") is None
    assert db.get_session("student") is None
    assert db.find_account("student") is not None
    assert db.list_classes("teacher")
    assert db.list_announcements("teacher")


def test_global_recompute_reset_preserves_administration(teaching_db):
    db.upsert_progress("student", 3)
    db.save_generated_report("student", "report", {"years": [2020], "runs": []})
    db.reset_learning_records()
    assert db.get_progress("student") is None
    assert db.latest_report("student") is None
    assert db.find_account("teacher") is not None
    assert db.list_announcements("teacher")


def test_teacher_sees_all_announcements_and_class_filter_applies(teaching_db):
    class_two = db.create_class("二班", "TWO", teacher_username="teacher")
    db.create_student("student2", "学生二", "student2-password", class_id=class_two["id"], teacher_username="teacher")
    announcement = db.create_announcement("二班公告", "body", "teacher", class_two["id"])
    assert announcement["id"] in {row["id"] for row in db.list_announcements("teacher")}
    assert db.overview_stats(class_two["id"], "teacher")["student_count"] == 1
