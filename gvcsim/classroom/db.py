"""教学数据库(PostgreSQL):班级/学生账号/实验会话/进度/报告提交评阅/公告。

设计取舍(教学系统定位,刻意保持简单):
  - 每次操作短连接,不引入连接池;班级规模(几十人)下开销可忽略
  - CREATE TABLE IF NOT EXISTS 懒建表,但先过 schema_meta 版本闸门:
    版本不符即明确失败并要求 reset,不在旧库上叠加新表、也不迁移旧语义
  - 数据库不可用统一抛 Unavailable:API 层转 503,认证层回退演示账号;
    但实验会话(逐步实验状态的持久化)确实依赖本库
  - 每账号独立随机盐 + PBKDF2 哈希;停用账号不吊销已发令牌(≤12h 自然过期)
"""

import hashlib
import json
import secrets
from collections.abc import Callable
from typing import Any

import psycopg
from psycopg.rows import dict_row

from gvcsim import config

MAX_STEP = 16
_SCHEMA_LOCK_ID = 736_861_016  # 固定事务级 advisory lock，串行化首次建表/播种
# 会话写入的 advisory lock 命名空间(与 account_id 组成两段锁键,不与建表锁冲突)
_SESSION_LOCK_NS = 736_861_017

# 教学库 schema 版本。本系统不做历史格式兼容:版本不符即明确失败并要求
# 一次性 reset,而不是就地迁移旧语义。改动表结构时必须同时改这个字符串。
TEACHING_DB_VERSION = "gvcsim-teaching-db-v3"


class Unavailable(Exception):
    """教学数据库不可用(未启动/未建库/网络不通)。"""


class SchemaVersionMismatch(RuntimeError):
    """教学库 schema 版本与当前代码不符,需要一次性 reset。"""


def hash_password(password: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 100_000).hex()


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
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
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
  report_key       text NOT NULL,
  session_revision bigint NOT NULL,
  manifest_id      text NOT NULL,
  markdown         text NOT NULL,
  provenance       jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, report_key)
);
CREATE TABLE IF NOT EXISTS submissions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    bigint NOT NULL UNIQUE REFERENCES accounts(id),
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


def _check_schema_version(c: psycopg.Connection[dict[str, Any]]) -> None:
    """版本闸门:不符即明确失败。

    绝不能在版本不符的库上继续 CREATE TABLE IF NOT EXISTS——那会让新旧两套
    表并存,而 schema_meta 仍写着旧版本,数据库从此对自己的身份说谎。
    """
    version = _existing_version(c)
    if version is None or version == TEACHING_DB_VERSION:
        return
    raise SchemaVersionMismatch(
        f"教学库 schema 版本为 {version},当前代码需要 {TEACHING_DB_VERSION}。"
        f"本系统不做历史格式兼容,请执行一次性重置:"
        f"uv run gvcsim classroom-init --reset(会删除全部教学数据)"
    )


def initialize_schema() -> list[str]:
    """校验版本、建表并播种;返回本次执行的动作说明。"""
    global _schema_ready
    c = _connect()
    applied: list[str] = []
    try:
        with c:
            # 先加锁再校验/建表，避免两个首次请求同时创建系统表或播种账号。
            _lock_schema(c)
            _check_schema_version(c)
            fresh = _existing_version(c) is None
            c.execute(_SCHEMA)
            c.execute(
                "INSERT INTO schema_meta(singleton, version) VALUES (true, %s) ON CONFLICT (singleton) DO NOTHING",
                (TEACHING_DB_VERSION,),
            )
            if fresh:
                applied.append(f"创建 schema {TEACHING_DB_VERSION}")
            _seed_if_empty(c)
    except SchemaVersionMismatch:
        c.close()
        raise
    except psycopg.Error as e:
        c.close()
        raise Unavailable(str(e)) from e
    _schema_ready = True
    return applied


def _connect() -> psycopg.Connection[dict[str, Any]]:
    try:
        return psycopg.connect(config.PG_DSN, row_factory=dict_row, connect_timeout=3)
    except psycopg.OperationalError as e:
        raise Unavailable(str(e)) from e


def conn() -> psycopg.Connection[dict[str, Any]]:
    """拿一个已保证建表并完成迁移的连接(with 语句用完即关)。"""
    if not _schema_ready:
        initialize_schema()
    return _connect()


