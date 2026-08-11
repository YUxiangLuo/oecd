"""Manifest-scoped progress, sessions, evidence, reports, grading, and announcements."""

import json
import uuid
from collections.abc import Callable
from typing import Any

import psycopg


class _DatabaseProxy:
    def __getattr__(self, name: str) -> Any:
        from gvcsim.classroom import db

        return getattr(db, name)


database = _DatabaseProxy()


def _current_manifest() -> str:
    from gvcsim.artifacts import manifest_id

    return manifest_id()


def _student(c: psycopg.Connection[dict[str, Any]], username: str) -> dict[str, Any] | None:
    return c.execute(
        "SELECT id,username,class_id FROM accounts WHERE username=%s AND role='student' AND active", (username,)
    ).fetchone()


def _workspace_reset_marker(
    c: psycopg.Connection[dict[str, Any]], account_id: int, manifest_id: str
) -> int:
    row = database._required(
        c.execute(
            "SELECT coalesce(max(id),0) AS marker FROM audit_log"
            " WHERE actor_id=%s AND action='workspace.reset' AND target_type='manifest' AND target_id=%s",
            (account_id, manifest_id),
        ).fetchone(),
        "load workspace reset marker",
    )
    return int(row["marker"])


def _lock_current_workspace(
    c: psycopg.Connection[dict[str, Any]],
    account_id: int,
    manifest_id: str,
    *,
    require_active: bool = True,
) -> None:
    """Fence every workspace writer against reset and manifest/account changes."""
    reset_marker = _workspace_reset_marker(c, account_id, manifest_id)
    c.execute("SELECT pg_advisory_xact_lock(%s,%s)", (database._SESSION_LOCK_NS, account_id))
    if manifest_id != _current_manifest():
        raise database.WorkspaceScopeMismatch("等待写入期间服务器当前 manifest 已切换，请刷新后重试")
    active_clause = " AND active" if require_active else ""
    if (
        c.execute(f"SELECT 1 FROM accounts WHERE id=%s AND role='student'{active_clause}", (account_id,)).fetchone()
        is None
    ):
        raise database.WorkspaceScopeMismatch("等待写入期间学生账号状态已变化，请刷新后重试")
    if reset_marker != _workspace_reset_marker(c, account_id, manifest_id):
        raise database.WorkspaceScopeMismatch("工作区已被清空，请刷新后重试")


def upsert_progress(username: str, step: int) -> None:
    step = max(1, min(database.MAX_STEP, step))
    manifest_id = _current_manifest()
    with database.conn() as c:
        account = _student(c, username)
        if account is None:
            return
        _lock_current_workspace(c, account["id"], manifest_id)
        c.execute(
            "INSERT INTO step_progress(account_id,manifest_id,current_step,max_step) VALUES (%s,%s,%s,%s)"
            " ON CONFLICT (account_id,manifest_id) DO UPDATE SET current_step=EXCLUDED.current_step,"
            " max_step=GREATEST(step_progress.max_step,EXCLUDED.max_step),updated_at=now()",
            (account["id"], manifest_id, step, step),
        )


def get_progress(username: str) -> dict[str, Any] | None:
    manifest_id = _current_manifest()
    with database.conn() as c:
        return c.execute(
            "SELECT p.current_step,p.max_step,p.updated_at FROM step_progress p"
            " JOIN accounts a ON a.id=p.account_id"
            " WHERE a.username=%s AND a.role='student' AND a.active AND p.manifest_id=%s",
            (username, manifest_id),
        ).fetchone()


def get_session(username: str, manifest_id: str | None = None) -> dict[str, Any] | None:
    target = manifest_id or _current_manifest()
    with database.conn() as c:
        return c.execute(
            "SELECT s.revision,s.manifest_id,s.session,s.updated_at FROM experiment_sessions s"
            " JOIN accounts a ON a.id=s.account_id"
            " WHERE a.username=%s AND a.role='student' AND a.active AND s.manifest_id=%s",
            (username, target),
        ).fetchone()


