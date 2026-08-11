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

from gvcsim import config
from gvcsim.classroom import schema

MAX_STEP = 16
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
            if version not in {None, TEACHING_DB_VERSION}:
                raise SchemaVersionMismatch(
                    f"教学库 schema 版本为 {version}，当前代码需要 {TEACHING_DB_VERSION}；"
                    "请运行 `uv run gvcsim classroom-init --reset`"
                )
            if version is None:
                c.execute(schema.SCHEMA_SQL)
                c.execute("INSERT INTO schema_meta(singleton,version) VALUES (true,%s)", (TEACHING_DB_VERSION,))
                applied.append(f"创建 schema {TEACHING_DB_VERSION}")
            _seed_if_empty(c)
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
    return {"status": "ok", "schema_version": TEACHING_DB_VERSION}


def _seed_if_empty(c: psycopg.Connection[dict[str, Any]]) -> bool:
    if c.execute("SELECT 1 FROM accounts LIMIT 1").fetchone() or not config.DEMO_MODE or not config.BOOTSTRAP_PASSWORD:
        return False
    class_id = _required(c.execute(
        "INSERT INTO classes(name,code,semester,note) VALUES (%s,%s,%s,%s) RETURNING id",
        ("GVC 实验演示班", "GVC-DEMO", config.COURSE_TERM, f"{config.COURSE_TERM}学期演示班级。"),
    ).fetchone(), "seed class")["id"]
    for username, name, role, target_class, student_no in (
        ("teacher", "老师", "teacher", None, ""),
        ("student", "同学", "student", class_id, "2026001"),
    ):
        salt = secrets.token_hex(16)
        c.execute(
            "INSERT INTO accounts(username,display_name,role,class_id,student_no,pw_salt,pw_hash)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s)",
            (username, name, role, target_class, student_no, salt, hash_password(config.BOOTSTRAP_PASSWORD, salt)),
        )
    c.execute(
        "INSERT INTO announcements(title,body,author) VALUES (%s,%s,%s)",
        ("欢迎进入 2026 秋学期", "本学期使用全新的题库与实验会话，请按顺序完成 16 步实验并提交报告。", "teacher"),
    )
    return True


def find_account(username: str) -> dict[str, Any] | None:
    with conn() as c:
        return c.execute("SELECT * FROM accounts WHERE username=%s", (username,)).fetchone()


def touch_login(username: str) -> None:
    with conn() as c:
        c.execute("UPDATE accounts SET last_login_at=now() WHERE username=%s", (username,))


def provision_teacher(username: str, display_name: str, password: str) -> dict[str, Any]:
    _validate_managed_password(password)
    salt = secrets.token_hex(16)
    with conn() as c:
        return _required(c.execute(
            "INSERT INTO accounts(username,display_name,role,pw_salt,pw_hash) VALUES (%s,%s,'teacher',%s,%s)"
            " RETURNING id,username,display_name,role",
            (username, display_name, salt, hash_password(password, salt)),
        ).fetchone(), "provision teacher")


def change_own_password(username: str, current_password: str, new_password: str) -> bool:
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
        c.execute("UPDATE accounts SET pw_salt=%s,pw_hash=%s WHERE id=%s", (salt, hash_password(new_password, salt), account["id"]))
    return True


def reset_learning_records() -> None:
    """Clear only data tied to an experiment recomputation."""
    with conn() as c:
        for table in ("submissions", "reports", "experiment_sessions", "step_progress"):
            c.execute(f"DELETE FROM {table}")


atexit.register(shutdown)


from gvcsim.classroom.management import (  # noqa: E402
    _STUDENT_COLS as _STUDENT_COLS,
    _learning_status_in_conn as _learning_status_in_conn,
    create_class as create_class,
    create_student as create_student,
    list_classes as list_classes,
    list_students as list_students,
    overview_stats as overview_stats,
    teacher_can_access_class as teacher_can_access_class,
    update_student as update_student,
)
from gvcsim.classroom.records import (  # noqa: E402
    create_announcement as create_announcement,
    delete_announcement as delete_announcement,
    get_progress as get_progress,
    get_session as get_session,
    get_submission as get_submission,
    grade_submission as grade_submission,
    latest_report as latest_report,
    list_announcements as list_announcements,
    list_submissions as list_submissions,
    my_submission as my_submission,
    reset_workspace as reset_workspace,
    save_generated_report as save_generated_report,
    save_session as save_session,
    submit_report as submit_report,
    teacher_can_access_submission_in_conn as teacher_can_access_submission_in_conn,
    upsert_progress as upsert_progress,
)
