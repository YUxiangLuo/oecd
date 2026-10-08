"""PostgreSQL connection and the small classroom data facade."""

from __future__ import annotations

import atexit
import hashlib
import hmac
import secrets
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolClosed, PoolTimeout, TooManyRequests

from gvcsim import config, demo_accounts
from gvcsim.classroom import schema

MAX_STEP = 15
TEACHING_DB_VERSION = schema.TEACHING_DB_VERSION


class Unavailable(Exception):
    pass


class OperationFailed(Unavailable):
    def __init__(self, reason: str, sqlstate: str | None):
        self.reason = reason
        self.sqlstate = sqlstate
        super().__init__("教学数据库操作失败，请稍后重试")


class SchemaVersionMismatch(RuntimeError):
    pass


def hash_password(password: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 100_000).hex()


def _validate_managed_password(password: str) -> None:
    if not 12 <= len(password) <= 256:
        raise ValueError("口令必须为 12..256 个字符")
    if not password.strip():
        raise ValueError("口令不能全是空白字符")


def _required(row: dict[str, Any] | None, operation: str) -> dict[str, Any]:
    if row is None:
        raise RuntimeError(f"数据库操作未返回预期行:{operation}")
    return row


_schema_ready = False
_startup_sealed = False
_pool: ConnectionPool[psycopg.Connection[dict[str, Any]]] | None = None
_pool_lock = threading.RLock()


def _connect() -> psycopg.Connection[dict[str, Any]]:
    if not config.PG_DSN:
        raise Unavailable("缺少 GVCSIM_PG_DSN")
    try:
        return psycopg.connect(config.PG_DSN, row_factory=dict_row, connect_timeout=3, application_name="gvcsim")
    except psycopg.OperationalError as error:
        raise Unavailable(str(error)) from error


def _get_pool() -> ConnectionPool[psycopg.Connection[dict[str, Any]]]:
    global _pool
    if not config.PG_DSN:
        raise Unavailable("缺少 GVCSIM_PG_DSN")
    with _pool_lock:
        if _pool is not None and not _pool.closed:
            return _pool
        try:
            _pool = ConnectionPool(
                conninfo=config.PG_DSN,
                min_size=1,
                max_size=8,
                timeout=5,
                kwargs={"row_factory": dict_row, "connect_timeout": 3, "application_name": "gvcsim-api"},
                open=True,
                name="gvcsim",
            )
        except (ValueError, psycopg.Error) as error:
            raise Unavailable(str(error)) from error
        return _pool


def close_pool() -> None:
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.close()
        _pool = None


def shutdown() -> None:
    global _startup_sealed
    _startup_sealed = False
    close_pool()


def initialize_schema() -> list[str]:
    global _schema_ready
    if _startup_sealed:
        raise RuntimeError("服务运行期间不能初始化 schema")
    close_pool()
    c = _connect()
    applied: list[str] = []
    try:
        with c:
            schema.lock_schema(c)
            version = schema.existing_version(c)
            if version not in {None, "gvcsim-teaching-db-v11", TEACHING_DB_VERSION}:
                raise SchemaVersionMismatch(
                    f"教学库 schema 版本为 {version}，当前代码需要 {TEACHING_DB_VERSION}；"
                    "请停止服务并执行经过测试的兼容迁移；"
                    "不能用 `uv run gvcsim classroom-init --reset` 代替普通升级，"
                    "只有完成备份后的新学期清场才允许 reset"
                )
            if version is None:
                c.execute(schema.SCHEMA_SQL)
                c.execute("INSERT INTO schema_meta(singleton,version) VALUES (true,%s)", (TEACHING_DB_VERSION,))
                applied.append(f"创建 schema {TEACHING_DB_VERSION}")
            elif version == "gvcsim-teaching-db-v11":
                c.execute(schema.MIGRATION_V11_TO_V12_SQL)
                applied.append("迁移 schema gvcsim-teaching-db-v11 → gvcsim-teaching-db-v12")
            synced = _sync_demo_accounts(c)
            if synced["created"] or synced["updated"]:
                applied.append(f"同步演示账号(created={synced['created']},updated={synced['updated']})")
    finally:
        c.close()
    _schema_ready = True
    return applied