def save_session(
    username: str,
    session: dict[str, Any],
    base_revision: int,
    merge: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]],
) -> dict[str, Any] | None:
    manifest_id = str(session.get("manifest_id") or "")
    if not manifest_id:
        raise database.WorkspaceScopeMismatch("会话缺少 manifest_id")
    if manifest_id != _current_manifest():
        raise database.WorkspaceScopeMismatch("只能写入服务器当前 manifest 的实验会话")
    with database.conn() as c:
        with c.transaction():
            account = _student(c, username)
            if account is None:
                return None
            _lock_current_workspace(c, account["id"], manifest_id)
            current = c.execute(
                "SELECT revision,session FROM experiment_sessions WHERE account_id=%s AND manifest_id=%s FOR UPDATE",
                (account["id"], manifest_id),
            ).fetchone()
            current_revision = int(current["revision"]) if current else 0
            merged_from = current_revision if current and current_revision != base_revision else None
            payload = merge(current["session"], session) if current else session
            revision = current_revision + 1
            c.execute(
                "INSERT INTO experiment_sessions(account_id,manifest_id,revision,session) VALUES (%s,%s,%s,%s)"
                " ON CONFLICT (account_id,manifest_id) DO UPDATE SET revision=EXCLUDED.revision,"
                " session=EXCLUDED.session,updated_at=now()",
                (account["id"], manifest_id, revision, json.dumps(payload, ensure_ascii=False)),
            )
            return {"revision": revision, "session": payload, "merged_from": merged_from}


def reset_workspace(username: str, manifest_id: str, confirmation: str) -> dict[str, Any] | None:
    if confirmation != "清空当前实验":
        raise ValueError("请输入“清空当前实验”确认不可恢复的删除操作")
    if manifest_id != _current_manifest():
        raise database.WorkspaceScopeMismatch("只能清空服务器当前 manifest 的实验记录")
    with database.conn() as c:
        with c.transaction():
            account = _student(c, username)
            if account is None:
                return None
            _lock_current_workspace(c, account["id"], manifest_id)
            submission_ids = [
                row["id"]
                for row in c.execute(
                    "SELECT id FROM submissions WHERE account_id=%s AND manifest_id=%s",
                    (account["id"], manifest_id),
                ).fetchall()
            ]
            if submission_ids:
                c.execute("DELETE FROM grading_events WHERE submission_id=ANY(%s)", (submission_ids,))
                c.execute("DELETE FROM submission_versions WHERE submission_id=ANY(%s)", (submission_ids,))
                c.execute("DELETE FROM submissions WHERE id=ANY(%s)", (submission_ids,))
            c.execute("DELETE FROM reports WHERE account_id=%s AND manifest_id=%s", (account["id"], manifest_id))
            c.execute(
                "DELETE FROM learning_evidence_events WHERE account_id=%s AND manifest_id=%s",
                (account["id"], manifest_id),
            )
            c.execute(
                "DELETE FROM experiment_sessions WHERE account_id=%s AND manifest_id=%s",
                (account["id"], manifest_id),
            )
            c.execute(
                "DELETE FROM step_progress WHERE account_id=%s AND manifest_id=%s",
                (account["id"], manifest_id),
            )
            c.execute(
                "INSERT INTO audit_log(actor_id,actor_name,action,target_type,target_id,details)"
                " VALUES (%s,%s,'workspace.reset','manifest',%s,%s)",
                (account["id"], username, manifest_id, json.dumps({"manifest_id": manifest_id})),
            )
            return {"ok": True, "manifest_id": manifest_id}


