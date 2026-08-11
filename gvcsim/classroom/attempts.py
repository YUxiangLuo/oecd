"""Assignment/attempt scope resolution and trusted learning-event persistence."""

import json
import uuid
from typing import Any

import psycopg


class _DatabaseProxy:
    """Resolve the compatibility facade lazily, after ``classroom.db`` finishes importing."""

    def __getattr__(self, name: str) -> Any:
        from gvcsim.classroom import db

        return getattr(db, name)


database = _DatabaseProxy()


# ---------------------------------------------------------------- 课程运行 / 作业 / enrollment / attempt


def _attempt_scope(
    c: psycopg.Connection[dict[str, Any]],
    username: str,
    manifest_id: str | None = None,
    *,
    create: bool = True,
    course_run_ids: list[int] | None = None,
) -> dict[str, Any] | None:
    """解析学生当前作业尝试；所有学习记录必须经此函数取得作用域。

    学生手动选择始终优先。没有选择时，先保留已有提交/报告/进度的
    作业，再考虑新发布的空作业；选中后持久化，不让刷新改变作用域。
    教师按 course_run_ids 查看时不改写学生的选择。
    """
    course_scope = " AND cr.id=ANY(%s)" if course_run_ids is not None else ""
    params: tuple[Any, ...] = (username, course_run_ids) if course_run_ids is not None else (username,)
    row = c.execute(
        "SELECT a.id AS account_id,a.class_id,cr.id AS course_run_id,cr.code AS course_run_code,"
        " cr.name AS course_run_name,cr.term AS course_run_term,"
        " ass.id AS assignment_id,ass.slug AS assignment_slug,ass.title AS assignment_title,"
        " ass.manifest_id AS assignment_manifest_id,ass.opens_at,ass.due_at,"
        " (ass.due_at IS NOT NULL AND ass.due_at<=now()) AS assignment_closed,e.id AS enrollment_id,"
        " NOT (e.active AND NOT cr.archived AND ass.active"
        "   AND (ass.opens_at IS NULL OR ass.opens_at<=now())) AS assignment_historical,"
        " at.id AS attempt_id,at.attempt_no,at.state AS attempt_state"
        " FROM accounts a"
        " LEFT JOIN student_assignment_selections sel ON sel.account_id=a.id"
        " JOIN enrollments e ON e.account_id=a.id"
        " JOIN course_runs cr ON cr.id=e.course_run_id"
        " JOIN assignments ass ON ass.course_run_id=cr.id"
        " LEFT JOIN LATERAL (SELECT x.* FROM experiment_attempts x"
        "   WHERE x.assignment_id=ass.id AND x.enrollment_id=e.id"
        "   ORDER BY (x.state='active') DESC,x.attempt_no DESC LIMIT 1) at ON true"
        " WHERE a.username=%s AND a.role='student' AND a.active"
        " AND ((sel.assignment_id=ass.id AND at.id IS NOT NULL)"
        "   OR (e.active AND NOT cr.archived AND ass.active"
        "     AND (ass.opens_at IS NULL OR ass.opens_at<=now())))"
        f"{course_scope}"
        " ORDER BY (sel.assignment_id=ass.id) DESC,"
        " EXISTS (SELECT 1 FROM submissions s WHERE s.attempt_id=at.id) DESC,"
        " EXISTS (SELECT 1 FROM reports r WHERE r.attempt_id=at.id) DESC,"
        " coalesce((SELECT p.max_step FROM attempt_step_progress p WHERE p.attempt_id=at.id),0) DESC,"
        " (at.id IS NOT NULL) DESC,"
        " (e.active AND NOT cr.archived AND ass.active) DESC,"
        " (ass.due_at IS NULL OR ass.due_at>now()) DESC,ass.created_at DESC LIMIT 1",
        params,
    ).fetchone()
    if row is None:
        return None
    if course_run_ids is None:
        c.execute(
            "INSERT INTO student_assignment_selections(account_id,assignment_id) VALUES (%s,%s)"
            " ON CONFLICT (account_id) DO UPDATE SET assignment_id=EXCLUDED.assignment_id,updated_at=now()"
            " WHERE student_assignment_selections.assignment_id IS DISTINCT FROM EXCLUDED.assignment_id",
            (row["account_id"], row["assignment_id"]),
        )
    row["assignment_scope"] = (
        f"course:{row['course_run_id']}/assignment:{row['assignment_id']}/attempt:{row['attempt_id']}"
    )
    if manifest_id:
        assigned = row["assignment_manifest_id"]
        if assigned and assigned != manifest_id:
            return {**row, "manifest_mismatch": True}
        if not assigned and not row["assignment_closed"] and not row["assignment_historical"]:
            c.execute(
                "UPDATE assignments SET manifest_id=%s WHERE id=%s AND manifest_id=''",
                (manifest_id, row["assignment_id"]),
            )
            row["assignment_manifest_id"] = manifest_id
    if (
        create
        and not row["assignment_closed"]
        and not row["assignment_historical"]
        and (row["attempt_id"] is None or row["attempt_state"] != "active")
    ):
        next_no = database._required(
            c.execute(
                "SELECT coalesce(max(attempt_no),0)+1 AS n FROM experiment_attempts"
                " WHERE assignment_id=%s AND enrollment_id=%s",
                (row["assignment_id"], row["enrollment_id"]),
            ).fetchone(),
            "next attempt number",
        )["n"]
        # 首次登录会并发请求 meta/progress/session。多个请求可能都先读到
        # attempt_id=NULL，并算出同一个 next_no；创建必须是幂等竞争安全，不能让
        # 输掉唯一键竞争的请求变成 500。冲突行提交后，READ COMMITTED 下方的
        # 新 SELECT 会看到获胜请求创建的同一 attempt。
        created = c.execute(
            "INSERT INTO experiment_attempts(assignment_id,enrollment_id,attempt_no) VALUES (%s,%s,%s)"
            # 同时吸收 attempt_no 唯一约束和“每个作业 enrollment 仅一个 active”
            # 的部分唯一索引竞争，因此这里不能只指定前三列那个约束。
            " ON CONFLICT DO NOTHING"
            " RETURNING id,attempt_no,state",
            (row["assignment_id"], row["enrollment_id"], next_no),
        ).fetchone()
        if created is None:
            created = database._required(
                c.execute(
                    "SELECT id,attempt_no,state FROM experiment_attempts"
                    " WHERE assignment_id=%s AND enrollment_id=%s"
                    " ORDER BY (state='active') DESC,attempt_no DESC LIMIT 1",
                    (row["assignment_id"], row["enrollment_id"]),
                ).fetchone(),
                "load concurrently created attempt",
            )
        row.update(
            {"attempt_id": created["id"], "attempt_no": created["attempt_no"], "attempt_state": created["state"]}
        )
    row["assignment_scope"] = (
        f"course:{row['course_run_id']}/assignment:{row['assignment_id']}/attempt:{row['attempt_id']}"
    )
    return row


