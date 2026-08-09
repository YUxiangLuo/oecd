"""教学数据库(PostgreSQL):班级/学生账号/实验会话/进度/报告提交评阅/公告。

设计取舍:
  - 每个 API worker 使用有界 psycopg 连接池；池满时背压，不创建连接风暴
  - schema_meta 串行化增量迁移；v3-v5 会原地升级且保留全部课堂数据，未知版本拒绝
  - course_run → assignment → enrollment → experiment_attempt 是所有学习记录的作用域
  - submission_versions / grading_events 追加写，保留不可变提交与评分历史
  - 数据库不可用统一抛 Unavailable；生产认证 fail-closed
  - 短期令牌在 auth_sessions 登记；登录限流状态由 PostgreSQL 跨 worker 共享
"""

import atexit
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import secrets
import threading
import uuid
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolClosed, PoolTimeout, TooManyRequests

from gvcsim import config
from gvcsim.classroom import schema

logger = logging.getLogger(__name__)

MAX_STEP = 16
# 会话写入的 advisory lock 命名空间(与 account_id 组成两段锁键,不与建表锁冲突)
_SESSION_LOCK_NS = 736_861_017

# 保留原有导入面；版本定义及迁移实现位于独立 schema 模块。
TEACHING_DB_VERSION = schema.TEACHING_DB_VERSION


class Unavailable(Exception):
    """教学数据库不可用(未启动/未建库/网络不通)。"""


class OperationFailed(Unavailable):
    """连接已经借出后发生的数据库操作故障，不与 pool checkout 饱和混淆。"""

    def __init__(self, reason: str, sqlstate: str | None):
        self.reason = reason
        self.sqlstate = sqlstate
        super().__init__("教学数据库操作失败，请稍后重试")


class SchemaVersionMismatch(RuntimeError):
    """教学库来自未知/不受支持版本，不能安全自动迁移。"""


class AssignmentScopeMismatch(RuntimeError):
    """客户端 manifest 不属于当前作业发布。"""


class AssignmentClosed(RuntimeError):
    """作业已到截止时间，学生端只能读取既有记录。"""


class LegacySessionReadOnly(RuntimeError):
    """旧 session 仅供查看，必须显式重置后才能写入新契约。"""


class SessionRevisionConflict(RuntimeError):
    """报告生成期间会话已被另一请求推进，必须基于最新状态重新生成。"""


def hash_password(password: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 100_000).hex()


def _validate_managed_password(password: str) -> None:
    if not 12 <= len(password) <= 256:
        raise ValueError("教师设置的账号口令必须为 12..256 个字符")


def _required(row: dict[str, Any] | None, operation: str) -> dict[str, Any]:
    """Narrow ``fetchone()`` after SQL that is contractually guaranteed to return one row."""
    if row is None:
        raise RuntimeError(f"数据库操作未返回预期行:{operation}")
    return row


_schema_ready = False
_startup_sealed = False
_pool: ConnectionPool[psycopg.Connection[dict[str, Any]]] | None = None
_pool_signature: tuple[Any, ...] | None = None
_pool_lock = threading.RLock()