def record_evidence_event(
    username: str,
    step: int,
    kind: str,
    manifest_id: str,
    payload_sha256: str,
    claims: dict[str, Any],
) -> dict[str, Any]:
    if manifest_id != _current_manifest():
        raise database.WorkspaceScopeMismatch("学习事件不属于服务器当前 manifest")
    event_id = uuid.uuid4()
    with database.conn() as c:
        account = _student(c, username)
        if account is None:
            raise database.WorkspaceScopeMismatch("学生账号不可用")
        _lock_current_workspace(c, account["id"], manifest_id)
        return database._required(
            c.execute(
                "INSERT INTO learning_evidence_events(id,account_id,step,kind,manifest_id,payload_hash,payload)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s)"
                " RETURNING id::text AS event_id,account_id,step,kind,manifest_id,created_at AS issued_at",
                (
                    event_id,
                    account["id"],
                    step,
                    kind,
                    manifest_id,
                    payload_sha256,
                    json.dumps(claims, ensure_ascii=False),
                ),
            ).fetchone(),
            "record evidence event",
        )


def _evidence_event_exists_in_conn(
    c: psycopg.Connection[dict[str, Any]],
    username: str,
    event_id: str,
    payload_sha256: str,
    *,
    account_id: int | None = None,
    step: int | None = None,
    kind: str | None = None,
    manifest_id: str | None = None,
) -> bool:
    clauses = [
        "a.username=%s",
        "a.role='student'",
        "a.active",
        "ev.id=%s",
        "ev.payload_hash=%s",
        "ev.revoked_at IS NULL",
    ]
    params: list[Any] = [username, event_id, payload_sha256]
    if account_id is not None:
        clauses.append("ev.account_id=%s")
        params.append(account_id)
    if step is not None:
        clauses.append("ev.step=%s")
        params.append(step)
    if kind is not None:
        clauses.append("ev.kind=%s")
        params.append(kind)
    if manifest_id is not None:
        clauses.append("ev.manifest_id=%s")
        params.append(manifest_id)
    return (
        c.execute(
            "SELECT 1 FROM learning_evidence_events ev JOIN accounts a ON a.id=ev.account_id"
            f" WHERE {' AND '.join(clauses)}",
            tuple(params),
        ).fetchone()
        is not None
    )


def evidence_event_exists(
    username: str,
    event_id: str,
    payload_sha256: str,
    *,
    account_id: int | None = None,
    step: int | None = None,
    kind: str | None = None,
    manifest_id: str | None = None,
    connection: psycopg.Connection[dict[str, Any]] | None = None,
) -> bool:
    if connection is not None:
        return _evidence_event_exists_in_conn(
            connection,
            username,
            event_id,
            payload_sha256,
            account_id=account_id,
            step=step,
            kind=kind,
            manifest_id=manifest_id,
        )
    with database.conn() as c:
        return _evidence_event_exists_in_conn(
            c, username, event_id, payload_sha256, account_id=account_id, step=step, kind=kind, manifest_id=manifest_id
        )


def save_generated_report_and_session(
    username: str,
    report_key: str,
    base_revision: int,
    manifest_id: str,
    markdown: str,
    provenance: dict[str, Any],
    session: dict[str, Any],
) -> dict[str, Any] | None:
    if manifest_id != _current_manifest():
        raise database.WorkspaceScopeMismatch("报告不属于服务器当前 manifest")
    with database.conn() as c:
        with c.transaction():
            account = _student(c, username)
            if account is None:
                return None
            _lock_current_workspace(c, account["id"], manifest_id)
            current = c.execute(
                "SELECT revision,session FROM experiment_sessions WHERE account_id=%s AND manifest_id=%s FOR UPDATE",
                (account["id"], manifest_id),
            ).fetchone()
            current_revision = int(current["revision"]) if current else 0
            if current_revision != base_revision:
                raise database.SessionRevisionConflict(
                    f"会话已从 revision {base_revision} 更新到 {current_revision}；请重新生成报告"
                )
            report = c.execute(
                "INSERT INTO reports(account_id,manifest_id,report_key,session_revision,markdown,provenance)"
                " VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (account_id,manifest_id,report_key) DO NOTHING"
                " RETURNING id,report_key,session_revision,manifest_id,markdown,provenance,created_at",
                (
                    account["id"],
                    manifest_id,
                    report_key,
                    base_revision,
                    markdown,
                    json.dumps(provenance, ensure_ascii=False),
                ),
            ).fetchone()
            if report is None:
                report = database._required(
                    c.execute(
                        "SELECT id,report_key,session_revision,manifest_id,markdown,provenance,created_at"
                        " FROM reports WHERE account_id=%s AND manifest_id=%s AND report_key=%s",
                        (account["id"], manifest_id, report_key),
                    ).fetchone(),
                    "load generated report",
                )
            if current is not None and current["session"] == session:
                return {"report": report, "revision": current_revision, "session": current["session"]}
            revision = current_revision + 1
            c.execute(
                "INSERT INTO experiment_sessions(account_id,manifest_id,revision,session) VALUES (%s,%s,%s,%s)"
                " ON CONFLICT (account_id,manifest_id) DO UPDATE SET revision=EXCLUDED.revision,"
                " session=EXCLUDED.session,updated_at=now()",
                (account["id"], manifest_id, revision, json.dumps(session, ensure_ascii=False)),
            )
            return {"report": report, "revision": revision, "session": session}


