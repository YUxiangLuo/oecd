"""Teacher-owned courses, classes, enrollments, students, and overview queries."""

import secrets
from typing import Any

import psycopg


class _DatabaseProxy:
    """Resolve the compatibility facade lazily, after ``classroom.db`` finishes importing."""

    def __getattr__(self, name: str) -> Any:
        from gvcsim.classroom import db

        return getattr(db, name)


database = _DatabaseProxy()


def _teacher_course_ids(c: psycopg.Connection[dict[str, Any]], username: str) -> list[int]:
    return [
        row["course_run_id"]
        for row in c.execute(
            "SELECT tca.course_run_id FROM teacher_course_access tca"
            " JOIN accounts a ON a.id=tca.teacher_account_id"
            " WHERE a.username=%s AND a.role='teacher' AND a.active AND tca.can_manage",
            (username,),
        ).fetchall()
    ]


def teacher_can_access_class(username: str, class_id: int) -> bool:
    with database.conn() as c:
        return (
            c.execute(
                "SELECT 1 FROM teacher_course_access tca JOIN accounts a ON a.id=tca.teacher_account_id"
                " JOIN course_class_links l ON l.course_run_id=tca.course_run_id"
                " WHERE a.username=%s AND a.active AND l.class_id=%s AND tca.can_manage",
                (username, class_id),
            ).fetchone()
            is not None
        )


def list_course_runs(teacher_username: str) -> list[dict[str, Any]]:
    with database.conn() as c:
        return c.execute(
            "SELECT cr.* FROM course_runs cr JOIN teacher_course_access tca ON tca.course_run_id=cr.id"
            " JOIN accounts t ON t.id=tca.teacher_account_id"
            " WHERE t.username=%s AND t.role='teacher' AND t.active AND tca.can_manage"
            " ORDER BY cr.created_at DESC",
            (teacher_username,),
        ).fetchall()


def create_course_run(
    teacher_username: str, name: str, code: str, term: str = "", release_tag: str = ""
) -> dict[str, Any]:
    with database.conn() as c:
        teacher = c.execute(
            "SELECT id FROM accounts WHERE username=%s AND role='teacher' AND active", (teacher_username,)
        ).fetchone()
        if not teacher:
            raise PermissionError("教师账号无效")
        row = database._required(
            c.execute(
                "INSERT INTO course_runs(name,code,term,release_tag) VALUES (%s,%s,%s,%s) RETURNING *",
                (name, code, term, release_tag),
            ).fetchone(),
            "create course run",
        )
        c.execute(
            "INSERT INTO teacher_course_access(teacher_account_id,course_run_id) VALUES (%s,%s)",
            (teacher["id"], row["id"]),
        )
        return row


def set_course_run_archived(teacher_username: str, course_run_id: int, archived: bool) -> dict | None:
    with database.conn() as c:
        if course_run_id not in _teacher_course_ids(c, teacher_username):
            return None
        return c.execute(
            "UPDATE course_runs SET archived=%s WHERE id=%s RETURNING *", (archived, course_run_id)
        ).fetchone()


def list_assignments(teacher_username: str, course_run_id: int | None = None) -> list[dict[str, Any]]:
    with database.conn() as c:
        ids = _teacher_course_ids(c, teacher_username)
        if course_run_id is not None:
            ids = [course_run_id] if course_run_id in ids else []
        if not ids:
            return []
        return c.execute(
            "SELECT ass.*,cr.code AS course_run_code,cr.name AS course_run_name"
            " FROM assignments ass JOIN course_runs cr ON cr.id=ass.course_run_id"
            " WHERE ass.course_run_id=ANY(%s) ORDER BY ass.created_at DESC",
            (ids,),
        ).fetchall()


def create_assignment(
    teacher_username: str,
    course_run_id: int,
    slug: str,
    title: str,
    manifest_id: str,
    release_tag: str = "",
    opens_at: Any = None,
    due_at: Any = None,
) -> dict[str, Any]:
    if not manifest_id:
        raise ValueError("assignment 必须固定 manifest_id")
    if opens_at is not None and due_at is not None:
        try:
            invalid_window = due_at <= opens_at
        except TypeError as error:
            raise ValueError("opens_at 与 due_at 必须使用一致的时区格式") from error
        if invalid_window:
            raise ValueError("due_at 必须晚于 opens_at")
    with database.conn() as c:
        if course_run_id not in _teacher_course_ids(c, teacher_username):
            raise PermissionError("教师无权管理该课程运行")
        row = c.execute(
            "INSERT INTO assignments(course_run_id,slug,title,manifest_id,release_tag,opens_at,due_at)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *",
            (course_run_id, slug, title, manifest_id, release_tag, opens_at, due_at),
        ).fetchone()
    assert row is not None
    return row


