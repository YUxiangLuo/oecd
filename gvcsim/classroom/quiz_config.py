"""Release-independent teacher quiz snapshots with optimistic step concurrency."""

from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from gvcsim import quizzes
from gvcsim.classroom import db
from gvcsim.name_keys import username_key


class QuizChanged(ValueError):
    """The caller's step version or bank revision is no longer current."""


def _read(c: psycopg.Connection[dict[str, Any]], lock: str = "") -> dict[str, Any]:
    row = c.execute("SELECT revision,steps FROM quiz_config WHERE singleton" + lock).fetchone()
    if row is None:
        raise db.Unavailable("教学数据库缺少初始化题库快照")
    return {"revision": row["revision"], "steps": row["steps"]}


def load_bank(connection: psycopg.Connection[dict[str, Any]] | None = None) -> dict[str, Any]:
    if connection is not None:
        return _read(connection)
    # Verify rather than initialize: a request must never seed the singleton lazily.
    if not db._schema_ready:
        db.verify_schema()
    with db.conn() as c:
        return _read(c)


def save_step(step: int, questions: Any, expected_version: str, teacher_username: str) -> dict[str, Any]:
    normalized = quizzes.validate_questions(step, questions)
    teacher = username_key(teacher_username)
    if not db._schema_ready:
        db.verify_schema()
    with db.conn() as c:
        account = c.execute(
            "SELECT username,role FROM accounts WHERE "
            "translate(username,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=%s FOR SHARE",
            (teacher,),
        ).fetchone()
        if not account or account["role"] != "teacher":
            raise PermissionError("只有教师可以修改理解题")
        bank = _read(c, " FOR UPDATE")
        current = bank["steps"][str(step)]
        if expected_version != current["version"]:
            raise QuizChanged(
                "题目版本已更新：刚有其他教师保存了本步。你的编辑已保留，需要的内容请先复制，再点“载入最新”。"
            )
        other_ids = {q["id"] for key, entry in bank["steps"].items() if key != str(step) for q in entry["questions"]}
        if any(q["id"] in other_ids for q in normalized):
            raise ValueError("题目 ID 必须全局唯一")
        if normalized == current["questions"]:
            return bank
        bank["revision"] += 1
        bank["steps"][str(step)] = {
            "version": f"quiz-step-{step}-r{bank['revision']}",
            "questions": normalized,
            "updated_by": account["username"],
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        c.execute(
            "UPDATE quiz_config SET revision=%s,steps=%s WHERE singleton", (bank["revision"], Jsonb(bank["steps"]))
        )
        return bank


def assert_revision(c: psycopg.Connection[dict[str, Any]], expected: int) -> None:
    """Hold a shared row lock until the caller's report transaction ends."""
    bank = _read(c, " FOR SHARE")
    if type(expected) is not int or expected != bank["revision"]:
        raise QuizChanged("题库已更新，请重新生成报告")
