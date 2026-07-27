#!/usr/bin/env python3
"""为容量验收创建隔离的 50-100 学生数据库与凭证文件。

只允许操作名称以 ``_loadtest`` 结尾的数据库；``--reset`` 会重建该库的
public schema，绝不能对课堂生产库使用。
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import psycopg
from psycopg import sql


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="准备 GVC Lab 并发压测账号")
    parser.add_argument("--dsn", default=os.environ.get("GVCSIM_LOADTEST_DSN", ""))
    parser.add_argument("--password", default=os.environ.get("GVCSIM_LOADTEST_PASSWORD", ""))
    parser.add_argument("--students", type=int, default=100)
    parser.add_argument("--prefix", default="load_student")
    parser.add_argument("--output", type=Path, default=Path("data/loadtest-users.json"))
    parser.add_argument("--reset", action="store_true", help="重建专用 *_loadtest 数据库的 public schema")
    return parser


def main() -> None:
    args = _parser().parse_args()
    if not args.dsn:
        raise SystemExit("必须通过 --dsn 或 GVCSIM_LOADTEST_DSN 指定专用数据库")
    if not 1 <= args.students <= 200:
        raise SystemExit("--students 必须在 1..200 之间")
    if len(args.password) < 12:
        raise SystemExit("压测口令必须至少 12 个字符")

    info = psycopg.conninfo.conninfo_to_dict(args.dsn)
    database = str(info.get("dbname") or "")
    if not database.endswith("_loadtest"):
        raise SystemExit("安全拒绝：压测数据库名称必须以 _loadtest 结尾")

    maintenance = psycopg.conninfo.make_conninfo(args.dsn, dbname="postgres")
    with psycopg.connect(maintenance, autocommit=True) as connection:
        exists = connection.execute("SELECT 1 FROM pg_database WHERE datname=%s", (database,)).fetchone()
        if not exists:
            connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))

    if args.reset:
        with psycopg.connect(args.dsn, autocommit=True) as connection:
            connection.execute("DROP SCHEMA public CASCADE")
            connection.execute("CREATE SCHEMA public")

    # 配置必须在导入数据库模块后也显式覆盖：脚本可能从已有 shell 环境启动。
    from gvcsim import artifacts, config
    from gvcsim.classroom import db

    config.PG_DSN = args.dsn
    config.IS_PRODUCTION = False
    config.DEMO_MODE = True
    config.BOOTSTRAP_PASSWORD = args.password
    db.close_pool()
    db._schema_ready = False
    db.initialize_schema()

    runs = db.list_course_runs("teacher")
    classes = db.list_classes("teacher")
    if not runs or not classes:
        raise SystemExit("压测 demo 课程或班级初始化失败")
    course_run_id = int(runs[0]["id"])
    class_id = int(classes[0]["id"])
    current_manifest = artifacts.manifest_id()

    users: list[dict[str, str]] = []
    for index in range(1, args.students + 1):
        username = f"{args.prefix}_{index:03d}"
        account = db.find_account(username)
        if account is None:
            account = db.create_student(
                username,
                f"压测学生 {index:03d}",
                args.password,
                f"LOAD-{index:03d}",
                class_id,
                "teacher",
            )
        else:
            updated = db.update_student(
                int(account["id"]),
                {"password": args.password, "class_id": class_id, "active": True},
                "teacher",
            )
            if updated is None:
                raise SystemExit(f"无法更新压测账号 {username}")
            account = updated
        db.enroll_student("teacher", course_run_id, int(account["id"]), class_id)
        scope = db.assignment_context(username, current_manifest)
        if not scope or scope.get("manifest_mismatch"):
            raise SystemExit(f"账号 {username} 没有绑定当前 manifest 的开放作业")
        users.append({"username": username, "password": args.password})

    payload = {
        "kind": "gvcsim-capacity-test-users-v1",
        "database": database,
        "manifest_id": current_manifest,
        "users": users,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.output.chmod(0o600)
    db.close_pool()
    print(f"已准备 {len(users)} 个隔离压测账号；凭证文件：{args.output}（0600）")


if __name__ == "__main__":
    main()