def set_assignment_active(teacher_username: str, assignment_id: int, active: bool) -> dict | None:
    with database.conn() as c:
        return c.execute(
            "UPDATE assignments ass SET active=%s FROM teacher_course_access tca"
            " JOIN accounts t ON t.id=tca.teacher_account_id"
            " WHERE ass.id=%s AND tca.course_run_id=ass.course_run_id"
            " AND t.username=%s AND t.active AND tca.can_manage RETURNING ass.*",
            (active, assignment_id, teacher_username),
        ).fetchone()


def enroll_student(
    teacher_username: str, course_run_id: int, account_id: int, class_id: int | None = None
) -> dict[str, Any]:
    with database.conn() as c:
        if course_run_id not in _teacher_course_ids(c, teacher_username):
            raise PermissionError("教师无权管理该课程运行")
        student = c.execute("SELECT id,class_id FROM accounts WHERE id=%s AND role='student'", (account_id,)).fetchone()
        if not student:
            raise ValueError("学生账号不存在")
        target_class = class_id if class_id is not None else student["class_id"]
        if target_class is not None:
            if not c.execute(
                "SELECT 1 FROM course_class_links l JOIN teacher_course_access tca"
                " ON tca.course_run_id=l.course_run_id JOIN accounts t ON t.id=tca.teacher_account_id"
                " WHERE l.class_id=%s AND t.username=%s AND t.active AND tca.can_manage",
                (target_class, teacher_username),
            ).fetchone():
                raise PermissionError("教师无权将该班级关联到课程运行")
            c.execute(
                "INSERT INTO course_class_links(course_run_id,class_id) VALUES (%s,%s) ON CONFLICT DO NOTHING",
                (course_run_id, target_class),
            )
        row = c.execute(
            "INSERT INTO enrollments(course_run_id,account_id,class_id) VALUES (%s,%s,%s)"
            " ON CONFLICT (course_run_id,account_id) DO UPDATE SET class_id=EXCLUDED.class_id,active=true"
            " RETURNING *",
            (course_run_id, account_id, target_class),
        ).fetchone()
    assert row is not None
    return row


def list_enrollments(teacher_username: str, course_run_id: int) -> list[dict[str, Any]]:
    """返回课程运行的持久 enrollment 真值；只允许获授权教师读取。"""
    with database.conn() as c:
        if course_run_id not in _teacher_course_ids(c, teacher_username):
            raise PermissionError("教师无权查看该课程运行的 enrollment")
        return c.execute(
            "SELECT e.id AS enrollment_id,e.course_run_id,e.account_id,e.class_id,e.active,e.enrolled_at,"
            " a.username,a.display_name,a.student_no,a.active AS account_active,cl.name AS class_name"
            " FROM enrollments e JOIN accounts a ON a.id=e.account_id"
            " LEFT JOIN classes cl ON cl.id=e.class_id WHERE e.course_run_id=%s"
            " ORDER BY a.student_no,a.username,e.id",
            (course_run_id,),
        ).fetchall()


