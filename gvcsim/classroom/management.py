"""Minimal teacher administration for students and verified learning status."""

from __future__ import annotations

import secrets
from typing import Any

import psycopg

from gvcsim import config, demo_accounts
from gvcsim.classroom import quiz_config, records
from gvcsim.name_keys import required_name_key, username_key


class _DatabaseProxy:
    def __getattr__(self, name: str) -> Any:
        from gvcsim.classroom import db

        return getattr(db, name)


database = _DatabaseProxy()
_ASCII_CASE_TABLE = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
_USERNAME_KEY_SQL = "translate(username,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')"
_STUDENT_NO_KEY_SQL = "translate(student_no,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')"
_STUDENT_COLS = "a.id,a.username,a.display_name,a.student_no,a.last_login_at,a.created_at"
_ENROLLMENTS_SQL = (
    "SELECT ce.term_id,t.name AS term_name,ce.class_id,cg.name AS class_name "
    "FROM class_enrollments ce JOIN academic_terms t ON t.id=ce.term_id "
    "JOIN class_groups cg ON cg.id=ce.class_id WHERE ce.account_id=%s "
    "ORDER BY t.created_at DESC,t.id DESC,cg.name"
)


def _teacher_exists(c: psycopg.Connection[dict[str, Any]], username: str) -> bool:
    return c.execute("SELECT 1 FROM accounts WHERE username=%s AND role='teacher'", (username,)).fetchone() is not None


def _student_enrollments(c: psycopg.Connection[dict[str, Any]], account_id: int) -> list[dict[str, Any]]:
    return c.execute(_ENROLLMENTS_SQL, (account_id,)).fetchall()


def list_academic_structure(teacher_username: str) -> list[dict[str, Any]]:
    with database.conn() as c:
        if not _teacher_exists(c, teacher_username):
            return []
        terms = c.execute(
            "SELECT t.id,t.name,t.is_active,t.created_at,count(DISTINCT ce.account_id) AS student_count "
            "FROM academic_terms t LEFT JOIN class_enrollments ce ON ce.term_id=t.id "
            "GROUP BY t.id ORDER BY t.created_at DESC,t.id DESC"
        ).fetchall()
        classes = c.execute(
            "SELECT cg.id,cg.term_id,cg.name,cg.is_active,cg.created_at,count(ce.account_id) AS student_count "
            "FROM class_groups cg LEFT JOIN class_enrollments ce ON ce.class_id=cg.id "
            "GROUP BY cg.id ORDER BY cg.name,cg.id"
        ).fetchall()
    by_term: dict[int, list[dict[str, Any]]] = {term["id"]: [] for term in terms}
    for row in classes:
        by_term[row["term_id"]].append(row)
    for term in terms:
        term["classes"] = by_term[term["id"]]
    return terms


def create_term(name: str, teacher_username: str) -> dict[str, Any]:
    with database.conn() as c:
        if not _teacher_exists(c, teacher_username):
            raise PermissionError("教师账号无效")
        return database._required(
            c.execute(
                "INSERT INTO academic_terms(name,name_key) VALUES (%s,%s) RETURNING id,name,is_active,created_at",
                (name, required_name_key(name)),
            ).fetchone(),
            "create term",
        )


def update_term(term_id: int, fields: dict[str, Any], teacher_username: str) -> dict[str, Any] | None:
    sets: list[str] = []
    params: list[Any] = []
    for key in ("name", "is_active"):
        if key in fields:
            sets.append(f"{key}=%s")
            params.append(fields[key])
    if "name" in fields:
        sets.append("name_key=%s")
        params.append(required_name_key(fields["name"]))
    if not sets:
        return None
    with database.conn() as c:
        if not _teacher_exists(c, teacher_username):
            return None
        return c.execute(
            f"UPDATE academic_terms SET {','.join(sets)} WHERE id=%s RETURNING id,name,is_active,created_at",
            (*params, term_id),
        ).fetchone()


