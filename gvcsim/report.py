"""步骤17:自动生成实验报告(Markdown)。

串联"数据→指标→回归→报告"闭环:读取预计算面板,跑四组回归,
产出一份带指标摘要与回归表的报告。PDF 导出留给前端/pandoc(见 README 路线图)。
"""

from datetime import date

import pandas as pd

from gvcsim.config import PROCESSED_DIR, REPORTS_DIR, processed_years
from gvcsim.regression.design import STEP_DEPVARS, RegressionDesign
from gvcsim.regression.panel import RegressionResult, run_design


def _load_panel(design: RegressionDesign) -> pd.DataFrame:
    path = PROCESSED_DIR / design.panel_file
    if not path.exists():
        raise FileNotFoundError(f"缺少 {design.panel_file},请先运行 gvcsim compute")
    return pd.read_csv(path)


def run_step_regression(
    step: int,
    panel: pd.DataFrame | None = None,
    granularity: str = "国家–行业级",
    method: str | None = None,
) -> RegressionResult:
    """跑步骤13-16 对应的默认设计回归(默认国家–行业级粒度 + DID)。"""
    kwargs = {"method": method} if method else {}
    design = RegressionDesign(step=step, granularity=granularity, **kwargs)
    if panel is None:
        panel = _load_panel(design)
    return run_design(panel, design)


def _coef_table(result: RegressionResult) -> str:
    lines = ["| 变量 | 系数 | 聚类标准误 | t | p | |", "|---|---|---|---|---|---|"]
    for c in result.coefs:
        lines.append(
            f"| {c.name} | {c.coef:.4f} | {c.se:.4f} | {c.t:.2f} | {c.p:.3f} | {c.stars} |"
        )
    lines.append(
        f"\nN = {result.n_obs}({result.n_entities} 个国家×行业 × {result.n_times} 年,"
        f"标准误按 {result.n_clusters} 国聚类),组内 R² = {result.r2_within:.4f},"
        "双向固定效应 ✓"
    )
    return "\n".join(lines)


def generate(year: int | None = None) -> str:
    """生成报告并返回文件路径。year 为指标摘要引用的截面年份。

    指标摘要用国家级面板(便于阅读),回归用国家–行业级面板(默认粒度)。
    """
    country_panel = pd.read_csv(PROCESSED_DIR / "panel_country.csv")
    sector_panel = _load_panel(RegressionDesign(step=13))
    years = processed_years()
    year = year or max(years)
    snap = country_panel[country_panel["year"] == year].set_index("country")

    top_backward = snap["share_trade_backward_gvc"].nlargest(5)
    top_forward = snap["share_trade_forward_gvc"].nlargest(5)
    top_between = snap["betweenness_centrality"].nlargest(5)

    sections = [
        "# 贸易政策冲击对全球价值链结构的影响\n",
        "> 供应链仿真系统自动生成的实验报告(演示版:冲击数据为覆盖全部经济体的"
        "拟真演示面板,以 2018–2020 全球贸易摩擦为原型,结论仅用于验证系统链路,"
        "不构成研究结论)\n",
        f"- 数据:OECD ICIO {min(years)}–{max(years)}(指标截面:{year} 年)",
        "- 方法:国家–行业级双重差分(个体=国家×行业,处理组=曾受冲击个体,"
        "处理期=首个冲击年起),含双向固定效应,标准误按国家聚类;"
        "双向FE(强度法)与事件研究可在前端切换",
        f"- 生成日期:{date.today().isoformat()}\n",
        "## 一、数据与质检",
        f"覆盖 {snap.shape[0]} 个国家/地区、{len(years)} 个年份。"
        f"质检结果见 data/processed/qc_{year}.json(维度一致性、会计恒等式、"
        "里昂惕夫逆矩阵性质等)。\n",
        "## 二、GVC 指标摘要",
        f"**后向参与度最高(KWW 外国增加值与外国重复计算占毛出口比重)**:"
        + "、".join(f"{c} ({v:.3f})" for c, v in top_backward.items()),
        f"\n**前向参与度最高(本国增加值最常嵌入他国出口)**:"
        + "、".join(f"{c} ({v:.3f})" for c, v in top_forward.items()),
        f"\n**介数中心性最高(供应链枢纽)**:"
        + "、".join(f"{c} ({v:.3f})" for c, v in top_between.items()) + "\n",
        "## 三、回归结果",
    ]

    for step in sorted(STEP_DEPVARS):
        design = RegressionDesign(step=step)
        result = run_step_regression(step, sector_panel)
        sections += [
            f"### 步骤{step}:{design.depvar_label}",
            f"模型:`{design.equation()}`\n",
            _coef_table(result),
            "",
        ]

    sections += [
        "## 四、结论与限制",
        "- 本报告验证了“数据 → 指标 → 回归 → 报告”闭环可自动运行(回归为国家–行业级)。",
        "- 冲击变量为拟真演示面板(事件与量级参考公开资料的手工编码,出口暴露度为风格化数值);"
        "接入 PIIE/WTO 真实数据 + 官方 HS→ICIO 映射后本报告即具备研究意义。",
        "- 指标采用 KWW 风格贸易流分解与 WWYZ 生产活动分解的国家/国家–行业聚合口径,"
        "重复计算项为启发式近似(详见 README 方法论说明),论文级精度需替换为 "
        "KWW/Borin-Mancini 完整分解;本报告不输出 exporter-importer-sector 双边矩阵明细。",
    ]

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORTS_DIR / f"experiment_report_{year}.md"
    out.write_text("\n".join(sections), encoding="utf-8")
    return str(out)
