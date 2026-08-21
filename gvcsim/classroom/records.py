"""Student sessions and the single report/grade record per student."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

import psycopg


class _DatabaseProxy:
    def __getattr__(self, name: str) -> Any:
        from gvcsim.classroom import db

        return getattr(db, name)


database = _DatabaseProxy()


class ReportChanged(RuntimeError):
    pass


def _student(c: psycopg.Connection[dict[str, Any]], username: str) -> dict[str, Any] | None:
    return c.execute("SELECT id,username FROM accounts WHERE username=%s AND role='student'", (username,)).fetchone()


def _teacher_exists(c: psycopg.Connection[dict[str, Any]], username: str) -> bool:
    return c.execute("SELECT 1 FROM accounts WHERE username=%s AND role='teacher'", (username,)).fetchone() is not None


def get_session(username: str) -> dict[str, Any] | None:
    release_id = database.current_release_id()
    with database.conn() as c:
        return c.execute(
            "SELECT s.session,s.updated_at FROM experiment_sessions s JOIN accounts a ON a.id=s.account_id"
            " WHERE a.username=%s AND a.role='student' AND s.release_id=%s",
            (username, release_id),
        ).fetchone()


def save_session(username: str, session: dict[str, Any]) -> dict[str, Any] | None:
    """Replace the student's current session; the latest request wins."""
    release_id = database.current_release_id()
    with database.conn() as c:
        account = _student(c, username)
        if not account:
            return None
        return c.execute(
            "INSERT INTO experiment_sessions(account_id,release_id,session) VALUES (%s,%s,%s)"
            " ON CONFLICT (account_id,release_id) DO UPDATE SET session=EXCLUDED.session,updated_at=now()"
            " RETURNING updated_at",
            (account["id"], release_id, json.dumps(session, ensure_ascii=False)),
        ).fetchone()


_REPORT_COLUMNS = (
    "r.release_id,r.markdown,r.provenance,r.state,r.score,r.feedback,r.graded_by,"
    "r.generated_at,r.updated_at,r.submitted_at,r.graded_at"
)


def latest_report(username: str) -> dict[str, Any] | None:
    release_id = database.current_release_id()
    with database.conn() as c:
        return c.execute(
            f"SELECT {_REPORT_COLUMNS} FROM reports r JOIN accounts a ON a.id=r.account_id"
            " WHERE a.username=%s AND a.role='student' AND r.release_id=%s",
            (username, release_id),
        ).fetchone()


def save_generated_report(username: str, markdown: str, provenance: dict[str, Any]) -> dict[str, Any] | None:
    """Store a generated report without touching the old row until generation succeeds.

    A first report is a draft. Regenerating a submitted or graded report immediately
    replaces the submitted copy and clears its old grade.
    """
    release_id = database.current_release_id()
    with database.conn() as c:
        account = _student(c, username)
        if not account:
            return None
        return c.execute(
            "INSERT INTO reports(account_id,release_id,markdown,provenance,state,generated_at,updated_at)"
            " VALUES (%s,%s,%s,%s,'draft',now(),now())"
            " ON CONFLICT (account_id,release_id) DO UPDATE SET"
            " markdown=EXCLUDED.markdown,provenance=EXCLUDED.provenance,"
            " state=CASE WHEN reports.state IN ('pending','graded') THEN 'pending' ELSE 'draft' END,"
            " score=NULL,feedback='',graded_by=NULL,graded_at=NULL,"
            " generated_at=now(),updated_at=now(),"
            " submitted_at=CASE WHEN reports.state IN ('pending','graded') THEN now() ELSE NULL END"
            f" RETURNING {_REPORT_COLUMNS.replace('r.', '')}",
            (account["id"], release_id, markdown, json.dumps(provenance, ensure_ascii=False)),
        ).fetchone()


def submit_report(username: str) -> dict[str, Any] | None:
    """Submit a draft; repeated submission of pending/graded work is idempotent."""
    release_id = database.current_release_id()
    with database.conn() as c:
        account = _student(c, username)
        if not account:
            return None
        row = c.execute(
            "SELECT state FROM reports WHERE account_id=%s AND release_id=%s FOR UPDATE",
            (account["id"], release_id),
        ).fetchone()
        if not row:
            return None
        if row["state"] == "draft":
            c.execute(
                "UPDATE reports SET state='pending',submitted_at=now(),updated_at=now()"
                " WHERE account_id=%s AND release_id=%s",
                (account["id"], release_id),
            )
        return c.execute(
            f"SELECT {_REPORT_COLUMNS} FROM reports r WHERE r.account_id=%s AND r.release_id=%s",
            (account["id"], release_id),
        ).fetchone()


def list_reports(teacher_username: str) -> list[dict[str, Any]]:
    release_id = database.current_release_id()
    with database.conn() as c:
        if not _teacher_exists(c, teacher_username):
            return []
        return c.execute(
            f"SELECT a.id AS account_id,a.username,a.display_name,a.student_no,{_REPORT_COLUMNS}"
            " FROM reports r JOIN accounts a ON a.id=r.account_id"
            " WHERE r.release_id=%s AND r.state IN ('pending','graded')"
            " ORDER BY CASE r.state WHEN 'pending' THEN 0 ELSE 1 END,r.submitted_at DESC,a.username",
            (release_id,),
        ).fetchall()


def get_report(account_id: int, teacher_username: str) -> dict[str, Any] | None:
    release_id = database.current_release_id()
    with database.conn() as c:
        if not _teacher_exists(c, teacher_username):
            return None
        return c.execute(
            f"SELECT a.id AS account_id,a.username,a.display_name,a.student_no,{_REPORT_COLUMNS}"
            " FROM reports r JOIN accounts a ON a.id=r.account_id"
            " WHERE a.id=%s AND r.release_id=%s AND r.state IN ('pending','graded')",
            (account_id, release_id),
        ).fetchone()


def grade_report(
    account_id: int,
    score: int,
    feedback: str,
    graded_by: str,
    expected_updated_at: datetime,
) -> dict[str, Any] | None:
    release_id = database.current_release_id()
    with database.conn() as c:
        if not _teacher_exists(c, graded_by):
            return None
        updated = c.execute(
            "UPDATE reports SET state='graded',score=%s,feedback=%s,graded_by=%s,graded_at=now(),updated_at=now()"
            " WHERE account_id=%s AND release_id=%s AND state IN ('pending','graded') AND updated_at=%s"
            f" RETURNING {_REPORT_COLUMNS.replace('r.', '')}",
            (score, feedback, graded_by, account_id, release_id, expected_updated_at),
        ).fetchone()
        if updated is not None:
            return updated
        current = c.execute(
            "SELECT 1 FROM reports WHERE account_id=%s AND release_id=%s AND state IN ('pending','graded')",
            (account_id, release_id),
        ).fetchone()
        if current is not None:
            raise ReportChanged("报告内容已更新，请重新加载后评阅")
        return None
