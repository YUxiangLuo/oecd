"""Current student work, submissions, grades, and announcements."""

from __future__ import annotations

import json
from typing import Any

import psycopg


class _DatabaseProxy:
    def __getattr__(self, name: str) -> Any:
        from gvcsim.classroom import db

        return getattr(db, name)


database = _DatabaseProxy()


def _student(c: psycopg.Connection[dict[str, Any]], username: str, *, active: bool = True) -> dict[str, Any] | None:
    suffix = " AND active" if active else ""
    return c.execute(
        f"SELECT id,username FROM accounts WHERE username=%s AND role='student'{suffix}", (username,)
    ).fetchone()


def upsert_progress(username: str, step: int) -> None:
    with database.conn() as c:
        account = _student(c, username)
        if account:
            c.execute(
                "INSERT INTO step_progress(account_id,current_step,max_step) VALUES (%s,%s,%s)"
                " ON CONFLICT (account_id) DO UPDATE SET current_step=EXCLUDED.current_step,"
                " max_step=greatest(step_progress.max_step,EXCLUDED.max_step),updated_at=now()",
                (account["id"], step, step),
            )


def get_progress(username: str) -> dict[str, Any] | None:
    with database.conn() as c:
        return c.execute(
            "SELECT p.current_step,p.max_step,p.updated_at FROM step_progress p"
            " JOIN accounts a ON a.id=p.account_id WHERE a.username=%s AND a.role='student' AND a.active",
            (username,),
        ).fetchone()


def get_session(username: str) -> dict[str, Any] | None:
    with database.conn() as c:
        return c.execute(
            "SELECT s.session,s.updated_at FROM experiment_sessions s JOIN accounts a ON a.id=s.account_id"
            " WHERE a.username=%s AND a.role='student' AND a.active",
            (username,),
        ).fetchone()


def save_session(username: str, session: dict[str, Any]) -> dict[str, Any] | None:
    """Replace the student's current session. The last request wins."""
    with database.conn() as c:
        account = _student(c, username)
        if not account:
            return None
        return c.execute(
            "INSERT INTO experiment_sessions(account_id,session) VALUES (%s,%s)"
            " ON CONFLICT (account_id) DO UPDATE SET session=EXCLUDED.session,updated_at=now()"
            " RETURNING session,updated_at",
            (account["id"], json.dumps(session, ensure_ascii=False)),
        ).fetchone()


def reset_workspace(username: str, confirmation: str) -> dict[str, bool] | None:
    if confirmation != "清空当前实验":
        raise ValueError("确认文字不正确")
    with database.conn() as c:
        account = _student(c, username)
        if not account:
            return None
        for table in ("submissions", "reports", "experiment_sessions", "step_progress"):
            c.execute(f"DELETE FROM {table} WHERE account_id=%s", (account["id"],))
        return {"ok": True}


def save_generated_report(
    username: str, markdown: str, provenance: dict[str, Any]
) -> dict[str, Any] | None:
    with database.conn() as c:
        account = _student(c, username)
        if not account:
            return None
        return c.execute(
            "INSERT INTO reports(account_id,markdown,provenance) VALUES (%s,%s,%s)"
            " ON CONFLICT (account_id) DO UPDATE SET markdown=EXCLUDED.markdown,"
            " provenance=EXCLUDED.provenance,updated_at=now()"
            " RETURNING markdown,provenance,updated_at",
            (account["id"], markdown, json.dumps(provenance, ensure_ascii=False)),
        ).fetchone()


def latest_report(username: str) -> dict[str, Any] | None:
    with database.conn() as c:
        return c.execute(
            "SELECT r.markdown,r.provenance,r.updated_at FROM reports r JOIN accounts a ON a.id=r.account_id"
            " WHERE a.username=%s AND a.active",
            (username,),
        ).fetchone()


def submit_report(username: str, title: str) -> dict[str, Any] | None:
    """Copy the latest generated report into the one current submission."""
    with database.conn() as c:
        account = _student(c, username)
        if not account:
            return None
        report = c.execute("SELECT markdown,provenance FROM reports WHERE account_id=%s", (account["id"],)).fetchone()
        if not report:
            return None
        provenance = report["provenance"]
        years = provenance.get("years") if isinstance(provenance, dict) else None
        year = int(years[-1]) if isinstance(years, list) and years else 0
        design = {"runs": provenance.get("runs", []) if isinstance(provenance, dict) else []}
        return c.execute(
            "INSERT INTO submissions(account_id,title,year,design,markdown) VALUES (%s,%s,%s,%s,%s)"
            " ON CONFLICT (account_id) DO UPDATE SET title=EXCLUDED.title,year=EXCLUDED.year,"
            " design=EXCLUDED.design,markdown=EXCLUDED.markdown,state='pending',score=NULL,feedback='',"
            " graded_by=NULL,graded_at=NULL,submitted_at=now()"
            " RETURNING id,state,submitted_at",
            (account["id"], title, year, json.dumps(design, ensure_ascii=False), report["markdown"]),
        ).fetchone()