def latest_report(username: str) -> dict[str, Any] | None:
    manifest_id = _current_manifest()
    with database.conn() as c:
        return c.execute(
            "SELECT r.id,r.report_key,r.session_revision,r.manifest_id,r.markdown,r.provenance,r.created_at"
            " FROM reports r JOIN accounts a ON a.id=r.account_id"
            " WHERE a.username=%s AND a.active AND r.manifest_id=%s ORDER BY r.created_at DESC LIMIT 1",
            (username, manifest_id),
        ).fetchone()


def _report_by_key_in_conn(
    c: psycopg.Connection[dict[str, Any]], username: str, report_key: str
) -> dict[str, Any] | None:
    manifest_id = _current_manifest()
    return c.execute(
        "SELECT r.id,r.report_key,r.session_revision,r.manifest_id,r.markdown,r.provenance,r.created_at"
        " FROM reports r JOIN accounts a ON a.id=r.account_id"
        " WHERE a.username=%s AND a.active AND r.manifest_id=%s AND r.report_key=%s",
        (username, manifest_id, report_key),
    ).fetchone()


def report_by_key(
    username: str, report_key: str, *, connection: psycopg.Connection[dict[str, Any]] | None = None
) -> dict[str, Any] | None:
    if connection is not None:
        return _report_by_key_in_conn(connection, username, report_key)
    with database.conn() as c:
        return _report_by_key_in_conn(c, username, report_key)