def _seed_if_empty(c: psycopg.Connection[dict[str, Any]]) -> None:
    if c.execute("SELECT 1 FROM accounts LIMIT 1").fetchone():
        return
    row = c.execute(
        "INSERT INTO classes(name, code, semester, note) VALUES (%s, %s, %s, %s) RETURNING id",
        ("GVC 实验演示班", "GVC-DEMO", "2026 春", "默认演示班级,用于课堂演示与自测。"),
    ).fetchone()
    class_id = row["id"]
    for username, display_name, role, cls, student_no in (
        ("teacher", "老师", "teacher", None, ""),
        ("student", "同学", "student", class_id, "2026001"),
    ):
        salt = secrets.token_hex(16)
        c.execute(
            "INSERT INTO accounts(username, display_name, role, class_id, student_no, pw_salt, pw_hash)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (username, display_name, role, cls, student_no, salt, hash_password("gvclab2026", salt)),
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


# ---------------------------------------------------------------- 账号与认证


def find_account(username: str) -> dict[str, Any] | None:
    with conn() as c:
        return c.execute("SELECT * FROM accounts WHERE username = %s", (username,)).fetchone()


def touch_login(username: str) -> None:
    with conn() as c:
        c.execute("UPDATE accounts SET last_login_at = now() WHERE username = %s", (username,))


# ---------------------------------------------------------------- 班级与学生


def list_classes() -> list[dict[str, Any]]:
    with conn() as c:
        return c.execute(
            "SELECT cl.*, count(a.id) AS student_count FROM classes cl"
            " LEFT JOIN accounts a ON a.class_id = cl.id AND a.role = 'student'"
            " GROUP BY cl.id ORDER BY cl.id"
        ).fetchall()


def create_class(name: str, code: str, semester: str = "", note: str = "") -> dict[str, Any]:
    with conn() as c:
        row = c.execute(
            "INSERT INTO classes(name, code, semester, note) VALUES (%s, %s, %s, %s) RETURNING *",
            (name, code, semester, note),
        ).fetchone()
    assert row is not None  # INSERT ... RETURNING 必有一行
    return row


_STUDENT_COLS = "a.id, a.username, a.display_name, a.class_id, a.student_no, a.active, a.last_login_at, a.created_at"


def list_students(class_id: int | None = None) -> list[dict[str, Any]]:
    """学生列表,联进度与提交状态(教师面板的进度矩阵数据)。"""
    where = "WHERE a.role = 'student'" + (" AND a.class_id = %s" if class_id is not None else "")
    params = (class_id,) if class_id is not None else ()
    with conn() as c:
        return c.execute(
            f"SELECT {_STUDENT_COLS}, cl.name AS class_name,"
            " p.current_step, p.max_step, p.updated_at AS progress_at,"
            " s.id AS submission_id, s.state AS submission_state, s.score, s.submitted_at"
            " FROM accounts a"
            " LEFT JOIN classes cl ON cl.id = a.class_id"
            " LEFT JOIN step_progress p ON p.account_id = a.id"
            " LEFT JOIN submissions s ON s.account_id = a.id"
            f" {where} ORDER BY a.class_id NULLS LAST, a.student_no, a.username",
            params,
        ).fetchall()


def create_student(
    username: str, display_name: str, password: str, student_no: str = "", class_id: int | None = None
) -> dict[str, Any]:
    salt = secrets.token_hex(16)
    with conn() as c:
        row = c.execute(
            "INSERT INTO accounts(username, display_name, role, class_id, student_no, pw_salt, pw_hash)"
            f" VALUES (%s, %s, 'student', %s, %s, %s, %s) RETURNING {_STUDENT_COLS.replace('a.', '')}",
            (username, display_name, class_id, student_no, salt, hash_password(password, salt)),
        ).fetchone()
    assert row is not None
    return row


def update_student(account_id: int, fields: dict[str, Any]) -> dict[str, Any] | None:
    """部分更新:display_name / student_no / class_id / active / password(重设密码)。"""
    sets, params = [], []
    for key in ("display_name", "student_no", "class_id", "active"):
        if key in fields:
            sets.append(f"{key} = %s")
            params.append(fields[key])
    if fields.get("password"):
        salt = secrets.token_hex(16)
        sets += ["pw_salt = %s", "pw_hash = %s"]
        params += [salt, hash_password(fields["password"], salt)]
    if not sets:
        return None
    with conn() as c:
        return c.execute(
            f"UPDATE accounts SET {', '.join(sets)} WHERE id = %s AND role = 'student'"
            f" RETURNING {_STUDENT_COLS.replace('a.', '')}",
            (*params, account_id),
        ).fetchone()


# ---------------------------------------------------------------- 实验进度


def upsert_progress(username: str, step: int) -> None:
    step = max(1, min(MAX_STEP, step))
    with conn() as c:
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
        return c.execute(
            "SELECT p.current_step, p.max_step, p.updated_at"
            " FROM step_progress p JOIN accounts a ON a.id = p.account_id"
            " WHERE a.username = %s AND a.role = 'student'",
            (username,),
        ).fetchone()


# ---------------------------------------------------------------- 实验会话


def get_session(username: str) -> dict[str, Any] | None:
    """读取学生的实验会话;从未保存过则返回 None。"""
    with conn() as c:
        return c.execute(
            "SELECT s.revision, s.manifest_id, s.session, s.updated_at"
            " FROM experiment_sessions s JOIN accounts a ON a.id = s.account_id"
            " WHERE a.username = %s AND a.role = 'student'",
            (username,),
        ).fetchone()


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
            account = c.execute(
                "SELECT id FROM accounts WHERE username = %s AND role = 'student'", (username,)
            ).fetchone()
            if account is None:
                return None
            # 按账号串行化整个读-合并-写。
            #
            # 不能只靠下面那句 SELECT ... FOR UPDATE:行不存在时它锁不住任何东西。
            # 首次并发写入(两个标签页都还没有会话行)会双双读到 current=None →
            # 都跳过 merge → 都算出 revision=1 → 后到的 ON CONFLICT DO UPDATE
            # 整份覆盖先到的,一边的实验被静默丢弃。advisory 锁对"尚不存在的行"
            # 同样有效,因此把首写竞态也一起关掉。
            c.execute("SELECT pg_advisory_xact_lock(%s, %s)", (_SESSION_LOCK_NS, account["id"]))
            current = c.execute(
                "SELECT revision, session FROM experiment_sessions WHERE account_id = %s FOR UPDATE",
                (account["id"],),
            ).fetchone()

            merged = session
            merged_from: int | None = None
            if current is not None and current["revision"] != base_revision:
                merged = merge(current["session"], session)
                merged_from = current["revision"]
            revision = (current["revision"] + 1) if current is not None else 1

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
    with conn() as c:
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

    同一 report_key 表示同一份会话内容 + 同一套产物,重复生成即幂等更新,
    不会堆出一串实质相同的报告。
    """
    with conn() as c:
        return c.execute(
            "INSERT INTO reports(account_id, report_key, session_revision, manifest_id, markdown, provenance)"
            " SELECT id, %s, %s, %s, %s, %s FROM accounts WHERE username = %s AND role = 'student'"
            " ON CONFLICT (account_id, report_key) DO UPDATE SET"
            " session_revision = EXCLUDED.session_revision, markdown = EXCLUDED.markdown,"
            " provenance = EXCLUDED.provenance, created_at = now()"
            " RETURNING id, report_key, session_revision, manifest_id, created_at",
            (report_key, session_revision, manifest_id, markdown, json.dumps(provenance, ensure_ascii=False), username),
        ).fetchone()


def latest_report(username: str) -> dict[str, Any] | None:
    """读取学生最近生成的报告(刷新后可重新打开全文)。"""
    with conn() as c:
        return c.execute(
            "SELECT r.id, r.report_key, r.session_revision, r.manifest_id, r.markdown, r.provenance, r.created_at"
            " FROM reports r JOIN accounts a ON a.id = r.account_id"
            " WHERE a.username = %s ORDER BY r.created_at DESC LIMIT 1",
            (username,),
        ).fetchone()


def report_by_key(username: str, report_key: str) -> dict[str, Any] | None:
    with conn() as c:
        return c.execute(
            "SELECT r.id, r.report_key, r.session_revision, r.manifest_id, r.markdown, r.provenance, r.created_at"
            " FROM reports r JOIN accounts a ON a.id = r.account_id"
            " WHERE a.username = %s AND r.report_key = %s",
            (username, report_key),
        ).fetchone()


# ---------------------------------------------------------------- 报告提交与评阅


def submit_report(username: str, title: str, report_key: str) -> dict[str, Any] | None:
    """提交学生**已由服务端生成**的那份报告。

    正文与溯源都从 reports 表里取,接口不接受任何客户端提供的 Markdown:
    否则"报告已提交"只能证明有人上传过一段文字,证明不了他做过课程。
    找不到对应 report_key(没生成过/不是本人的)时返回 None。
    """
    with conn() as c:
        return c.execute(
            "INSERT INTO submissions(account_id, title, year, design, markdown)"
            " SELECT r.account_id, %s,"
            "        coalesce((r.provenance #>> '{artifact,years,-1}')::int, 0),"
            "        jsonb_build_object("
            "          'report_key', r.report_key, 'manifest_id', r.manifest_id,"
            "          'session_revision', r.session_revision, 'runs', r.provenance -> 'runs'),"
            "        r.markdown"
            " FROM reports r JOIN accounts a ON a.id = r.account_id"
            " WHERE a.username = %s AND a.role = 'student' AND r.report_key = %s"
            " ON CONFLICT (account_id) DO UPDATE SET"
            " title = EXCLUDED.title, year = EXCLUDED.year, design = EXCLUDED.design,"
            " markdown = EXCLUDED.markdown, state = 'pending', score = NULL, feedback = '',"
            " graded_by = NULL, graded_at = NULL, submitted_at = now()"
            " RETURNING id, state, submitted_at",
            (title, username, report_key),
        ).fetchone()


def my_submission(username: str) -> dict[str, Any] | None:
    with conn() as c:
        return c.execute(
            "SELECT s.id, s.title, s.year, s.state, s.score, s.feedback, s.graded_by, s.graded_at, s.submitted_at"
            " FROM submissions s JOIN accounts a ON a.id = s.account_id WHERE a.username = %s",
            (username,),
        ).fetchone()


def list_submissions() -> list[dict[str, Any]]:
    with conn() as c:
        return c.execute(
            "SELECT s.id, s.title, s.year, s.state, s.score, s.graded_by, s.graded_at, s.submitted_at,"
            " a.username, a.display_name, a.student_no, cl.name AS class_name"
            " FROM submissions s JOIN accounts a ON a.id = s.account_id"
            " LEFT JOIN classes cl ON cl.id = a.class_id"
            " ORDER BY s.state, s.submitted_at DESC"
        ).fetchall()


def get_submission(submission_id: int) -> dict[str, Any] | None:
    with conn() as c:
        return c.execute(
            "SELECT s.*, a.username, a.display_name, a.student_no, cl.name AS class_name"
            " FROM submissions s JOIN accounts a ON a.id = s.account_id"
            " LEFT JOIN classes cl ON cl.id = a.class_id WHERE s.id = %s",
            (submission_id,),
        ).fetchone()


def grade_submission(submission_id: int, score: int, feedback: str, graded_by: str) -> dict[str, Any] | None:
    with conn() as c:
        return c.execute(
            "UPDATE submissions SET state = 'graded', score = %s, feedback = %s,"
            " graded_by = %s, graded_at = now() WHERE id = %s"
            " RETURNING id, state, score, feedback, graded_by, graded_at",
            (score, feedback, graded_by, submission_id),
        ).fetchone()


# ---------------------------------------------------------------- 公告


def list_announcements(username: str) -> list[dict[str, Any]]:
    """全局公告 + 本人班级公告;教师看全部。"""
    with conn() as c:
        me = c.execute("SELECT role, class_id FROM accounts WHERE username = %s", (username,)).fetchone()
        if me and me["role"] == "teacher":
            where, params = "TRUE", ()
        else:
            where, params = "(an.class_id IS NULL OR an.class_id = %s)", ((me or {}).get("class_id"),)
        return c.execute(
            f"SELECT an.*, cl.name AS class_name FROM announcements an"
            f" LEFT JOIN classes cl ON cl.id = an.class_id WHERE {where} ORDER BY an.created_at DESC",
            params,
        ).fetchall()


def create_announcement(title: str, body: str, author: str, class_id: int | None = None) -> dict[str, Any]:
    with conn() as c:
        row = c.execute(
            "INSERT INTO announcements(class_id, title, body, author) VALUES (%s, %s, %s, %s) RETURNING *",
            (class_id, title, body, author),
        ).fetchone()
    assert row is not None
    return row


def delete_announcement(announcement_id: int) -> bool:
    with conn() as c:
        return (
            c.execute("DELETE FROM announcements WHERE id = %s RETURNING id", (announcement_id,)).fetchone() is not None
        )


# ---------------------------------------------------------------- 概览统计


def overview_stats(class_id: int | None = None) -> dict[str, Any]:
    """教师概览:人数/提交/评分统计 + 分数段 + 各步到达率。"""
    where = "a.role = 'student'" + (" AND a.class_id = %s" if class_id is not None else "")
    params = (class_id,) if class_id is not None else ()
    with conn() as c:
        base = c.execute(
            "SELECT count(*) AS student_count,"
            " count(*) FILTER (WHERE NOT a.active) AS disabled_count,"
            " count(s.id) AS submitted,"
            " count(s.id) FILTER (WHERE s.state = 'graded') AS graded,"
            " round(avg(s.score) FILTER (WHERE s.state = 'graded'), 1) AS avg_score"
            f" FROM accounts a LEFT JOIN submissions s ON s.account_id = a.id WHERE {where}",
            params,
        ).fetchone()
        buckets = c.execute(
            "SELECT coalesce(count(*) FILTER (WHERE s.score < 60), 0) AS b0,"
            " count(*) FILTER (WHERE s.score BETWEEN 60 AND 69) AS b60,"
            " count(*) FILTER (WHERE s.score BETWEEN 70 AND 79) AS b70,"
            " count(*) FILTER (WHERE s.score BETWEEN 80 AND 89) AS b80,"
            " count(*) FILTER (WHERE s.score >= 90) AS b90"
            " FROM submissions s JOIN accounts a ON a.id = s.account_id"
            f" WHERE s.state = 'graded' AND {where}",
            params,
        ).fetchone()
        # 到达人数:max_step 只记录学生最远到过哪一步(深链即可推高),
        # 因此这是到达统计,不是完成统计;字段名与前端文案都必须说“到达”。
        steps = c.execute(
            "SELECT gs.n AS step,"
            " (SELECT count(*) FROM step_progress p JOIN accounts a ON a.id = p.account_id"
            f"  WHERE {where} AND p.max_step >= gs.n) AS reached"
            " FROM generate_series(1, %s) AS gs(n) ORDER BY gs.n",
            (*params, MAX_STEP),
        ).fetchall()
        # 近 14 天每日提交/评阅计数(补零到完整日历序列,便于前端画趋势)
        trend = c.execute(
            "SELECT to_char(gs.d, 'MM-DD') AS date,"
            "  (SELECT count(*) FROM submissions s JOIN accounts a ON a.id = s.account_id"
            f"   WHERE {where} AND s.submitted_at::date = gs.d) AS submitted,"
            "  (SELECT count(*) FROM submissions s JOIN accounts a ON a.id = s.account_id"
            f"   WHERE {where} AND s.graded_at::date = gs.d) AS graded"
            " FROM generate_series(now()::date - 13, now()::date, interval '1 day') AS gs(d)"
            " ORDER BY gs.d",
            (*params, *params),
        ).fetchall()
        # 近 7 天有进度上报的活跃学生数
        active = c.execute(
            "SELECT count(*) AS n FROM step_progress p JOIN accounts a ON a.id = p.account_id"
            f" WHERE {where} AND p.updated_at >= now() - interval '7 days'",
            params,
        ).fetchone()
        # 各班对比(与 class_id 过滤无关,始终按全部班级分组)
        by_class = c.execute(
            "SELECT cl.id AS class_id, cl.name,"
            " count(a.id) AS student_count,"
            " count(s.id) AS submitted,"
            " count(s.id) FILTER (WHERE s.state = 'graded') AS graded,"
            " round(avg(s.score) FILTER (WHERE s.state = 'graded'), 1) AS avg_score"
            " FROM classes cl"
            " LEFT JOIN accounts a ON a.class_id = cl.id AND a.role = 'student'"
            " LEFT JOIN submissions s ON s.account_id = a.id"
            " GROUP BY cl.id, cl.name ORDER BY cl.id"
        ).fetchall()
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
        "step_reach": [{"step": r["step"], "reached": r["reached"]} for r in steps],
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
