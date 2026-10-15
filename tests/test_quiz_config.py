"""Public persistence behavior on the explicitly selected isolated teaching database."""

from copy import deepcopy

import pytest

from gvcsim import artifacts, quizzes
from gvcsim.classroom import quiz_config


def test_snapshot_initialization_edits_reset_and_release_independence(teaching_db, monkeypatch):
    original = quiz_config.load_bank()
    assert original == quizzes.default_bank()
    defaults = original["steps"]["7"]["questions"]
    version = original["steps"]["7"]["version"]
    assert quiz_config.save_step(7, defaults, version, "teacher") == original
    changed_questions = deepcopy(defaults)
    changed_questions[0]["prompt"] += "（修改）"
    changed = quiz_config.save_step(7, changed_questions, version, "teacher")
    assert changed["revision"] == 1
    assert changed["steps"]["7"]["version"] == "quiz-step-7-r1"
    assert changed["steps"]["7"]["updated_by"] == "teacher"
    assert changed["steps"]["7"]["updated_at"]
    assert all(changed["steps"][k] == v for k, v in original["steps"].items() if k != "7")
    with pytest.raises(quiz_config.QuizChanged):
        quiz_config.save_step(7, defaults, version, "teacher")
    monkeypatch.setattr(artifacts, "release_identity", lambda _path=None: "b" * 32)
    teaching_db.reset_learning_records()
    teaching_db.initialize_schema()
    assert quiz_config.load_bank() == changed
    restored = quiz_config.save_step(7, defaults, "quiz-step-7-r1", "teacher")
    assert restored["revision"] == 2
    assert restored["steps"]["7"]["questions"] == defaults
    assert restored["steps"]["7"]["version"] == "quiz-step-7-r2"
    with teaching_db.conn() as c:
        assert quiz_config.load_bank(c) == restored
        quiz_config.assert_revision(c, 2)
        with pytest.raises(quiz_config.QuizChanged):
            quiz_config.assert_revision(c, 1)


def test_invalid_save_and_nonteacher_do_not_modify_snapshot(teaching_db):
    original = quiz_config.load_bank()
    version = original["steps"]["1"]["version"]
    questions = original["steps"]["1"]["questions"]
    for username in ("student01", "not-a-teacher"):
        with pytest.raises(PermissionError):
            quiz_config.save_step(1, questions, version, username)
    with pytest.raises(ValueError):
        quiz_config.save_step(1, [], version, "teacher")
    with pytest.raises(ValueError):
        quiz_config.save_step(1, original["steps"]["2"]["questions"], version, "teacher")
    assert quiz_config.load_bank() == original


def test_missing_snapshot_is_not_lazily_created(teaching_db):
    with teaching_db.conn() as c:
        c.execute("DELETE FROM quiz_config")
    with pytest.raises(teaching_db.Unavailable):
        quiz_config.load_bank()


def _edit_step(bank, step=1):
    entry = bank["steps"][str(step)]
    questions = deepcopy(entry["questions"])
    questions[0]["prompt"] += "（教师修改）"
    return quiz_config.save_step(step, questions, entry["version"], "teacher")


@pytest.mark.parametrize("existing", [False, True])
def test_generation_rejects_bank_changed_since_render_without_overwriting(teaching_db, existing):
    from gvcsim.session import empty_session

    db = teaching_db
    saved = db.save_session("student", empty_session())
    original = db.save_generated_report("student", "original", {}, saved["updated_at"]) if existing else None
    _edit_step(quiz_config.load_bank())
    with pytest.raises(quiz_config.QuizChanged):
        db.save_generated_report(
            "student",
            "stale",
            {"quiz_revision": 0},
            saved["updated_at"],
            original["updated_at"] if original else None,
        )
    assert db.latest_report("student") == original
    current = db.save_generated_report(
        "student",
        "current",
        {"quiz_revision": 1},
        saved["updated_at"],
        original["updated_at"] if original else None,
    )
    assert current["provenance"]["quiz_revision"] == 1
    assert db.submit_report("student")["state"] == "pending"