def submit_report(
    username: str, title: str, report_key: str, current_manifest_id: str | None = None
) -> dict[str, Any] | None:
    manifest_id = current_manifest_id or _current_manifest()
    if manifest_id != _current_manifest():
        return None
    with database.conn() as c:
        with c.transaction():
            account = _student(c, username)
            if account is None:
                return None
            _lock_current_workspace(c, account["id"], manifest_id)
            report = c.execute(
                "SELECT r.*,coalesce((r.provenance #>> '{artifact,years,-1}')::int,0) AS year"
                " FROM reports r WHERE r.account_id=%s AND r.manifest_id=%s AND r.report_key=%s",
                (account["id"], manifest_id, report_key),
            ).fetchone()
            if report is None:
                return None
            design = {
                "report_key": report["report_key"],
                "manifest_id": manifest_id,
                "session_revision": report["session_revision"],
                "runs": report["provenance"].get("runs"),
            }
            submission = c.execute(
                "SELECT * FROM submissions WHERE account_id=%s AND manifest_id=%s FOR UPDATE",
                (account["id"], manifest_id),
            ).fetchone()
            if submission is None:
                submission = database._required(
                    c.execute(
                        "INSERT INTO submissions(account_id,manifest_id,latest_version_no,title,year,design,markdown)"
                        " VALUES (%s,%s,1,%s,%s,%s,%s) RETURNING *",
                        (
                            account["id"],
                            manifest_id,
                            title,
                            report["year"],
                            json.dumps(design, ensure_ascii=False),
                            report["markdown"],
                        ),
                    ).fetchone(),
                    "create submission",
                )
                version_no = 1
            else:
                latest = c.execute(
                    "SELECT report_id,title FROM submission_versions WHERE submission_id=%s ORDER BY version_no DESC LIMIT 1",
                    (submission["id"],),
                ).fetchone()
                if latest and latest["report_id"] == report["id"] and latest["title"] == title:
                    return {
                        "id": submission["id"],
                        "state": submission["state"],
                        "submitted_at": submission["submitted_at"],
                        "version_no": submission["latest_version_no"],
                    }
                version_no = int(submission["latest_version_no"]) + 1
                submission = database._required(
                    c.execute(
                        "UPDATE submissions SET latest_version_no=%s,title=%s,year=%s,design=%s,markdown=%s,"
                        " state='pending',score=NULL,feedback='',graded_by=NULL,graded_at=NULL,submitted_at=now()"
                        " WHERE id=%s RETURNING *",
                        (
                            version_no,
                            title,
                            report["year"],
                            json.dumps(design, ensure_ascii=False),
                            report["markdown"],
                            submission["id"],
                        ),
                    ).fetchone(),
                    "revise submission",
                )
            c.execute(
                "INSERT INTO submission_versions(submission_id,version_no,report_id,title,year,design,markdown,submitted_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    submission["id"],
                    version_no,
                    report["id"],
                    title,
                    report["year"],
                    json.dumps(design, ensure_ascii=False),
                    report["markdown"],
                    submission["submitted_at"],
                ),
            )
            return {
                "id": submission["id"],
                "state": submission["state"],
                "submitted_at": submission["submitted_at"],
                "version_no": version_no,
            }


def my_submission(username: str) -> dict[str, Any] | None:
    manifest_id = _current_manifest()
    with database.conn() as c:
        return c.execute(
            "SELECT s.id,s.title,s.year,s.state,s.score,s.feedback,s.graded_by,s.graded_at,s.submitted_at,"
            " s.latest_version_no AS version_no FROM submissions s JOIN accounts a ON a.id=s.account_id"
            " WHERE a.username=%s AND a.active AND s.manifest_id=%s",
            (username, manifest_id),
        ).fetchone()


def _active_teacher(c: psycopg.Connection[dict[str, Any]], username: str) -> bool:
    return (
        c.execute("SELECT 1 FROM accounts WHERE username=%s AND role='teacher' AND active", (username,)).fetchone()
        is not None
    )


def list_submissions(teacher_username: str | None = None) -> list[dict[str, Any]]:
    manifest_id = _current_manifest()
    with database.conn() as c:
        if teacher_username and not _active_teacher(c, teacher_username):
            return []
        return c.execute(
            "SELECT s.id,s.title,s.year,s.state,s.score,s.graded_by,s.graded_at,s.submitted_at,"
            " a.username,a.display_name,a.student_no,cl.name AS class_name FROM submissions s"
            " JOIN accounts a ON a.id=s.account_id LEFT JOIN classes cl ON cl.id=a.class_id"
            " WHERE s.manifest_id=%s ORDER BY s.state,s.submitted_at DESC",
            (manifest_id,),
        ).fetchall()


def get_submission(submission_id: int, teacher_username: str | None = None) -> dict[str, Any] | None:
    manifest_id = _current_manifest()
    with database.conn() as c:
        if teacher_username and not _active_teacher(c, teacher_username):
            return None
        return c.execute(
            "SELECT s.*,a.username,a.display_name,a.student_no,cl.name AS class_name FROM submissions s"
            " JOIN accounts a ON a.id=s.account_id LEFT JOIN classes cl ON cl.id=a.class_id"
            " WHERE s.id=%s AND s.manifest_id=%s",
            (submission_id, manifest_id),
        ).fetchone()


def teacher_can_access_submission_in_conn(c, username: str, submission_id: int) -> bool:
    return (
        _active_teacher(c, username)
        and c.execute(
            "SELECT 1 FROM submissions WHERE id=%s AND manifest_id=%s", (submission_id, _current_manifest())
        ).fetchone()
        is not None
    )