def verify_schema() -> dict[str, str]:
    global _schema_ready
    c = _connect()
    try:
        with c:
            version = schema.existing_version(c)
            if version != TEACHING_DB_VERSION:
                raise SchemaVersionMismatch(
                    f"教学库 schema 版本为 {version or '未初始化'}，当前代码需要 {TEACHING_DB_VERSION}"
                )
    finally:
        c.close()
    _schema_ready = True
    return {"status": "ok", "schema_version": TEACHING_DB_VERSION}


def startup() -> None:
    global _startup_sealed
    if not _schema_ready:
        verify_schema()
    try:
        _get_pool().wait(timeout=5)
    except (PoolTimeout, PoolClosed, psycopg.OperationalError) as error:
        close_pool()
        raise Unavailable(str(error)) from error
    _startup_sealed = True


@contextmanager
def conn() -> Iterator[psycopg.Connection[dict[str, Any]]]:
    if not _schema_ready:
        if _startup_sealed:
            raise Unavailable("schema 未就绪")
        initialize_schema()
    pool = _get_pool()
    try:
        connection = pool.getconn(timeout=5)
    except (PoolTimeout, TooManyRequests, PoolClosed, psycopg.OperationalError) as error:
        raise Unavailable("教学数据库连接池繁忙或不可用") from error
    try:
        try:
            with connection:
                yield connection
        except psycopg.OperationalError as error:
            raise OperationFailed("operational_error", error.sqlstate) from error
    finally:
        pool.putconn(connection)


def readiness() -> dict[str, str]:
    with conn() as c:
        row = c.execute("SELECT version FROM schema_meta WHERE singleton").fetchone()
        if not row or row["version"] != TEACHING_DB_VERSION:
            raise SchemaVersionMismatch("教学数据库 schema 未就绪")
        if c.execute("SELECT 1 FROM accounts WHERE role='teacher' LIMIT 1").fetchone() is None:
            raise Unavailable("教学数据库缺少教师账号")
    return {"status": "ok", "schema_version": TEACHING_DB_VERSION}


def current_release_id() -> str:
    from gvcsim.artifacts import release_identity

    return release_identity()


def _sync_demo_accounts(c: psycopg.Connection[dict[str, Any]]) -> dict[str, int]:
    """Idempotently reconcile the public teacher and 50 student demo credentials.

    This runs only under the explicit server-side demo switch.  Existing account
    ids are preserved so adding the expanded pool never deletes sessions/reports;
    a changed configured base password rotates only the recognized seed accounts.
    """
    if not config.DEMO_MODE or not config.BOOTSTRAP_PASSWORD:
        return {"created": 0, "updated": 0}

    records = [("teacher", "老师", "teacher", "", config.BOOTSTRAP_PASSWORD)]
    records.extend(
        (student.username, student.display_name, "student", student.student_no, student.password)
        for student in demo_accounts.demo_student_credentials(config.BOOTSTRAP_PASSWORD)
    )
    created = 0
    updated = 0
    for username, display_name, role, student_no, password in records:
        existing = c.execute(
            "SELECT role,display_name,student_no,pw_salt,pw_hash FROM accounts WHERE username=%s",
            (username,),
        ).fetchone()
        if existing is None:
            salt = secrets.token_hex(16)
            c.execute(
                "INSERT INTO accounts(username,display_name,role,student_no,pw_salt,pw_hash)"
                " VALUES (%s,%s,%s,%s,%s,%s)",
                (username, display_name, role, student_no, salt, hash_password(password, salt)),
            )
            created += 1
            continue
        if existing["role"] != role:
            raise RuntimeError(f"演示种子账号 {username} 已被不同角色占用")

        password_matches = hmac.compare_digest(
            existing["pw_hash"],
            hash_password(password, existing["pw_salt"]),
        )
        profile_matches = existing["display_name"] == display_name and existing["student_no"] == student_no
        if password_matches and profile_matches:
            continue
        if password_matches:
            c.execute(
                "UPDATE accounts SET display_name=%s,student_no=%s WHERE username=%s",
                (display_name, student_no, username),
            )
        else:
            salt = secrets.token_hex(16)
            c.execute(
                "UPDATE accounts SET display_name=%s,student_no=%s,pw_salt=%s,pw_hash=%s,"
                "auth_version=auth_version+1 WHERE username=%s",
                (display_name, student_no, salt, hash_password(password, salt), username),
            )
        updated += 1
    return {"created": created, "updated": updated}


def find_account(username: str) -> dict[str, Any] | None:
    with conn() as c:
        return c.execute("SELECT * FROM accounts WHERE username=%s", (username,)).fetchone()


