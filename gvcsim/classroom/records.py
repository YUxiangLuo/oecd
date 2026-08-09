"""Attempt progress, sessions, reports, submissions, grading, and announcements."""

import json
from collections.abc import Callable
from typing import Any

import psycopg

from gvcsim.classroom import schema


class _DatabaseProxy:
    """Resolve the compatibility facade lazily, after ``classroom.db`` finishes importing."""

    def __getattr__(self, name: str) -> Any:
        from gvcsim.classroom import db

        return getattr(db, name)


database = _DatabaseProxy()


# ---------------------------------------------------------------- 实验进度


def upsert_progress(username: str, step: int) -> None:
    step = max(1, min(database.MAX_STEP, step))
    with database.conn() as c:
        scope = database._attempt_scope(c, username)
        if not scope or scope["attempt_id"] is None:
            return
        database._require_assignment_writable(scope)
        c.execute(
            "INSERT INTO attempt_step_progress(attempt_id,current_step,max_step) VALUES (%s,%s,%s)"
            " ON CONFLICT (attempt_id) DO UPDATE SET current_step=EXCLUDED.current_step,"
            " max_step=GREATEST(attempt_step_progress.max_step,EXCLUDED.max_step),updated_at=now()",
            (scope["attempt_id"], step, step),
        )
        # v3 缓存仅为旧客户端/运维查询兼容，不再是权威作用域。
        c.execute(
            "INSERT INTO step_progress(account_id, current_step, max_step)"
            " SELECT id, %s, %s FROM accounts WHERE username = %s"
            " ON CONFLICT (account_id) DO UPDATE SET"
            " current_step = EXCLUDED.current_step,"
            " max_step = GREATEST(step_progress.max_step, EXCLUDED.max_step),"
            " updated_at = now()",
            (step, step, username),
        )


def get_progress(username: str) -> dict[str, Any] | None:
    """读取学生最后一次上报的当前步骤与历史最远步骤。"""
    with database.conn() as c:
        scope = database._attempt_scope(c, username)
        if scope and scope["attempt_id"] is not None:
            row = c.execute(
                "SELECT current_step,max_step,updated_at FROM attempt_step_progress WHERE attempt_id=%s",
                (scope["attempt_id"],),
            ).fetchone()
            if row:
                return row
            return None
        return c.execute(
            "SELECT p.current_step, p.max_step, p.updated_at"
            " FROM step_progress p JOIN accounts a ON a.id = p.account_id"
            " WHERE a.username = %s AND a.role = 'student'",
            (username,),
        ).fetchone()


# ---------------------------------------------------------------- 实验会话


def get_session(username: str, manifest_id: str | None = None) -> dict[str, Any] | None:
    """读取学生的实验会话;从未保存过则返回 None。"""
    with database.conn() as c:
        scope = database._attempt_scope(c, username, manifest_id)
        if not scope or scope.get("manifest_mismatch") or scope["attempt_id"] is None:
            return None
        row = c.execute(
            "SELECT s.revision,s.manifest_id,s.session,s.legacy_unverified,s.updated_at"
            " FROM attempt_sessions s WHERE s.attempt_id=%s",
            (scope["attempt_id"],),
        ).fetchone()
        return {**row, **scope} if row else None


