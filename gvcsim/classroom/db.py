"""教学数据库(PostgreSQL):班级/学生账号/实验进度/报告提交评阅/公告。

设计取舍(教学系统定位,刻意保持简单):
  - 每次操作短连接,不引入连接池;班级规模(几十人)下开销可忽略
  - 无迁移工具:CREATE TABLE IF NOT EXISTS 懒建表,accounts 为空时播种演示数据
  - 数据库不可用统一抛 Unavailable:API 层转 503,认证层回退演示账号,
    核心 17 步实验流程完全不依赖本库
  - 每账号独立随机盐 + PBKDF2 哈希;停用账号不吊销已发令牌(≤12h 自然过期)
"""

import hashlib
import json
import secrets
from typing import Any

import psycopg
from psycopg.rows import dict_row

from gvcsim import config

MAX_STEP = 17


class Unavailable(Exception):
    """教学数据库不可用(未启动/未建库/网络不通)。"""


def hash_password(password: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 100_000).hex()


_SCHEMA = """
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
  current_step int NOT NULL CHECK (current_step BETWEEN 1 AND 17),
  max_step     int NOT NULL CHECK (max_step BETWEEN 1 AND 17),
  updated_at   timestamptz NOT NULL DEFAULT now()
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


def _connect() -> psycopg.Connection[dict[str, Any]]:
    try:
        return psycopg.connect(config.PG_DSN, row_factory=dict_row, connect_timeout=3)
    except psycopg.OperationalError as e:
        raise Unavailable(str(e)) from e


def conn() -> psycopg.Connection[dict[str, Any]]:
    """拿一个已保证建表的连接(with 语句用完即关)。"""
    global _schema_ready
    c = _connect()
    if not _schema_ready:
        try:
            with c:
                c.execute(_SCHEMA)
                _seed_if_empty(c)
            _schema_ready = True
            c = _connect()
        except psycopg.Error as e:
            c.close()
            raise Unavailable(str(e)) from e
    return c


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
            "请按课程大纲完成 17 步实验;完成步骤 17 后,在报告页点击「提交报告给老师」,教师评阅后可在同一页面查看得分与评语。",
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


# ---------------------------------------------------------------- 报告提交与评阅


def submit_report(username: str, year: int, title: str, design: dict, markdown: str) -> dict[str, Any] | None:
    """提交(或重交,覆盖并重置评阅)现行报告。"""
    with conn() as c:
        return c.execute(
            "INSERT INTO submissions(account_id, title, year, design, markdown)"
            " SELECT id, %s, %s, %s, %s FROM accounts WHERE username = %s"
            " ON CONFLICT (account_id) DO UPDATE SET"
            " title = EXCLUDED.title, year = EXCLUDED.year, design = EXCLUDED.design,"
            " markdown = EXCLUDED.markdown, state = 'pending', score = NULL, feedback = '',"
            " graded_by = NULL, graded_at = NULL, submitted_at = now()"
            " RETURNING id, state, submitted_at",
            (title, year, json.dumps(design, ensure_ascii=False), markdown, username),
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
        "step_completion": [{"step": r["step"], "reached": r["reached"]} for r in steps],
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