def start_new_attempt(
    username: str,
    manifest_id: str,
    *,
    expected_assignment_id: int | None = None,
    expected_attempt_id: int | None = None,
) -> dict[str, Any]:
    """显式归档当前尝试并创建下一次；既有答题、运行、提交和评分保持不可变。"""
    with database.conn() as c:
        with c.transaction():
            scope = database._attempt_scope(c, username, manifest_id)
            if not scope or scope.get("manifest_mismatch") or scope["attempt_id"] is None:
                raise database.AssignmentScopeMismatch("没有与当前 manifest 匹配的开放作业")
            attempt_id = scope["attempt_id"]
            c.execute("SELECT pg_advisory_xact_lock(%s, %s)", (database._SESSION_LOCK_NS, attempt_id))
            locked_scope = database._attempt_scope(c, username, manifest_id, create=False)
            if (
                not locked_scope
                or locked_scope.get("manifest_mismatch")
                or locked_scope["assignment_id"] != scope["assignment_id"]
                or locked_scope["attempt_id"] != attempt_id
                or (expected_assignment_id is not None and locked_scope["assignment_id"] != expected_assignment_id)
                or (expected_attempt_id is not None and locked_scope["attempt_id"] != expected_attempt_id)
            ):
                raise database.AssignmentScopeMismatch("当前作业 attempt 已变化；请刷新页面后重试")
            scope = locked_scope
            database._require_assignment_writable(scope)
            archived = c.execute(
                "UPDATE experiment_attempts SET state='archived',updated_at=now()"
                " WHERE id=%s AND state='active' RETURNING id",
                (scope["attempt_id"],),
            ).fetchone()
            if archived is None:
                raise database.AssignmentScopeMismatch("当前作业 attempt 已变化；请刷新页面后重试")
            next_no = database._required(
                c.execute(
                    "SELECT coalesce(max(attempt_no),0)+1 AS n FROM experiment_attempts"
                    " WHERE assignment_id=%s AND enrollment_id=%s",
                    (scope["assignment_id"], scope["enrollment_id"]),
                ).fetchone(),
                "next explicit attempt number",
            )["n"]
            created = database._required(
                c.execute(
                    "INSERT INTO experiment_attempts(assignment_id,enrollment_id,attempt_no)"
                    " VALUES (%s,%s,%s) RETURNING id,attempt_no,state",
                    (scope["assignment_id"], scope["enrollment_id"], next_no),
                ).fetchone(),
                "start explicit attempt",
            )
            return {
                **scope,
                "attempt_id": created["id"],
                "attempt_no": created["attempt_no"],
                "attempt_state": created["state"],
                "assignment_scope": (
                    f"course:{scope['course_run_id']}/assignment:{scope['assignment_id']}/attempt:{created['id']}"
                ),
            }


# ---------------------------------------------------------------- 班级与学生


def list_classes(teacher_username: str | None = None) -> list[dict[str, Any]]:
    with database.conn() as c:
        where = ""
        params: tuple[Any, ...] = ()
        if teacher_username:
            where = (
                " JOIN course_class_links l ON l.class_id=cl.id"
                " JOIN teacher_course_access tca ON tca.course_run_id=l.course_run_id"
                " JOIN accounts t ON t.id=tca.teacher_account_id"
                " WHERE t.username=%s AND t.active AND tca.can_manage"
            )
            params = (teacher_username,)
        return c.execute(
            "SELECT cl.*, count(DISTINCT a.id) AS student_count FROM classes cl"
            " LEFT JOIN accounts a ON a.class_id = cl.id AND a.role = 'student'"
            f" {where} GROUP BY cl.id ORDER BY cl.id",
            params,
        ).fetchall()


def create_class(
    name: str, code: str, semester: str = "", note: str = "", teacher_username: str | None = None
) -> dict[str, Any]:
    with database.conn() as c:
        row = database._required(
            c.execute(
                "INSERT INTO classes(name, code, semester, note) VALUES (%s, %s, %s, %s) RETURNING *",
                (name, code, semester, note),
            ).fetchone(),
            "create class",
        )
        if teacher_username:
            run = c.execute(
                "SELECT tca.course_run_id FROM teacher_course_access tca JOIN accounts a"
                " ON a.id=tca.teacher_account_id WHERE a.username=%s AND tca.can_manage"
                " ORDER BY tca.course_run_id LIMIT 1",
                (teacher_username,),
            ).fetchone()
            if run is None:
                raise PermissionError("教师没有可管理的课程运行")
            c.execute(
                "INSERT INTO course_class_links(course_run_id,class_id) VALUES (%s,%s)",
                (run["course_run_id"], row["id"]),
            )
    return row


_STUDENT_COLS = "a.id, a.username, a.display_name, a.class_id, a.student_no, a.active, a.last_login_at, a.created_at"