def save_session(
    username: str,
    session: dict[str, Any],
    base_revision: int,
    merge: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]],
    *,
    expected_assignment_id: int | None = None,
    expected_attempt_id: int | None = None,
) -> dict[str, Any] | None:
    """写入会话;并发写入时按记录级与字段级时间戳合并,不整份覆盖。

    ``base_revision`` 是客户端读到的版本。若服务端已被另一个标签页推进,
    则用 ``merge`` 把两边的步骤记录合并后再写,避免丢掉任何一边的实验。
    整个读-合并-写在一个事务内完成,并按账号加事务级 advisory 锁串行化。
    """
    with database.conn() as c:
        with c.transaction():
            scope = database._attempt_scope(c, username, session.get("manifest_id"))
            if scope is None:
                return None
            if scope.get("manifest_mismatch"):
                raise database.AssignmentScopeMismatch(
                    f"当前作业绑定 {scope['assignment_manifest_id']}，不能写入 {session.get('manifest_id')}"
                )
            if (expected_assignment_id is not None and scope["assignment_id"] != expected_assignment_id) or (
                expected_attempt_id is not None and scope["attempt_id"] != expected_attempt_id
            ):
                raise database.AssignmentScopeMismatch("当前作业 attempt 已变化；请刷新页面后再继续实验")
            database._require_assignment_writable(scope)
            account = {"id": scope["account_id"]}
            attempt_id = scope["attempt_id"]
            # 按账号串行化整个读-合并-写。
            #
            # 不能只靠下面那句 SELECT ... FOR UPDATE:行不存在时它锁不住任何东西。
            # 首次并发写入(两个标签页都还没有会话行)会双双读到 current=None →
            # 都跳过 merge → 都算出 revision=1 → 后到的 ON CONFLICT DO UPDATE
            # 整份覆盖先到的,一边的实验被静默丢弃。advisory 锁对"尚不存在的行"
            # 同样有效,因此把首写竞态也一起关掉。
            c.execute("SELECT pg_advisory_xact_lock(%s, %s)", (database._SESSION_LOCK_NS, attempt_id))
            # reset 与 PUT 共用 attempt 锁。若 PUT 在等待锁时另一个标签页已重置，
            # 必须重新解析当前边界；否则它会在 reset 提交后把旧会话写回已归档
            # attempt，并重新污染 account 级兼容镜像。
            locked_scope = database._attempt_scope(c, username, session.get("manifest_id"), create=False)
            if (
                locked_scope is None
                or locked_scope.get("manifest_mismatch")
                or locked_scope["assignment_id"] != scope["assignment_id"]
                or locked_scope["attempt_id"] != attempt_id
                or (expected_assignment_id is not None and locked_scope["assignment_id"] != expected_assignment_id)
                or (expected_attempt_id is not None and locked_scope["attempt_id"] != expected_attempt_id)
            ):
                raise database.AssignmentScopeMismatch("当前作业 attempt 已变化；请刷新页面后再继续实验")
            scope = locked_scope
            database._require_assignment_writable(scope)
            current = c.execute(
                "SELECT revision,session,legacy_unverified FROM attempt_sessions WHERE attempt_id=%s FOR UPDATE",
                (attempt_id,),
            ).fetchone()
            if current is not None and current["legacy_unverified"]:
                raise database.LegacySessionReadOnly("迁移前会话未经可信证据验证；请先导出记录并显式重新开始")

            # 即使客户端带回的 ``base_revision`` 正好等于 current，也必须做
            # 记录/字段级合并。服务端本身也会写会话（目前是报告生成写入 step 16），
            # 而浏览器里可能已有一个在该写入前排队的防抖 PUT。它收到报告响应后
            # 会更新 revision，却仍可能携带那份缺少 step 16 的旧本地快照；若因
            # revision 相同就整份采用 incoming，服务端刚写下的可信记录会被删除。
            #
            # 单步删除从来不是 PUT /session 的契约；显式 reset 走独立的新 attempt
            # 路径。因此 current 存在时始终 merge，既保护服务端专用步骤，也保持
            # 两标签页“不同步骤都不丢”的既有语义。
            merged = merge(current["session"], session) if current is not None else session
            merged_from: int | None = None
            if current is not None and current["revision"] != base_revision:
                merged_from = current["revision"]
            revision = (current["revision"] + 1) if current is not None else 1

            c.execute(
                "INSERT INTO attempt_sessions(attempt_id,revision,manifest_id,session,legacy_unverified)"
                " VALUES (%s,%s,%s,%s,false) ON CONFLICT (attempt_id) DO UPDATE SET"
                " revision=EXCLUDED.revision,manifest_id=EXCLUDED.manifest_id,session=EXCLUDED.session,"
                " legacy_unverified=false,updated_at=now()",
                (attempt_id, revision, merged["manifest_id"], json.dumps(merged)),
            )
            c.execute(
                "INSERT INTO experiment_sessions(account_id, revision, manifest_id, session)"
                " VALUES (%s, %s, %s, %s)"
                " ON CONFLICT (account_id) DO UPDATE SET"
                " revision = EXCLUDED.revision, manifest_id = EXCLUDED.manifest_id,"
                " session = EXCLUDED.session, updated_at = now()",
                (account["id"], revision, merged["manifest_id"], json.dumps(merged)),
            )
            return {"revision": revision, "session": merged, "merged_from": merged_from}