def initialize_schema() -> list[str]:
    """建表/安全迁移并播种；从 v3-v5 升级不需要 reset。"""
    global _schema_ready
    if _startup_sealed:
        raise RuntimeError("服务已完成启动，禁止在请求生命周期内重新初始化 schema")
    # 测试/运维将 ready 复位通常意味着 schema 或 DSN 已切换；旧连接上的
    # prepared statement/事务状态不能跨越这条边界。
    if not _schema_ready:
        close_pool()
    c = _connect()
    applied: list[str] = []
    try:
        with c:
            # 先加锁再校验/建表，避免两个首次请求同时创建系统表或播种账号。
            schema.lock_schema(c)
            version = schema.existing_version(c)
            fresh = version is None
            if version == "gvcsim-teaching-db-v3":
                schema.migrate_v3_to_v4(c)
                applied.append("安全迁移 v3 → v4（保留课堂、会话、报告、提交与评分）")
                version = "gvcsim-teaching-db-v4"
            if version == "gvcsim-teaching-db-v4":
                schema.migrate_v4_to_v5(c)
                applied.append("安全迁移 v4 → v5（增加学生显式作业选择）")
                version = "gvcsim-teaching-db-v5"
            if version == "gvcsim-teaching-db-v5":
                schema.migrate_v5_to_v6(c)
                applied.append("安全迁移 v5 → v6（增加跨 worker 登录限流）")
                version = TEACHING_DB_VERSION
            elif version not in {None, TEACHING_DB_VERSION}:
                raise SchemaVersionMismatch(
                    f"教学库 schema 版本为 {version}，当前代码需要 {TEACHING_DB_VERSION}；"
                    "没有已验证的自动迁移路径，请先备份并按部署文档处理，禁止直接 reset 生产数据"
                )
            if version is None:
                c.execute(schema.SCHEMA_SQL)
                c.execute(
                    "INSERT INTO schema_meta(singleton, version) VALUES (true, %s) ON CONFLICT (singleton) DO NOTHING",
                    (TEACHING_DB_VERSION,),
                )
            # v4 开发期新增的非破坏性列仍保持幂等，旧测试库无需 reset。
            c.execute(
                "ALTER TABLE attempt_sessions ADD COLUMN IF NOT EXISTS legacy_unverified boolean NOT NULL DEFAULT false"
            )
            c.execute("ALTER TABLE reports ALTER COLUMN attempt_id SET NOT NULL")
            c.execute("ALTER TABLE reports ALTER COLUMN assignment_id SET NOT NULL")
            c.execute("ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_account_id_report_key_key")
            c.execute("CREATE UNIQUE INDEX IF NOT EXISTS reports_attempt_report_key ON reports(attempt_id,report_key)")
            if fresh:
                applied.append(f"创建 schema {TEACHING_DB_VERSION}")
            # 只有**本次调用确实创建了显式 demo 账号**时才需要为它们补默认
            # course/assignment。v3 的历史回填已在 _migrate_v3_to_v4 的同一事务
            # 内完成；普通已版本化 schema 重启绝不能再次把所有教师/班级/学生汇入 legacy run。
            if _seed_if_empty(c):
                schema.ensure_legacy_context(c)
    except SchemaVersionMismatch:
        c.close()
        raise
    except psycopg.Error as e:
        c.close()
        raise Unavailable(str(e)) from e
    _schema_ready = True
    return applied


def _connect() -> psycopg.Connection[dict[str, Any]]:
    if not config.PG_DSN:
        raise Unavailable("缺少 GVCSIM_PG_DSN；教学数据库未配置")
    try:
        return psycopg.connect(
            config.PG_DSN,
            row_factory=dict_row,
            connect_timeout=config.DB_CONNECT_TIMEOUT_SECONDS,
            application_name="gvcsim-schema",
            options=(
                f"-c statement_timeout={config.DB_STATEMENT_TIMEOUT_MS} -c idle_in_transaction_session_timeout=30000"
            ),
        )
    except psycopg.OperationalError as e:
        raise Unavailable(str(e)) from e


def _current_pool_signature() -> tuple[Any, ...]:
    return (
        os.getpid(),  # fork/spawn 后每个 worker 必须拥有自己的池和后台线程
        config.PG_DSN,
        config.DB_POOL_MIN_SIZE,
        config.DB_POOL_MAX_SIZE,
        config.DB_POOL_TIMEOUT_SECONDS,
        config.DB_POOL_MAX_WAITING,
        config.DB_POOL_MAX_LIFETIME_SECONDS,
        config.DB_POOL_MAX_IDLE_SECONDS,
        config.DB_CONNECT_TIMEOUT_SECONDS,
        config.DB_STATEMENT_TIMEOUT_MS,
    )


def _get_pool() -> ConnectionPool[psycopg.Connection[dict[str, Any]]]:
    global _pool, _pool_signature
    if not config.PG_DSN:
        raise Unavailable("缺少 GVCSIM_PG_DSN；教学数据库未配置")
    signature = _current_pool_signature()
    with _pool_lock:
        if _pool is not None and _pool_signature == signature and not _pool.closed:
            return _pool
        if _pool is not None:
            _pool.close()
        try:
            pool: ConnectionPool[psycopg.Connection[dict[str, Any]]] = ConnectionPool(
                conninfo=config.PG_DSN,
                min_size=config.DB_POOL_MIN_SIZE,
                max_size=config.DB_POOL_MAX_SIZE,
                kwargs={
                    "row_factory": dict_row,
                    "connect_timeout": config.DB_CONNECT_TIMEOUT_SECONDS,
                    "application_name": f"gvcsim-api-{os.getpid()}",
                    "options": (
                        f"-c statement_timeout={config.DB_STATEMENT_TIMEOUT_MS} "
                        "-c idle_in_transaction_session_timeout=30000"
                    ),
                },
                open=False,
                timeout=config.DB_POOL_TIMEOUT_SECONDS,
                max_waiting=config.DB_POOL_MAX_WAITING,
                max_lifetime=config.DB_POOL_MAX_LIFETIME_SECONDS,
                max_idle=config.DB_POOL_MAX_IDLE_SECONDS,
                reconnect_timeout=max(5.0, config.DB_POOL_TIMEOUT_SECONDS),
                num_workers=2,
                name=f"gvcsim-{os.getpid()}",
            )
            pool.open()
        except (ValueError, psycopg.Error) as error:
            raise Unavailable(str(error)) from error
        _pool = pool
        _pool_signature = signature
        return pool