@pytest.mark.parametrize("state", ["draft", "pending", "graded"])
@pytest.mark.parametrize("legacy", [False, True])
def test_bank_edit_blocks_draft_but_preserves_submitted_report_and_grade(teaching_db, state, legacy):
    from gvcsim.session import empty_session

    db = teaching_db
    saved = db.save_session("student", empty_session())
    bank = quiz_config.load_bank()
    if not legacy:
        bank = _edit_step(bank)
    provenance = {} if legacy else {"quiz_revision": bank["revision"]}
    report = db.save_generated_report("student", "immutable content", provenance, saved["updated_at"])
    if state != "draft":
        report = db.submit_report("student")
    if state == "graded":
        student = next(row for row in db.list_students("teacher") if row["username"] == "student")
        report = db.grade_report(student["id"], 88, "保留评分", "teacher", report["updated_at"])
    _edit_step(quiz_config.load_bank())
    if state == "draft":
        with pytest.raises(quiz_config.QuizChanged):
            db.submit_report("student")
    else:
        assert db.submit_report("student") == report
        assert db.submit_report("student") == report
        teacher_reports = db.list_reports("teacher")
        assert teacher_reports[0]["markdown"] == "immutable content"
        assert teacher_reports[0]["report_outdated"] is False
    assert db.latest_report("student") == report


def test_teacher_roster_regrades_current_bank_and_reads_it_once(teaching_db, monkeypatch):
    from gvcsim.session import empty_session, make_record

    db = teaching_db
    bank = quiz_config.load_bank()
    session = empty_session()
    session["steps"]["1"] = make_record({"quiz": quizzes.correct_quiz(1, bank)})
    db.save_session("student", session)
    db.create_student("another", "另一学生", "another-password", teacher_username="teacher")
    assert 1 in next(r for r in db.list_students("teacher") if r["username"] == "student")["verified_completed_steps"]
    changed = _edit_step(bank)
    original_load = quiz_config.load_bank
    reads = []

    def counted_load(connection=None):
        reads.append(connection)
        return original_load(connection)

    monkeypatch.setattr(quiz_config, "load_bank", counted_load)
    rows = db.list_students("teacher")
    assert len(reads) == 1 and reads[0] is not None
    assert len(rows) >= 2
    student = next(r for r in rows if r["username"] == "student")
    assert 1 not in student["verified_completed_steps"]
    session["steps"]["1"] = make_record({"quiz": quizzes.correct_quiz(1, changed)})
    db.save_session("student", session)
    assert 1 in next(r for r in db.list_students("teacher") if r["username"] == "student")["verified_completed_steps"]


@pytest.mark.parametrize("field", ["id", "prompt", "correct", "option-id", "option-label", "hint", "explanation"])
@pytest.mark.parametrize("invalid", ["\x00", "\ud800", "\udfff"], ids=["NUL", "high-surrogate", "low-surrogate"])
def test_invalid_nested_quiz_text_returns_422_without_changing_bank(teaching_db, field, invalid):
    import json
    import os

    from fastapi.testclient import TestClient

    from gvcsim.api import app

    client = TestClient(app, raise_server_exceptions=False)
    login = client.post(
        "/api/auth/login", json={"username": "teacher", "password": os.environ["GVCSIM_BOOTSTRAP_PASSWORD"]}
    )
    assert login.status_code == 200
    client.headers["Authorization"] = "Bearer " + login.json()["token"]
    before = quiz_config.load_bank()
    entry = deepcopy(before["steps"]["1"])
    question = entry["questions"][0]
    value = "pasted " + invalid
    if field == "option-id":
        question["options"][0]["id"] = value
        question["correct"] = value
    elif field == "option-label":
        question["options"][0]["label"] = value
    elif field == "correct":
        question["correct"] = value
        question["options"][0]["id"] = value
    else:
        question[field] = value
    response = client.put(
        "/api/classroom/quizzes/1",
        content=json.dumps({"version": entry["version"], "questions": entry["questions"]}),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422, response.text
    assert quiz_config.load_bank() == before


def test_quiz_validation_preserves_multilingual_text_and_line_breaks(teaching_db):
    bank = quiz_config.load_bank()
    entry = deepcopy(bank["steps"]["1"])
    text = "中文 / 日本語 / e\u0301 / 👩🏽‍💻\n下一行\t内容"
    entry["questions"][0]["prompt"] = text
    entry["questions"][0]["hint"] = text
    result = quiz_config.save_step(1, entry["questions"], entry["version"], "teacher")
    assert result["steps"]["1"]["questions"][0]["prompt"] == text
    assert quiz_config.load_bank()["steps"]["1"]["questions"][0]["hint"] == text