def clear_session(
    username: str,
    *,
    expected_assignment_id: int,
    expected_attempt_id: int,
) -> None:
    """一致性重置当前尝试。

    归档旧尝试并创建下一 attempt；当前进度/报告/提交自然为空，历史记录仍可
    审计。旧答题/回归收据引用的事件同时撤销，不能跨 attempt 复用。
    """
    with database.conn() as c:
        with c.transaction():
            initial_scope = database._attempt_scope(c, username, create=False)
            if not initial_scope or initial_scope["attempt_id"] is None:
                raise database.AssignmentScopeMismatch("当前没有可重置的作业 attempt；请刷新页面后重试")
            # 两个标签页可能同时拿着同一个旧 attempt 发 reset。先锁调用方最初
            # 命中的 attempt，再重新读取 active 边界，令后到请求看到第一个请求
            # 已创建的新 attempt 并被 expected_attempt_id 拒绝。
            c.execute(
                "SELECT pg_advisory_xact_lock(%s, %s)",
                (database._SESSION_LOCK_NS, initial_scope["attempt_id"]),
            )
            scope = database._attempt_scope(c, username, create=False)
            if (
                not scope
                or scope["attempt_state"] != "active"
                or scope["assignment_id"] != expected_assignment_id
                or scope["attempt_id"] != expected_attempt_id
            ):
                raise database.AssignmentScopeMismatch("当前作业 attempt 已变化；本次重新开始已取消，请刷新页面")
            database._require_assignment_writable(scope)
            # 每次重置都换 attempt 边界：旧答题/回归收据绑定旧 attempt，无法在
            # 新会话复用；既有提交/评分仍可由教师审计，但不再是学生“当前状态”。
            c.execute(
                "UPDATE learning_evidence_events SET revoked_at=coalesce(revoked_at,now()) WHERE attempt_id=%s",
                (scope["attempt_id"],),
            )
            c.execute(
                "UPDATE experiment_attempts SET state='archived',updated_at=now() WHERE id=%s",
                (scope["attempt_id"],),
            )
            next_no = database._required(
                c.execute(
                    "SELECT coalesce(max(attempt_no),0)+1 AS n FROM experiment_attempts"
                    " WHERE assignment_id=%s AND enrollment_id=%s",
                    (scope["assignment_id"], scope["enrollment_id"]),
                ).fetchone(),
                "next reset attempt number",
            )["n"]
            c.execute(
                "INSERT INTO experiment_attempts(assignment_id,enrollment_id,attempt_no) VALUES (%s,%s,%s)",
                (scope["assignment_id"], scope["enrollment_id"], next_no),
            )
            c.execute("DELETE FROM step_progress WHERE account_id=%s", (scope["account_id"],))
            c.execute(
                "DELETE FROM experiment_sessions s USING accounts a WHERE s.account_id = a.id AND a.username = %s",
                (username,),
            )