def close_pool() -> None:
    """关闭当前进程的池；借出的连接会在归还时关闭，不会被中途打断。"""
    global _pool, _pool_signature
    with _pool_lock:
        if _pool is not None:
            _pool.close()
        _pool = None
        _pool_signature = None


def shutdown() -> None:
    """结束服务生命周期并重新允许 CLI/测试显式执行 schema 初始化。"""
    global _startup_sealed
    _startup_sealed = False
    close_pool()


def verify_schema() -> dict[str, str]:
    """只读确认教学库已经由显式 ``classroom-init`` 迁移到当前版本。

    服务启动和 preflight 都走这里，绝不在部署探针里建表或迁移。这样数据库
    变更是可单独备份、审查和回滚的运维步骤，而不是启动新二进制的副作用。
    """
    global _schema_ready
    c = _connect()
    try:
        with c:
            c.execute("SET TRANSACTION READ ONLY")
            version = schema.existing_version(c)
            if version != TEACHING_DB_VERSION:
                rendered = version or "未初始化"
                raise SchemaVersionMismatch(
                    f"教学库 schema 版本为 {rendered}，当前代码需要 {TEACHING_DB_VERSION}；"
                    "请先备份并显式运行 `uv run gvcsim classroom-init`"
                )
            c.execute("SELECT 1")
    except SchemaVersionMismatch:
        raise
    except psycopg.Error as error:
        raise Unavailable(str(error)) from error
    finally:
        c.close()
    _schema_ready = True
    return {"status": "ok", "schema_version": TEACHING_DB_VERSION}


def startup() -> None:
    """服务 worker 启动闸门：只读验 schema，并等待最小连接数建立。"""
    global _startup_sealed
    config.validate_capacity_config()
    if not _schema_ready:
        verify_schema()
    try:
        _get_pool().wait(timeout=max(5.0, config.DB_POOL_TIMEOUT_SECONDS))
    except (PoolTimeout, PoolClosed, psycopg.OperationalError) as error:
        _startup_sealed = False
        close_pool()
        raise Unavailable(str(error)) from error
    _startup_sealed = True


def _operation_failure(error: psycopg.OperationalError) -> OperationFailed:
    sqlstate = error.sqlstate
    if sqlstate == "57014":
        reason = "query_canceled"
    elif sqlstate and sqlstate.startswith("40"):
        reason = "transaction_conflict"
    elif sqlstate and (sqlstate.startswith("08") or sqlstate.startswith("57P0")):
        reason = "connection_lost"
    else:
        reason = "operational_error"
    logger.warning(
        "database operation failed: reason=%s sqlstate=%s driver_error=%s",
        reason,
        sqlstate or "unknown",
        type(error).__name__,
    )
    return OperationFailed(reason, sqlstate)


@contextmanager
def conn() -> Iterator[psycopg.Connection[dict[str, Any]]]:
    """从池中借用事务连接；正常提交、异常回滚，最后归还而不是断开。"""
    if not _schema_ready:
        if _startup_sealed:
            raise Unavailable("服务启动后的 schema 就绪状态丢失；拒绝在请求路径执行惰性迁移")
        initialize_schema()

    pool = _get_pool()
    try:
        connection = pool.getconn(timeout=config.DB_POOL_TIMEOUT_SECONDS)
    except (PoolTimeout, TooManyRequests, PoolClosed, psycopg.OperationalError) as error:
        raise Unavailable("教学数据库连接池繁忙或不可用，请稍后重试") from error

    try:
        try:
            with connection:
                yield connection
        except psycopg.OperationalError as error:
            raise _operation_failure(error) from error
    finally:
        pool.putconn(connection)


def pool_stats() -> dict[str, int]:
    """返回当前 worker 的池指标；键名稳定且不包含 DSN。"""
    stats = _get_pool().get_stats()
    return {
        "min": int(stats.get("pool_min", config.DB_POOL_MIN_SIZE)),
        "max": int(stats.get("pool_max", config.DB_POOL_MAX_SIZE)),
        "size": int(stats.get("pool_size", 0)),
        "available": int(stats.get("pool_available", 0)),
        "requests_waiting": int(stats.get("requests_waiting", 0)),
        "requests_num": int(stats.get("requests_num", 0)),
        "requests_queued": int(stats.get("requests_queued", 0)),
        "requests_errors": int(stats.get("requests_errors", 0)),
    }