def create_class_group(term_id: int, name: str, teacher_username: str) -> dict[str, Any] | None:
    with database.conn() as c:
        if not _teacher_exists(c, teacher_username):
            raise PermissionError("教师账号无效")
        term = c.execute("SELECT is_active FROM academic_terms WHERE id=%s", (term_id,)).fetchone()
        if term is None:
            return None
        if not term["is_active"]:
            raise ValueError("已归档学期不能新建班级，请先恢复学期")
        return c.execute(
            "INSERT INTO class_groups(term_id,name,name_key) VALUES (%s,%s,%s) RETURNING id,term_id,name,is_active,created_at",
            (term_id, name, required_name_key(name)),
        ).fetchone()


def update_class_group(class_id: int, fields: dict[str, Any], teacher_username: str) -> dict[str, Any] | None:
    sets: list[str] = []
    params: list[Any] = []
    for key in ("name", "is_active"):
        if key in fields:
            sets.append(f"{key}=%s")
            params.append(fields[key])
    if "name" in fields:
        sets.append("name_key=%s")
        params.append(required_name_key(fields["name"]))
    if not sets:
        return None
    with database.conn() as c:
        if not _teacher_exists(c, teacher_username):
            return None
        return c.execute(
            f"UPDATE class_groups SET {','.join(sets)} WHERE id=%s RETURNING id,term_id,name,is_active,created_at",
            (*params, class_id),
        ).fetchone()


def set_student_enrollment(
    account_id: int,
    term_id: int,
    class_id: int | None,
    teacher_username: str,
) -> list[dict[str, Any]] | None:
    with database.conn() as c:
        if not _teacher_exists(c, teacher_username):
            return None
        student = c.execute("SELECT 1 FROM accounts WHERE id=%s AND role='student'", (account_id,)).fetchone()
        if student is None:
            return None
        term = c.execute("SELECT is_active FROM academic_terms WHERE id=%s", (term_id,)).fetchone()
        if term is None:
            raise LookupError("学期不存在")
        if class_id is None:
            c.execute("DELETE FROM class_enrollments WHERE term_id=%s AND account_id=%s", (term_id, account_id))
        else:
            class_group = c.execute(
                "SELECT is_active FROM class_groups WHERE id=%s AND term_id=%s",
                (class_id, term_id),
            ).fetchone()
            if class_group is None:
                raise ValueError("班级不属于所选学期")
            current = c.execute(
                "SELECT class_id FROM class_enrollments WHERE term_id=%s AND account_id=%s",
                (term_id, account_id),
            ).fetchone()
            if (not term["is_active"] or not class_group["is_active"]) and (
                current is None or current["class_id"] != class_id
            ):
                raise ValueError("这个学期或班级已归档，请先在“学期与班级”里恢复")
            c.execute(
                "INSERT INTO class_enrollments(term_id,class_id,account_id) VALUES (%s,%s,%s) "
                "ON CONFLICT (term_id,account_id) DO UPDATE SET class_id=EXCLUDED.class_id,created_at=now()",
                (term_id, class_id, account_id),
            )
        return _student_enrollments(c, account_id)


class StudentNumberTaken(ValueError):
    """A non-empty 学号 already belongs to another student (学号 identifies one student)."""


def _ensure_student_no_free(c: Any, student_no: str, exclude_id: int | None = None) -> None:
    key = student_no.strip().translate(_ASCII_CASE_TABLE)
    if not key:
        return
    owner = c.execute(
        "SELECT username,display_name FROM accounts"
        f" WHERE role='student' AND {_STUDENT_NO_KEY_SQL}=%s AND id IS DISTINCT FROM %s LIMIT 1",
        (key, exclude_id),
    ).fetchone()
    if owner is not None:
        raise StudentNumberTaken(f"学号 {student_no} 已被 {owner['display_name']}（{owner['username']}）使用")
    # Same rule as the batch import (学号 doubles as the login name there): a 学号 may not be another account's
    # username. A student's own username may equal its 学号.
    account = c.execute(
        f"SELECT username FROM accounts WHERE {_USERNAME_KEY_SQL}=%s AND id IS DISTINCT FROM %s LIMIT 1",
        (key, exclude_id),
    ).fetchone()
    if account is not None:
        raise StudentNumberTaken(f"学号 {student_no} 和已有账号 {account['username']} 的用户名重复，请换一个学号")