def reset_active_attempts_for_quiz(quiz_version: str, manifest_id: str) -> dict[str, Any]:
    """为新版题库一次性归档所有仍可写的当前 attempt。

    历史 session、报告、提交和评分均留在旧 attempt 上；只撤销旧学习凭证并为
    同一 assignment/enrollment 创建一个空白 attempt。audit_log 中的版本标记让
    同一部署命令可安全重跑而不会连续重置学生。
    """
    if not quiz_version or len(quiz_version) > 80:
        raise ValueError("quiz_version 必须是 1..80 字符的稳定版本号")
    if not manifest_id:
        raise ValueError("重置 attempt 需要当前 manifest_id")
    action = "quiz.active_attempts_reset"
    with database.conn() as c:
        with c.transaction():
            schema.lock_schema(c)
            prior = c.execute(
                "SELECT details,created_at FROM audit_log"
                " WHERE action=%s AND target_type='quiz_version' AND target_id=%s"
                " ORDER BY id DESC LIMIT 1",
                (action, quiz_version),
            ).fetchone()
            if prior:
                raw_details = prior.get("details")
                details: dict[str, Any] = raw_details if isinstance(raw_details, dict) else {}
                return {
                    "quiz_version": quiz_version,
                    "already_applied": True,
                    "reset_count": int(details.get("reset_count") or 0),
                    "applied_at": prior["created_at"],
                }

            attempts = c.execute(
                "SELECT ea.id AS attempt_id,ea.assignment_id,ea.enrollment_id,en.account_id"
                " FROM experiment_attempts ea"
                " JOIN assignments ass ON ass.id=ea.assignment_id"
                " JOIN course_runs cr ON cr.id=ass.course_run_id"
                " JOIN enrollments en ON en.id=ea.enrollment_id"
                " JOIN accounts acc ON acc.id=en.account_id"
                " WHERE ea.state='active' AND ass.active AND NOT cr.archived"
                " AND en.active AND acc.active AND ass.manifest_id=%s"
                " AND (ass.opens_at IS NULL OR ass.opens_at<=now())"
                " AND (ass.due_at IS NULL OR ass.due_at>now())"
                " ORDER BY ea.id FOR UPDATE OF ea",
                (manifest_id,),
            ).fetchall()
            account_ids: set[int] = set()
            new_attempt_ids: list[int] = []
            for attempt in attempts:
                c.execute(
                    "UPDATE learning_evidence_events SET revoked_at=coalesce(revoked_at,now()) WHERE attempt_id=%s",
                    (attempt["attempt_id"],),
                )
                c.execute(
                    "UPDATE experiment_attempts SET state='archived',updated_at=now() WHERE id=%s",
                    (attempt["attempt_id"],),
                )
                next_no = database._required(
                    c.execute(
                        "SELECT coalesce(max(attempt_no),0)+1 AS n FROM experiment_attempts"
                        " WHERE assignment_id=%s AND enrollment_id=%s",
                        (attempt["assignment_id"], attempt["enrollment_id"]),
                    ).fetchone(),
                    "next quiz reset attempt number",
                )["n"]
                created = database._required(
                    c.execute(
                        "INSERT INTO experiment_attempts(assignment_id,enrollment_id,attempt_no)"
                        " VALUES (%s,%s,%s) RETURNING id",
                        (attempt["assignment_id"], attempt["enrollment_id"], next_no),
                    ).fetchone(),
                    "create quiz reset attempt",
                )
                new_attempt_ids.append(int(created["id"]))
                account_ids.add(int(attempt["account_id"]))

            if account_ids:
                ids = sorted(account_ids)
                c.execute("DELETE FROM step_progress WHERE account_id=ANY(%s)", (ids,))
                c.execute("DELETE FROM experiment_sessions WHERE account_id=ANY(%s)", (ids,))
            details = {
                "quiz_version": quiz_version,
                "manifest_id": manifest_id,
                "reset_count": len(attempts),
                "new_attempt_ids": new_attempt_ids,
            }
            c.execute(
                "INSERT INTO audit_log(actor_name,action,target_type,target_id,details)"
                " VALUES ('deployment',%s,'quiz_version',%s,%s)",
                (action, quiz_version, json.dumps(details)),
            )
            return {**details, "already_applied": False}


# ---------------------------------------------------------------- 服务端生成的报告