def grade_submission(submission_id: int, score: int, feedback: str, graded_by: str) -> dict[str, Any] | None:
    with database.conn() as c:
        with c.transaction():
            grader = c.execute(
                "SELECT id FROM accounts WHERE username=%s AND role='teacher' AND active", (graded_by,)
            ).fetchone()
            target = c.execute(
                "SELECT account_id,manifest_id FROM submissions WHERE id=%s", (submission_id,)
            ).fetchone()
            if not grader or not target or target["manifest_id"] != _current_manifest():
                return None
            _lock_current_workspace(c, target["account_id"], target["manifest_id"], require_active=False)
            current = c.execute(
                "SELECT s.*,sv.id AS version_id FROM submissions s JOIN submission_versions sv"
                " ON sv.submission_id=s.id AND sv.version_no=s.latest_version_no"
                " WHERE s.id=%s AND s.account_id=%s AND s.manifest_id=%s FOR UPDATE",
                (submission_id, target["account_id"], target["manifest_id"]),
            ).fetchone()
            if not current:
                return None
            c.execute(
                "INSERT INTO grading_events(submission_id,submission_version_id,score,feedback,graded_by_account_id)"
                " VALUES (%s,%s,%s,%s,%s)",
                (submission_id, current["version_id"], score, feedback, grader["id"]),
            )
            return c.execute(
                "UPDATE submissions SET state='graded',score=%s,feedback=%s,graded_by=%s,graded_at=now()"
                " WHERE id=%s RETURNING id,state,score,feedback,graded_by,graded_at",
                (score, feedback, graded_by, submission_id),
            ).fetchone()


def submission_history(submission_id: int, teacher_username: str) -> dict[str, Any] | None:
    with database.conn() as c:
        if not teacher_can_access_submission_in_conn(c, teacher_username, submission_id):
            return None
        versions = c.execute(
            "SELECT id,version_no,title,year,design,markdown,submitted_at FROM submission_versions"
            " WHERE submission_id=%s ORDER BY version_no",
            (submission_id,),
        ).fetchall()
        grades = c.execute(
            "SELECT g.id,sv.version_no,g.score,g.feedback,a.username AS graded_by,g.graded_at"
            " FROM grading_events g JOIN submission_versions sv ON sv.id=g.submission_version_id"
            " JOIN accounts a ON a.id=g.graded_by_account_id WHERE g.submission_id=%s ORDER BY g.graded_at",
            (submission_id,),
        ).fetchall()
        return {"versions": versions, "grades": grades}


def list_announcements(username: str) -> list[dict[str, Any]]:
    with database.conn() as c:
        account = c.execute("SELECT role,class_id FROM accounts WHERE username=%s AND active", (username,)).fetchone()
        if account is None:
            return []
        if account["role"] == "teacher":
            return c.execute(
                "SELECT an.*,cl.name AS class_name FROM announcements an LEFT JOIN classes cl ON cl.id=an.class_id"
                " ORDER BY an.created_at DESC,an.id DESC"
            ).fetchall()
        return c.execute(
            "SELECT an.*,cl.name AS class_name FROM announcements an LEFT JOIN classes cl ON cl.id=an.class_id"
            " WHERE an.class_id IS NULL OR an.class_id=%s ORDER BY an.created_at DESC,an.id DESC",
            (account["class_id"],),
        ).fetchall()


def create_announcement(title: str, body: str, author: str, class_id: int | None = None) -> dict[str, Any]:
    with database.conn() as c:
        if not _active_teacher(c, author):
            raise PermissionError("教师账号无效")
        if class_id is not None and c.execute("SELECT 1 FROM classes WHERE id=%s", (class_id,)).fetchone() is None:
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
        return (
            c.execute("DELETE FROM announcements WHERE id=%s RETURNING id", (announcement_id,)).fetchone() is not None
        )
