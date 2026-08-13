"""Minimal teacher administration for students and verified learning status."""

from __future__ import annotations

import secrets
from typing import Any

import psycopg


class _DatabaseProxy:
    def __getattr__(self, name: str) -> Any:
        from gvcsim.classroom import db

        return getattr(db, name)


database = _DatabaseProxy()
_STUDENT_COLS = "a.id,a.username,a.display_name,a.student_no,a.last_login_at,a.created_at"


def _teacher_exists(c: psycopg.Connection[dict[str, Any]], username: str) -> bool:
    return c.execute("SELECT 1 FROM accounts WHERE username=%s AND role='teacher'", (username,)).fetchone() is not None


def create_student(
    username: str,
    display_name: str,
    password: str,
    student_no: str = "",
    teacher_username: str | None = None,
) -> dict[str, Any]:
    database._validate_managed_password(password)
    salt = secrets.token_hex(16)
    with database.conn() as c:
        if teacher_username and not _teacher_exists(c, teacher_username):
            raise PermissionError("教师账号无效")
        return database._required(
            c.execute(
                "INSERT INTO accounts(username,display_name,role,student_no,pw_salt,pw_hash)"
                " VALUES (%s,%s,'student',%s,%s,%s)"
                " RETURNING id,username,display_name,student_no,last_login_at,created_at",
                (username, display_name, student_no, salt, database.hash_password(password, salt)),
            ).fetchone(),
            "create student",
        )


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
        return c.execute(
            f"UPDATE accounts SET {','.join(sets)} WHERE id=%s AND role='student'"
            " RETURNING id,username,display_name,student_no,last_login_at,created_at",
            (*params, account_id),
        ).fetchone()


def _learning_status_in_conn(c: psycopg.Connection[dict[str, Any]], account_id: int) -> dict[str, Any]:
    from gvcsim import evidence

    release_id = database.current_release_id()
    session = c.execute(
        "SELECT session,updated_at FROM experiment_sessions WHERE account_id=%s AND release_id=%s",
        (account_id, release_id),
    ).fetchone()
    report = c.execute(
        "SELECT state,score,generated_at,submitted_at,graded_at,updated_at FROM reports"
        " WHERE account_id=%s AND release_id=%s",
        (account_id, release_id),
    ).fetchone()
    summary = evidence.completion_summary(session["session"] if session else {"steps": {}}, report_exists=bool(report))
    timestamps = [row["updated_at"] for row in (session, report) if row]
    return {
        "verified_completed_count": len(summary["completed"]),
        "verified_completed_steps": summary["completed"],
        "completion_missing": [step for step in range(1, 17) if step not in summary["completed"]],
        "last_valid_activity": max(timestamps) if timestamps else None,
        "report_state": report["state"] if report else None,
        "score": report["score"] if report else None,
        "generated_at": report["generated_at"] if report else None,
        "submitted_at": report["submitted_at"] if report else None,
        "graded_at": report["graded_at"] if report else None,
    }


def list_students(teacher_username: str | None = None) -> list[dict[str, Any]]:
    with database.conn() as c:
        if teacher_username and not _teacher_exists(c, teacher_username):
            return []
        rows = c.execute(
            f"SELECT {_STUDENT_COLS} FROM accounts a WHERE a.role='student' ORDER BY a.student_no,a.username"
        ).fetchall()
        for row in rows:
            row.update(_learning_status_in_conn(c, row["id"]))
        return rows
