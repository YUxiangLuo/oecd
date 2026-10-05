"""Student sessions and the single report/grade record per student."""

from __future__ import annotations

import hashlib
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


class SessionChanged(RuntimeError):
    """The browser attempted to replace a session version that is no longer current."""

    pass


_UNCONDITIONAL_SESSION_WRITE = object()


def _session_fingerprint(session: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(session, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]


# What the student was looking at rather than what the report uses: changing these must not make a
# submitted report look out of date (the report prints recorded material, never these view settings).
_VIEW_ONLY_KEYS = frozenset({"slice", "year", "country", "chart", "drill", "heat_sort", "heat_coverage"})


def report_fingerprint(session: dict[str, Any]) -> str:
    """Fingerprint of the session parts a report is built from (view-only settings excluded)."""
    steps = session.get("steps")
    if not isinstance(steps, dict):
        return _session_fingerprint(session)
    projected_steps = {
        key: (
            {**value, "data": {k: v for k, v in value["data"].items() if k not in _VIEW_ONLY_KEYS}}
            if isinstance(value, dict) and isinstance(value.get("data"), dict)
            else value
        )
        for key, value in steps.items()
    }
    return _session_fingerprint({**session, "steps": projected_steps})


def report_matches_session(session: dict[str, Any], report: dict[str, Any] | None) -> bool:
    """Return whether a report was generated from this session's report inputs.

    Reports saved before the view-only exclusion carry only the full-session fingerprint.
    """
    if report is None:
        return False
    provenance = report.get("provenance")
    if not isinstance(provenance, dict):
        return False
    if "report_fingerprint" in provenance:
        return provenance["report_fingerprint"] == report_fingerprint(session)
    return provenance.get("session_fingerprint") == _session_fingerprint(session)


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


def save_session(
    username: str,
    session: dict[str, Any],
    expected_updated_at: datetime | None | object = _UNCONDITIONAL_SESSION_WRITE,
) -> dict[str, Any] | None:
    """Persist a session, optionally rejecting a stale whole-session replacement.

    Internal maintenance callers may omit ``expected_updated_at``. The classroom
    HTTP route always supplies the version observed by that browser, including
    ``None`` when no row existed yet, so two tabs cannot silently overwrite one
    another.
    """
    release_id = database.current_release_id()
    encoded = json.dumps(session, ensure_ascii=False)
    with database.conn() as c:
        account = _student(c, username)
        if not account:
            return None
        if expected_updated_at is _UNCONDITIONAL_SESSION_WRITE:
            return c.execute(
                "INSERT INTO experiment_sessions(account_id,release_id,session) VALUES (%s,%s,%s)"
                " ON CONFLICT (account_id,release_id) DO UPDATE"
                " SET session=EXCLUDED.session,updated_at=clock_timestamp()"
                " RETURNING updated_at",
                (account["id"], release_id, encoded),
            ).fetchone()
        if expected_updated_at is None:
            saved = c.execute(
                "INSERT INTO experiment_sessions(account_id,release_id,session) VALUES (%s,%s,%s)"
                " ON CONFLICT (account_id,release_id) DO NOTHING RETURNING updated_at",
                (account["id"], release_id, encoded),
            ).fetchone()
        else:
            saved = c.execute(
                "UPDATE experiment_sessions SET session=%s,updated_at=clock_timestamp()"
                " WHERE account_id=%s AND release_id=%s AND updated_at=%s RETURNING updated_at",
                (encoded, account["id"], release_id, expected_updated_at),
            ).fetchone()
        if saved is None:
            raise SessionChanged("实验记录已被另一个标签页更新")
        return saved


_REPORT_COLUMNS = (
    "r.release_id,r.markdown,r.provenance,r.state,r.score,r.feedback,r.graded_by,"
    "r.generated_at,r.updated_at,r.submitted_at,r.graded_at"
)
_REPORT_ENROLLMENTS = (
    "COALESCE((SELECT jsonb_agg(jsonb_build_object('term_id',ce.term_id,'term_name',t.name,"
    "'class_id',ce.class_id,'class_name',cg.name) ORDER BY t.created_at DESC,t.id DESC) "
    "FROM class_enrollments ce JOIN academic_terms t ON t.id=ce.term_id "
    "JOIN class_groups cg ON cg.id=ce.class_id WHERE ce.account_id=a.id),'[]'::jsonb) AS enrollments"
)


def latest_report(username: str) -> dict[str, Any] | None:
    release_id = database.current_release_id()
    with database.conn() as c:
        return c.execute(
            f"SELECT {_REPORT_COLUMNS} FROM reports r JOIN accounts a ON a.id=r.account_id"
            " WHERE a.username=%s AND a.role='student' AND r.release_id=%s",
            (username, release_id),
        ).fetchone()


def save_generated_report(
    username: str,
    markdown: str,
    provenance: dict[str, Any],
    expected_session_updated_at: datetime,
    expected_report_updated_at: datetime | None = None,
) -> dict[str, Any] | None:
    """Store only against the source session and report versions the caller saw.

    None means no report was observed, not an unconditional overwrite. Lock the
    session before the report, as submission does; the session lock also serializes
    first insertions. Confirmed regeneration clears the old grade and resubmits.
    """
    release_id = database.current_release_id()
    with database.conn() as c:
        account = _student(c, username)
        if not account:
            return None
        current_session = c.execute(
            "SELECT session,updated_at FROM experiment_sessions WHERE account_id=%s AND release_id=%s FOR UPDATE",
            (account["id"], release_id),
        ).fetchone()
        if current_session is None or current_session["updated_at"] != expected_session_updated_at:
            raise SessionChanged("报告生成期间实验记录已更新")
        current_report = c.execute(
            "SELECT updated_at FROM reports WHERE account_id=%s AND release_id=%s FOR UPDATE",
            (account["id"], release_id),
        ).fetchone()
        if (current_report["updated_at"] if current_report else None) != expected_report_updated_at:
            raise ReportChanged("报告或评分已更新，请刷新页面核对后再确认重新生成")
        stored_provenance = {
            **provenance,
            "session_fingerprint": _session_fingerprint(current_session["session"]),
            "report_fingerprint": report_fingerprint(current_session["session"]),
        }
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
            (account["id"], release_id, markdown, json.dumps(stored_provenance, ensure_ascii=False)),
        ).fetchone()


def submit_report(username: str) -> dict[str, Any] | None:
    """Submit a current draft; repeated submission of pending/graded work is idempotent."""
    release_id = database.current_release_id()
    with database.conn() as c:
        account = _student(c, username)
        if not account:
            return None
        current_session = c.execute(
            "SELECT session FROM experiment_sessions WHERE account_id=%s AND release_id=%s FOR UPDATE",
            (account["id"], release_id),
        ).fetchone()
        row = c.execute(
            "SELECT state,provenance FROM reports WHERE account_id=%s AND release_id=%s FOR UPDATE",
            (account["id"], release_id),
        ).fetchone()
        if not row:
            return None
        if row["state"] == "draft":
            if current_session is None or not report_matches_session(current_session["session"], row):
                raise ReportChanged("实验记录已更新，请重新生成报告")
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
            f"SELECT a.id AS account_id,a.username,a.display_name,a.student_no,{_REPORT_COLUMNS},"
            f"{_REPORT_ENROLLMENTS}"
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
            f"SELECT a.id AS account_id,a.username,a.display_name,a.student_no,{_REPORT_COLUMNS},"
            f"{_REPORT_ENROLLMENTS}"
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