def readiness() -> dict[str, Any]:
    """轻量就绪探针：连接、schema 版本与事务读均必须正常。"""
    with conn() as c:
        row = c.execute("SELECT version,now() AS checked_at FROM schema_meta WHERE singleton").fetchone()
        if not row or row["version"] != TEACHING_DB_VERSION:
            raise SchemaVersionMismatch("教学数据库 schema 未就绪")
    # 先归还 readiness 自己借用的连接，再取 stats；否则 available 会稳定少 1，
    # 在 min_size=1 的健康 worker 上产生“池已耗尽”的误报警。
    return {"status": "ok", "schema_version": row["version"], "pool": pool_stats()}


atexit.register(shutdown)


def _seed_if_empty(c: psycopg.Connection[dict[str, Any]]) -> bool:
    """显式 demo 模式下播种默认账号；返回本次是否真的完成了播种。"""
    if c.execute("SELECT 1 FROM accounts LIMIT 1").fetchone():
        return False
    if not config.DEMO_MODE or not config.BOOTSTRAP_PASSWORD:
        return False
    row = _required(
        c.execute(
            "INSERT INTO classes(name, code, semester, note) VALUES (%s, %s, %s, %s) RETURNING id",
            ("GVC 实验演示班", "GVC-DEMO", "2026 春", "默认演示班级,用于课堂演示与自测。"),
        ).fetchone(),
        "seed demo class",
    )
    class_id = row["id"]
    for username, display_name, role, cls, student_no in (
        ("teacher", "老师", "teacher", None, ""),
        ("student", "同学", "student", class_id, "2026001"),
    ):
        salt = secrets.token_hex(16)
        c.execute(
            "INSERT INTO accounts(username, display_name, role, class_id, student_no, pw_salt, pw_hash)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (username, display_name, role, cls, student_no, salt, hash_password(config.BOOTSTRAP_PASSWORD, salt)),
        )
    c.execute(
        "INSERT INTO announcements(class_id, title, body, author) VALUES (%s, %s, %s, %s)",
        (
            None,
            "欢迎使用 GVC 实验系统",
            "请按课程大纲完成 16 步实验;完成步骤 16 后,在报告页点击「提交报告给老师」,教师评阅后可在同一页面查看得分与评语。",
            "teacher",
        ),
    )
    return True


# ---------------------------------------------------------------- 账号与认证


def _rate_key_hash(rate_key: str) -> str:
    return hashlib.sha256(rate_key.encode("utf-8")).hexdigest()


_LOGIN_ATTEMPT_RETENTION_WINDOWS = 4


def reserve_login_attempts(
    rate_limits: Sequence[tuple[str, int]],
    window_seconds: int,
    *,
    now: float | None = None,
) -> int | None:
    """按顺序原子预占多个登录预算；任一达到上限时返回等待秒数。

    所有键的 advisory lock 按数值排序取得，避免并发请求死锁。较早预算（per-IP）
    已插入后即使较晚预算（IP+username）拒绝也会提交，从而让被身份限流挡住的
    请求仍计入 IP 总量。键只以 SHA-256 形式落库。
    """
    limits = list(rate_limits)
    if window_seconds <= 0 or not limits or any(not key or maximum <= 0 for key, maximum in limits):
        raise ValueError("登录限流窗口和次数必须为正数")
    if len({key for key, _maximum in limits}) != len(limits):
        raise ValueError("同一次登录限流预占不能包含重复键")

    hashed_limits = [(_rate_key_hash(key), maximum) for key, maximum in limits]
    lock_keys = {
        int.from_bytes(hashlib.sha256(key_hash.encode()).digest()[:8], "big", signed=True)
        for key_hash, _maximum in hashed_limits
    }
    with conn() as c:
        for lock_key in sorted(lock_keys):
            c.execute("SELECT pg_advisory_xact_lock(%s)", (lock_key,))
        if now is None:
            current_epoch = _required(
                c.execute("SELECT extract(epoch FROM now()) AS value").fetchone(),
                "login rate clock",
            )["value"]
            attempted_at_sql = "now()"
            attempted_at_params: tuple[Any, ...] = ()
        else:
            current_epoch = now
            attempted_at_sql = "to_timestamp(%s)"
            attempted_at_params = (now,)

        # 全局清理窗口只比限流窗口长一个小倍数。即使攻击者轮换 username，
        # 旧键也不会按固定 1 天滞留；显式 now 让测试和离线调用保持同一时钟。
        if secrets.randbelow(128) == 0:
            retention_seconds = window_seconds * _LOGIN_ATTEMPT_RETENTION_WINDOWS
            if now is None:
                c.execute(
                    "DELETE FROM auth_login_attempts WHERE attempted_at<now()-(%s * interval '1 second')",
                    (retention_seconds,),
                )
            else:
                c.execute(
                    "DELETE FROM auth_login_attempts WHERE attempted_at<to_timestamp(%s)",
                    (float(current_epoch) - retention_seconds,),
                )

        for key_hash, max_attempts in hashed_limits:
            cutoff = float(current_epoch) - window_seconds
            if now is None:
                c.execute(
                    "DELETE FROM auth_login_attempts"
                    " WHERE rate_key_hash=%s AND attempted_at<=now()-(%s * interval '1 second')",
                    (key_hash, window_seconds),
                )
            else:
                c.execute(
                    "DELETE FROM auth_login_attempts WHERE rate_key_hash=%s AND attempted_at<=to_timestamp(%s)",
                    (key_hash, cutoff),
                )
            row = _required(
                c.execute(
                    "SELECT count(*)::int AS attempts,"
                    " extract(epoch FROM min(attempted_at)) AS oldest"
                    " FROM auth_login_attempts WHERE rate_key_hash=%s",
                    (key_hash,),
                ).fetchone(),
                "login rate count",
            )
            if row["attempts"] >= max_attempts:
                oldest = float(row["oldest"] or current_epoch)
                return max(1, int(oldest + window_seconds - float(current_epoch)) + 1)
            c.execute(
                f"INSERT INTO auth_login_attempts(rate_key_hash,attempted_at) VALUES (%s,{attempted_at_sql})",
                (key_hash, *attempted_at_params),
            )
    return None


