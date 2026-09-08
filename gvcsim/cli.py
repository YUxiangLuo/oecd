"""命令行入口:uv run gvcsim <子命令>

download  下载 OECD ICIO 原始数据(步骤1)
validate  对某年数据运行维护者诊断
compute   预计算诊断、指标、可视化/冲击数据与回归面板
serve     启动 API 服务(供前端使用)
preflight 启动前验证应用、固定产物与数据库
classroom-init  初始化教学数据库(建库/建表/播种演示数据)
"""

import argparse
import os


def main() -> None:
    parser = argparse.ArgumentParser(prog="gvcsim", description="供应链仿真系统 CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("download", help="下载 OECD ICIO 数据")
    p.add_argument("--years", type=int, nargs="+", required=True)

    p = sub.add_parser("validate", help="数据质检")
    p.add_argument("--year", type=int, required=True)

    p = sub.add_parser("compute", help="预计算指标(默认:本地所有年份)")
    p.add_argument("--years", type=int, nargs="*", default=None)

    p = sub.add_parser("serve", help="启动 API 服务")
    p.add_argument("--host", default=os.environ.get("GVCSIM_BIND_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true")
    p.add_argument(
        "--limit-concurrency",
        type=int,
        default=int(os.environ.get("GVCSIM_WORKER_CONNECTION_LIMIT", "512")),
        help="每 worker 同时连接/任务上限，超过时由 Uvicorn 返回 503",
    )
    p.add_argument("--backlog", type=int, default=int(os.environ.get("GVCSIM_SOCKET_BACKLOG", "2048")))
    p.add_argument(
        "--graceful-timeout",
        type=int,
        default=int(os.environ.get("GVCSIM_GRACEFUL_TIMEOUT_SECONDS", "120")),
    )
    p.add_argument("--log-level", default=os.environ.get("GVCSIM_LOG_LEVEL", "info"))
    p.add_argument(
        "--access-log",
        action=argparse.BooleanOptionalAction,
        default=os.environ.get("GVCSIM_ACCESS_LOG", "1").lower() not in {"0", "false", "no", "off"},
        help="API 访问日志；Nginx 已记录访问时生产可用 --no-access-log 降低日志 I/O",
    )

    sub.add_parser("preflight", help="启动前验证 ASGI 应用、产物、容量目录和教学数据库")

    p = sub.add_parser("classroom-init", help="显式初始化或迁移教学数据库（serve/preflight 不会修改 schema）")
    p.add_argument("--reset", action="store_true", help="删除并重建全部教学表（会清空账号、会话和报告）")
    p.add_argument("--teacher-username", help="显式创建首位教师（口令从 GVCSIM_INITIAL_TEACHER_PASSWORD 读取）")
    p.add_argument("--teacher-name", default="课程管理员", help="首位教师显示名")

    args = parser.parse_args()

    if args.command == "download":
        from gvcsim.data import loader

        loader.download(args.years)

    elif args.command == "validate":
        from gvcsim.data import loader, quality

        io = loader.load(args.year)
        checks = quality.run_all(io)
        for c in checks:
            marker = {"fatal": "✗", "warning": "⚠", "disclosure": "◇", "ok": "✓"}[c.effective_severity]
            print(f"[{marker}] {c.name} —— {c.detail}")
            for w in c.warnings:
                print(f"      ⚠ {w}")
        summary = quality.summarize_checks(checks)
        from gvcsim.artifacts import publication_policy_metadata

        blocking = publication_policy_metadata()["blocking_kinds"]["icio"]
        integrity_failures = [check.name for check in checks if check.kind in blocking and not check.passed]
        if integrity_failures:
            conclusion = f"存在完整性或数学异常，数据不得发布：{'、'.join(integrity_failures)}。"
        elif summary["fatal"]:
            conclusion = "存在经济账户诊断发现；不阻断发布，但必须持续披露。"
        elif summary["requires_disclosure"]:
            conclusion = "无 fatal 异常；数据可使用，但必须持续披露上述 warning/disclosure。"
        else:
            conclusion = "数据整体校验通过。"
        print("\n" + conclusion)

    elif args.command == "compute":
        from gvcsim import pipeline

        try:
            pipeline.run(args.years)
        except pipeline.QualityGateError as error:
            raise SystemExit(f"{error}\n请修复完整性或数学检查失败后重新计算。") from error
    elif args.command == "serve":
        import uvicorn

        if args.limit_concurrency <= 0 or args.backlog <= 0 or args.graceful_timeout <= 0:
            raise SystemExit("limit-concurrency、backlog、graceful-timeout 必须为正数")
        uvicorn.run(
            "gvcsim.api:app",
            host=args.host,
            port=args.port,
            reload=args.reload,
            workers=1,
            limit_concurrency=args.limit_concurrency,
            backlog=args.backlog,
            timeout_graceful_shutdown=args.graceful_timeout,
            proxy_headers=True,
            forwarded_allow_ips="127.0.0.1",
            log_level=args.log_level,
            access_log=args.access_log,
        )

    elif args.command == "preflight":
        from gvcsim import preflight

        try:
            preflight_report = preflight.run()
        except Exception as error:
            raise SystemExit(f"服务启动预检失败（{type(error).__name__}）：{error}") from error
        print(
            "服务启动预检通过："
            f"年份={','.join(str(year) for year in preflight_report['years'])}，"
            f"schema={preflight_report['database']['schema_version']}"
        )

    elif args.command == "classroom-init":
        import psycopg
        from psycopg import sql

        from gvcsim import config
        from gvcsim.classroom import db as classroom_db

        if not config.PG_DSN:
            raise SystemExit("缺少 GVCSIM_PG_DSN；classroom-init 拒绝连接或创建未显式指定的数据库")

        # 目标库不存在则先经维护库(dbname=postgres)创建
        dsn = psycopg.conninfo.conninfo_to_dict(config.PG_DSN)
        dbname = str(dsn.get("dbname") or "gvclab")
        maintenance_dsn = psycopg.conninfo.make_conninfo(config.PG_DSN, dbname="postgres")
        try:
            with psycopg.connect(maintenance_dsn, autocommit=True) as connection:
                if not connection.execute("SELECT 1 FROM pg_database WHERE datname = %s", (dbname,)).fetchone():
                    connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(dbname)))
                    print(f"已创建数据库 {dbname}")
        except psycopg.OperationalError as e:
            raise SystemExit(f"无法连接 PostgreSQL({e});请确认服务已启动、GVCSIM_PG_DSN 正确") from e

        if args.reset:
            # 整个 schema 重建,而不是删一份写死的表名单:后者会把不在名单里的
            # 旧表(如已废弃版本留下的表)留在库里,与新表并存,而版本戳仍写着旧值。
            with psycopg.connect(config.PG_DSN, autocommit=True) as connection:
                connection.execute("DROP SCHEMA public CASCADE")
                connection.execute("CREATE SCHEMA public")
            classroom_db._schema_ready = False
            print("已重建 public schema(旧教学数据全部删除)")
        try:
            applied = classroom_db.initialize_schema()
        except classroom_db.SchemaVersionMismatch as e:
            raise SystemExit(f"{e}") from e
        if applied:
            print("已执行:" + "、".join(applied))
        else:
            print(f"教学库 schema 已是当前版本({classroom_db.TEACHING_DB_VERSION})")
        if args.teacher_username:
            password = os.environ.get("GVCSIM_INITIAL_TEACHER_PASSWORD", "")
            if len(password) < 12:
                raise SystemExit("请通过 GVCSIM_INITIAL_TEACHER_PASSWORD 提供至少 12 位的初始教师口令")
            if classroom_db.find_account(args.teacher_username):
                raise SystemExit(f"账号 {args.teacher_username} 已存在，未修改其口令")
            classroom_db.provision_teacher(args.teacher_username, args.teacher_name, password)
            print(f"已创建首位教师:{args.teacher_username}（请登录后立即轮换初始口令）")
        print(f"教学数据库就绪:{dbname}(schema {classroom_db.TEACHING_DB_VERSION})")


if __name__ == "__main__":
    main()