def _require_assignment_writable(scope: dict[str, Any]) -> None:
    if scope.get("assignment_historical"):
        raise database.AssignmentClosed("这是历史作业；既有进度、报告和评分可查看，但不能继续写入")
    if scope.get("assignment_closed"):
        due_at = scope.get("due_at")
        isoformat = getattr(due_at, "isoformat", None)
        rendered = str(isoformat()) if callable(isoformat) else str(due_at or "")
        raise database.AssignmentClosed(f"作业已于 {rendered} 截止；现可查看既有记录，但不能继续写入或提交")


def assignment_context(username: str, manifest_id: str | None = None) -> dict[str, Any] | None:
    with database.conn() as c:
        return _attempt_scope(c, username, manifest_id)


def list_student_assignment_contexts(username: str, manifest_id: str | None = None) -> list[dict[str, Any]]:
    """列出学生可切换的当前作业与有 attempt 的历史作业。"""
    with database.conn() as c:
        # 先解析一次，为 v4 升级后尚未有 selection 的账号建立稳定默认值。
        _attempt_scope(c, username, manifest_id)
        return c.execute(
            "SELECT cr.id AS course_run_id,cr.code AS course_run_code,cr.name AS course_run_name,"
            " cr.term AS course_run_term,cr.archived AS course_run_archived,"
            " ass.id AS assignment_id,ass.slug AS assignment_slug,ass.title AS assignment_title,"
            " ass.manifest_id AS assignment_manifest_id,ass.opens_at,ass.due_at,ass.active AS assignment_active,"
            " e.active AS enrollment_active,at.id AS attempt_id,at.attempt_no,at.state AS attempt_state,"
            " p.current_step,p.max_step,s.state AS submission_state,s.score,s.feedback,s.graded_at,s.submitted_at,"
            " (sel.assignment_id=ass.id) AS selected,"
            " NOT (e.active AND NOT cr.archived AND ass.active"
            "   AND (ass.opens_at IS NULL OR ass.opens_at<=now())) AS historical,"
            " (ass.due_at IS NOT NULL AND ass.due_at<=now()) AS assignment_closed"
            " FROM accounts a"
            " JOIN enrollments e ON e.account_id=a.id"
            " JOIN course_runs cr ON cr.id=e.course_run_id"
            " JOIN assignments ass ON ass.course_run_id=cr.id"
            " LEFT JOIN student_assignment_selections sel ON sel.account_id=a.id"
            " LEFT JOIN LATERAL (SELECT x.* FROM experiment_attempts x"
            "   WHERE x.assignment_id=ass.id AND x.enrollment_id=e.id"
            "   ORDER BY (x.state='active') DESC,x.attempt_no DESC LIMIT 1) at ON true"
            " LEFT JOIN attempt_step_progress p ON p.attempt_id=at.id"
            " LEFT JOIN submissions s ON s.attempt_id=at.id"
            " WHERE a.username=%s AND a.role='student' AND a.active"
            " AND ((e.active AND NOT cr.archived AND ass.active"
            "   AND (ass.opens_at IS NULL OR ass.opens_at<=now())) OR at.id IS NOT NULL)"
            " ORDER BY (sel.assignment_id=ass.id) DESC,historical,cr.created_at DESC,ass.created_at DESC",
            (username,),
        ).fetchall()