def save_generated_report_and_session(
    username: str,
    report_key: str,
    base_revision: int,
    manifest_id: str,
    markdown: str,
    provenance: dict[str, Any],
    session: dict[str, Any],
) -> dict[str, Any] | None:
    """单事务写入服务端报告与 step16 完成记录。

    不接受并发 merge：报告正文基于 ``base_revision`` 重算；若会话已推进，
    合并后正文与完成记录将不再属于同一快照，因此明确冲突并要求重新生成。
    """
    with database.conn() as c:
        with c.transaction():
            scope = database._attempt_scope(c, username, manifest_id)
            if not scope or scope.get("manifest_mismatch"):
                raise database.AssignmentScopeMismatch("报告不属于当前 assignment/manifest")
            database._require_assignment_writable(scope)
            attempt_id = scope["attempt_id"]
            c.execute("SELECT pg_advisory_xact_lock(%s,%s)", (database._SESSION_LOCK_NS, attempt_id))
            current = c.execute(
                "SELECT revision,session,legacy_unverified FROM attempt_sessions WHERE attempt_id=%s FOR UPDATE",
                (attempt_id,),
            ).fetchone()
            current_revision = current["revision"] if current else 0
            if current and current["legacy_unverified"]:
                raise database.LegacySessionReadOnly("迁移前会话不能生成可评分报告")
            if current_revision != base_revision:
                raise database.SessionRevisionConflict(
                    f"会话已从 revision {base_revision} 更新到 {current_revision}；请重新生成报告"
                )
            report = c.execute(
                "INSERT INTO reports(account_id,attempt_id,assignment_id,report_key,session_revision,"
                " manifest_id,markdown,provenance) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)"
                " ON CONFLICT (attempt_id,report_key) DO NOTHING"
                " RETURNING id,report_key,session_revision,manifest_id,markdown,provenance,created_at",
                (
                    scope["account_id"],
                    attempt_id,
                    scope["assignment_id"],
                    report_key,
                    base_revision,
                    manifest_id,
                    markdown,
                    json.dumps(provenance, ensure_ascii=False),
                ),
            ).fetchone()
            if report is None:
                report = c.execute(
                    "SELECT id,report_key,session_revision,manifest_id,markdown,provenance,created_at FROM reports"
                    " WHERE account_id=%s AND attempt_id=%s AND report_key=%s",
                    (scope["account_id"], attempt_id, report_key),
                ).fetchone()
                if report is None:
                    raise database.SessionRevisionConflict("report_key 已被其他 attempt 使用")
            if current is not None and current["session"] == session:
                return {"report": report, "revision": current_revision, "session": current["session"]}
            revision = current_revision + 1
            serialized = json.dumps(session, ensure_ascii=False)
            c.execute(
                "INSERT INTO attempt_sessions(attempt_id,revision,manifest_id,session,legacy_unverified)"
                " VALUES (%s,%s,%s,%s,false) ON CONFLICT (attempt_id) DO UPDATE SET"
                " revision=EXCLUDED.revision,manifest_id=EXCLUDED.manifest_id,session=EXCLUDED.session,"
                " legacy_unverified=false,updated_at=now()",
                (attempt_id, revision, manifest_id, serialized),
            )
            c.execute(
                "INSERT INTO experiment_sessions(account_id,revision,manifest_id,session) VALUES (%s,%s,%s,%s)"
                " ON CONFLICT (account_id) DO UPDATE SET revision=EXCLUDED.revision,"
                " manifest_id=EXCLUDED.manifest_id,session=EXCLUDED.session,updated_at=now()",
                (scope["account_id"], revision, manifest_id, serialized),
            )
            return {"report": report, "revision": revision, "session": session}


def latest_report(username: str) -> dict[str, Any] | None:
    """读取学生最近生成的报告(刷新后可重新打开全文)。"""
    with database.conn() as c:
        scope = database._attempt_scope(c, username)
        if not scope:
            return None
        return c.execute(
            "SELECT r.id, r.report_key, r.session_revision, r.manifest_id, r.markdown, r.provenance, r.created_at"
            " FROM reports r JOIN accounts a ON a.id = r.account_id"
            " WHERE a.username = %s AND r.attempt_id=%s ORDER BY r.created_at DESC LIMIT 1",
            (username, scope["attempt_id"]),
        ).fetchone()


def _report_by_key_in_conn(
    c: psycopg.Connection[dict[str, Any]], username: str, report_key: str
) -> dict[str, Any] | None:
    scope = database._attempt_scope(c, username)
    if not scope:
        return None
    return c.execute(
        "SELECT r.id, r.report_key, r.session_revision, r.manifest_id, r.markdown, r.provenance, r.created_at"
        " FROM reports r JOIN accounts a ON a.id = r.account_id"
        " WHERE a.username = %s AND r.report_key = %s AND r.attempt_id=%s",
        (username, report_key, scope["attempt_id"]),
    ).fetchone()