def _ensure_username_not_student_no(c: Any, username: str, exclude_id: int | None = None) -> None:
    owner = c.execute(
        "SELECT username,display_name FROM accounts"
        f" WHERE role='student' AND {_STUDENT_NO_KEY_SQL}=%s AND id IS DISTINCT FROM %s LIMIT 1",
        (username_key(username), exclude_id),
    ).fetchone()
    if owner is not None:
        raise StudentNumberTaken(
            f"用户名 {username} 已是 {owner['display_name']}（{owner['username']}）的学号，请换一个用户名"
        )


def create_student(
    username: str,
    display_name: str,
    password: str,
    student_no: str = "",
    teacher_username: str | None = None,
    class_id: int | None = None,
) -> dict[str, Any]:
    username = username_key(username)
    database._validate_managed_password(password)
    salt = secrets.token_hex(16)
    password_hash = database.hash_password(password, salt)
    with database.conn() as c:
        if teacher_username and not _teacher_exists(c, teacher_username):
            raise PermissionError("教师账号无效")
        database._lock_account_identities(c)
        _ensure_student_no_free(c, student_no)
        # Same rule as the batch import: a username must not be another student's 学号 either.
        _ensure_username_not_student_no(c, username)
        row = database._required(
            c.execute(
                "INSERT INTO accounts(username,display_name,role,student_no,pw_salt,pw_hash)"
                " VALUES (%s,%s,'student',%s,%s,%s)"
                " RETURNING id,username,display_name,student_no,last_login_at,created_at",
                (username, display_name, student_no, salt, password_hash),
            ).fetchone(),
            "create student",
        )
        if class_id is not None:
            class_group = c.execute(
                "SELECT cg.term_id,cg.is_active,t.is_active AS term_is_active "
                "FROM class_groups cg JOIN academic_terms t ON t.id=cg.term_id WHERE cg.id=%s",
                (class_id,),
            ).fetchone()
            if class_group is None:
                raise ValueError("班级不存在")
            if not class_group["is_active"] or not class_group["term_is_active"]:
                raise ValueError("这个学期或班级已归档，请先在“学期与班级”里恢复")
            c.execute(
                "INSERT INTO class_enrollments(term_id,class_id,account_id) VALUES (%s,%s,%s)",
                (class_group["term_id"], class_id, row["id"]),
            )
        row["enrollments"] = _student_enrollments(c, row["id"])
        return row