def select_student_assignment(
    username: str, assignment_id: int, manifest_id: str | None = None
) -> dict[str, Any] | None:
    """显式选择当前作业；只允许选本人开放作业或已有 attempt 的历史作业。"""
    with database.conn() as c:
        candidate = c.execute(
            "SELECT a.id AS account_id FROM accounts a"
            " JOIN enrollments e ON e.account_id=a.id"
            " JOIN course_runs cr ON cr.id=e.course_run_id"
            " JOIN assignments ass ON ass.course_run_id=cr.id"
            " WHERE a.username=%s AND a.role='student' AND a.active AND ass.id=%s"
            " AND ((e.active AND NOT cr.archived AND ass.active"
            "   AND (ass.opens_at IS NULL OR ass.opens_at<=now()))"
            " OR EXISTS (SELECT 1 FROM experiment_attempts at"
            "   WHERE at.assignment_id=ass.id AND at.enrollment_id=e.id))",
            (username, assignment_id),
        ).fetchone()
        if candidate is None:
            return None
        c.execute(
            "INSERT INTO student_assignment_selections(account_id,assignment_id) VALUES (%s,%s)"
            " ON CONFLICT (account_id) DO UPDATE SET assignment_id=EXCLUDED.assignment_id,updated_at=now()",
            (candidate["account_id"], assignment_id),
        )
        return _attempt_scope(c, username, manifest_id)


