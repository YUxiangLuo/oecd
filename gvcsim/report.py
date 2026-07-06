"""步骤17:自动生成实验报告(Markdown)。

串联"数据→指标→回归→报告"闭环:读取预计算面板,跑四组回归,
产出一份带指标摘要与回归表的报告。PDF 导出留给前端/pandoc(见 README 路线图)。
"""

from datetime import date
from functools import lru_cache

import pandas as pd

from gvcsim.config import PROCESSED_DIR, REPORTS_DIR, processed_years
from gvcsim.regression.design import STEP_DEPVARS, RegressionDesign
from gvcsim.regression.panel import RegressionResult, benchmark_linearmodels, run_design


def _load_panel(design: RegressionDesign) -> pd.DataFrame:
    path = PROCESSED_DIR / design.panel_file
    if not path.exists():
        raise FileNotFoundError(f"缺少 {design.panel_file},请先运行 gvcsim compute")
    return pd.read_csv(path)


@lru_cache(maxsize=8)
def _load_panel_file(name: str) -> pd.DataFrame:
    path = PROCESSED_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"缺少 {name},请先运行 gvcsim compute")
    return pd.read_csv(path)


def run_step_regression(
    step: int,
    panel: pd.DataFrame | None = None,
    granularity: str = "国家–行业级",
    method: str | None = None,
    control_mode: str = "不加控制变量",
    interaction: bool = False,
    price_mode: str = "名义值",
) -> RegressionResult:
    """跑步骤13-16 对应的默认设计回归(默认国家–行业级粒度 + DID)。"""
    kwargs = {"method": method} if method else {}
    design = RegressionDesign(
        step=step, granularity=granularity, control_mode=control_mode,
        interaction=interaction, price_mode=price_mode, **kwargs
    )
    if panel is None:
        panel = _load_panel(design)
    return run_design(panel, design)


def _coef_table(result: RegressionResult, design: RegressionDesign) -> str:
    lines = ["| 变量 | 系数 | 聚类标准误 | t | p | |", "|---|---|---|---|---|---|"]
    for c in result.coefs:
        lines.append(
            f"| {c.name} | {c.coef:.4f} | {c.se:.4f} | {c.t:.2f} | {c.p:.3f} | {c.stars} |"
        )
    entity_label = "国家" if design.granularity == "国家级" else "国家×行业"
    lines.append(
        f"\nN = {result.n_obs}({result.n_entities} 个{entity_label} × {result.n_times} 年,"
        f"标准误按 {result.n_clusters} 国聚类),组内 R² = {result.r2_within:.4f},"
        "双向固定效应 ✓"
    )
    return "\n".join(lines)


def _design_summary(design: RegressionDesign) -> str:
    controls = "、".join(design.control_labels.values()) if design.controls else "不加控制变量"
    interaction = "开启:冲击×基期GVC参与度" if design.interaction else "未开启"
    return "\n".join([
        f"- 粒度:{design.granularity}",
        f"- 冲击类型:{design.shock_type}",
        f"- 估计方法:{design.method}",
        f"- 控制变量:{controls}",
        f"- 交互项:{interaction}",
        f"- 价格口径:{design.price_mode}",
    ])


def _policy_names(design: RegressionDesign, result: RegressionResult) -> list[str]:
    if design.method == "双重差分 (DID)":
        return ["treated×post" if design.treated_col == "treated" else f"{design.treated_col}×post"]
    if design.method == "事件研究":
        return [c.name for c in result.coefs if c.name not in design.controls]
    return list(design.regressors)


def _compare_table(
    base_design: RegressionDesign,
    base: RegressionResult,
    ctrl_design: RegressionDesign,
    ctrl: RegressionResult,
) -> str:
    base_by = {c.name: c for c in base.coefs}
    ctrl_by = {c.name: c for c in ctrl.coefs}
    lines = [
        "| 政策变量 | 基准系数 | 基准 p | 加控制系数 | 加控制 p |",
        "|---|---:|---:|---:|---:|",
    ]
    for name in _policy_names(base_design, base):
        if name not in base_by or name not in ctrl_by:
            continue
        b, c = base_by[name], ctrl_by[name]
        lines.append(
            f"| {name} | {b.coef:.4f}{b.stars} | {b.p:.3f} | "
            f"{c.coef:.4f}{c.stars} | {c.p:.3f} |"
        )
    lines.append(
        f"\n基准:N={base.n_obs},组内 R²={base.r2_within:.4f}; "
        f"加控制:N={ctrl.n_obs},组内 R²={ctrl.r2_within:.4f}。"
    )
    return "\n".join(lines)


