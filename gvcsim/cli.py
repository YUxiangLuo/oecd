"""命令行入口:uv run gvcsim <子命令>

download  下载 OECD ICIO 原始数据(步骤1)
validate  对某年数据做质检并打印结果(步骤2)
compute   预计算质检、指标、可视化/冲击数据与回归面板(步骤2–11 + 面板)
regress   跑指定 outcome 的教学实证回归并打印系数表
report    生成实验报告(步骤16)
serve     启动 API 服务(供前端使用)
preflight 生产多 worker 启动前验证应用、产物、运行目录与数据库
classroom-init  初始化教学数据库(建库/建表/播种演示数据)
classroom-reset-attempts  为新版题库归档开放作业的当前尝试
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
    p.add_argument(
        "--allow-qc-override",
        action="store_true",
        help="仅用于有审计记录的教学演示:允许 fatal QC 后继续，并把 override 永久写入 manifest/报告",
    )

    p = sub.add_parser("regress", help="教学实证回归")
    p.add_argument("--outcome", default="trade", choices=["trade", "production", "length", "network"])
    p.add_argument(
        "--granularity",
        default="industry",
        choices=["industry", "country"],
        help="回归粒度:industry=国家–行业级(默认),country=国家级",
    )
    p.add_argument(
        "--method",
        default="did",
        choices=["did", "fe", "event"],
        help="估计方法:did=双重差分(默认),fe=双向固定效应(强度法),event=事件研究",
    )
    p.add_argument("--controls", action="store_true", help="加入 ICIO 派生国家-年份控制变量")
    p.add_argument("--macro-controls", action="store_true", help="加入 WDI/IMF 风格模拟宏观控制变量")
    p.add_argument("--interaction", action="store_true", help="加入 冲击×基期GVC生产份额 交互项")
    p.add_argument("--real", action="store_true", help="使用 GDP 平减指数切换到实际值口径(2016=1)")

    p = sub.add_parser("report", help="生成实验报告")
    p.add_argument("--year", type=int, default=None)

    p = sub.add_parser("serve", help="启动 API 服务")
    p.add_argument("--host", default=os.environ.get("GVCSIM_BIND_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true")
    p.add_argument("--workers", type=int, default=int(os.environ.get("GVCSIM_WEB_WORKERS", "1")))
    p.add_argument(
        "--limit-concurrency",
        type=int,
        default=int(os.environ.get("GVCSIM_WORKER_CONNECTION_LIMIT", "64")),
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
    p.add_argument("--reset", action="store_true", help="删除并重建全部教学表(会清空班级/学生/提交数据)")
    p.add_argument("--teacher-username", help="显式创建首位教师（口令从 GVCSIM_INITIAL_TEACHER_PASSWORD 读取）")
    p.add_argument("--teacher-name", default="课程管理员", help="首位教师显示名")

    p = sub.add_parser("classroom-reset-attempts", help="为新版理解检查归档开放作业的当前尝试")
    p.add_argument("--quiz-version", required=True, help="稳定题库版本，例如 course-quiz-v2")
    p.add_argument("--confirm", action="store_true", help="确认归档旧 attempt 并为学生创建空白 attempt")

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
        if summary["fatal"]:
            conclusion = "存在 fatal 异常，数据不得发布。"
        elif summary["requires_disclosure"]:
            conclusion = "无 fatal 异常；数据可使用，但必须持续披露上述 warning/disclosure。"
        else:
            conclusion = "数据整体校验通过。"
        print("\n" + conclusion)

    elif args.command == "compute":
        from gvcsim import pipeline

        try:
            pipeline.run(args.years, allow_qc_override=args.allow_qc_override)
        except pipeline.QualityGateError as error:
            raise SystemExit(
                f"{error}\n如已完成修正/风险评审，可显式加 --allow-qc-override；该决定会写入 manifest。"
            ) from error

    elif args.command == "regress":
        from gvcsim.regression.design import (
            CONTROL_MODE_ICIO,
            CONTROL_MODE_MACRO,
            CONTROL_MODE_NONE,
            GRANULARITY_COUNTRY,
            GRANULARITY_COUNTRY_INDUSTRY,
            METHOD_DID,
            METHOD_EVENT_STUDY,
            METHOD_TWFE_INTENSITY,
            PRICE_MODE_NOMINAL,
            PRICE_MODE_REAL,
            RegressionDesign,
        )
        from gvcsim.report import run_outcome_regression

        if args.controls and args.macro_controls:
            raise SystemExit("--controls 与 --macro-controls 只能选择一个")
        granularity = GRANULARITY_COUNTRY if args.granularity == "country" else GRANULARITY_COUNTRY_INDUSTRY
        method = {"did": METHOD_DID, "fe": METHOD_TWFE_INTENSITY, "event": METHOD_EVENT_STUDY}[args.method]
        control_mode = (
            CONTROL_MODE_MACRO if args.macro_controls else CONTROL_MODE_ICIO if args.controls else CONTROL_MODE_NONE
        )
        price_mode = PRICE_MODE_REAL if args.real else PRICE_MODE_NOMINAL
        try:
            design = RegressionDesign(
                outcome=args.outcome,
                granularity=granularity,
                method=method,
                control_mode=control_mode,
                interaction=args.interaction,
                price_mode=price_mode,
            )
        except ValueError as error:
            raise SystemExit(str(error)) from error
        result = run_outcome_regression(
            args.outcome,
            granularity=granularity,
            method=method,
            control_mode=control_mode,
            interaction=args.interaction,
            price_mode=price_mode,
        )
        print(f"{args.outcome}:{design.depvar_label}({design.granularity_label} · {design.method_label})")
        print(f"价格口径:{design.price_mode_label}")
        print(f"回归样本:{design.sample_filter}")
        if args.controls or args.macro_controls:
            print(f"控制变量:{design.control_mode_label}")
        if args.interaction:
            print("交互项:冲击×基期GVC参与度")
        print(f"模型: {design.equation()}\n")
        print(f"{'变量':<20}{'系数':>12}{'标准误':>12}{'t':>8}{'p':>8}")
        for coef in result.coefs:
            # 推断被抑制时 p 为 None,不能用 :.3f 直接格式化(也不能拿 0 冒充)。
            p_text = f"{coef.p:>8.3f}" if coef.p is not None else f"{'—':>8}"
            print(f"{coef.name:<20}{coef.coef:>12.4f}{coef.se:>12.4f}{coef.t:>8.2f}{p_text} {coef.stars}")
        if result.status_reasons:
            print("\n设计有效性:" + (result.status or "ok"))
            for reason in result.status_reasons:
                print(f"  · {reason}")
        print(
            f"\nN={result.n_obs}({result.n_entities}个体×{result.n_times}年, "
            f"{result.n_clusters}国聚类), 组内R²={result.r2_within:.4f}"
        )
        for note in result.notes:
            print(f"  · {note}")

    elif args.command == "report":
        from gvcsim import report

        path = report.generate(args.year)
        print(f"报告已生成: {path}")

    elif args.command == "serve":
        import uvicorn

        if args.workers <= 0 or args.limit_concurrency <= 0 or args.backlog <= 0 or args.graceful_timeout <= 0:
            raise SystemExit("workers、limit-concurrency、backlog、graceful-timeout 必须为正数")
        if args.reload and args.workers != 1:
            raise SystemExit("--reload 与多 worker 不兼容；开发热更新请使用 --workers 1")
        uvicorn.run(
            "gvcsim.api:app",
            host=args.host,
            port=args.port,
            reload=args.reload,
            workers=args.workers,
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
            f"manifest={preflight_report['manifest_id']}，"
            f"年份={','.join(str(year) for year in preflight_report['years'])}，"
            f"schema={preflight_report['database']['schema_version']}"
        )

    elif args.command == "classroom-init":
        import psycopg
        from psycopg import sql

        from gvcsim import config
        from gvcsim.classroom import db as classroom_db

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

    elif args.command == "classroom-reset-attempts":
        if not args.confirm:
            raise SystemExit("该命令会归档开放作业的当前 attempt；确认备份后加 --confirm")
        from gvcsim import artifacts
        from gvcsim.classroom import db as classroom_db

        reset_result = classroom_db.reset_active_attempts_for_quiz(args.quiz_version, artifacts.manifest_id())
        if reset_result["already_applied"]:
            print(
                f"题库 {args.quiz_version} 已执行过 attempt 重置；"
                f"本次未重复操作（原重置 {reset_result['reset_count']} 个）"
            )
        else:
            print(f"已为题库 {args.quiz_version} 归档并重建 {reset_result['reset_count']} 个当前 attempt")


if __name__ == "__main__":
    main()