def my_submission(username: str) -> dict[str, Any] | None:
    with database.conn() as c:
        return c.execute(
            "SELECT s.id,s.title,s.year,s.state,s.score,s.feedback,s.graded_by,s.graded_at,s.submitted_at"
            " FROM submissions s JOIN accounts a ON a.id=s.account_id WHERE a.username=%s AND a.active",
            (username,),
        ).fetchone()


def _active_teacher(c: psycopg.Connection[dict[str, Any]], username: str) -> bool:
    return c.execute(
        "SELECT 1 FROM accounts WHERE username=%s AND role='teacher' AND active", (username,)
    ).fetchone() is not None


def list_submissions(teacher_username: str | None = None) -> list[dict[str, Any]]:
    with database.conn() as c:
        if teacher_username and not _active_teacher(c, teacher_username):
            return []
        return c.execute(
            "SELECT s.id,s.title,s.year,s.state,s.score,s.graded_by,s.graded_at,s.submitted_at,"
            " a.username,a.display_name,a.student_no,cl.name AS class_name FROM submissions s"
            " JOIN accounts a ON a.id=s.account_id LEFT JOIN classes cl ON cl.id=a.class_id"
            " ORDER BY s.state,s.submitted_at DESC"
        ).fetchall()


def get_submission(submission_id: int, teacher_username: str | None = None) -> dict[str, Any] | None:
    with database.conn() as c:
        if teacher_username and not _active_teacher(c, teacher_username):
            return None
        return c.execute(
            "SELECT s.*,a.username,a.display_name,a.student_no,cl.name AS class_name FROM submissions s"
            " JOIN accounts a ON a.id=s.account_id LEFT JOIN classes cl ON cl.id=a.class_id WHERE s.id=%s",
            (submission_id,),
        ).fetchone()


def teacher_can_access_submission_in_conn(c, username: str, submission_id: int) -> bool:
    return _active_teacher(c, username) and c.execute(
        "SELECT 1 FROM submissions WHERE id=%s", (submission_id,)
    ).fetchone() is not None


def grade_submission(submission_id: int, score: int, feedback: str, graded_by: str) -> dict[str, Any] | None:
    with database.conn() as c:
        if not _active_teacher(c, graded_by):
            return None
        return c.execute(
            "UPDATE submissions SET state='graded',score=%s,feedback=%s,graded_by=%s,graded_at=now()"
            " WHERE id=%s RETURNING id,state,score,feedback,graded_by,graded_at",
            (score, feedback, graded_by, submission_id),
        ).fetchone()


def list_announcements(username: str) -> list[dict[str, Any]]:
    with database.conn() as c:
        account = c.execute("SELECT role,class_id FROM accounts WHERE username=%s AND active", (username,)).fetchone()
        if not account:
            return []
        base = (
            "SELECT an.*,cl.name AS class_name FROM announcements an"
            " LEFT JOIN classes cl ON cl.id=an.class_id"
        )
        if account["role"] == "teacher":
            return c.execute(base + " ORDER BY an.created_at DESC,an.id DESC").fetchall()
        return c.execute(
            base + " WHERE an.class_id IS NULL OR an.class_id=%s ORDER BY an.created_at DESC,an.id DESC",
            (account["class_id"],),
        ).fetchall()


def create_announcement(title: str, body: str, author: str, class_id: int | None = None) -> dict[str, Any]:
    with database.conn() as c:
        if not _active_teacher(c, author):
            raise PermissionError("教师账号无效")
        if class_id is not None and not c.execute("SELECT 1 FROM classes WHERE id=%s", (class_id,)).fetchone():
            raise PermissionError("班级不存在")
        return database._required(
            c.execute(
                "INSERT INTO announcements(class_id,title,body,author) VALUES (%s,%s,%s,%s) RETURNING *",
                (class_id, title, body, author),
            ).fetchone(),
            "create announcement",
        )


def delete_announcement(announcement_id: int, actor: str | None = None) -> bool:
    with database.conn() as c:
        if actor and not _active_teacher(c, actor):
            return False
        return c.execute("DELETE FROM announcements WHERE id=%s RETURNING id", (announcement_id,)).fetchone() is not None