def list_students(class_id: int | None = None, teacher_username: str | None = None) -> list[dict[str, Any]]:
    """学生列表,联进度与提交状态(教师面板的进度矩阵数据)。"""
    clauses = ["a.role = 'student'"]
    params: list[Any] = []
    if class_id is not None:
        clauses.append("a.class_id = %s")
        params.append(class_id)
    scope_join = ""
    if teacher_username:
        clauses.append(
            "EXISTS (SELECT 1 FROM course_class_links acl"
            " JOIN teacher_course_access tca ON tca.course_run_id=acl.course_run_id"
            " JOIN accounts teacher ON teacher.id=tca.teacher_account_id"
            " WHERE acl.class_id=a.class_id AND teacher.username=%s"
            " AND teacher.active AND tca.can_manage)"
        )
        params.append(teacher_username)
    where = "WHERE " + " AND ".join(clauses)
    with database.conn() as c:
        course_ids = _teacher_course_ids(c, teacher_username) if teacher_username else None
        submission_scope = ""
        query_params: list[Any] = []
        if course_ids is not None:
            # 班级可以被多个课程/教师共享；“最新提交”必须限定到当前教师获授权
            # 的 course_run，不能把另一门课的成绩或 attempt id 泄露到本面板。
            submission_scope = (
                " JOIN experiment_attempts sat ON sat.id=sx.attempt_id"
                " JOIN assignments sass ON sass.id=sat.assignment_id"
                " WHERE sx.account_id=a.id AND sass.course_run_id=ANY(%s)"
            )
            query_params.append(course_ids)
        else:
            submission_scope = " WHERE sx.account_id=a.id"
        query_params.extend(params)
        rows = c.execute(
            f"SELECT {_STUDENT_COLS}, cl.name AS class_name,"
            " p.current_step, p.max_step, p.updated_at AS progress_at,"
            " s.id AS submission_id, s.state AS submission_state, s.score, s.submitted_at"
            " FROM accounts a"
            f" {scope_join}"
            " LEFT JOIN classes cl ON cl.id = a.class_id"
            " LEFT JOIN step_progress p ON p.account_id = a.id"
            f" LEFT JOIN LATERAL (SELECT sx.* FROM submissions sx{submission_scope}"
            "  ORDER BY sx.submitted_at DESC LIMIT 1) s ON true"
            f" {where} ORDER BY a.class_id NULLS LAST, a.student_no, a.username",
            tuple(query_params),
        ).fetchall()
        for row in rows:
            row.update(_learning_status_in_conn(c, row["username"], course_ids))
        return rows


