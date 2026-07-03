"""命令行入口:uv run gvcsim <子命令>

  download  下载 OECD ICIO 原始数据(步骤1)
  validate  对某年数据做质检并打印结果(步骤3)
  compute   预计算指标与回归面板(步骤4-7 + 面板)
  regress   跑步骤13-16 的演示回归并打印系数表
  report    生成实验报告(步骤17)
  serve     启动 API 服务(供前端使用)
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

    p = sub.add_parser("regress", help="演示回归(步骤13-16)")
    p.add_argument("--step", type=int, default=13, choices=[13, 14, 15, 16])

    p = sub.add_parser("report", help="生成实验报告")
    p.add_argument("--year", type=int, default=None)

    p = sub.add_parser("serve", help="启动 API 服务")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true")

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
        print("\n" + ("数据整体校验通过。" if all(c.passed for c in checks)
                       else "存在异常项,请查看上方警告后决定是否使用。"))

    elif args.command == "compute":
        from gvcsim import pipeline

        pipeline.run(args.years)

    elif args.command == "regress":
        from gvcsim.regression.design import RegressionDesign
        from gvcsim.report import run_step_regression

        design = RegressionDesign(step=args.step)
        result = run_step_regression(args.step)
        print(f"步骤{args.step}:{design.depvar_label}")
        print(f"模型: {design.equation()}\n")
        print(f"{'变量':<20}{'系数':>12}{'标准误':>12}{'t':>8}{'p':>8}")
        for c in result.coefs:
            print(f"{c.name:<20}{c.coef:>12.4f}{c.se:>12.4f}{c.t:>8.2f}{c.p:>8.3f} {c.stars}")
        print(f"\nN={result.n_obs}({result.n_entities}国×{result.n_times}年), "
              f"组内R²={result.r2_within:.4f}")
        for note in result.notes:
            print(f"  · {note}")

    elif args.command == "report":
        from gvcsim import report

        path = report.generate(args.year)
        print(f"报告已生成: {path}")

    elif args.command == "serve":
        import uvicorn

        uvicorn.run("gvcsim.api:app", port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