def record_evidence_event(
    username: str,
    step: int,
    kind: str,
    manifest_id: str,
    payload_sha256: str,
    claims: dict[str, Any],
) -> dict[str, Any]:
    """持久化由服务端观察到的学习事件，再由可信证据层签发引用。"""
    event_id = uuid.uuid4()
    with database.conn() as c:
        scope = _attempt_scope(c, username, manifest_id)
        if not scope or scope.get("manifest_mismatch") or scope["attempt_id"] is None:
            raise database.AssignmentScopeMismatch("事件不属于当前 assignment/manifest")
        _require_assignment_writable(scope)
        row = c.execute(
            "INSERT INTO learning_evidence_events(id,account_id,assignment_id,attempt_id,step,kind,manifest_id,payload_hash,payload)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)"
            " RETURNING id::text AS event_id,account_id,assignment_id,attempt_id,step,kind,manifest_id,"
            " created_at AS issued_at",
            (
                event_id,
                scope["account_id"],
                scope["assignment_id"],
                scope["attempt_id"],
                step,
                kind,
                manifest_id,
                payload_sha256,
                json.dumps(claims, ensure_ascii=False),
            ),
        ).fetchone()
    assert row is not None
    return row


def _evidence_event_exists_in_conn(
    c: psycopg.Connection[dict[str, Any]],
    username: str,
    event_id: str,
    assignment_id: int,
    attempt_id: int,
    payload_sha256: str,
    *,
    account_id: int | None = None,
    step: int | None = None,
    kind: str | None = None,
    manifest_id: str | None = None,
) -> bool:
    scope = _attempt_scope(c, username, manifest_id, create=False)
    if (
        not scope
        or scope.get("manifest_mismatch")
        or scope.get("assignment_id") != assignment_id
        or scope.get("attempt_id") != attempt_id
        or (account_id is not None and scope.get("account_id") != account_id)
    ):
        return False
    clauses = [
        "a.username=%s",
        "ev.id=%s",
        "ev.account_id=%s",
        "ev.assignment_id=%s",
        "ev.attempt_id=%s",
        "ev.payload_hash=%s",
        "ev.revoked_at IS NULL",
        "at.state='active'",
    ]
    params: list[Any] = [
        username,
        event_id,
        scope["account_id"],
        assignment_id,
        attempt_id,
        payload_sha256,
    ]
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
            " JOIN experiment_attempts at ON at.id=ev.attempt_id"
            f" WHERE {' AND '.join(clauses)}",
            tuple(params),
        ).fetchone()
        is not None
    )


