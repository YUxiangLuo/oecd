#!/usr/bin/env python3
"""为容量验收创建隔离的 50-100 学生数据库与凭证文件。

只允许操作名称以 ``_loadtest`` 结尾的数据库；``--reset`` 会重建该库的
public schema，绝不能对课堂生产库使用。
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Any

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


def _write_credentials(output: Path, payload: dict[str, Any]) -> None:
    """以 0600 临时文件写入并原子替换，任何时刻都不暴露新凭据。"""
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=output.parent,
        prefix=f".{output.name}.",
        suffix=".tmp",
    )
    temporary = Path(temporary_name)
    try:
        # mkstemp 已承诺 0600；这里显式收紧，防止平台差异或后续重构破坏契约。
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = -1  # fdopen 已接管 descriptor
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output)
    except BaseException:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass
        temporary.unlink(missing_ok=True)
        raise


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
    from gvcsim import config
    from gvcsim.classroom import db

    config.PG_DSN = args.dsn
    config.IS_PRODUCTION = False
    config.DEMO_MODE = True
    config.BOOTSTRAP_PASSWORD = args.password
    db.close_pool()
    db._schema_ready = False
    db.initialize_schema()

    classes = db.list_classes("teacher")
    if not classes:
        raise SystemExit("压测 demo 班级初始化失败")
    class_id = int(classes[0]["id"])

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
                {"password": args.password, "class_id": class_id},
                "teacher",
            )
            if updated is None:
                raise SystemExit(f"无法更新压测账号 {username}")
            account = updated
        users.append({"username": username, "password": args.password})

    payload = {
        "kind": "gvcsim-capacity-test-users-v1",
        "database": database,
        "users": users,
    }
    _write_credentials(args.output, payload)
    db.close_pool()
    print(f"已准备 {len(users)} 个隔离压测账号；凭证文件：{args.output}（0600）")


if __name__ == "__main__":
    main()
