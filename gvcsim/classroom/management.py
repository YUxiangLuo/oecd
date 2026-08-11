"""Teacher management and dashboard queries."""

from __future__ import annotations

import secrets
from collections import defaultdict
from datetime import date, timedelta
from typing import Any

import psycopg


class _DatabaseProxy:
    def __getattr__(self, name: str) -> Any:
        from gvcsim.classroom import db

        return getattr(db, name)


database = _DatabaseProxy()
_STUDENT_COLS = "a.id,a.username,a.display_name,a.class_id,a.student_no,a.active,a.last_login_at,a.created_at"


def _active_teacher(c: psycopg.Connection[dict[str, Any]], username: str) -> bool:
    return c.execute(
        "SELECT 1 FROM accounts WHERE username=%s AND role='teacher' AND active", (username,)
    ).fetchone() is not None


def teacher_can_access_class(username: str, class_id: int) -> bool:
    with database.conn() as c:
        return _active_teacher(c, username) and c.execute("SELECT 1 FROM classes WHERE id=%s", (class_id,)).fetchone() is not None


def list_classes(teacher_username: str | None = None) -> list[dict[str, Any]]:
    with database.conn() as c:
        if teacher_username and not _active_teacher(c, teacher_username):
            return []
        return c.execute(
            "SELECT cl.*,count(a.id) AS student_count FROM classes cl LEFT JOIN accounts a"
            " ON a.class_id=cl.id AND a.role='student' GROUP BY cl.id ORDER BY cl.id"
        ).fetchall()


def create_class(name: str, code: str, semester: str = "", note: str = "", teacher_username: str | None = None) -> dict[str, Any]:
    with database.conn() as c:
        if teacher_username and not _active_teacher(c, teacher_username):
            raise PermissionError("教师账号无效")
        return database._required(c.execute(
            "INSERT INTO classes(name,code,semester,note) VALUES (%s,%s,%s,%s) RETURNING *",
            (name, code, semester, note),
        ).fetchone(), "create class")


def create_student(username: str, display_name: str, password: str, student_no: str = "", class_id: int | None = None, teacher_username: str | None = None) -> dict[str, Any]:
    database._validate_managed_password(password)
    salt = secrets.token_hex(16)
    with database.conn() as c:
        if teacher_username and not _active_teacher(c, teacher_username):
            raise PermissionError("教师账号无效")
        if class_id is not None and not c.execute("SELECT 1 FROM classes WHERE id=%s", (class_id,)).fetchone():
            raise ValueError("班级不存在")
        return database._required(c.execute(
            "INSERT INTO accounts(username,display_name,role,class_id,student_no,pw_salt,pw_hash)"
            " VALUES (%s,%s,'student',%s,%s,%s,%s) RETURNING id,username,display_name,class_id,student_no,active,last_login_at,created_at",
            (username, display_name, class_id, student_no, salt, database.hash_password(password, salt)),
        ).fetchone(), "create student")


def update_student(account_id: int, fields: dict[str, Any], teacher_username: str | None = None) -> dict[str, Any] | None:
    sets: list[str] = []
    params: list[Any] = []
    for key in ("display_name", "student_no", "class_id", "active"):
        if key in fields:
            sets.append(f"{key}=%s")
            params.append(fields[key])
    if fields.get("password"):
        database._validate_managed_password(fields["password"])
        salt = secrets.token_hex(16)
        sets.extend(("pw_salt=%s", "pw_hash=%s"))
        params.extend((salt, database.hash_password(fields["password"], salt)))
    if not sets:
        return None
    with database.conn() as c:
        if teacher_username and not _active_teacher(c, teacher_username):
            return None
        if fields.get("class_id") is not None and not c.execute("SELECT 1 FROM classes WHERE id=%s", (fields["class_id"],)).fetchone():
            return None
        return c.execute(
            f"UPDATE accounts SET {','.join(sets)} WHERE id=%s AND role='student'"
            " RETURNING id,username,display_name,class_id,student_no,active,last_login_at,created_at",
            (*params, account_id),
        ).fetchone()


def _learning_status_in_conn(c: psycopg.Connection[dict[str, Any]], username: str, _unused: str = "") -> dict[str, Any]:
    from gvcsim import evidence

    account = c.execute("SELECT id FROM accounts WHERE username=%s AND role='student'", (username,)).fetchone()
    result: dict[str, Any] = {"verified_completed_count": 0, "verified_completed_steps": [], "completion_missing": list(range(1, 17)), "last_valid_activity": None, "current_step": None, "max_step": None, "progress_at": None}
    if not account:
        return result
    progress = c.execute("SELECT current_step,max_step,updated_at FROM step_progress WHERE account_id=%s", (account["id"],)).fetchone()
    session = c.execute("SELECT session,updated_at FROM experiment_sessions WHERE account_id=%s", (account["id"],)).fetchone()
    report = c.execute("SELECT updated_at FROM reports WHERE account_id=%s", (account["id"],)).fetchone()
    timestamps = [row[key] for row, key in ((progress, "updated_at"), (session, "updated_at"), (report, "updated_at")) if row]
    if progress:
        result.update(current_step=progress["current_step"], max_step=progress["max_step"], progress_at=progress["updated_at"])
    result["last_valid_activity"] = max(timestamps) if timestamps else None
    summary = evidence.completion_summary(session["session"] if session else {"steps": {}}, report_exists=bool(report))
    completed = summary["completed"]
    result.update(verified_completed_count=len(completed), verified_completed_steps=completed, completion_missing=[n for n in range(1, 17) if n not in completed])
    return result