def _learning_status_in_conn(
    c: psycopg.Connection[dict[str, Any]], username: str, course_run_ids: list[int] | None = None
) -> dict[str, Any]:
    """教师端统一的“到达 vs 服务端验证完成”契约。"""
    from gvcsim import evidence

    scope = database._attempt_scope(c, username, create=False, course_run_ids=course_run_ids)
    result: dict[str, Any] = {
        "verified_completed_count": 0,
        "verified_completed_steps": [],
        "completion_missing": list(range(1, database.MAX_STEP + 1)),
        "session_stale": False,
        "legacy_unverified": False,
        "last_valid_activity": None,
        "course_run_id": None,
        "assignment_id": None,
        "attempt_id": None,
        "current_step": None,
        "max_step": None,
        "progress_at": None,
    }
    if not scope or scope["attempt_id"] is None:
        return result
    result.update(
        {
            "course_run_id": scope["course_run_id"],
            "assignment_id": scope["assignment_id"],
            "attempt_id": scope["attempt_id"],
        }
    )
    session = c.execute(
        "SELECT session,manifest_id,legacy_unverified,updated_at FROM attempt_sessions WHERE attempt_id=%s",
        (scope["attempt_id"],),
    ).fetchone()
    progress = c.execute(
        "SELECT current_step,max_step,updated_at FROM attempt_step_progress WHERE attempt_id=%s",
        (scope["attempt_id"],),
    ).fetchone()
    if progress:
        result.update(
            {
                "current_step": progress["current_step"],
                "max_step": progress["max_step"],
                "progress_at": progress["updated_at"],
            }
        )
    activity = c.execute(
        "SELECT max(ts) AS ts FROM ("
        " SELECT updated_at AS ts FROM attempt_step_progress WHERE attempt_id=%s"
        " UNION ALL SELECT updated_at FROM attempt_sessions WHERE attempt_id=%s"
        " UNION ALL SELECT created_at FROM learning_evidence_events"
        "  WHERE attempt_id=%s AND revoked_at IS NULL) q",
        (scope["attempt_id"], scope["attempt_id"], scope["attempt_id"]),
    ).fetchone()
    result["last_valid_activity"] = activity["ts"] if activity else None
    if session is None:
        return result
    result["legacy_unverified"] = session["legacy_unverified"]
    result["session_stale"] = bool(
        scope["assignment_manifest_id"] and session["manifest_id"] != scope["assignment_manifest_id"]
    )
    if result["legacy_unverified"] or result["session_stale"]:
        return result
    try:
        summary = evidence.completion_summary(
            session["session"],
            subject=username,
            require_trusted=True,
            connection=c,
        )
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
        row = database._required(
            c.execute(
                "INSERT INTO accounts(username, display_name, role, class_id, student_no, pw_salt, pw_hash,"
                " pw_algorithm, pw_iterations)"
                f" VALUES (%s, %s, 'student', %s, %s, %s, %s, %s, %s)"
                f" RETURNING {_STUDENT_COLS.replace('a.', '')}",
                (
                    username,
                    display_name,
                    class_id,
                    student_no,
                    salt,
                    database.hash_password(password, salt),
                    database.PASSWORD_ALGORITHM,
                    database.PASSWORD_ITERATIONS,
                ),
            ).fetchone(),
            "create student",
        )
        if class_id is not None:
            if (
                teacher_username
                and not c.execute(
                    "SELECT 1 FROM course_class_links l JOIN teacher_course_access tca"
                    " ON tca.course_run_id=l.course_run_id JOIN accounts t ON t.id=tca.teacher_account_id"
                    " WHERE l.class_id=%s AND t.username=%s AND tca.can_manage",
                    (class_id, teacher_username),
                ).fetchone()
            ):
                raise PermissionError("教师无权管理该班级")
            c.execute(
                "INSERT INTO enrollments(course_run_id,account_id,class_id)"
                " SELECT course_run_id,%s,%s FROM course_class_links WHERE class_id=%s"
                " ON CONFLICT (course_run_id,account_id) DO NOTHING",
                (row["id"], class_id, class_id),
            )
    return row


def update_student(
    account_id: int, fields: dict[str, Any], teacher_username: str | None = None
) -> dict[str, Any] | None:
    """部分更新:display_name / student_no / class_id / active / password(重设密码)。"""
    sets, params = [], []
    for key in ("display_name", "student_no", "class_id", "active"):
        if key in fields:
            sets.append(f"{key} = %s")
            params.append(fields[key])
    security_changed = bool(fields.get("password")) or fields.get("active") is False
    if fields.get("password"):
        database._validate_managed_password(fields["password"])
        salt = secrets.token_hex(16)
        sets += ["pw_salt = %s", "pw_hash = %s", "pw_algorithm = %s", "pw_iterations = %s"]
        params += [
            salt,
            database.hash_password(fields["password"], salt),
            database.PASSWORD_ALGORITHM,
            database.PASSWORD_ITERATIONS,
        ]
    if not sets:
        return None
    with database.conn() as c:
        if teacher_username:
            allowed = c.execute(
                "SELECT 1 FROM accounts student JOIN course_class_links l ON l.class_id=student.class_id"
                " JOIN teacher_course_access tca ON tca.course_run_id=l.course_run_id"
                " JOIN accounts teacher ON teacher.id=tca.teacher_account_id"
                " WHERE student.id=%s AND teacher.username=%s AND teacher.active AND tca.can_manage",
                (account_id, teacher_username),
            ).fetchone()
            if not allowed:
                return None
            if (
                fields.get("class_id") is not None
                and not c.execute(
                    "SELECT 1 FROM course_class_links l JOIN teacher_course_access tca"
                    " ON tca.course_run_id=l.course_run_id JOIN accounts teacher"
                    " ON teacher.id=tca.teacher_account_id WHERE l.class_id=%s"
                    " AND teacher.username=%s AND teacher.active AND tca.can_manage",
                    (fields["class_id"], teacher_username),
                ).fetchone()
            ):
                return None
        if security_changed:
            sets.append("auth_version = auth_version + 1")
        updated = c.execute(
            f"UPDATE accounts SET {', '.join(sets)} WHERE id = %s AND role = 'student'"
            f" RETURNING {_STUDENT_COLS.replace('a.', '')}",
            (*params, account_id),
        ).fetchone()
        if updated and security_changed:
            c.execute(
                "UPDATE auth_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE account_id=%s", (account_id,)
            )
        if updated and "class_id" in fields:
            c.execute("UPDATE enrollments SET class_id=%s WHERE account_id=%s", (fields["class_id"], account_id))
        return updated


