"""HTTP regressions from fresh-deployment dogfood, including database non-mutation."""

import json
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from gvcsim.api import app
from gvcsim.classroom import db
from gvcsim.classroom.routes import (
    AcademicNameRequest,
    AcademicUpdateRequest,
    GradeRequest,
    StudentCreateRequest,
    StudentUpdateRequest,
    normalize_label,
)
from gvcsim.session import empty_session
from test_saved_run_integrity import saved_run
from test_teaching_report import _complete


def client_for(username):
    client = TestClient(app, raise_server_exceptions=False)
    login = client.post("/api/auth/login", json={"username": username, "password": "gvclab2026"})
    assert login.status_code == 200
    client.headers["Authorization"] = f"Bearer {login.json()['token']}"
    return client


@pytest.mark.parametrize("field", ["display_name", "student_no", "password"])
def test_null_student_update_is_rejected_without_mutation(teaching_db, field):
    client = client_for("teacher")
    account = db.find_account("student")
    response = client.post(f"/api/classroom/students/{account['id']}", json={field: None})
    assert response.status_code == 422, response.text
    assert db.find_account("student") == account


@pytest.mark.parametrize("operation", ["create", "update"])
def test_blank_student_name_is_rejected(teaching_db, operation):
    client = client_for("teacher")
    if operation == "create":
        response = client.post(
            "/api/classroom/students",
            json={
                "username": "blank-name",
                "display_name": " \t\n ",
                "password": "valid-password-2026",
            },
        )
        assert db.find_account("blank-name") is None
    else:
        account = db.find_account("student")
        response = client.post(f"/api/classroom/students/{account['id']}", json={"display_name": " \t\n "})
        assert db.find_account("student") == account
    assert response.status_code == 422, response.text