def create_student_batch(
    students: list[dict[str, Any]], class_id: int, teacher_username: str, preview: bool
) -> dict[str, Any]:
    """Validate again at commit and create the entire roster in one transaction."""
    students = [{**student, "username": username_key(student["username"])} for student in students]
    if len({student["username"] for student in students}) != len(students):
        raise ValueError("用户名不能重复")
    # Password derivation is deliberately outside the identity lock, even for a full 200-row class.
    if not preview:
        for student in students:
            database._validate_managed_password(student["password"])
            student["pw_salt"] = secrets.token_hex(16)
            student["pw_hash"] = database.hash_password(student["password"], student["pw_salt"])
    with database.conn() as c:
        if not _teacher_exists(c, teacher_username):
            raise PermissionError("教师账号无效")
        database._lock_account_identities(c)
        group = c.execute(
            "SELECT cg.term_id,cg.is_active,t.is_active AS term_is_active "
            "FROM class_groups cg JOIN academic_terms t ON t.id=cg.term_id WHERE cg.id=%s FOR SHARE OF cg,t",
            (class_id,),
        ).fetchone()
        if group is None or not group["is_active"] or not group["term_is_active"]:
            raise ValueError("这个学期或班级已归档，请选择使用中的班级")
        # Each roster 学号 becomes both the username and the 学号, so it conflicts with an
        # existing username or with another student's 学号.
        names = [student["username"] for student in students]
        existing = c.execute(
            f"SELECT {_USERNAME_KEY_SQL} AS username,{_STUDENT_NO_KEY_SQL} AS student_no FROM accounts"
            f" WHERE {_USERNAME_KEY_SQL}=ANY(%s) OR (role='student' AND {_STUDENT_NO_KEY_SQL}=ANY(%s))",
            (names, names),
        ).fetchall()
        taken = {row["username"] for row in existing} | {row["student_no"] for row in existing}
        conflicts = [name for name in names if name in taken]
        if preview:
            return {"existing": conflicts, "created": 0}
        if conflicts:
            raise ValueError("部分学号已有账号，本次没有创建任何学生")
        for student in sorted(students, key=lambda row: row["username"]):
            row = database._required(
                c.execute(
                    "INSERT INTO accounts(username,display_name,role,student_no,pw_salt,pw_hash) "
                    "VALUES (%s,%s,'student',%s,%s,%s) RETURNING id",
                    (
                        student["username"],
                        student["display_name"],
                        student["username"],
                        student["pw_salt"],
                        student["pw_hash"],
                    ),
                ).fetchone(),
                "batch student",
            )
            c.execute(
                "INSERT INTO class_enrollments(term_id,class_id,account_id) VALUES (%s,%s,%s)",
                (group["term_id"], class_id, row["id"]),
            )
        return {"existing": [], "created": len(students)}


def update_student(
    account_id: int, fields: dict[str, Any], teacher_username: str | None = None
) -> dict[str, Any] | None:
    sets: list[str] = []
    params: list[Any] = []
    for key in ("display_name", "student_no"):
        if key in fields:
            sets.append(f"{key}=%s")
            params.append(fields[key])
    if fields.get("password"):
        database._validate_managed_password(fields["password"])
        salt = secrets.token_hex(16)
        sets.extend(("pw_salt=%s", "pw_hash=%s", "auth_version=auth_version+1"))
        params.extend((salt, database.hash_password(fields["password"], salt)))
    if not sets:
        return None
    with database.conn() as c:
        if teacher_username and not _teacher_exists(c, teacher_username):
            return None
        if "student_no" in fields:
            database._lock_account_identities(c)
        target = c.execute(
            "SELECT username FROM accounts WHERE id=%s AND role='student'",
            (account_id,),
        ).fetchone()
        if target is None:
            return None
        if "student_no" in fields:
            _ensure_student_no_free(c, fields["student_no"], account_id)
        if fields.get("password") and config.DEMO_MODE and demo_accounts.is_demo_student_username(target["username"]):
            raise demo_accounts.DemoSeedPasswordProtected("演示账号不能修改密码；要演示改密码，请新建一个学生账号")
        row = c.execute(
            f"UPDATE accounts SET {','.join(sets)} WHERE id=%s AND role='student'"
            " RETURNING id,username,display_name,student_no,last_login_at,created_at",
            (*params, account_id),
        ).fetchone()
        if row is not None:
            row["enrollments"] = _student_enrollments(c, account_id)
        return row