def reserve_login_attempt(
    rate_key: str,
    window_seconds: int,
    max_attempts: int,
    *,
    now: float | None = None,
) -> int | None:
    """兼容单键调用；API 登录使用 :func:`reserve_login_attempts` 双层预算。"""
    return reserve_login_attempts(((rate_key, max_attempts),), window_seconds, now=now)


def clear_login_attempts(rate_key: str) -> None:
    """登录成功后清空该身份键；其他用户名不受同一校园 NAT 影响。"""
    with conn() as c:
        c.execute("DELETE FROM auth_login_attempts WHERE rate_key_hash=%s", (_rate_key_hash(rate_key),))


def find_account(username: str) -> dict[str, Any] | None:
    with conn() as c:
        return c.execute("SELECT * FROM accounts WHERE username = %s", (username,)).fetchone()


def touch_login(username: str) -> None:
    with conn() as c:
        c.execute("UPDATE accounts SET last_login_at = now() WHERE username = %s", (username,))


def create_auth_session(account_id: int, jti: str, token_hash: str, expires_at: int) -> None:
    """登记可撤销访问会话；顺手清理过期行，避免无限增长。"""
    with conn() as c:
        c.execute("DELETE FROM auth_sessions WHERE expires_at <= now() - interval '1 day'")
        c.execute(
            "INSERT INTO auth_sessions(jti, account_id, token_hash, expires_at) VALUES (%s, %s, %s, to_timestamp(%s))",
            (jti, account_id, token_hash, expires_at),
        )


def validate_auth_session(jti: str, token_hash: str, account_id: int | None, auth_version: int | None) -> dict | None:
    """逐请求复查会话未撤销、账号启用、身份版本未变化。"""
    with conn() as c:
        return c.execute(
            "SELECT a.id, a.username, a.display_name, a.role, a.auth_version"
            " FROM auth_sessions s JOIN accounts a ON a.id=s.account_id"
            " WHERE s.jti=%s AND s.token_hash=%s AND s.account_id=%s"
            " AND s.revoked_at IS NULL AND s.expires_at>now()"
            " AND a.active AND a.auth_version=%s",
            (jti, token_hash, account_id, auth_version),
        ).fetchone()


def revoke_auth_session(jti: str) -> bool:
    with conn() as c:
        return (
            c.execute(
                "UPDATE auth_sessions SET revoked_at=coalesce(revoked_at, now()) WHERE jti=%s RETURNING jti", (jti,)
            ).fetchone()
            is not None
        )


def record_audit_event(
    action: str,
    *,
    actor_name: str = "",
    actor_id: int | None = None,
    target_type: str = "",
    target_id: str = "",
    details: dict[str, Any] | None = None,
    ip_address: str | None = None,
) -> None:
    """追加安全审计；调用方不得把口令、令牌或报告正文放入 details。"""
    try:
        safe_ip = str(ipaddress.ip_address(ip_address)) if ip_address else None
    except ValueError:
        safe_ip = None
    with conn() as c:
        c.execute(
            "INSERT INTO audit_log(actor_id, actor_name, action, target_type, target_id, details, ip_address)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s)",
            (actor_id, actor_name, action, target_type, target_id, json.dumps(details or {}), safe_ip),
        )