@pytest.mark.parametrize(
    "key,value",
    [
        ("1", float("nan")),
        ("1", float("inf")),
        ("1", -float("inf")),
        ("1", "\x00"),
        ("1", "\ud800"),
        ("²", None),
        ("01", None),
        ("１", None),
    ],
)
def test_invalid_session_is_rejected_before_writing(teaching_db, key, value):
    client = client_for("student")
    session = empty_session()
    session["steps"][key] = {"data": {"value": value}}
    response = client.put(
        "/api/classroom/session",
        content=json.dumps(
            {
                "session": session,
                "base_updated_at": None,
            }
        ),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422, response.text
    assert db.get_session("student") is None


def test_session_accepts_unicode_and_finite_numeric_boundaries(teaching_db):
    client = client_for("student")
    session = empty_session()
    session["steps"]["15"] = {"data": {"text": "中文 👩🏽‍💻\n\t", "values": [0, -1, 1e308, None, True]}}
    response = client.put("/api/classroom/session", json={"session": session, "base_updated_at": None})
    assert response.status_code == 200, response.text
    restored = client.get("/api/classroom/session").json()["session"]
    # PostgreSQL JSONB expands exponent notation; JavaScript reads both as the same number.
    restored["steps"]["15"]["data"]["values"][2] = float(restored["steps"]["15"]["data"]["values"][2])
    assert restored == session


def _regression_session():
    session = empty_session()
    session["steps"]["10"] = _complete()["steps"]["10"]
    session["steps"]["11"] = {"data": {"run": saved_run()}}
    return json.loads(json.dumps(session))


def _poison_regression_number(session, step, value):
    data = session["steps"][str(step)]["data"]
    if step == 10:
        data["teaching_observation"]["teaching_export_share_w"] = value
    else:
        data["run"]["result"]["coefs"][0]["coef"] = value


@pytest.mark.parametrize("method,status", [("PUT", 422), ("PATCH", 405)])
@pytest.mark.parametrize("step", [10, 11])
@pytest.mark.parametrize("value", [10**400, -(10**400)])
def test_out_of_range_regression_save_preserves_previous_session(teaching_db, method, status, step, value):
    client = client_for("student")
    valid = _regression_session()
    initial = client.put("/api/classroom/session", json={"session": valid, "base_updated_at": None})
    assert initial.status_code == 200, initial.text
    stored = db.get_session("student")
    bad = deepcopy(valid)
    _poison_regression_number(bad, step, value)

    # PATCH is unsupported; it must not become an alternate write path around PUT's validation.
    response = client.request(
        method,
        "/api/classroom/session",
        json={"session": bad, "base_updated_at": initial.json()["updated_at"]},
    )

    assert response.status_code == status, response.text
    assert db.get_session("student") == stored
    restored = client.get("/api/classroom/session")
    assert restored.status_code == 200, restored.text
    assert restored.json()["session"] == valid
    assert restored.json()["updated_at"] == initial.json()["updated_at"]


@pytest.mark.parametrize("username,password", [("a\x00b", "password"), ("unknown", "\ud800"), ("\ud800", "password")])
def test_invalid_login_text_returns_422_without_echoing_password(teaching_db, username, password):
    response = TestClient(app, raise_server_exceptions=False).post(
        "/api/auth/login",
        content=json.dumps({"username": username, "password": password}),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422, response.text
    assert all("input" not in error and "ctx" not in error for error in response.json()["detail"])


@pytest.mark.parametrize("field", ["display_name", "student_no"])
@pytest.mark.parametrize("value", ["\x00", "\ud800"])
def test_invalid_account_text_never_reaches_database(teaching_db, field, value):
    client = client_for("teacher")
    body = {"username": "invalid-text", "password": "valid-password-2026", "display_name": "姓名", field: value}
    response = client.post(
        "/api/classroom/students", content=json.dumps(body), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422, response.text
    assert db.find_account("invalid-text") is None


@pytest.mark.parametrize(
    "fields", [{"score": float("nan")}, {"score": float("inf")}, {"score": 92, "feedback": "\x00"}]
)
def test_invalid_grade_payload_returns_validation_error(teaching_db, fields):
    client = client_for("teacher")
    response = client.post(
        "/api/classroom/reports/999/grade",
        content=json.dumps(
            {
                **fields,
                "expected_updated_at": "2026-09-07T00:00:00Z",
            }
        ),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422, response.text
    assert all("input" not in error for error in response.json()["detail"])


def test_invalid_unicode_validation_location_is_serializable(teaching_db):
    client = client_for("teacher")
    response = client.post(
        "/api/classroom/students/999", content=json.dumps({"\ud800": 1}), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"][0]["type"] == "string_unicode"


def test_student_number_is_trimmed_bounded_and_unique_after_trimming(teaching_db):
    client = client_for("teacher")
    body = {"username": "sno-owner", "display_name": "甲", "password": "valid-password-2026", "student_no": "2026023"}
    assert client.post("/api/classroom/students", json=body).status_code == 200
    padded = {**body, "username": "sno-padded", "student_no": " 2026023 "}
    response = client.post("/api/classroom/students", json=padded)
    assert response.status_code == 409, response.text
    assert db.find_account("sno-padded") is None
    too_long = {**body, "username": "sno-long", "student_no": "9" * 41}
    assert client.post("/api/classroom/students", json=too_long).status_code == 422
    assert db.find_account("sno-long") is None
    account = db.find_account("sno-owner")
    response = client.post(f"/api/classroom/students/{account['id']}", json={"student_no": "9" * 300})
    assert response.status_code == 422, response.text
    response = client.post(f"/api/classroom/students/{account['id']}", json={"student_no": " 2026024 "})
    assert response.status_code == 200, response.text
    assert response.json()["student_no"] == "2026024"


def test_whitespace_only_password_is_rejected(teaching_db):
    client = client_for("teacher")
    body = {"username": "blank-pass", "display_name": "乙", "password": " " * 12}
    assert client.post("/api/classroom/students", json=body).status_code == 422
    assert db.find_account("blank-pass") is None
    body["password"] = "valid-password-2026"
    account = client.post("/api/classroom/students", json=body).json()
    response = client.post(f"/api/classroom/students/{account['id']}", json={"password": "\t" * 12})
    assert response.status_code == 422, response.text


def test_login_ignores_spaces_around_the_username(teaching_db):
    response = TestClient(app).post("/api/auth/login", json={"username": "  student \t", "password": "gvclab2026"})
    assert response.status_code == 200, response.text
    assert response.json()["user"]["username"] == "student"


def test_student_number_strips_invisible_characters(teaching_db):
    client = client_for("teacher")
    bom = {
        "username": "\ufeffbom-user\u200b",
        "display_name": "乙",
        "password": "valid-password-2026",
        "student_no": "\ufeff2026998",
    }
    created = client.post("/api/classroom/students", json=bom)
    assert created.status_code == 200, created.text
    assert created.json()["username"] == "bom-user"
    assert created.json()["student_no"] == "2026998"


def test_blank_password_is_a_field_error_in_batch_preview_and_self_service(teaching_db):
    teacher = client_for("teacher")
    term = db.create_term("2026 秋", "teacher")
    group = db.create_class_group(term["id"], "一班", "teacher")
    roster = {
        "class_id": group["id"],
        "preview": True,
        "students": [{"username": "b-1", "display_name": "甲", "password": " " * 12}],
    }
    assert teacher.post("/api/classroom/students/batch", json=roster).status_code == 422
    student = client_for("student")
    response = student.post("/api/auth/password", json={"current_password": "gvclab2026", "new_password": " " * 12})
    assert response.status_code == 422


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("2026　秋", "2026 秋"),
        ("2026  秋", "2026 秋"),
        ("2026​秋", "2026秋"),
        ("﻿ ２０２６秋 ⁠", "2026秋"),
        ("Ａ班\t\n二组", "A班 二组"),
        # Full-width punctuation is how Chinese is written: kept, while the digits beside it still fold.
        ("王五（转专业）", "王五（转专业）"),
        ("国贸１班：（二）！", "国贸1班：（二）！"),
        ("e\u0301（备注）", "é（备注）"),
    ],
)
def test_normalize_label_folds_lookalike_text(raw, expected):
    assert normalize_label(raw) == expected
    assert normalize_label(None) is None
    assert normalize_label(3) == 3


def test_label_length_is_checked_after_normalization():
    # 61 characters as typed, 60 after collapsing the double space: accepted.
    name = "名" + "  " + "字" * 58
    assert len(StudentCreateRequest(username="ab", display_name=name, password="x" * 12).display_name) == 60
    # Only zero-width characters: blank after normalization, so rejected.
    with pytest.raises(ValidationError):
        StudentCreateRequest(username="ab", display_name="​‌", password="x" * 12)
    with pytest.raises(ValidationError):
        StudentUpdateRequest(display_name="﻿ ​")
    with pytest.raises(ValidationError):
        AcademicNameRequest(name="​")
    with pytest.raises(ValidationError):
        AcademicUpdateRequest(name=None)
    assert AcademicUpdateRequest(name=" 一班　 ").name == "一班"
    assert StudentUpdateRequest(student_no="２０２６ ００１").student_no == "2026 001"


def test_usernames_keep_edge_stripping_only():
    request = StudentCreateRequest(username="﻿ab​ ", display_name="x", password="x" * 12)
    assert request.username == "ab"
    # Internal whitespace is not collapsed away: the route still rejects it.
    assert StudentCreateRequest(username="a b", display_name="x", password="x" * 12).username == "a b"


def test_whitespace_only_feedback_is_no_feedback():
    request = GradeRequest(score=80, feedback=" \n\t　", expected_updated_at="2026-09-07T00:00:00Z")
    assert request.feedback == ""
    assert GradeRequest(score=80, feedback="  好  ", expected_updated_at="2026-09-07T00:00:00Z").feedback == "好"


def test_lookalike_semester_and_class_names_collide(teaching_db):
    client = client_for("teacher")
    created = client.post("/api/classroom/semesters", json={"name": "2026  秋"})
    assert created.status_code == 200, created.text
    # Inner runs of whitespace become one space, in the stored name as in its comparison key; NFKC, invisibles
    # and edge whitespace are normalized for comparison only.
    assert created.json()["name"] == "2026 秋"
    for lookalike in ["2026 秋", "2026　　秋", "２０２６  秋", "2026  ​秋", " 2026  秋 ", "2026\t秋"]:
        response = client.post("/api/classroom/semesters", json={"name": lookalike})
        assert response.status_code == 409, (lookalike, response.text)
    term_id = created.json()["id"]
    first = client.post("/api/classroom/classes", json={"term_id": term_id, "name": "一班"})
    assert first.status_code == 200, first.text
    duplicate = client.post("/api/classroom/classes", json={"term_id": term_id, "name": "一​班"})
    assert duplicate.status_code == 409, duplicate.text
    other = client.post("/api/classroom/semesters", json={"name": "2027 春"})
    rename = client.post(f"/api/classroom/semesters/{other.json()['id']}", json={"name": "２０２６  秋"})
    assert rename.status_code == 409, rename.text


def test_student_name_and_number_are_normalized(teaching_db):
    client = client_for("teacher")
    invisible = client.post(
        "/api/classroom/students",
        json={"username": "invisible-name", "display_name": "​‍", "password": "valid-password-2026"},
    )
    assert invisible.status_code == 422, invisible.text
    assert db.find_account("invisible-name") is None
    created = client.post(
        "/api/classroom/students",
        json={
            "username": "fullwidth-no",
            "display_name": " 张　　三 ",
            "password": "valid-password-2026",
            "student_no": "２０２６７７７",
        },
    )
    assert created.status_code == 200, created.text
    assert created.json()["display_name"] == "张 三"
    assert created.json()["student_no"] == "2026777"
    duplicate = client.post(
        "/api/classroom/students",
        json={
            "username": "fullwidth-dup",
            "display_name": "李四",
            "password": "valid-password-2026",
            "student_no": "2026777",
        },
    )
    assert duplicate.status_code == 409, duplicate.text


def test_single_create_rejects_a_username_that_is_another_students_number(teaching_db):
    client = client_for("teacher")
    owner = client.post(
        "/api/classroom/students",
        json={
            "username": "number-owner",
            "display_name": "甲",
            "password": "valid-password-2026",
            "student_no": "2026555",
        },
    )
    assert owner.status_code == 200, owner.text
    clash = client.post(
        "/api/classroom/students",
        json={"username": "2026555", "display_name": "乙", "password": "valid-password-2026"},
    )
    assert clash.status_code == 409, clash.text
    assert "2026555" in clash.json()["detail"]
    assert db.find_account("2026555") is None


def test_a_student_number_may_not_be_another_accounts_username(teaching_db):
    client = client_for("teacher")
    clash = client.post(
        "/api/classroom/students",
        json={"username": "new-one", "display_name": "丙", "password": "valid-password-2026", "student_no": "student"},
    )
    assert clash.status_code == 409, clash.text
    assert "student" in clash.json()["detail"]
    # A student's own username may equal its 学号 (the batch import does exactly that).
    own = client.post(
        "/api/classroom/students",
        json={"username": "2026777", "display_name": "丁", "password": "valid-password-2026", "student_no": "2026777"},
    )
    assert own.status_code == 200, own.text


def test_whitespace_only_feedback_is_saved_empty(teaching_db):
    session = db.save_session("student", empty_session())
    assert session is not None
    db.save_generated_report("student", "report", {"years": [2020], "runs": []}, session["updated_at"])
    submitted = db.submit_report("student")
    assert submitted is not None
    account_id = db.find_account("student")["id"]
    client = client_for("teacher")
    response = client.post(
        f"/api/classroom/reports/{account_id}/grade",
        json={"score": 75, "feedback": "  \n\t ", "expected_updated_at": submitted["updated_at"].isoformat()},
    )
    assert response.status_code == 200, response.text
    assert db.get_report(account_id, "teacher")["feedback"] == ""