def _learning_status(
    session: dict[str, Any] | None,
    report: dict[str, Any] | None,
    quiz_bank: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from gvcsim import evidence

    if quiz_bank is None:
        quiz_bank = quiz_config.load_bank()
    session_payload = session["session"] if session else {"steps": {}}
    # Step 15 counts once the report is handed in, as in the student's own progress count (records.report_handed_in);
    # a record changed since then is said separately (report_outdated), the teacher still holding the submitted one.
    handed_in = records.report_handed_in(report)
    summary = evidence.completion_summary(session_payload, report_exists=handed_in, quiz_bank=quiz_bank)
    # Only the student's own actions count; grading also bumps reports.updated_at, and viewing a page saves default
    # records (step 1's largest cell on the first login) that are not the student's work.
    timestamps = [
        value
        for value in (
            session and records.has_student_work(session_payload) and session["updated_at"],
            report and report["generated_at"],
            report and report["submitted_at"],
        )
        if value
    ]
    return {
        "verified_completed_count": len(summary["completed"]),
        "verified_total_steps": summary["total"],
        "verified_completed_steps": summary["completed"],
        "completion_missing": [item["step"] for item in summary["steps"] if not item["complete"]],
        "last_valid_activity": max(timestamps) if timestamps else None,
        "report_state": report["state"] if report else None,
        "report_outdated": handed_in and not records.report_matches_session(session_payload, report),
        "score": report["score"] if report else None,
        "generated_at": report["generated_at"] if report else None,
        "submitted_at": report["submitted_at"] if report else None,
        "graded_at": report["graded_at"] if report else None,
    }


def _learning_status_in_conn(c: psycopg.Connection[dict[str, Any]], account_id: int) -> dict[str, Any]:
    release_id = database.current_release_id()
    session = c.execute(
        "SELECT session,updated_at FROM experiment_sessions WHERE account_id=%s AND release_id=%s",
        (account_id, release_id),
    ).fetchone()
    report = c.execute(
        "SELECT state,score,provenance,generated_at,submitted_at,graded_at,updated_at FROM reports"
        " WHERE account_id=%s AND release_id=%s",
        (account_id, release_id),
    ).fetchone()
    return _learning_status(session, report, quiz_config.load_bank(c))


def list_students(teacher_username: str | None = None) -> list[dict[str, Any]]:
    release_id = database.current_release_id()
    with database.conn() as c:
        if teacher_username and not _teacher_exists(c, teacher_username):
            return []
        quiz_bank = quiz_config.load_bank(c)
        rows = c.execute(
            f"SELECT {_STUDENT_COLS},s.session AS learning_session,s.updated_at AS session_updated_at,"
            "r.state AS learning_report_state,r.score AS report_score,r.generated_at AS report_generated_at,"
            "r.submitted_at AS report_submitted_at,r.graded_at AS report_graded_at,"
            "r.updated_at AS report_updated_at,r.provenance AS report_provenance,"
            "COALESCE((SELECT jsonb_agg(jsonb_build_object('term_id',ce.term_id,'term_name',t.name,"
            "'class_id',ce.class_id,'class_name',cg.name) ORDER BY t.created_at DESC,t.id DESC) "
            "FROM class_enrollments ce JOIN academic_terms t ON t.id=ce.term_id "
            "JOIN class_groups cg ON cg.id=ce.class_id WHERE ce.account_id=a.id),'[]'::jsonb) AS enrollments "
            "FROM accounts a"
            " LEFT JOIN experiment_sessions s ON s.account_id=a.id AND s.release_id=%s"
            " LEFT JOIN reports r ON r.account_id=a.id AND r.release_id=%s"
            " WHERE a.role='student' ORDER BY a.student_no,a.username",
            (release_id, release_id),
        ).fetchall()
        for row in rows:
            row["demo_seed"] = config.DEMO_MODE and demo_accounts.is_demo_student_username(row["username"])
            session_payload = row.pop("learning_session")
            session_updated_at = row.pop("session_updated_at")
            report_state = row.pop("learning_report_state")
            report = {
                "state": report_state,
                "score": row.pop("report_score"),
                "provenance": row.pop("report_provenance"),
                "generated_at": row.pop("report_generated_at"),
                "submitted_at": row.pop("report_submitted_at"),
                "graded_at": row.pop("report_graded_at"),
                "updated_at": row.pop("report_updated_at"),
            }
            session = {"session": session_payload, "updated_at": session_updated_at}
            row.update(
                _learning_status(
                    session if session_payload is not None else None, report if report_state else None, quiz_bank
                )
            )
        return rows