def provision_teacher(username: str, display_name: str, password: str) -> dict[str, Any]:
    """显式初始化教师；不使用仓库默认口令，并创建其独立默认课程。"""
    _validate_managed_password(password)
    salt = secrets.token_hex(16)
    with conn() as c:
        row = _required(
            c.execute(
                "INSERT INTO accounts(username,display_name,role,pw_salt,pw_hash)"
                " VALUES (%s,%s,'teacher',%s,%s) RETURNING id,username,display_name,role,active",
                (username, display_name, salt, hash_password(password, salt)),
            ).fetchone(),
            "provision teacher",
        )
        run = _required(
            c.execute(
                "INSERT INTO course_runs(name,code,release_tag) VALUES (%s,%s,'initial') RETURNING id",
                (f"{display_name}的 GVC 实验课程", f"GVC-DEFAULT-{row['id']}"),
            ).fetchone(),
            "provision teacher-owned default course",
        )
        c.execute(
            "INSERT INTO teacher_course_access(teacher_account_id,course_run_id) VALUES (%s,%s) ON CONFLICT DO NOTHING",
            (row["id"], run["id"]),
        )
    return row


def change_own_password(username: str, current_password: str, new_password: str) -> bool:
    """验证当前口令后修改本人密码，并撤销该账号的全部既有登录会话。

    密码更新、认证版本推进、会话撤销和审计记录处于同一事务；成功返回后调用方
    必须要求重新登录。``False`` 只表示当前口令不正确，不泄露账号其它状态。
    """
    _validate_managed_password(new_password)
    with conn() as c:
        account = c.execute(
            "SELECT id,username,pw_salt,pw_hash,active FROM accounts WHERE username=%s FOR UPDATE",
            (username,),
        ).fetchone()
        if not account or not account["active"]:
            return False
        supplied = hash_password(current_password, account["pw_salt"])
        if not hmac.compare_digest(account["pw_hash"], supplied):
            return False
        replacement_with_old_salt = hash_password(new_password, account["pw_salt"])
        if hmac.compare_digest(account["pw_hash"], replacement_with_old_salt):
            raise ValueError("新密码不能与当前密码相同")

        salt = secrets.token_hex(16)
        c.execute(
            "UPDATE accounts SET pw_salt=%s,pw_hash=%s,auth_version=auth_version+1 WHERE id=%s",
            (salt, hash_password(new_password, salt), account["id"]),
        )
        c.execute(
            "UPDATE auth_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE account_id=%s",
            (account["id"],),
        )
        c.execute(
            "INSERT INTO audit_log(actor_id,actor_name,action,target_type,target_id)"
            " VALUES (%s,%s,'auth.password_changed','account',%s)",
            (account["id"], account["username"], str(account["id"])),
        )
    return True


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
        next_no = _required(
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
            created = _required(
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
        raise AssignmentClosed("这是历史作业；既有进度、报告和评分可查看，但不能继续写入")
    if scope.get("assignment_closed"):
        due_at = scope.get("due_at")
        isoformat = getattr(due_at, "isoformat", None)
        rendered = str(isoformat()) if callable(isoformat) else str(due_at or "")
        raise AssignmentClosed(f"作业已于 {rendered} 截止；现可查看既有记录，但不能继续写入或提交")


def assignment_context(username: str, manifest_id: str | None = None) -> dict[str, Any] | None:
    with conn() as c:
        return _attempt_scope(c, username, manifest_id)


def list_student_assignment_contexts(username: str, manifest_id: str | None = None) -> list[dict[str, Any]]:
    """列出学生可切换的当前作业与有 attempt 的历史作业。"""
    with conn() as c:
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
    with conn() as c:
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
    with conn() as c:
        scope = _attempt_scope(c, username, manifest_id)
        if not scope or scope.get("manifest_mismatch") or scope["attempt_id"] is None:
            raise AssignmentScopeMismatch("事件不属于当前 assignment/manifest")
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
    with conn() as c:
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
    with conn() as c:
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
    with conn() as c:
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
    with conn() as c:
        teacher = c.execute(
            "SELECT id FROM accounts WHERE username=%s AND role='teacher' AND active", (teacher_username,)
        ).fetchone()
        if not teacher:
            raise PermissionError("教师账号无效")
        row = _required(
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
    with conn() as c:
        if course_run_id not in _teacher_course_ids(c, teacher_username):
            return None
        return c.execute(
            "UPDATE course_runs SET archived=%s WHERE id=%s RETURNING *", (archived, course_run_id)
        ).fetchone()


def list_assignments(teacher_username: str, course_run_id: int | None = None) -> list[dict[str, Any]]:
    with conn() as c:
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
    with conn() as c:
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
    with conn() as c:
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
    with conn() as c:
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
    with conn() as c:
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
    with conn() as c:
        with c.transaction():
            scope = _attempt_scope(c, username, manifest_id)
            if not scope or scope.get("manifest_mismatch") or scope["attempt_id"] is None:
                raise AssignmentScopeMismatch("没有与当前 manifest 匹配的开放作业")
            attempt_id = scope["attempt_id"]
            c.execute("SELECT pg_advisory_xact_lock(%s, %s)", (_SESSION_LOCK_NS, attempt_id))
            locked_scope = _attempt_scope(c, username, manifest_id, create=False)
            if (
                not locked_scope
                or locked_scope.get("manifest_mismatch")
                or locked_scope["assignment_id"] != scope["assignment_id"]
                or locked_scope["attempt_id"] != attempt_id
                or (expected_assignment_id is not None and locked_scope["assignment_id"] != expected_assignment_id)
                or (expected_attempt_id is not None and locked_scope["attempt_id"] != expected_attempt_id)
            ):
                raise AssignmentScopeMismatch("当前作业 attempt 已变化；请刷新页面后重试")
            scope = locked_scope
            _require_assignment_writable(scope)
            archived = c.execute(
                "UPDATE experiment_attempts SET state='archived',updated_at=now()"
                " WHERE id=%s AND state='active' RETURNING id",
                (scope["attempt_id"],),
            ).fetchone()
            if archived is None:
                raise AssignmentScopeMismatch("当前作业 attempt 已变化；请刷新页面后重试")
            next_no = _required(
                c.execute(
                    "SELECT coalesce(max(attempt_no),0)+1 AS n FROM experiment_attempts"
                    " WHERE assignment_id=%s AND enrollment_id=%s",
                    (scope["assignment_id"], scope["enrollment_id"]),
                ).fetchone(),
                "next explicit attempt number",
            )["n"]
            created = _required(
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
    with conn() as c:
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
    with conn() as c:
        row = _required(
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
    with conn() as c:
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

    scope = _attempt_scope(c, username, create=False, course_run_ids=course_run_ids)
    result: dict[str, Any] = {
        "verified_completed_count": 0,
        "verified_completed_steps": [],
        "completion_missing": list(range(1, MAX_STEP + 1)),
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
            "completion_missing": [n for n in range(1, MAX_STEP + 1) if n not in completed],
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
    _validate_managed_password(password)
    salt = secrets.token_hex(16)
    with conn() as c:
        row = _required(
            c.execute(
                "INSERT INTO accounts(username, display_name, role, class_id, student_no, pw_salt, pw_hash)"
                f" VALUES (%s, %s, 'student', %s, %s, %s, %s) RETURNING {_STUDENT_COLS.replace('a.', '')}",
                (username, display_name, class_id, student_no, salt, hash_password(password, salt)),
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
        _validate_managed_password(fields["password"])
        salt = secrets.token_hex(16)
        sets += ["pw_salt = %s", "pw_hash = %s"]
        params += [salt, hash_password(fields["password"], salt)]
    if not sets:
        return None
    with conn() as c:
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


# ---------------------------------------------------------------- 实验进度


def upsert_progress(username: str, step: int) -> None:
    step = max(1, min(MAX_STEP, step))
    with conn() as c:
        scope = _attempt_scope(c, username)
        if not scope or scope["attempt_id"] is None:
            return
        _require_assignment_writable(scope)
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
    with conn() as c:
        scope = _attempt_scope(c, username)
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
    with conn() as c:
        scope = _attempt_scope(c, username, manifest_id)
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
    with conn() as c:
        with c.transaction():
            scope = _attempt_scope(c, username, session.get("manifest_id"))
            if scope is None:
                return None
            if scope.get("manifest_mismatch"):
                raise AssignmentScopeMismatch(
                    f"当前作业绑定 {scope['assignment_manifest_id']}，不能写入 {session.get('manifest_id')}"
                )
            if (expected_assignment_id is not None and scope["assignment_id"] != expected_assignment_id) or (
                expected_attempt_id is not None and scope["attempt_id"] != expected_attempt_id
            ):
                raise AssignmentScopeMismatch("当前作业 attempt 已变化；请刷新页面后再继续实验")
            _require_assignment_writable(scope)
            account = {"id": scope["account_id"]}
            attempt_id = scope["attempt_id"]
            # 按账号串行化整个读-合并-写。
            #
            # 不能只靠下面那句 SELECT ... FOR UPDATE:行不存在时它锁不住任何东西。
            # 首次并发写入(两个标签页都还没有会话行)会双双读到 current=None →
            # 都跳过 merge → 都算出 revision=1 → 后到的 ON CONFLICT DO UPDATE
            # 整份覆盖先到的,一边的实验被静默丢弃。advisory 锁对"尚不存在的行"
            # 同样有效,因此把首写竞态也一起关掉。
            c.execute("SELECT pg_advisory_xact_lock(%s, %s)", (_SESSION_LOCK_NS, attempt_id))
            # reset 与 PUT 共用 attempt 锁。若 PUT 在等待锁时另一个标签页已重置，
            # 必须重新解析当前边界；否则它会在 reset 提交后把旧会话写回已归档
            # attempt，并重新污染 account 级兼容镜像。
            locked_scope = _attempt_scope(c, username, session.get("manifest_id"), create=False)
            if (
                locked_scope is None
                or locked_scope.get("manifest_mismatch")
                or locked_scope["assignment_id"] != scope["assignment_id"]
                or locked_scope["attempt_id"] != attempt_id
                or (expected_assignment_id is not None and locked_scope["assignment_id"] != expected_assignment_id)
                or (expected_attempt_id is not None and locked_scope["attempt_id"] != expected_attempt_id)
            ):
                raise AssignmentScopeMismatch("当前作业 attempt 已变化；请刷新页面后再继续实验")
            scope = locked_scope
            _require_assignment_writable(scope)
            current = c.execute(
                "SELECT revision,session,legacy_unverified FROM attempt_sessions WHERE attempt_id=%s FOR UPDATE",
                (attempt_id,),
            ).fetchone()
            if current is not None and current["legacy_unverified"]:
                raise LegacySessionReadOnly("迁移前会话未经可信证据验证；请先导出记录并显式重新开始")

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
    with conn() as c:
        with c.transaction():
            initial_scope = _attempt_scope(c, username, create=False)
            if not initial_scope or initial_scope["attempt_id"] is None:
                raise AssignmentScopeMismatch("当前没有可重置的作业 attempt；请刷新页面后重试")
            # 两个标签页可能同时拿着同一个旧 attempt 发 reset。先锁调用方最初
            # 命中的 attempt，再重新读取 active 边界，令后到请求看到第一个请求
            # 已创建的新 attempt 并被 expected_attempt_id 拒绝。
            c.execute(
                "SELECT pg_advisory_xact_lock(%s, %s)",
                (_SESSION_LOCK_NS, initial_scope["attempt_id"]),
            )
            scope = _attempt_scope(c, username, create=False)
            if (
                not scope
                or scope["attempt_state"] != "active"
                or scope["assignment_id"] != expected_assignment_id
                or scope["attempt_id"] != expected_attempt_id
            ):
                raise AssignmentScopeMismatch("当前作业 attempt 已变化；本次重新开始已取消，请刷新页面")
            _require_assignment_writable(scope)
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
            next_no = _required(
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
    with conn() as c:
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
                next_no = _required(
                    c.execute(
                        "SELECT coalesce(max(attempt_no),0)+1 AS n FROM experiment_attempts"
                        " WHERE assignment_id=%s AND enrollment_id=%s",
                        (attempt["assignment_id"], attempt["enrollment_id"]),
                    ).fetchone(),
                    "next quiz reset attempt number",
                )["n"]
                created = _required(
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
    with conn() as c:
        with c.transaction():
            scope = _attempt_scope(c, username, manifest_id)
            if not scope or scope.get("manifest_mismatch"):
                raise AssignmentScopeMismatch("报告不属于当前 assignment/manifest")
            _require_assignment_writable(scope)
            attempt_id = scope["attempt_id"]
            c.execute("SELECT pg_advisory_xact_lock(%s,%s)", (_SESSION_LOCK_NS, attempt_id))
            current = c.execute(
                "SELECT revision,session,legacy_unverified FROM attempt_sessions WHERE attempt_id=%s FOR UPDATE",
                (attempt_id,),
            ).fetchone()
            current_revision = current["revision"] if current else 0
            if current and current["legacy_unverified"]:
                raise LegacySessionReadOnly("迁移前会话不能生成可评分报告")
            if current_revision != base_revision:
                raise SessionRevisionConflict(
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
                    raise SessionRevisionConflict("report_key 已被其他 attempt 使用")
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
    with conn() as c:
        scope = _attempt_scope(c, username)
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
    scope = _attempt_scope(c, username)
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
    with conn() as c:
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
    with conn() as c:
        with c.transaction():
            scope = _attempt_scope(c, username, current_manifest_id)
            if not scope or scope.get("manifest_mismatch"):
                return None
            _require_assignment_writable(scope)
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
                submission = _required(
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
                submission = _required(
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
    with conn() as c:
        scope = _attempt_scope(c, username, create=False)
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
    with conn() as c:
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
    with conn() as c:
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
    with conn() as c:
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
    with conn() as c:
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
    with conn() as c:
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
    with conn() as c:
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
    with conn() as c:
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
    with conn() as c:
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
        base = _required(
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
        buckets = _required(
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
        active = _required(
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
        for n in range(1, MAX_STEP + 1)
    ]
    step_reach = [
        {"step": n, "reached": sum((row.get("max_step") or 0) >= n for row in student_rows)}
        for n in range(1, MAX_STEP + 1)
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
