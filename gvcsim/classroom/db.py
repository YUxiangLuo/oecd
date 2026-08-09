"""教学数据库(PostgreSQL):班级/学生账号/实验会话/进度/报告提交评阅/公告。

设计取舍:
  - 每个 API worker 使用有界 psycopg 连接池；池满时背压，不创建连接风暴
  - schema_meta 串行化增量迁移；v3-v5 会原地升级且保留全部课堂数据，未知版本拒绝
  - course_run → assignment → enrollment → experiment_attempt 是所有学习记录的作用域
  - submission_versions / grading_events 追加写，保留不可变提交与评分历史
  - 数据库不可用统一抛 Unavailable；生产认证 fail-closed
  - 短期令牌在 auth_sessions 登记；登录限流状态由 PostgreSQL 跨 worker 共享

本模块保留连接池、schema 闸门、认证和 assignment/attempt 作用域，并作为兼容
facade 重新导出 ``management`` 与 ``records`` 中的领域操作。
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
from collections.abc import Iterator, Sequence
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


# Domain repositories live in focused modules; these imports preserve the
# historical ``gvcsim.classroom.db`` API used by routes, CLI code, and extensions.
from gvcsim.classroom.attempts import (  # noqa: E402
    _attempt_scope as _attempt_scope,
    _evidence_event_exists_in_conn as _evidence_event_exists_in_conn,
    _require_assignment_writable as _require_assignment_writable,
    assignment_context as assignment_context,
    evidence_event_exists as evidence_event_exists,
    list_student_assignment_contexts as list_student_assignment_contexts,
    record_evidence_event as record_evidence_event,
    select_student_assignment as select_student_assignment,
)

from gvcsim.classroom.management import (  # noqa: E402
    _STUDENT_COLS as _STUDENT_COLS,
    _learning_status_in_conn as _learning_status_in_conn,
    _teacher_course_ids as _teacher_course_ids,
    create_assignment as create_assignment,
    create_class as create_class,
    create_course_run as create_course_run,
    create_student as create_student,
    enroll_student as enroll_student,
    list_assignments as list_assignments,
    list_classes as list_classes,
    list_course_runs as list_course_runs,
    list_enrollments as list_enrollments,
    list_students as list_students,
    overview_stats as overview_stats,
    set_assignment_active as set_assignment_active,
    set_course_run_archived as set_course_run_archived,
    start_new_attempt as start_new_attempt,
    teacher_can_access_class as teacher_can_access_class,
    update_student as update_student,
)

from gvcsim.classroom.records import (  # noqa: E402
    _report_by_key_in_conn as _report_by_key_in_conn,
    clear_session as clear_session,
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
    report_by_key as report_by_key,
    reset_active_attempts_for_quiz as reset_active_attempts_for_quiz,
    save_generated_report_and_session as save_generated_report_and_session,
    save_session as save_session,
    submission_history as submission_history,
    submit_report as submit_report,
    teacher_can_access_submission_in_conn as teacher_can_access_submission_in_conn,
    upsert_progress as upsert_progress,
)
