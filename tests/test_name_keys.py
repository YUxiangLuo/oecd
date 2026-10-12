import json
from pathlib import Path

import psycopg
import pytest

from gvcsim import auth
from gvcsim.classroom import db, management, routes
from gvcsim.name_keys import name_key
from gvcsim.regression.workbench import name_problem


def test_shared_name_keys():
    fixtures = json.loads((Path(__file__).parent / "fixtures/name_keys.json").read_text())
    for name, key in fixtures:
        assert name_key(name) == key
        if not key:
            assert name_problem(name) == "请输入名称"
    assert name_problem("👩🏽‍💻") is None
    assert name_problem("\ud800") is not None


def test_academic_names_compare_keys_but_keep_display_and_class_scope(teaching_db):
    term = management.create_term("Ａ（秋）👩‍💻", "teacher")
    assert term["name"] == "Ａ（秋）👩‍💻"
    with pytest.raises(psycopg.errors.UniqueViolation):
        management.create_term("a(秋)👩💻", "teacher")
    group = management.create_class_group(term["id"], "Ｂ班", "teacher")
    with pytest.raises(psycopg.errors.UniqueViolation):
        management.create_class_group(term["id"], "b班\ufe0f", "teacher")
    other = management.create_term("春", "teacher")
    assert management.create_class_group(other["id"], "b班", "teacher")
    assert management.update_class_group(group["id"], {"name": "B班"}, "teacher")["name"] == "B班"
    with pytest.raises(psycopg.errors.UniqueViolation):
        management.update_term(other["id"], {"name": "a(秋)👩💻"}, "teacher")
    for name in ["\u3164", "\u2800", "\u034f"]:
        with pytest.raises(ValueError):
            routes.AcademicNameRequest(name=name)


def test_ascii_login_creation_lookup_and_unique_constraint(teaching_db):
    student = management.create_student("Mixed.Case", "学生", "long-password-123")
    assert db.find_account("MIXED.CASE")["id"] == student["id"]
    authenticated = auth.authenticate("MIXED.CASE", "long-password-123")
    assert authenticated["username"] == student["username"]
    assert db.current_auth_subject(student["id"], authenticated["username"], "student", 1)
    assert db.find_account("ｍｉｘｅｄ.case") is None
    with pytest.raises(psycopg.errors.UniqueViolation):
        management.create_student("mixed.case", "学生2", "long-password-123")
    teacher = db.provision_teacher("Other.Teacher", "老师", "long-password-123")
    assert db.find_account("OTHER.TEACHER")["id"] == teacher["id"]
    with db.conn() as c:
        with pytest.raises(psycopg.errors.UniqueViolation):
            c.execute("UPDATE accounts SET username='MIXED.CASE' WHERE id=%s", (teacher["id"],))


def test_batch_login_names_are_case_insensitive(teaching_db):
    term = management.create_term("秋", "teacher")
    group = management.create_class_group(term["id"], "一班", "teacher")
    rows = [{"username": "Roster.A", "display_name": "甲", "password": "long-password-123"}]
    assert management.create_student_batch(rows, group["id"], "teacher", False)["created"] == 1
    assert management.create_student_batch(rows, group["id"], "teacher", True)["existing"] == ["roster.a"]
    with pytest.raises(ValueError, match="不能重复"):
        management.create_student_batch(rows + [{**rows[0], "username": "roster.a"}], group["id"], "teacher", True)
