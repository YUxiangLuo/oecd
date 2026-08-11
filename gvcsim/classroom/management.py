"""Global teacher management for classes, students, and current-manifest overview."""

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
_STUDENT_COLS = "a.id, a.username, a.display_name, a.class_id, a.student_no, a.active, a.last_login_at, a.created_at"


def _current_manifest() -> str:
    from gvcsim.artifacts import manifest_id

    return manifest_id()


def _active_teacher(c: psycopg.Connection[dict[str, Any]], username: str) -> bool:
    return (
        c.execute("SELECT 1 FROM accounts WHERE username=%s AND role='teacher' AND active", (username,)).fetchone()
        is not None
    )


def teacher_can_access_class(username: str, class_id: int) -> bool:
    with database.conn() as c:
        return (
            _active_teacher(c, username)
            and c.execute("SELECT 1 FROM classes WHERE id=%s", (class_id,)).fetchone() is not None
        )


def list_classes(teacher_username: str | None = None) -> list[dict[str, Any]]:
    with database.conn() as c:
        if teacher_username and not _active_teacher(c, teacher_username):
            return []
        return c.execute(
            "SELECT cl.*,count(a.id) AS student_count FROM classes cl"
            " LEFT JOIN accounts a ON a.class_id=cl.id AND a.role='student'"
            " GROUP BY cl.id ORDER BY cl.id"
        ).fetchall()


def create_class(
    name: str, code: str, semester: str = "", note: str = "", teacher_username: str | None = None
) -> dict[str, Any]:
    with database.conn() as c:
        if teacher_username and not _active_teacher(c, teacher_username):
            raise PermissionError("教师账号无效")
        return database._required(
            c.execute(
                "INSERT INTO classes(name,code,semester,note) VALUES (%s,%s,%s,%s) RETURNING *",
                (name, code, semester, note),
            ).fetchone(),
            "create class",
        )


def create_student(
    username: str,
    display_name: str,
    password: str,
    student_no: str = "",
    class_id: int | None = None,
    teacher_username: str | None = None,
) -> dict[str, Any]:
    database._validate_managed_password(password)
    salt = secrets.token_hex(16)
    with database.conn() as c:
        if teacher_username and not _active_teacher(c, teacher_username):
            raise PermissionError("教师账号无效")
        if class_id is not None and c.execute("SELECT 1 FROM classes WHERE id=%s", (class_id,)).fetchone() is None:
            raise ValueError("班级不存在")
        return database._required(
            c.execute(
                "INSERT INTO accounts(username,display_name,role,class_id,student_no,pw_salt,pw_hash)"
                " VALUES (%s,%s,'student',%s,%s,%s,%s)"
                f" RETURNING {_STUDENT_COLS.replace('a.', '')}",
                (username, display_name, class_id, student_no, salt, database.hash_password(password, salt)),
            ).fetchone(),
            "create student",
        )


def update_student(
    account_id: int, fields: dict[str, Any], teacher_username: str | None = None
) -> dict[str, Any] | None:
    sets: list[str] = []
    params: list[Any] = []
    for key in ("display_name", "student_no", "class_id", "active"):
        if key in fields:
            sets.append(f"{key}=%s")
            params.append(fields[key])
    security_changed = bool(fields.get("password")) or fields.get("active") is False
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
        if "class_id" in fields and fields["class_id"] is not None:
            if c.execute("SELECT 1 FROM classes WHERE id=%s", (fields["class_id"],)).fetchone() is None:
                return None
        if security_changed:
            sets.append("auth_version=auth_version+1")
        row = c.execute(
            f"UPDATE accounts SET {','.join(sets)} WHERE id=%s AND role='student'"
            f" RETURNING {_STUDENT_COLS.replace('a.', '')}",
            (*params, account_id),
        ).fetchone()
        if row and security_changed:
            c.execute(
                "UPDATE auth_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE account_id=%s", (account_id,)
            )
        return row


