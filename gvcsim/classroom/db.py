"""教学数据库(PostgreSQL):班级/学生账号/实验会话/进度/报告提交评阅/公告。

设计取舍:
  - 每次操作短连接,不引入连接池;班级规模(几十人)下开销可忽略
  - schema_meta 串行化增量迁移；v3 会原地升级且保留全部课堂数据，未知版本拒绝
  - course_run → assignment → enrollment → experiment_attempt 是所有学习记录的作用域
  - submission_versions / grading_events 追加写，保留不可变提交与评分历史
  - 数据库不可用统一抛 Unavailable；生产认证 fail-closed
  - 短期令牌在 auth_sessions 登记，可撤销且逐请求复查账号状态
"""

import hashlib
import ipaddress
import json
import secrets
import uuid
from collections.abc import Callable
from typing import Any

import psycopg
from psycopg.rows import dict_row

from gvcsim import config

MAX_STEP = 16
_SCHEMA_LOCK_ID = 736_861_016  # 固定事务级 advisory lock，串行化首次建表/播种
# 会话写入的 advisory lock 命名空间(与 account_id 组成两段锁键,不与建表锁冲突)
_SESSION_LOCK_NS = 736_861_017

# v4 是首个支持多课程运行/多作业/多次尝试和不可变提交历史的版本。
TEACHING_DB_VERSION = "gvcsim-teaching-db-v4"


class Unavailable(Exception):
    """教学数据库不可用(未启动/未建库/网络不通)。"""


class SchemaVersionMismatch(RuntimeError):
    """教学库来自未知/不受支持版本，不能安全自动迁移。"""


class AssignmentScopeMismatch(RuntimeError):
    """客户端 manifest 不属于当前作业发布。"""


class AssignmentClosed(RuntimeError):
    """作业已到截止时间，学生端只能读取既有记录。"""


class LegacySessionReadOnly(RuntimeError):
    """旧 session 仅供查看，必须显式重置后才能写入新契约。"""


class SessionRevisionConflict(RuntimeError):
    """报告生成期间会话已被另一请求推进，必须基于新证据重新生成。"""


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


_SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_meta (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS classes (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text NOT NULL,
  code         text NOT NULL UNIQUE,
  semester     text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS accounts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('student', 'teacher')),
  class_id      bigint REFERENCES classes(id),
  student_no    text NOT NULL DEFAULT '',
  pw_salt       text NOT NULL,
  pw_hash       text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  auth_version  int NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS course_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  code        text NOT NULL UNIQUE,
  term        text NOT NULL DEFAULT '',
  release_tag text NOT NULL DEFAULT '',
  archived    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS course_class_links (
  course_run_id bigint NOT NULL REFERENCES course_runs(id) ON DELETE CASCADE,
  class_id      bigint NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  PRIMARY KEY (course_run_id, class_id)
);
CREATE TABLE IF NOT EXISTS teacher_course_access (
  teacher_account_id bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  course_run_id      bigint NOT NULL REFERENCES course_runs(id) ON DELETE CASCADE,
  can_manage         boolean NOT NULL DEFAULT true,
  granted_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (teacher_account_id, course_run_id)
);
CREATE TABLE IF NOT EXISTS assignments (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_run_id bigint NOT NULL REFERENCES course_runs(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  title         text NOT NULL,
  manifest_id   text NOT NULL DEFAULT '',
  release_tag   text NOT NULL DEFAULT '',
  opens_at      timestamptz,
  due_at        timestamptz,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_run_id, slug)
);
CREATE TABLE IF NOT EXISTS enrollments (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_run_id bigint NOT NULL REFERENCES course_runs(id) ON DELETE CASCADE,
  account_id    bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  class_id      bigint REFERENCES classes(id),
  active        boolean NOT NULL DEFAULT true,
  enrolled_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_run_id, account_id)
);
CREATE TABLE IF NOT EXISTS experiment_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id bigint NOT NULL REFERENCES assignments(id) ON DELETE RESTRICT,
  enrollment_id bigint NOT NULL REFERENCES enrollments(id) ON DELETE RESTRICT,
  attempt_no    int NOT NULL CHECK (attempt_no > 0),
  state         text NOT NULL DEFAULT 'active' CHECK (state IN ('active','submitted','archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, enrollment_id, attempt_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS experiment_attempts_one_active
  ON experiment_attempts(assignment_id, enrollment_id) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS attempt_step_progress (
  attempt_id   bigint PRIMARY KEY REFERENCES experiment_attempts(id) ON DELETE CASCADE,
  current_step int NOT NULL CHECK (current_step BETWEEN 1 AND 16),
  max_step     int NOT NULL CHECK (max_step BETWEEN 1 AND 16),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS attempt_sessions (
  attempt_id  bigint PRIMARY KEY REFERENCES experiment_attempts(id) ON DELETE CASCADE,
  revision    bigint NOT NULL,
  manifest_id text NOT NULL,
  session     jsonb NOT NULL,
  legacy_unverified boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS learning_evidence_events (
  id             uuid PRIMARY KEY,
  account_id     bigint NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  assignment_id  bigint NOT NULL REFERENCES assignments(id) ON DELETE RESTRICT,
  attempt_id     bigint NOT NULL REFERENCES experiment_attempts(id) ON DELETE RESTRICT,
  step           int NOT NULL CHECK (step BETWEEN 1 AND 16),
  kind           text NOT NULL,
  manifest_id    text NOT NULL,
  payload_hash   text NOT NULL CHECK (length(payload_hash)=64),
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);
CREATE INDEX IF NOT EXISTS learning_evidence_events_attempt_step_idx
  ON learning_evidence_events(attempt_id,step,created_at);
CREATE TABLE IF NOT EXISTS step_progress (
  account_id   bigint PRIMARY KEY REFERENCES accounts(id),
  current_step int NOT NULL CONSTRAINT step_progress_current_step_check CHECK (current_step BETWEEN 1 AND 16),
  max_step     int NOT NULL CONSTRAINT step_progress_max_step_check CHECK (max_step BETWEEN 1 AND 16),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS experiment_sessions (
  account_id  bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  revision    bigint NOT NULL,
  manifest_id text NOT NULL,
  session     jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reports (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  attempt_id       bigint NOT NULL REFERENCES experiment_attempts(id) ON DELETE RESTRICT,
  assignment_id    bigint NOT NULL REFERENCES assignments(id) ON DELETE RESTRICT,
  report_key       text NOT NULL,
  session_revision bigint NOT NULL,
  manifest_id      text NOT NULL,
  markdown         text NOT NULL,
  provenance       jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, report_key)
);
CREATE TABLE IF NOT EXISTS submissions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    bigint NOT NULL REFERENCES accounts(id),
  attempt_id    bigint UNIQUE REFERENCES experiment_attempts(id) ON DELETE RESTRICT,
  latest_version_no int NOT NULL DEFAULT 1 CHECK (latest_version_no > 0),
  title         text NOT NULL,
  year          int NOT NULL,
  design        jsonb NOT NULL,
  markdown      text NOT NULL,
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'graded')),
  score         int CHECK (score BETWEEN 0 AND 100),
  feedback      text NOT NULL DEFAULT '',
  graded_by     text,
  graded_at     timestamptz,
  submitted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS submission_versions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id bigint NOT NULL REFERENCES submissions(id) ON DELETE RESTRICT,
  version_no    int NOT NULL CHECK (version_no > 0),
  report_id     bigint REFERENCES reports(id) ON DELETE RESTRICT,
  title         text NOT NULL,
  year          int NOT NULL,
  design        jsonb NOT NULL,
  markdown      text NOT NULL,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, version_no)
);
CREATE TABLE IF NOT EXISTS grading_events (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id         bigint NOT NULL REFERENCES submissions(id) ON DELETE RESTRICT,
  submission_version_id bigint NOT NULL REFERENCES submission_versions(id) ON DELETE RESTRICT,
  score                 int NOT NULL CHECK (score BETWEEN 0 AND 100),
  feedback              text NOT NULL DEFAULT '',
  graded_by_account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  graded_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  jti          text PRIMARY KEY,
  account_id   bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_account_idx ON auth_sessions(account_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    bigint REFERENCES accounts(id) ON DELETE SET NULL,
  actor_name  text NOT NULL DEFAULT '',
  action      text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id   text NOT NULL DEFAULT '',
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address  inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS announcements (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id    bigint REFERENCES classes(id),
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  author      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
"""

_schema_ready = False


def _lock_schema(c: psycopg.Connection[dict[str, Any]]) -> None:
    """在当前事务结束前持有全局 schema 锁；同一事务重复获取是安全的。"""
    c.execute("SELECT pg_advisory_xact_lock(%s)", (_SCHEMA_LOCK_ID,))


def _existing_version(c: psycopg.Connection[dict[str, Any]]) -> str | None:
    """读取已有库的 schema 版本;空库或从未建表时返回 None。"""
    present = c.execute("SELECT to_regclass('public.schema_meta') AS t").fetchone()
    if not present or present["t"] is None:
        # 完全空库返回 None;但若已有教学表却没有 schema_meta,说明它来自
        # 更早的、无版本戳的 schema,同样必须 reset,不能在其上继续建表。
        legacy = c.execute("SELECT to_regclass('public.accounts') AS t").fetchone()
        if legacy and legacy["t"] is not None:
            return "(无版本戳的旧 schema)"
        return None
    row = c.execute("SELECT version FROM schema_meta WHERE singleton").fetchone()
    return row["version"] if row else None


def _migrate_v3_to_v4(c: psycopg.Connection[dict[str, Any]]) -> None:
    """原地升级 v3；整个函数运行在 schema 锁保护的单一事务内。"""
    c.execute("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS auth_version int NOT NULL DEFAULT 1")
    c.execute("ALTER TABLE reports ADD COLUMN IF NOT EXISTS attempt_id bigint")
    c.execute("ALTER TABLE reports ADD COLUMN IF NOT EXISTS assignment_id bigint")
    c.execute("ALTER TABLE submissions ADD COLUMN IF NOT EXISTS attempt_id bigint")
    c.execute("ALTER TABLE submissions ADD COLUMN IF NOT EXISTS latest_version_no int NOT NULL DEFAULT 1")
    # v3 每账号只能一份提交；v4 的唯一边界是 attempt。
    c.execute("ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_account_id_key")
    c.execute(_SCHEMA)
    c.execute("ALTER TABLE attempt_sessions ADD COLUMN IF NOT EXISTS legacy_unverified boolean NOT NULL DEFAULT false")
    c.execute(
        "ALTER TABLE reports ADD CONSTRAINT reports_attempt_fk FOREIGN KEY (attempt_id)"
        " REFERENCES experiment_attempts(id) ON DELETE RESTRICT NOT VALID"
    )
    c.execute(
        "ALTER TABLE reports ADD CONSTRAINT reports_assignment_fk FOREIGN KEY (assignment_id)"
        " REFERENCES assignments(id) ON DELETE RESTRICT NOT VALID"
    )
    c.execute(
        "ALTER TABLE submissions ADD CONSTRAINT submissions_attempt_fk FOREIGN KEY (attempt_id)"
        " REFERENCES experiment_attempts(id) ON DELETE RESTRICT NOT VALID"
    )
    c.execute("CREATE UNIQUE INDEX IF NOT EXISTS submissions_attempt_unique ON submissions(attempt_id)")
    _ensure_legacy_context(c)
    c.execute("ALTER TABLE reports VALIDATE CONSTRAINT reports_attempt_fk")
    c.execute("ALTER TABLE reports VALIDATE CONSTRAINT reports_assignment_fk")
    c.execute("ALTER TABLE submissions VALIDATE CONSTRAINT submissions_attempt_fk")
    c.execute("ALTER TABLE reports ALTER COLUMN attempt_id SET NOT NULL")
    c.execute("ALTER TABLE reports ALTER COLUMN assignment_id SET NOT NULL")
    c.execute("ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_account_id_report_key_key")
    c.execute("CREATE UNIQUE INDEX IF NOT EXISTS reports_attempt_report_key ON reports(attempt_id,report_key)")
    c.execute("UPDATE schema_meta SET version = %s WHERE singleton", (TEACHING_DB_VERSION,))


def _ensure_legacy_context(c: psycopg.Connection[dict[str, Any]]) -> None:
    """为真实 v3 数据或本次显式播种的 demo 建立默认作用域。

    调用方必须证明自己正处于这两种 bootstrap 路径之一。普通 v4 启动不能
    调用本函数：这里会把既有班级、学生和教师汇入同一个 legacy course，若在
    多教师生产库中反复执行，会把原本隔离的课程权限扩成全局共享。
    """
    if not c.execute("SELECT 1 FROM accounts LIMIT 1").fetchone():
        return
    run = _required(
        c.execute(
            "INSERT INTO course_runs(name, code, term, release_tag)"
            " VALUES ('GVC 实验课程', 'GVC-LEGACY', '', 'legacy-v3')"
            " ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id"
        ).fetchone(),
        "ensure legacy course",
    )
    run_id = run["id"]
    c.execute(
        "INSERT INTO course_class_links(course_run_id, class_id) SELECT %s, id FROM classes ON CONFLICT DO NOTHING",
        (run_id,),
    )
    c.execute(
        "INSERT INTO teacher_course_access(teacher_account_id, course_run_id)"
        " SELECT id, %s FROM accounts WHERE role = 'teacher' ON CONFLICT DO NOTHING",
        (run_id,),
    )
    manifest = c.execute(
        "SELECT manifest_id FROM ("
        " SELECT manifest_id, updated_at AS ts FROM experiment_sessions"
        " UNION ALL SELECT manifest_id, created_at FROM reports"
        ") x WHERE manifest_id <> '' ORDER BY ts DESC LIMIT 1"
    ).fetchone()
    assignment = _required(
        c.execute(
            "INSERT INTO assignments(course_run_id, slug, title, manifest_id, release_tag)"
            " VALUES (%s, 'main', '16 步 GVC 实验', %s, 'legacy-v3')"
            " ON CONFLICT (course_run_id, slug) DO UPDATE SET title = EXCLUDED.title RETURNING id",
            (run_id, manifest["manifest_id"] if manifest else ""),
        ).fetchone(),
        "ensure legacy assignment",
    )
    assignment_id = assignment["id"]
    c.execute(
        "INSERT INTO enrollments(course_run_id, account_id, class_id)"
        " SELECT %s, id, class_id FROM accounts WHERE role = 'student' ON CONFLICT DO NOTHING",
        (run_id,),
    )
    c.execute(
        "INSERT INTO experiment_attempts(assignment_id, enrollment_id, attempt_no, state)"
        " SELECT %s, e.id, 1, 'active'"
        " FROM enrollments e LEFT JOIN submissions s ON s.account_id = e.account_id"
        " WHERE e.course_run_id = %s"
        " ON CONFLICT (assignment_id, enrollment_id, attempt_no) DO NOTHING",
        (assignment_id, run_id),
    )
    # ``attempt.state`` 表示是否仍是当前可恢复尝试；提交状态由 submissions 管理。
    # 已提交仍保持 active，以支持修订版和刷新恢复，只有显式重置/新尝试才归档。
    c.execute(
        "INSERT INTO attempt_step_progress(attempt_id, current_step, max_step, updated_at)"
        " SELECT at.id, p.current_step, p.max_step, p.updated_at"
        " FROM step_progress p JOIN enrollments e ON e.account_id = p.account_id"
        " JOIN experiment_attempts at ON at.enrollment_id=e.id AND at.assignment_id=%s AND at.attempt_no=1"
        " ON CONFLICT (attempt_id) DO NOTHING",
        (assignment_id,),
    )
    c.execute(
        "INSERT INTO attempt_sessions(attempt_id, revision, manifest_id, session, legacy_unverified, updated_at)"
        " SELECT at.id, s.revision, s.manifest_id, s.session, true, s.updated_at"
        " FROM experiment_sessions s JOIN enrollments e ON e.account_id=s.account_id"
        " JOIN experiment_attempts at ON at.enrollment_id=e.id AND at.assignment_id=%s AND at.attempt_no=1"
        " ON CONFLICT (attempt_id) DO NOTHING",
        (assignment_id,),
    )
    c.execute(
        "UPDATE reports r SET attempt_id=at.id, assignment_id=%s"
        " FROM enrollments e JOIN experiment_attempts at ON at.enrollment_id=e.id AND at.assignment_id=%s"
        " WHERE r.account_id=e.account_id AND r.attempt_id IS NULL",
        (assignment_id, assignment_id),
    )
    c.execute(
        "UPDATE submissions s SET attempt_id=at.id"
        " FROM enrollments e JOIN experiment_attempts at ON at.enrollment_id=e.id AND at.assignment_id=%s"
        " WHERE s.account_id=e.account_id AND s.attempt_id IS NULL",
        (assignment_id,),
    )
    c.execute(
        "INSERT INTO submission_versions(submission_id, version_no, report_id, title, year, design, markdown, submitted_at)"
        " SELECT s.id, 1, r.id, s.title, s.year, s.design, s.markdown, s.submitted_at"
        " FROM submissions s LEFT JOIN reports r ON r.account_id=s.account_id"
        "  AND r.report_key=s.design->>'report_key'"
        " ON CONFLICT (submission_id, version_no) DO NOTHING"
    )
    c.execute(
        "INSERT INTO grading_events(submission_id, submission_version_id, score, feedback, graded_by_account_id, graded_at)"
        " SELECT s.id, sv.id, s.score, s.feedback, grader.id, coalesce(s.graded_at, s.submitted_at)"
        " FROM submissions s JOIN submission_versions sv ON sv.submission_id=s.id AND sv.version_no=1"
        " JOIN accounts grader ON grader.username=s.graded_by"
        " WHERE s.state='graded' AND s.score IS NOT NULL"
        " AND NOT EXISTS (SELECT 1 FROM grading_events g WHERE g.submission_id=s.id)"
    )


def initialize_schema() -> list[str]:
    """建表/安全迁移并播种；从 v3 升级不需要 reset。"""
    global _schema_ready
    c = _connect()
    applied: list[str] = []
    try:
        with c:
            # 先加锁再校验/建表，避免两个首次请求同时创建系统表或播种账号。
            _lock_schema(c)
            version = _existing_version(c)
            fresh = version is None
            if version == "gvcsim-teaching-db-v3":
                _migrate_v3_to_v4(c)
                applied.append("安全迁移 v3 → v4（保留课堂、会话、报告、提交与评分）")
            elif version not in {None, TEACHING_DB_VERSION}:
                raise SchemaVersionMismatch(
                    f"教学库 schema 版本为 {version}，当前代码需要 {TEACHING_DB_VERSION}；"
                    "没有已验证的自动迁移路径，请先备份并按部署文档处理，禁止直接 reset 生产数据"
                )
            else:
                c.execute(_SCHEMA)
                c.execute(
                    "INSERT INTO schema_meta(singleton, version) VALUES (true, %s) ON CONFLICT (singleton) DO NOTHING",
                    (TEACHING_DB_VERSION,),
                )
            # v4 开发期新增的非破坏性列也保持幂等，避免早期 v4 测试库需 reset。
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
            # 内完成；普通 v4 重启绝不能再次把所有教师/班级/学生汇入 legacy run。
            if _seed_if_empty(c):
                _ensure_legacy_context(c)
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
        return psycopg.connect(config.PG_DSN, row_factory=dict_row, connect_timeout=3)
    except psycopg.OperationalError as e:
        raise Unavailable(str(e)) from e


def conn() -> psycopg.Connection[dict[str, Any]]:
    """拿一个已保证建表并完成迁移的连接(with 语句用完即关)。"""
    if not _schema_ready:
        initialize_schema()
    return _connect()


def readiness() -> dict[str, Any]:
    """轻量就绪探针：连接、schema 版本与事务读均必须正常。"""
    with conn() as c:
        row = c.execute("SELECT version,now() AS checked_at FROM schema_meta WHERE singleton").fetchone()
        if not row or row["version"] != TEACHING_DB_VERSION:
            raise SchemaVersionMismatch("教学数据库 schema 未就绪")
        return {"status": "ok", "schema_version": row["version"]}


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


def revoke_account_sessions(account_id: int) -> None:
    with conn() as c:
        c.execute("UPDATE auth_sessions SET revoked_at=coalesce(revoked_at, now()) WHERE account_id=%s", (account_id,))


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


# ---------------------------------------------------------------- 课程运行 / 作业 / enrollment / attempt


def _attempt_scope(
    c: psycopg.Connection[dict[str, Any]],
    username: str,
    manifest_id: str | None = None,
    *,
    create: bool = True,
    course_run_ids: list[int] | None = None,
) -> dict[str, Any] | None:
    """解析学生当前作业尝试；所有学习记录必须经此函数取得作用域。"""
    course_scope = " AND cr.id=ANY(%s)" if course_run_ids is not None else ""
    params: tuple[Any, ...] = (username, course_run_ids) if course_run_ids is not None else (username,)
    row = c.execute(
        "SELECT a.id AS account_id,a.class_id,cr.id AS course_run_id,cr.code AS course_run_code,"
        " ass.id AS assignment_id,ass.slug AS assignment_slug,ass.title AS assignment_title,"
        " ass.manifest_id AS assignment_manifest_id,ass.opens_at,ass.due_at,"
        " (ass.due_at IS NOT NULL AND ass.due_at<=now()) AS assignment_closed,e.id AS enrollment_id,"
        " at.id AS attempt_id,at.attempt_no,at.state AS attempt_state"
        " FROM accounts a JOIN enrollments e ON e.account_id=a.id AND e.active"
        " JOIN course_runs cr ON cr.id=e.course_run_id AND NOT cr.archived"
        " JOIN assignments ass ON ass.course_run_id=cr.id AND ass.active"
        " LEFT JOIN LATERAL (SELECT x.* FROM experiment_attempts x"
        "   WHERE x.assignment_id=ass.id AND x.enrollment_id=e.id"
        "   ORDER BY (x.state='active') DESC,x.attempt_no DESC LIMIT 1) at ON true"
        " WHERE a.username=%s AND a.role='student' AND a.active"
        " AND (ass.opens_at IS NULL OR ass.opens_at<=now())"
        f"{course_scope}"
        " ORDER BY (ass.due_at IS NULL OR ass.due_at>now()) DESC,ass.created_at DESC LIMIT 1",
        params,
    ).fetchone()
    if row is None:
        return None
    row["assignment_scope"] = (
        f"course:{row['course_run_id']}/assignment:{row['assignment_id']}/attempt:{row['attempt_id']}"
    )
    if manifest_id:
        assigned = row["assignment_manifest_id"]
        if assigned and assigned != manifest_id:
            return {**row, "manifest_mismatch": True}
        if not assigned and not row["assignment_closed"]:
            c.execute(
                "UPDATE assignments SET manifest_id=%s WHERE id=%s AND manifest_id=''",
                (manifest_id, row["assignment_id"]),
            )
            row["assignment_manifest_id"] = manifest_id
    if create and not row["assignment_closed"] and (row["attempt_id"] is None or row["attempt_state"] != "active"):
        next_no = _required(
            c.execute(
                "SELECT coalesce(max(attempt_no),0)+1 AS n FROM experiment_attempts"
                " WHERE assignment_id=%s AND enrollment_id=%s",
                (row["assignment_id"], row["enrollment_id"]),
            ).fetchone(),
            "next attempt number",
        )["n"]
        created = _required(
            c.execute(
                "INSERT INTO experiment_attempts(assignment_id,enrollment_id,attempt_no) VALUES (%s,%s,%s)"
                " RETURNING id,attempt_no,state",
                (row["assignment_id"], row["enrollment_id"], next_no),
            ).fetchone(),
            "create attempt",
        )
        row.update(
            {"attempt_id": created["id"], "attempt_no": created["attempt_no"], "attempt_state": created["state"]}
        )
    row["assignment_scope"] = (
        f"course:{row['course_run_id']}/assignment:{row['assignment_id']}/attempt:{row['attempt_id']}"
    )
    return row


def _require_assignment_writable(scope: dict[str, Any]) -> None:
    if scope.get("assignment_closed"):
        due_at = scope.get("due_at")
        isoformat = getattr(due_at, "isoformat", None)
        rendered = str(isoformat()) if callable(isoformat) else str(due_at or "")
        raise AssignmentClosed(f"作业已于 {rendered} 截止；现可查看既有记录，但不能继续写入或提交")


def assignment_context(username: str, manifest_id: str | None = None) -> dict[str, Any] | None:
    with conn() as c:
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
) -> bool:
    """确认事件属于学生**当前**解析出的 assignment/attempt。

    仅检查 token 自称的旧 attempt 仍为 ``active`` 不够：教师发布同一 manifest
    的新 assignment 时，旧 assignment 的 attempt 不会自动归档。若不再核对当前
    scope，旧收据可被复制到新作业。这里同时核对事件的教学语义字段，learning、
    regression 与 placebo 共用这一道不可跨作业重放的边界。
    """
    with conn() as c:
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


def teacher_can_access_submission(username: str, submission_id: int) -> bool:
    with conn() as c:
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


def start_new_attempt(username: str, manifest_id: str) -> dict[str, Any]:
    """显式归档当前尝试并创建下一次；既有证据、提交和评分保持不可变。"""
    with conn() as c:
        with c.transaction():
            scope = _attempt_scope(c, username, manifest_id)
            if not scope or scope.get("manifest_mismatch"):
                raise AssignmentScopeMismatch("没有与当前 manifest 匹配的开放作业")
            _require_assignment_writable(scope)
            c.execute(
                "UPDATE experiment_attempts SET state='archived',updated_at=now() WHERE id=%s AND state='active'",
                (scope["attempt_id"],),
            )
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
        summary = evidence.completion_summary(session["session"], subject=username, require_trusted=True)
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
) -> dict[str, Any] | None:
    """写入会话;并发写入时按记录级时间戳合并,不整份覆盖。

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
            current = c.execute(
                "SELECT revision,session,legacy_unverified FROM attempt_sessions WHERE attempt_id=%s FOR UPDATE",
                (attempt_id,),
            ).fetchone()
            if current is not None and current["legacy_unverified"]:
                raise LegacySessionReadOnly("迁移前会话未经可信证据验证；请先导出记录并显式重新开始")

            merged = session
            merged_from: int | None = None
            if current is not None and current["revision"] != base_revision:
                merged = merge(current["session"], session)
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


def clear_session(username: str) -> None:
    """一致性重置当前尝试。

    归档旧尝试并创建下一 attempt；当前进度/报告/提交自然为空，历史记录仍可
    审计。旧 evidence event 同时撤销，不能跨 attempt 复用。
    """
    with conn() as c:
        with c.transaction():
            scope = _attempt_scope(c, username)
            if not scope or scope["attempt_id"] is None:
                return
            _require_assignment_writable(scope)
            # 每次重置都换 attempt 边界：旧 evidence token 绑定旧 attempt，无法在
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


# ---------------------------------------------------------------- 服务端生成的报告


def save_report(
    username: str,
    report_key: str,
    session_revision: int,
    manifest_id: str,
    markdown: str,
    provenance: dict[str, Any],
) -> dict[str, Any] | None:
    """落库一份服务端生成的报告。

    报告内容不可变：相同 report_key 幂等返回原行，不更新时间/正文。
    """
    with conn() as c:
        scope = _attempt_scope(c, username, manifest_id)
        if not scope or scope.get("manifest_mismatch"):
            raise AssignmentScopeMismatch("报告不属于当前 assignment/manifest")
        _require_assignment_writable(scope)
        row = c.execute(
            "INSERT INTO reports(account_id,attempt_id,assignment_id,report_key,session_revision,manifest_id,markdown,provenance)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (attempt_id,report_key) DO NOTHING"
            " RETURNING id,report_key,session_revision,manifest_id,created_at",
            (
                scope["account_id"],
                scope["attempt_id"],
                scope["assignment_id"],
                report_key,
                session_revision,
                manifest_id,
                markdown,
                json.dumps(provenance, ensure_ascii=False),
            ),
        ).fetchone()
        return (
            row
            or c.execute(
                "SELECT id,report_key,session_revision,manifest_id,created_at FROM reports"
                " WHERE account_id=%s AND report_key=%s AND attempt_id=%s",
                (scope["account_id"], report_key, scope["attempt_id"]),
            ).fetchone()
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
    """单事务写入服务端报告与 step16 会话证据。

    不接受并发 merge：报告正文基于 ``base_revision`` 重算；若会话已推进，
    合并后正文与证据将不再属于同一快照，因此明确冲突并要求重新生成。
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


def report_by_key(username: str, report_key: str) -> dict[str, Any] | None:
    with conn() as c:
        scope = _attempt_scope(c, username)
        if not scope:
            return None
        return c.execute(
            "SELECT r.id, r.report_key, r.session_revision, r.manifest_id, r.markdown, r.provenance, r.created_at"
            " FROM reports r JOIN accounts a ON a.id = r.account_id"
            " WHERE a.username = %s AND r.report_key = %s AND r.attempt_id=%s",
            (username, report_key, scope["attempt_id"]),
        ).fetchone()


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