def current_auth_subject(
    account_id: int,
    username: str,
    role: str,
    auth_version: int,
) -> dict[str, Any] | None:
    """Return the current account identity for a still-valid token subject.

    Display names are profile data, not immutable authorization claims. Returning
    the current value here lets every verified request observe a teacher rename
    immediately without forcing the student to sign in again.
    """
    with conn() as c:
        return c.execute(
            "SELECT display_name FROM accounts WHERE id=%s AND username=%s AND role=%s AND auth_version=%s",
            (account_id, username, role, auth_version),
        ).fetchone()


def demo_students_by_activity(in_use_seconds: float) -> list[tuple[str, bool]]:
    """Demo student usernames, least recently active first (never-used accounts lead), each with whether it
    is in use: active within ``in_use_seconds``.

    Activity is the later of the last login and the last saved session in any release, so an account a
    student is still working in is not handed to someone else just because the login was long ago.
    """
    with conn() as c:
        rows = c.execute(
            "SELECT username, active_at IS NOT NULL AND active_at > now() - make_interval(secs => %s) AS in_use"
            " FROM (SELECT a.username, GREATEST(a.last_login_at, MAX(s.updated_at)) AS active_at FROM accounts a"
            " LEFT JOIN experiment_sessions s ON s.account_id=a.id"
            " WHERE a.role='student' AND a.username = ANY(%s)"
            " GROUP BY a.id) activity ORDER BY active_at ASC NULLS FIRST, username",
            (in_use_seconds, sorted(demo_accounts.DEMO_STUDENT_USERNAMES)),
        ).fetchall()
    return [(row["username"], bool(row["in_use"])) for row in rows]


def touch_login(username: str) -> None:
    with conn() as c:
        c.execute("UPDATE accounts SET last_login_at=now() WHERE username=%s", (username,))


def provision_teacher(username: str, display_name: str, password: str) -> dict[str, Any]:
    _validate_managed_password(password)
    salt = secrets.token_hex(16)
    with conn() as c:
        return _required(
            c.execute(
                "INSERT INTO accounts(username,display_name,role,pw_salt,pw_hash) VALUES (%s,%s,'teacher',%s,%s)"
                " RETURNING id,username,display_name,role",
                (username, display_name, salt, hash_password(password, salt)),
            ).fetchone(),
            "provision teacher",
        )


def change_own_password(username: str, current_password: str, new_password: str) -> bool:
    if config.DEMO_MODE and demo_accounts.is_demo_student_username(username):
        raise demo_accounts.DemoSeedPasswordProtected("演示种子学生使用固定轮换口令，不能修改密码")
    _validate_managed_password(new_password)
    with conn() as c:
        account = c.execute("SELECT id,pw_salt,pw_hash FROM accounts WHERE username=%s", (username,)).fetchone()
        if not account:
            return False
        if not hmac.compare_digest(account["pw_hash"], hash_password(current_password, account["pw_salt"])):
            return False
        if hmac.compare_digest(account["pw_hash"], hash_password(new_password, account["pw_salt"])):
            raise ValueError("新密码不能与当前密码相同")
        salt = secrets.token_hex(16)
        c.execute(
            "UPDATE accounts SET pw_salt=%s,pw_hash=%s,auth_version=auth_version+1 WHERE id=%s",
            (salt, hash_password(new_password, salt), account["id"]),
        )
    return True


def reset_learning_records() -> None:
    """Clear only data tied to an experiment recomputation."""
    with conn() as c:
        for table in ("reports", "experiment_sessions"):
            c.execute(f"DELETE FROM {table}")


atexit.register(shutdown)


from gvcsim.classroom.management import (  # noqa: E402
    _STUDENT_COLS as _STUDENT_COLS,
    _learning_status_in_conn as _learning_status_in_conn,
    create_class_group as create_class_group,
    create_student as create_student,
    create_term as create_term,
    list_academic_structure as list_academic_structure,
    list_students as list_students,
    set_student_enrollment as set_student_enrollment,
    update_class_group as update_class_group,
    update_student as update_student,
    update_term as update_term,
)
from gvcsim.classroom.records import (  # noqa: E402
    ReportChanged as ReportChanged,
    get_report as get_report,
    get_session as get_session,
    grade_report as grade_report,
    latest_report as latest_report,
    list_reports as list_reports,
    save_generated_report as save_generated_report,
    save_session as save_session,
    submit_report as submit_report,
)