def _learning_status_in_conn(c: psycopg.Connection[dict[str, Any]], username: str, manifest_id: str) -> dict[str, Any]:
    from gvcsim import evidence

    account = c.execute("SELECT id FROM accounts WHERE username=%s AND role='student'", (username,)).fetchone()
    result: dict[str, Any] = {
        "verified_completed_count": 0,
        "verified_completed_steps": [],
        "completion_missing": list(range(1, database.MAX_STEP + 1)),
        "last_valid_activity": None,
        "current_step": None,
        "max_step": None,
        "progress_at": None,
    }
    if account is None:
        return result
    progress = c.execute(
        "SELECT current_step,max_step,updated_at FROM step_progress WHERE account_id=%s AND manifest_id=%s",
        (account["id"], manifest_id),
    ).fetchone()
    if progress:
        result.update(
            {
                "current_step": progress["current_step"],
                "max_step": progress["max_step"],
                "progress_at": progress["updated_at"],
            }
        )
    session = c.execute(
        "SELECT session,updated_at FROM experiment_sessions WHERE account_id=%s AND manifest_id=%s",
        (account["id"], manifest_id),
    ).fetchone()
    activity = c.execute(
        "SELECT max(ts) AS ts FROM ("
        " SELECT updated_at AS ts FROM step_progress WHERE account_id=%s AND manifest_id=%s"
        " UNION ALL SELECT updated_at FROM experiment_sessions WHERE account_id=%s AND manifest_id=%s"
        " UNION ALL SELECT created_at FROM learning_evidence_events"
        " WHERE account_id=%s AND manifest_id=%s AND revoked_at IS NULL) q",
        (account["id"], manifest_id, account["id"], manifest_id, account["id"], manifest_id),
    ).fetchone()
    result["last_valid_activity"] = activity["ts"] if activity else None
    if session is None:
        return result
    try:
        summary = evidence.completion_summary(session["session"], subject=username, require_trusted=True, connection=c)
    except Exception:
        return result
    completed = summary.get("completed", [])
    result.update(
        {
            "verified_completed_count": len(completed),
            "verified_completed_steps": completed,
            "completion_missing": [n for n in range(1, database.MAX_STEP + 1) if n not in completed],
        }
    )
    return result


def list_students(class_id: int | None = None, teacher_username: str | None = None) -> list[dict[str, Any]]:
    manifest_id = _current_manifest()
    clauses = ["a.role='student'"]
    params: list[Any] = [manifest_id]
    if class_id is not None:
        clauses.append("a.class_id=%s")
        params.append(class_id)
    with database.conn() as c:
        if teacher_username and not _active_teacher(c, teacher_username):
            return []
        rows = c.execute(
            f"SELECT {_STUDENT_COLS},cl.name AS class_name,p.current_step,p.max_step,p.updated_at AS progress_at,"
            " s.id AS submission_id,s.state AS submission_state,s.score,s.submitted_at"
            " FROM accounts a LEFT JOIN classes cl ON cl.id=a.class_id"
            " LEFT JOIN step_progress p ON p.account_id=a.id AND p.manifest_id=%s"
            " LEFT JOIN submissions s ON s.account_id=a.id AND s.manifest_id=%s"
            f" WHERE {' AND '.join(clauses)} ORDER BY a.class_id NULLS LAST,a.student_no,a.username",
            (manifest_id, *params),
        ).fetchall()
        for row in rows:
            row.update(_learning_status_in_conn(c, row["username"], manifest_id))
        return rows