def list_students(class_id: int | None = None, teacher_username: str | None = None) -> list[dict[str, Any]]:
    clauses = ["a.role='student'"]
    params: list[Any] = []
    if class_id is not None:
        clauses.append("a.class_id=%s")
        params.append(class_id)
    with database.conn() as c:
        if teacher_username and not _active_teacher(c, teacher_username):
            return []
        rows = c.execute(
            f"SELECT {_STUDENT_COLS},cl.name AS class_name,p.current_step,p.max_step,p.updated_at AS progress_at,"
            "s.id AS submission_id,s.state AS submission_state,s.score,s.submitted_at FROM accounts a"
            " LEFT JOIN classes cl ON cl.id=a.class_id LEFT JOIN step_progress p ON p.account_id=a.id"
            " LEFT JOIN submissions s ON s.account_id=a.id"
            f" WHERE {' AND '.join(clauses)} ORDER BY a.class_id NULLS LAST,a.student_no,a.username",
            tuple(params),
        ).fetchall()
        for row in rows:
            row.update(_learning_status_in_conn(c, row["username"]))
        return rows


def overview_stats(class_id: int | None = None, teacher_username: str | None = None) -> dict[str, Any]:
    students = list_students(class_id, teacher_username)
    submitted = [row for row in students if row.get("submission_id")]
    graded = [row for row in submitted if row.get("submission_state") == "graded"]
    scores = [int(row["score"]) for row in graded if row.get("score") is not None]
    today = date.today()
    where = ["a.role='student'"]
    params: list[Any] = []
    if class_id is not None:
        where.append("a.class_id=%s")
        params.append(class_id)
    with database.conn() as c:
        submitted_rows = c.execute("SELECT s.submitted_at::date AS day,count(*) AS count FROM submissions s JOIN accounts a ON a.id=s.account_id WHERE " + " AND ".join(where) + " AND s.submitted_at::date>=current_date-13 GROUP BY 1", tuple(params)).fetchall()
        graded_rows = c.execute("SELECT s.graded_at::date AS day,count(*) AS count FROM submissions s JOIN accounts a ON a.id=s.account_id WHERE " + " AND ".join(where) + " AND s.graded_at IS NOT NULL AND s.graded_at::date>=current_date-13 GROUP BY 1", tuple(params)).fetchall()
    trend = {today - timedelta(days=n): {"submitted": 0, "graded": 0} for n in range(14)}
    for row in submitted_rows:
        trend[row["day"]]["submitted"] = int(row["count"])
    for row in graded_rows:
        trend[row["day"]]["graded"] = int(row["count"])
    groups: dict[tuple[int | None, str], list[dict[str, Any]]] = defaultdict(list)
    for row in students:
        groups[(row.get("class_id"), row.get("class_name") or "未分班")].append(row)
    breakdown = []
    for (cid, name), rows in groups.items():
        subs = [row for row in rows if row.get("submission_id")]
        grades = [row for row in subs if row.get("submission_state") == "graded" and row.get("score") is not None]
        breakdown.append({"class_id": cid, "name": name, "student_count": len(rows), "submitted": len(subs), "graded": len(grades), "avg_score": round(sum(int(row["score"]) for row in grades) / len(grades), 1) if grades else None})
    return {
        "student_count": len(students), "disabled_count": sum(not row["active"] for row in students),
        "submitted": len(submitted), "graded": len(graded), "avg_score": round(sum(scores) / len(scores), 1) if scores else None,
        "score_buckets": [{"label": label, "count": sum(test(score) for score in scores)} for label, test in (("<60", lambda n: n < 60), ("60–69", lambda n: 60 <= n <= 69), ("70–79", lambda n: 70 <= n <= 79), ("80–89", lambda n: 80 <= n <= 89), ("90–100", lambda n: n >= 90))],
        "step_reach": [{"step": step, "reached": sum((row.get("max_step") or 0) >= step for row in students)} for step in range(1, 17)],
        "step_completion": [{"step": step, "completed": sum(step in row["verified_completed_steps"] for row in students)} for step in range(1, 17)],
        "active_7d": sum(bool(row.get("last_valid_activity") and row["last_valid_activity"].date() >= today - timedelta(days=6)) for row in students),
        "submission_trend": [{"date": day.strftime("%m-%d"), **trend[day]} for day in sorted(trend)],
        "class_breakdown": sorted(breakdown, key=lambda row: (row["class_id"] is None, row["name"])),
    }