def generate(
    year: int | None = None,
    *,
    granularity: str = "国家–行业级",
    shock_type: str = "关税冲击",
    method: str = "双重差分 (DID)",
    control_mode: str = "不加控制变量",
    interaction: bool = False,
    price_mode: str = "名义值",
) -> str:
    """生成报告并返回文件路径。year 为指标摘要引用的截面年份。

    指标摘要用国家级面板(便于阅读),回归用国家–行业级面板(默认粒度)。
    """
    country_panel = _load_panel_file("panel_country.csv")
    years = processed_years()
    year = year or max(years)
    snap = country_panel[country_panel["year"] == year].set_index("country")
    design_preview = RegressionDesign(
        step=13,
        granularity=granularity,
        shock_type=shock_type,
        method=method,
        control_mode=control_mode,
        interaction=interaction,
        price_mode=price_mode,
    )

    top_backward = snap["share_trade_backward_gvc"].nlargest(5)
    top_forward = snap["share_trade_forward_gvc"].nlargest(5)
    top_between = snap["betweenness_centrality"].nlargest(5)

    sections = [
        "# 贸易政策冲击对全球价值链结构的影响\n",
        "> 供应链仿真系统自动生成的实验报告(演示版:冲击数据为覆盖全部经济体的"
        "拟真演示面板,以 2018–2020 全球贸易摩擦为原型,结论仅用于验证系统链路,"
        "不构成研究结论)\n",
        f"- 数据:OECD ICIO {min(years)}–{max(years)}(指标截面:{year} 年)",
        "- 方法:本报告使用步骤17中选择的回归设定;四组因变量共用同一套"
        "粒度/冲击/方法/控制/价格口径,便于横向比较",
        _design_summary(design_preview),
        f"- 生成日期:{date.today().isoformat()}\n",
        "## 一、数据与质检",
        f"覆盖 {snap.shape[0]} 个国家/地区、{len(years)} 个年份。"
        f"质检结果见 data/processed/qc_{year}.json(维度一致性、会计恒等式、"
        "里昂惕夫逆矩阵性质等)。\n",
        "## 二、GVC 指标摘要",
        f"**后向参与度最高(BM 外国增加值与外国重复计算占毛出口比重)**:"
        + "、".join(f"{c} ({v:.3f})" for c, v in top_backward.items()),
        f"\n**前向参与度最高(本国增加值最常嵌入他国出口)**:"
        + "、".join(f"{c} ({v:.3f})" for c, v in top_forward.items()),
        f"\n**介数中心性最高(供应链枢纽)**:"
        + "、".join(f"{c} ({v:.3f})" for c, v in top_between.items()) + "\n",
        "## 三、回归结果",
    ]

    for step in sorted(STEP_DEPVARS):
        design = RegressionDesign(
            step=step,
            granularity=granularity,
            shock_type=shock_type,
            method=method,
            control_mode=control_mode,
            interaction=interaction,
            price_mode=price_mode,
        )
        panel = _load_panel_file(design.panel_file)
        result = run_design(panel, design)
        bench = benchmark_linearmodels(panel, design, result)
        sections += [
            f"### 步骤{step}:{design.depvar_label}",
            f"模型:`{design.equation()}`\n",
            _coef_table(result, design),
            f"PanelOLS 政策系数对照:{'通过' if bench['coef_check_passed'] else '需复核'},"
            f"最大政策系数差异={bench['max_abs_coef_diff']:.2e};"
            f"标准误最大差异={bench['max_abs_se_diff']:.2e},仅作参考"
            "(不同实现的小样本/自由度修正规则可能不同)。",
            "",
        ]

    sections += [
        "## 四、结论与限制",
        f"- 本报告验证了“数据 → 指标 → 回归 → 报告”闭环可自动运行"
        f"(本次回归粒度:{granularity})。",
        "- 冲击变量为拟真演示面板(事件与量级参考公开资料的手工编码,"
        "出口暴露度由 OECD ICIO 双边流向计算);"
        "接入 PIIE/WTO 真实数据 + 官方 HS→ICIO 映射后本报告即具备研究意义。",
        "- 控制变量支持 ICIO 内生派生与 WDI/IMF 风格宏观 mock,用于稳健性演示;"
        "GDP 平减指数为拟真 mock,不是官方价格指数。论文级研究仍需接入真实 WDI/IMF/"
        "行业价格指数。",
        "- 指标采用 Borin-Mancini source-based 贸易流分解与 WWYZ 生产活动分解的"
        "国家/国家–行业聚合口径;本报告不输出 exporter-importer-sector 双边矩阵明细。",
    ]

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORTS_DIR / f"experiment_report_{year}.md"
    out.write_text("\n".join(sections), encoding="utf-8")
    return str(out)