def report_by_key(
    username: str,
    report_key: str,
    *,
    connection: psycopg.Connection[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    if connection is not None:
        return _report_by_key_in_conn(connection, username, report_key)
    with database.conn() as c:
        return _report_by_key_in_conn(c, username, report_key)


# ---------------------------------------------------------------- 报告提交与评阅


def submit_report(
    username: str, title: str, report_key: str, current_manifest_id: str | None = None
) -> dict[str, Any] | None:
    """提交学生**已由服务端生成**的那份报告。

    正文与溯源都从 reports 表里取,接口不接受任何客户端提供的 Markdown:
    否则"报告已提交"只能证明有人上传过一段文字,证明不了他做过课程。
    找不到对应 report_key(没生成过/不是本人的)时返回 None。

    ``experiment_attempts.state`` 保持 active，以便同一 attempt 提交修订版并在
    刷新后恢复；是否已交/已评只由 submissions.state 表示。显式“新尝试/重置”
    才会把 attempt 归档。
    """
    with database.conn() as c:
        with c.transaction():
            scope = database._attempt_scope(c, username, current_manifest_id)
            if not scope or scope.get("manifest_mismatch"):
                return None
            database._require_assignment_writable(scope)
            report = c.execute(
                "SELECT r.*,coalesce((r.provenance #>> '{artifact,years,-1}')::int,0) AS year"
                " FROM reports r WHERE r.account_id=%s AND r.attempt_id=%s AND r.assignment_id=%s"
                " AND r.report_key=%s AND r.manifest_id=%s",
                (
                    scope["account_id"],
                    scope["attempt_id"],
                    scope["assignment_id"],
                    report_key,
                    current_manifest_id or scope["assignment_manifest_id"],
                ),
            ).fetchone()
            if report is None:
                return None
            design = {
                "report_key": report["report_key"],
                "manifest_id": report["manifest_id"],
                "session_revision": report["session_revision"],
                "runs": report["provenance"].get("runs"),
                "assignment_id": scope["assignment_id"],
                "attempt_id": scope["attempt_id"],
            }
            submission = c.execute(
                "SELECT * FROM submissions WHERE attempt_id=%s FOR UPDATE", (scope["attempt_id"],)
            ).fetchone()
            if submission is None:
                submission = database._required(
                    c.execute(
                        "INSERT INTO submissions(account_id,attempt_id,latest_version_no,title,year,design,markdown)"
                        " VALUES (%s,%s,1,%s,%s,%s,%s) RETURNING *",
                        (
                            scope["account_id"],
                            scope["attempt_id"],
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
                    "SELECT report_id,title FROM submission_versions WHERE submission_id=%s"
                    " ORDER BY version_no DESC LIMIT 1",
                    (submission["id"],),
                ).fetchone()
                if latest and latest["report_id"] == report["id"] and latest["title"] == title:
                    return {
                        "id": submission["id"],
                        "state": submission["state"],
                        "submitted_at": submission["submitted_at"],
                        "version_no": submission["latest_version_no"],
                    }
                version_no = submission["latest_version_no"] + 1
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
    with database.conn() as c:
        scope = database._attempt_scope(c, username, create=False)
        if not scope or scope["attempt_id"] is None:
            return None
        return c.execute(
            "SELECT s.id,s.title,s.year,s.state,s.score,s.feedback,s.graded_by,s.graded_at,s.submitted_at,"
            " s.latest_version_no AS version_no"
            " FROM submissions s JOIN accounts a ON a.id=s.account_id"
            " WHERE a.username=%s AND s.attempt_id=%s ORDER BY s.submitted_at DESC LIMIT 1",
            (username, scope["attempt_id"]),
        ).fetchone()


def list_submissions(teacher_username: str | None = None) -> list[dict[str, Any]]:
    with database.conn() as c:
        scope_join = ""
        params: tuple[Any, ...] = ()
        if teacher_username:
            scope_join = (
                " JOIN experiment_attempts at ON at.id=s.attempt_id JOIN assignments ass ON ass.id=at.assignment_id"
                " JOIN teacher_course_access tca ON tca.course_run_id=ass.course_run_id"
                " JOIN accounts teacher ON teacher.id=tca.teacher_account_id AND teacher.username=%s"
                " AND teacher.role='teacher' AND teacher.active AND tca.can_manage"
            )
            params = (teacher_username,)
        return c.execute(
            "SELECT s.id, s.title, s.year, s.state, s.score, s.graded_by, s.graded_at, s.submitted_at,"
            " a.username, a.display_name, a.student_no, cl.name AS class_name"
            " FROM submissions s JOIN accounts a ON a.id = s.account_id"
            f" {scope_join}"
            " LEFT JOIN classes cl ON cl.id = a.class_id"
            " ORDER BY s.state, s.submitted_at DESC",
            params,
        ).fetchall()


def get_submission(submission_id: int, teacher_username: str | None = None) -> dict[str, Any] | None:
    with database.conn() as c:
        scope = ""
        params: list[Any] = [submission_id]
        if teacher_username:
            scope = (
                " AND EXISTS (SELECT 1 FROM experiment_attempts at JOIN assignments ass ON ass.id=at.assignment_id"
                " JOIN teacher_course_access tca ON tca.course_run_id=ass.course_run_id"
                " JOIN accounts t ON t.id=tca.teacher_account_id WHERE at.id=s.attempt_id"
                " AND t.username=%s AND t.active AND tca.can_manage)"
            )
            params.append(teacher_username)
        return c.execute(
            "SELECT s.*, a.username, a.display_name, a.student_no, cl.name AS class_name"
            " FROM submissions s JOIN accounts a ON a.id = s.account_id"
            f" LEFT JOIN classes cl ON cl.id = a.class_id WHERE s.id = %s {scope}",
            tuple(params),
        ).fetchone()


def grade_submission(submission_id: int, score: int, feedback: str, graded_by: str) -> dict[str, Any] | None:
    with database.conn() as c:
        with c.transaction():
            if not teacher_can_access_submission_in_conn(c, graded_by, submission_id):
                return None
            current = c.execute(
                "SELECT s.*,sv.id AS version_id FROM submissions s JOIN submission_versions sv"
                " ON sv.submission_id=s.id AND sv.version_no=s.latest_version_no WHERE s.id=%s FOR UPDATE",
                (submission_id,),
            ).fetchone()
            grader = c.execute("SELECT id FROM accounts WHERE username=%s AND role='teacher'", (graded_by,)).fetchone()
            if not current or not grader:
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


def teacher_can_access_submission_in_conn(c, username: str, submission_id: int) -> bool:
    return (
        c.execute(
            "SELECT 1 FROM submissions s JOIN experiment_attempts at ON at.id=s.attempt_id"
            " JOIN assignments ass ON ass.id=at.assignment_id"
            " JOIN teacher_course_access tca ON tca.course_run_id=ass.course_run_id"
            " JOIN accounts t ON t.id=tca.teacher_account_id"
            " WHERE s.id=%s AND t.username=%s AND t.active AND tca.can_manage",
            (submission_id, username),
        ).fetchone()
        is not None
    )


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


# ---------------------------------------------------------------- 公告


def list_announcements(username: str) -> list[dict[str, Any]]:
    """全局公告 + 学生本人班级；教师只看获授权课程关联班级。"""
    with database.conn() as c:
        me = c.execute("SELECT role, class_id FROM accounts WHERE username = %s", (username,)).fetchone()
        params: tuple[Any, ...]
        if me and me["role"] == "teacher":
            where = (
                "(an.class_id IS NULL OR EXISTS (SELECT 1 FROM course_class_links l"
                " JOIN teacher_course_access tca ON tca.course_run_id=l.course_run_id"
                " JOIN accounts t ON t.id=tca.teacher_account_id"
                " WHERE l.class_id=an.class_id AND t.username=%s AND t.active AND tca.can_manage))"
            )
            params = (username,)
        else:
            where, params = "(an.class_id IS NULL OR an.class_id = %s)", ((me or {}).get("class_id"),)
        return c.execute(
            f"SELECT an.*, cl.name AS class_name FROM announcements an"
            f" LEFT JOIN classes cl ON cl.id = an.class_id WHERE {where} ORDER BY an.created_at DESC",
            params,
        ).fetchall()


def create_announcement(title: str, body: str, author: str, class_id: int | None = None) -> dict[str, Any]:
    with database.conn() as c:
        if (
            class_id is not None
            and not c.execute(
                "SELECT 1 FROM course_class_links l JOIN teacher_course_access tca"
                " ON tca.course_run_id=l.course_run_id JOIN accounts t ON t.id=tca.teacher_account_id"
                " WHERE l.class_id=%s AND t.username=%s AND t.active AND tca.can_manage",
                (class_id, author),
            ).fetchone()
        ):
            raise PermissionError("教师无权向该班级发布公告")
        row = c.execute(
            "INSERT INTO announcements(class_id, title, body, author) VALUES (%s, %s, %s, %s) RETURNING *",
            (class_id, title, body, author),
        ).fetchone()
    assert row is not None
    return row


def delete_announcement(announcement_id: int, actor: str | None = None) -> bool:
    with database.conn() as c:
        scope = ""
        params: list[Any] = [announcement_id]
        if actor:
            scope = (
                " AND (class_id IS NULL AND author=%s OR EXISTS (SELECT 1 FROM course_class_links l"
                " JOIN teacher_course_access tca ON tca.course_run_id=l.course_run_id"
                " JOIN accounts t ON t.id=tca.teacher_account_id WHERE l.class_id=announcements.class_id"
                " AND t.username=%s AND t.active AND tca.can_manage))"
            )
            params += [actor, actor]
        return (
            c.execute(f"DELETE FROM announcements WHERE id=%s {scope} RETURNING id", tuple(params)).fetchone()
            is not None
        )