def overview_stats(class_id: int | None = None, teacher_username: str | None = None) -> dict[str, Any]:
    manifest_id = _current_manifest()
    students = list_students(class_id, teacher_username)
    submitted = [row for row in students if row.get("submission_id") is not None]
    graded = [row for row in submitted if row.get("submission_state") == "graded"]
    scores = [int(row["score"]) for row in graded if row.get("score") is not None]
    today = date.today()
    trend_clauses = ["s.manifest_id=%s", "a.role='student'"]
    trend_params: list[Any] = [manifest_id]
    if class_id is not None:
        trend_clauses.append("a.class_id=%s")
        trend_params.append(class_id)
    trend_where = " AND ".join(trend_clauses)
    with database.conn() as c:
        submission_trend_rows = c.execute(
            "SELECT s.submitted_at::date AS day,count(*) AS submitted FROM submissions s"
            " JOIN accounts a ON a.id=s.account_id"
            f" WHERE {trend_where} AND s.submitted_at::date>=current_date-13 GROUP BY s.submitted_at::date",
            tuple(trend_params),
        ).fetchall()
        grading_trend_rows = c.execute(
            "SELECT s.graded_at::date AS day,count(*) AS graded FROM submissions s"
            " JOIN accounts a ON a.id=s.account_id"
            f" WHERE {trend_where} AND s.graded_at IS NOT NULL"
            " AND s.graded_at::date>=current_date-13 GROUP BY s.graded_at::date",
            tuple(trend_params),
        ).fetchall()
    trend_map: dict[date, dict[str, int]] = {}
    for row in submission_trend_rows:
        trend_map.setdefault(row["day"], {"submitted": 0, "graded": 0})["submitted"] = int(row["submitted"])
    for row in grading_trend_rows:
        trend_map.setdefault(row["day"], {"submitted": 0, "graded": 0})["graded"] = int(row["graded"])
    step_reach = [
        {"step": step, "reached": sum(1 for row in students if (row.get("max_step") or 0) >= step)}
        for step in range(1, 17)
    ]
    step_completion = [
        {"step": step, "completed": sum(1 for row in students if step in row["verified_completed_steps"])}
        for step in range(1, 17)
    ]
    by_class: dict[tuple[int | None, str], list[dict[str, Any]]] = defaultdict(list)
    for row in students:
        by_class[(row.get("class_id"), row.get("class_name") or "未分班")].append(row)
    class_breakdown = []
    for (cid, name), rows in by_class.items():
        subs = [row for row in rows if row.get("submission_id") is not None]
        grades = [row for row in subs if row.get("submission_state") == "graded" and row.get("score") is not None]
        class_breakdown.append(
            {
                "class_id": cid,
                "name": name,
                "student_count": len(rows),
                "submitted": len(subs),
                "graded": len(grades),
                "avg_score": round(sum(int(row["score"]) for row in grades) / len(grades), 1) if grades else None,
            }
        )
    return {
        "student_count": len(students),
        "disabled_count": sum(1 for row in students if not row["active"]),
        "submitted": len(submitted),
        "graded": len(graded),
        "avg_score": round(sum(scores) / len(scores), 1) if scores else None,
        "score_buckets": [
            {"label": "<60", "count": sum(score < 60 for score in scores)},
            {"label": "60–69", "count": sum(60 <= score <= 69 for score in scores)},
            {"label": "70–79", "count": sum(70 <= score <= 79 for score in scores)},
            {"label": "80–89", "count": sum(80 <= score <= 89 for score in scores)},
            {"label": "90–100", "count": sum(score >= 90 for score in scores)},
        ],
        "step_reach": step_reach,
        "step_completion": step_completion,
        "active_7d": sum(
            1
            for row in students
            if row.get("last_valid_activity") and row["last_valid_activity"].date() >= today - timedelta(days=6)
        ),
        "submission_trend": [
            {
                "date": (today - timedelta(days=offset)).strftime("%m-%d"),
                "submitted": int(trend_map.get(today - timedelta(days=offset), {}).get("submitted", 0)),
                "graded": int(trend_map.get(today - timedelta(days=offset), {}).get("graded", 0)),
            }
            for offset in range(13, -1, -1)
        ],
        "class_breakdown": sorted(class_breakdown, key=lambda row: (row["class_id"] is None, row["name"])),
    }