# ---------------------------------------------------------------- 概览统计


def overview_stats(class_id: int | None = None, teacher_username: str | None = None) -> dict[str, Any]:
    """教师概览:人数/提交/评分统计 + 分数段 + 各步到达率。"""
    clauses = ["a.role = 'student'"]
    params_list: list[Any] = []
    if class_id is not None:
        clauses.append("a.class_id=%s")
        params_list.append(class_id)
    if teacher_username:
        clauses.append(
            "EXISTS (SELECT 1 FROM course_class_links l JOIN teacher_course_access tca"
            " ON tca.course_run_id=l.course_run_id JOIN accounts t ON t.id=tca.teacher_account_id"
            " WHERE l.class_id=a.class_id AND t.username=%s AND t.active AND tca.can_manage)"
        )
        params_list.append(teacher_username)
    where = " AND ".join(clauses)
    params = tuple(params_list)
    with database.conn() as c:
        course_ids = _teacher_course_ids(c, teacher_username) if teacher_username else None
        latest_submission_scope = " WHERE sx.account_id=a.id"
        latest_submission_params: tuple[Any, ...] = ()
        submission_course_join = ""
        submission_course_where = ""
        if course_ids is not None:
            latest_submission_scope = (
                " JOIN experiment_attempts sat ON sat.id=sx.attempt_id"
                " JOIN assignments sass ON sass.id=sat.assignment_id"
                " WHERE sx.account_id=a.id AND sass.course_run_id=ANY(%s)"
            )
            latest_submission_params = (course_ids,)
            submission_course_join = (
                " JOIN experiment_attempts sat ON sat.id=s.attempt_id"
                " JOIN assignments sass ON sass.id=sat.assignment_id"
            )
            submission_course_where = " AND sass.course_run_id=ANY(%s)"
        base = database._required(
            c.execute(
                "SELECT count(*) AS student_count,"
                " count(*) FILTER (WHERE NOT a.active) AS disabled_count,"
                " count(s.id) AS submitted,"
                " count(s.id) FILTER (WHERE s.state = 'graded') AS graded,"
                " round(avg(s.score) FILTER (WHERE s.state = 'graded'), 1) AS avg_score"
                " FROM accounts a LEFT JOIN LATERAL (SELECT sx.* FROM submissions sx"
                f"  {latest_submission_scope} ORDER BY sx.submitted_at DESC LIMIT 1) s ON true"
                f" WHERE {where}",
                (*latest_submission_params, *params),
            ).fetchone(),
            "overview base",
        )
        buckets = database._required(
            c.execute(
                "SELECT coalesce(count(*) FILTER (WHERE s.score < 60), 0) AS b0,"
                " count(*) FILTER (WHERE s.score BETWEEN 60 AND 69) AS b60,"
                " count(*) FILTER (WHERE s.score BETWEEN 70 AND 79) AS b70,"
                " count(*) FILTER (WHERE s.score BETWEEN 80 AND 89) AS b80,"
                " count(*) FILTER (WHERE s.score >= 90) AS b90"
                " FROM submissions s JOIN accounts a ON a.id = s.account_id"
                f" {submission_course_join}"
                f" WHERE s.state = 'graded' AND {where}{submission_course_where}",
                (*params, *((course_ids,) if course_ids is not None else ())),
            ).fetchone(),
            "overview score buckets",
        )
        # 近 14 天每日提交/评阅计数(补零到完整日历序列,便于前端画趋势)
        trend = c.execute(
            "SELECT to_char(gs.d, 'MM-DD') AS date,"
            "  (SELECT count(*) FROM submissions s JOIN accounts a ON a.id = s.account_id"
            f"   {submission_course_join} WHERE {where} AND s.submitted_at::date = gs.d"
            f"   {submission_course_where}) AS submitted,"
            "  (SELECT count(*) FROM submissions s JOIN accounts a ON a.id = s.account_id"
            f"   {submission_course_join} WHERE {where} AND s.graded_at::date = gs.d"
            f"   {submission_course_where}) AS graded"
            " FROM generate_series(now()::date - 13, now()::date, interval '1 day') AS gs(d)"
            " ORDER BY gs.d",
            (
                *params,
                *((course_ids,) if course_ids is not None else ()),
                *params,
                *((course_ids,) if course_ids is not None else ()),
            ),
        ).fetchall()
        # 近 7 天有进度上报的活跃学生数
        active_course_where = " AND ass.course_run_id=ANY(%s)" if course_ids is not None else ""
        active = database._required(
            c.execute(
                "SELECT count(DISTINCT a.id) AS n FROM attempt_step_progress p"
                " JOIN experiment_attempts at ON at.id=p.attempt_id"
                " JOIN assignments ass ON ass.id=at.assignment_id"
                " JOIN enrollments e ON e.id=at.enrollment_id"
                " JOIN accounts a ON a.id=e.account_id"
                f" WHERE {where} AND p.updated_at >= now() - interval '7 days'{active_course_where}",
                (*params, *((course_ids,) if course_ids is not None else ())),
            ).fetchone(),
            "overview activity",
        )
        # 各班对比(与 class_id 过滤无关,始终按全部班级分组)
        class_scope = ""
        class_params: tuple[Any, ...] = ()
        if teacher_username:
            class_scope = (
                " WHERE EXISTS (SELECT 1 FROM course_class_links l JOIN teacher_course_access tca"
                " ON tca.course_run_id=l.course_run_id JOIN accounts t ON t.id=tca.teacher_account_id"
                " WHERE l.class_id=cl.id AND t.username=%s AND t.active AND tca.can_manage)"
            )
            class_params = (teacher_username,)
        by_class = c.execute(
            "SELECT cl.id AS class_id, cl.name,"
            " count(a.id) AS student_count,"
            " count(s.id) AS submitted,"
            " count(s.id) FILTER (WHERE s.state = 'graded') AS graded,"
            " round(avg(s.score) FILTER (WHERE s.state = 'graded'), 1) AS avg_score"
            " FROM classes cl"
            " LEFT JOIN accounts a ON a.class_id = cl.id AND a.role = 'student'"
            " LEFT JOIN LATERAL (SELECT sx.* FROM submissions sx"
            f"  {latest_submission_scope} ORDER BY sx.submitted_at DESC LIMIT 1) s ON true"
            f" {class_scope} GROUP BY cl.id, cl.name ORDER BY cl.id",
            (*latest_submission_params, *class_params),
        ).fetchall()
    student_rows = list_students(class_id, teacher_username)
    step_completion = [
        {"step": n, "completed": sum(n in row["verified_completed_steps"] for row in student_rows)}
        for n in range(1, database.MAX_STEP + 1)
    ]
    step_reach = [
        {"step": n, "reached": sum((row.get("max_step") or 0) >= n for row in student_rows)}
        for n in range(1, database.MAX_STEP + 1)
    ]
    return {
        "student_count": base["student_count"],
        "disabled_count": base["disabled_count"],
        "submitted": base["submitted"],
        "graded": base["graded"],
        "avg_score": float(base["avg_score"]) if base["avg_score"] is not None else None,
        "score_buckets": [
            {"label": "<60", "count": buckets["b0"]},
            {"label": "60-69", "count": buckets["b60"]},
            {"label": "70-79", "count": buckets["b70"]},
            {"label": "80-89", "count": buckets["b80"]},
            {"label": "90+", "count": buckets["b90"]},
        ],
        "step_reach": step_reach,
        "step_completion": step_completion,
        "active_7d": active["n"],
        "submission_trend": [{"date": r["date"], "submitted": r["submitted"], "graded": r["graded"]} for r in trend],
        "class_breakdown": [
            {
                "class_id": r["class_id"],
                "name": r["name"],
                "student_count": r["student_count"],
                "submitted": r["submitted"],
                "graded": r["graded"],
                "avg_score": float(r["avg_score"]) if r["avg_score"] is not None else None,
            }
            for r in by_class
        ],
    }
