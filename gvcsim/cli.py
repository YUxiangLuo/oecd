"""命令行入口:uv run gvcsim <子命令>

download  下载 OECD ICIO 原始数据(步骤1)
validate  对某年数据做质检并打印结果(步骤3)
compute   预计算指标与回归面板(步骤4-7 + 面板)
regress   跑指定 outcome 的教学实证回归并打印系数表
report    生成实验报告(步骤16)
serve     启动 API 服务(供前端使用)
classroom-init  初始化教学数据库(建库/建表/播种演示数据)
"""

import argparse


def main() -> None:
    parser = argparse.ArgumentParser(prog="gvcsim", description="供应链仿真系统 CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("download", help="下载 OECD ICIO 数据")
    p.add_argument("--years", type=int, nargs="+", required=True)

    p = sub.add_parser("validate", help="数据质检")
    p.add_argument("--year", type=int, required=True)

    p = sub.add_parser("compute", help="预计算指标(默认:本地所有年份)")
    p.add_argument("--years", type=int, nargs="*", default=None)

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
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true")

    p = sub.add_parser("classroom-init", help="初始化教学数据库(教师面板用;服务端也会懒建表)")
    p.add_argument("--reset", action="store_true", help="删除并重建全部教学表(会清空班级/学生/提交数据)")

    args = parser.parse_args()

    if args.command == "download":
        from gvcsim.data import loader

        loader.download(args.years)

    elif args.command == "validate":
        from gvcsim.data import loader, quality

        io = loader.load(args.year)
        checks = quality.run_all(io)
        for c in checks:
            print(f"[{'✓' if c.passed else '✗'}] {c.name} —— {c.detail}")
            for w in c.warnings:
                print(f"      ⚠ {w}")
        print(
            "\n"
            + ("数据整体校验通过。" if all(c.passed for c in checks) else "存在异常项,请查看上方警告后决定是否使用。")
        )

    elif args.command == "compute":
        from gvcsim import pipeline

        pipeline.run(args.years)

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
        for c in result.coefs:
            # 推断被抑制时 p 为 None,不能用 :.3f 直接格式化(也不能拿 0 冒充)。
            p_text = f"{c.p:>8.3f}" if c.p is not None else f"{'—':>8}"
            print(f"{c.name:<20}{c.coef:>12.4f}{c.se:>12.4f}{c.t:>8.2f}{p_text} {c.stars}")
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

        uvicorn.run("gvcsim.api:app", port=args.port, reload=args.reload)

    elif args.command == "classroom-init":
        import psycopg

        from gvcsim import config
        from gvcsim.classroom import db as classroom_db

        # 目标库不存在则先经维护库(dbname=postgres)创建
        dsn = psycopg.conninfo.conninfo_to_dict(config.PG_DSN)
        dbname = dsn.get("dbname", "gvclab")
        try:
            with psycopg.connect(**{**dsn, "dbname": "postgres"}, autocommit=True) as c:
                if not c.execute("SELECT 1 FROM pg_database WHERE datname = %s", (dbname,)).fetchone():
                    c.execute(f'CREATE DATABASE "{dbname}"')
                    print(f"已创建数据库 {dbname}")
        except psycopg.OperationalError as e:
            raise SystemExit(f"无法连接 PostgreSQL({e});请确认服务已启动、GVCSIM_PG_DSN 正确") from e

        if args.reset:
            # 整个 schema 重建,而不是删一份写死的表名单:后者会把不在名单里的
            # 旧表(如已废弃版本留下的表)留在库里,与新表并存,而版本戳仍写着旧值。
            with psycopg.connect(config.PG_DSN, autocommit=True) as c:
                c.execute("DROP SCHEMA public CASCADE")
                c.execute("CREATE SCHEMA public")
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
        print(f"教学数据库就绪:{dbname}(16 步;演示账号 teacher/student,班级 GVC-DEMO)")


if __name__ == "__main__":
    main()
