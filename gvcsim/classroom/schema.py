"""Versioned PostgreSQL schema and in-place classroom database migrations.

This module contains only DDL and migration operations over a caller-owned
transaction. Connection pooling, startup policy, and request-time queries stay
in :mod:`gvcsim.classroom.db`.
"""

from typing import Any

import psycopg
from psycopg import sql

from gvcsim.classroom import passwords

_SCHEMA_LOCK_ID = 736_861_016
TEACHING_DB_VERSION = "gvcsim-teaching-db-v7"


def _required(row: dict[str, Any] | None, operation: str) -> dict[str, Any]:
    if row is None:
        raise RuntimeError(f"数据库操作未返回预期行:{operation}")
    return row


SCHEMA_SQL = f"""
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
  pw_algorithm  text NOT NULL DEFAULT '{passwords.CURRENT_ALGORITHM}'
                CHECK (pw_algorithm = '{passwords.PBKDF2_SHA256}'),
  pw_iterations int NOT NULL DEFAULT {passwords.CURRENT_ITERATIONS}
                CHECK (pw_iterations BETWEEN {passwords.MIN_ITERATIONS} AND {passwords.MAX_ITERATIONS}),
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
CREATE TABLE IF NOT EXISTS student_assignment_selections (
  account_id    bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  assignment_id bigint NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  updated_at    timestamptz NOT NULL DEFAULT now()
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
CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_key_hash text NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_login_attempts_key_time_idx
  ON auth_login_attempts(rate_key_hash, attempted_at);
CREATE INDEX IF NOT EXISTS auth_login_attempts_time_idx
  ON auth_login_attempts(attempted_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    bigint REFERENCES accounts(id) ON DELETE SET NULL,
  actor_name  text NOT NULL DEFAULT '',
  action      text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id   text NOT NULL DEFAULT '',
  details     jsonb NOT NULL DEFAULT '{{}}'::jsonb,
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


def lock_schema(c: psycopg.Connection[dict[str, Any]]) -> None:
    """在当前事务结束前持有全局 schema 锁；同一事务重复获取是安全的。"""
    c.execute("SELECT pg_advisory_xact_lock(%s)", (_SCHEMA_LOCK_ID,))


def existing_version(c: psycopg.Connection[dict[str, Any]]) -> str | None:
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


def migrate_v3_to_v4(c: psycopg.Connection[dict[str, Any]]) -> None:
    """原地升级 v3；整个函数运行在 schema 锁保护的单一事务内。"""
    c.execute("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS auth_version int NOT NULL DEFAULT 1")
    c.execute("ALTER TABLE reports ADD COLUMN IF NOT EXISTS attempt_id bigint")
    c.execute("ALTER TABLE reports ADD COLUMN IF NOT EXISTS assignment_id bigint")
    c.execute("ALTER TABLE submissions ADD COLUMN IF NOT EXISTS attempt_id bigint")
    c.execute("ALTER TABLE submissions ADD COLUMN IF NOT EXISTS latest_version_no int NOT NULL DEFAULT 1")
    # v3 每账号只能一份提交；v4 的唯一边界是 attempt。
    c.execute("ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_account_id_key")
    c.execute(SCHEMA_SQL)
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
    ensure_legacy_context(c)
    c.execute("ALTER TABLE reports VALIDATE CONSTRAINT reports_attempt_fk")
    c.execute("ALTER TABLE reports VALIDATE CONSTRAINT reports_assignment_fk")
    c.execute("ALTER TABLE submissions VALIDATE CONSTRAINT submissions_attempt_fk")
    c.execute("ALTER TABLE reports ALTER COLUMN attempt_id SET NOT NULL")
    c.execute("ALTER TABLE reports ALTER COLUMN assignment_id SET NOT NULL")
    c.execute("ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_account_id_report_key_key")
    c.execute("CREATE UNIQUE INDEX IF NOT EXISTS reports_attempt_report_key ON reports(attempt_id,report_key)")
    c.execute("UPDATE schema_meta SET version = 'gvcsim-teaching-db-v4' WHERE singleton")


def migrate_v4_to_v5(c: psycopg.Connection[dict[str, Any]]) -> None:
    """原地增加学生的显式作业选择。

    不在迁移时猜测“当前”作业：第一次解析作用域时会优先选择已有
    提交/进度的 attempt，然后持久化。这样升级后不会把新建的空作业
    写成默认值，也不会破坏既有历史。
    """
    c.execute(
        "CREATE TABLE IF NOT EXISTS student_assignment_selections ("
        " account_id bigint PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,"
        " assignment_id bigint NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,"
        " updated_at timestamptz NOT NULL DEFAULT now())"
    )
    c.execute("UPDATE schema_meta SET version = 'gvcsim-teaching-db-v5' WHERE singleton")


def migrate_v5_to_v6(c: psycopg.Connection[dict[str, Any]]) -> None:
    """增加跨进程共享的登录失败滑动窗口，不触碰既有认证会话。"""
    c.execute(
        "CREATE TABLE IF NOT EXISTS auth_login_attempts ("
        " id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,"
        " rate_key_hash text NOT NULL,"
        " attempted_at timestamptz NOT NULL DEFAULT now())"
    )
    c.execute(
        "CREATE INDEX IF NOT EXISTS auth_login_attempts_key_time_idx ON auth_login_attempts(rate_key_hash,attempted_at)"
    )
    c.execute("CREATE INDEX IF NOT EXISTS auth_login_attempts_time_idx ON auth_login_attempts(attempted_at)")
    c.execute("UPDATE schema_meta SET version = 'gvcsim-teaching-db-v6' WHERE singleton")


def migrate_v6_to_v7(c: psycopg.Connection[dict[str, Any]]) -> None:
    """参数化旧口令哈希；保留 100k 成本并允许登录后渐进升级。"""
    c.execute(
        sql.SQL("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pw_algorithm text NOT NULL DEFAULT {}").format(
            sql.Literal(passwords.PBKDF2_SHA256)
        )
    )
    # 旧 schema 的每一行都由隐式 100k 生成；这里必须先忠实标记，不能把旧 hash
    # 错写成当前 600k。迁移完成后再把新行的数据库默认值提升到当前成本。
    c.execute(
        sql.SQL("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pw_iterations int NOT NULL DEFAULT {}").format(
            sql.Literal(passwords.LEGACY_ITERATIONS)
        )
    )
    # 版本戳测试和候选版数据库可能已经有列/约束；事务迁移保持幂等，但不会
    # 改写已显式记录的成本。
    c.execute(
        sql.SQL(
            "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint"
            " WHERE conrelid='accounts'::regclass AND conname='accounts_pw_algorithm_check') THEN"
            " ALTER TABLE accounts ADD CONSTRAINT accounts_pw_algorithm_check CHECK (pw_algorithm = {});"
            " END IF; END $$"
        ).format(sql.Literal(passwords.PBKDF2_SHA256))
    )
    c.execute(
        sql.SQL(
            "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint"
            " WHERE conrelid='accounts'::regclass AND conname='accounts_pw_iterations_check') THEN"
            " ALTER TABLE accounts ADD CONSTRAINT accounts_pw_iterations_check"
            " CHECK (pw_iterations BETWEEN {} AND {}); END IF; END $$"
        ).format(sql.Literal(passwords.MIN_ITERATIONS), sql.Literal(passwords.MAX_ITERATIONS))
    )
    c.execute(
        sql.SQL("ALTER TABLE accounts ALTER COLUMN pw_iterations SET DEFAULT {}").format(
            sql.Literal(passwords.CURRENT_ITERATIONS)
        )
    )
    c.execute("UPDATE schema_meta SET version = %s WHERE singleton", (TEACHING_DB_VERSION,))


def ensure_legacy_context(c: psycopg.Connection[dict[str, Any]]) -> None:
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