def _valid_evidence_event_ids_in_conn(
    c: psycopg.Connection[dict[str, Any]],
    username: str,
    checks: list[dict[str, Any]],
    *,
    manifest_id: str,
    scope: dict[str, Any] | None = None,
) -> set[str]:
    """一次确认当前 attempt 下的一组可信收据事件。

    完成度最多需要核对 15 道题。逐题调用 ``evidence_event_exists`` 会逐题
    重新解析 assignment/attempt，并在真实课堂库上放大成数秒延迟。这里先解析
    一次当前作用域，再按事件主键批量读取；每一行仍逐字段核对账号、作业、
    attempt、步骤、类型、manifest 和 payload 摘要，不放宽防重放边界。
    """
    if not checks:
        return set()
    current = scope or _attempt_scope(c, username, manifest_id, create=False)
    if (
        not current
        or current.get("attempt_id") is None
        or (current.get("assignment_manifest_id") and current.get("assignment_manifest_id") != manifest_id)
    ):
        return set()

    expected: dict[str, dict[str, Any]] = {}
    conflicts: set[str] = set()
    for raw in checks:
        try:
            event_uuid = uuid.UUID(str(raw["event_id"]))
            check: dict[str, Any] = {
                "event_id": str(event_uuid),
                "account_id": int(raw["account_id"]),
                "assignment_id": int(raw["assignment_id"]),
                "attempt_id": int(raw["attempt_id"]),
                "payload_sha256": str(raw["payload_sha256"]),
                "step": int(raw["step"]),
                "kind": str(raw["kind"]),
                "manifest_id": str(raw["manifest_id"]),
            }
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        if (
            check["account_id"] != current.get("account_id")
            or check["assignment_id"] != current.get("assignment_id")
            or check["attempt_id"] != current.get("attempt_id")
            or check["manifest_id"] != manifest_id
        ):
            continue
        event_id = str(check["event_id"])
        if event_id in conflicts:
            continue
        previous = expected.get(event_id)
        if previous is not None and previous != check:
            expected.pop(event_id, None)
            conflicts.add(event_id)
            continue
        expected[event_id] = check
    if not expected:
        return set()

    rows = c.execute(
        "SELECT ev.id::text AS event_id,ev.account_id,ev.assignment_id,ev.attempt_id,"
        " ev.step,ev.kind,ev.manifest_id,ev.payload_hash"
        " FROM learning_evidence_events ev JOIN accounts a ON a.id=ev.account_id"
        " JOIN experiment_attempts at ON at.id=ev.attempt_id"
        " WHERE ev.id=ANY(%s) AND a.username=%s AND ev.account_id=%s"
        " AND ev.assignment_id=%s AND ev.attempt_id=%s"
        " AND EXISTS (SELECT 1 FROM student_assignment_selections sel"
        "   WHERE sel.account_id=ev.account_id AND sel.assignment_id=ev.assignment_id)"
        " AND ev.revoked_at IS NULL AND at.state='active'",
        (
            [uuid.UUID(event_id) for event_id in expected],
            username,
            current["account_id"],
            current["assignment_id"],
            current["attempt_id"],
        ),
    ).fetchall()
    valid: set[str] = set()
    for row in rows:
        event_id = str(row["event_id"])
        expected_check = expected.get(event_id)
        if expected_check and all(
            (
                row["account_id"] == expected_check["account_id"],
                row["assignment_id"] == expected_check["assignment_id"],
                row["attempt_id"] == expected_check["attempt_id"],
                row["step"] == expected_check["step"],
                row["kind"] == expected_check["kind"],
                row["manifest_id"] == expected_check["manifest_id"],
                row["payload_hash"] == expected_check["payload_sha256"],
            )
        ):
            valid.add(event_id)
    return valid


def valid_evidence_event_ids(
    username: str,
    checks: list[dict[str, Any]],
    *,
    manifest_id: str,
    scope: dict[str, Any] | None = None,
    connection: psycopg.Connection[dict[str, Any]] | None = None,
) -> set[str]:
    """批量确认事件；可复用调用方同一事务中解析出的可信 scope。"""
    if connection is not None:
        return _valid_evidence_event_ids_in_conn(
            connection,
            username,
            checks,
            manifest_id=manifest_id,
            scope=scope,
        )
    with database.conn() as c:
        return _valid_evidence_event_ids_in_conn(
            c,
            username,
            checks,
            manifest_id=manifest_id,
            scope=scope,
        )


def evidence_event_exists(
    username: str,
    event_id: str,
    assignment_id: int,
    attempt_id: int,
    payload_sha256: str,
    *,
    account_id: int | None = None,
    step: int | None = None,
    kind: str | None = None,
    manifest_id: str | None = None,
    connection: psycopg.Connection[dict[str, Any]] | None = None,
) -> bool:
    """确认事件属于学生**当前**解析出的 assignment/attempt。

    仅检查 token 自称的旧 attempt 仍为 ``active`` 不够：教师发布同一 manifest
    的新 assignment 时，旧 assignment 的 attempt 不会自动归档。若不再核对当前
    scope，旧收据可被复制到新作业。这里同时核对事件的教学语义字段，quiz 与
    regression 共用这一道不可跨作业重放的边界。
    """
    if connection is not None:
        return _evidence_event_exists_in_conn(
            connection,
            username,
            event_id,
            assignment_id,
            attempt_id,
            payload_sha256,
            account_id=account_id,
            step=step,
            kind=kind,
            manifest_id=manifest_id,
        )
    with database.conn() as c:
        return _evidence_event_exists_in_conn(
            c,
            username,
            event_id,
            assignment_id,
            attempt_id,
            payload_sha256,
            account_id=account_id,
            step=step,
            kind=kind,
            manifest_id=manifest_id,
        )
