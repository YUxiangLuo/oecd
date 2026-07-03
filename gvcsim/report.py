"""步骤17:自动生成实验报告(Markdown)。

串联"数据→指标→回归→报告"闭环:读取预计算面板,跑四组回归,
产出一份带指标摘要与回归表的报告。PDF 导出留给前端/pandoc(见 README 路线图)。
"""

from datetime import date

import pandas as pd

from gvcsim.config import PROCESSED_DIR, REPORTS_DIR, processed_years
from gvcsim.regression.design import STEP_DEPVARS, RegressionDesign
from gvcsim.regression.panel import RegressionResult, twoway_fe


def _load_panel() -> pd.DataFrame:
    path = PROCESSED_DIR / "panel_country.csv"
    if not path.exists():
        raise FileNotFoundError("缺少 panel_country.csv,请先运行 gvcsim compute")
    return pd.read_csv(path)


def run_step_regression(step: int, panel: pd.DataFrame | None = None) -> RegressionResult:
    """跑步骤13-16 对应的默认设计回归。"""
    if panel is None:
        panel = _load_panel()
    design = RegressionDesign(step=step)
    return twoway_fe(panel, design.depvar, list(design.regressors))


def _coef_table(result: RegressionResult) -> str:
    lines = ["| 变量 | 系数 | 聚类标准误 | t | p | |", "|---|---|---|---|---|---|"]
    for c in result.coefs:
        lines.append(
            f"| {c.name} | {c.coef:.4f} | {c.se:.4f} | {c.t:.2f} | {c.p:.3f} | {c.stars} |"
        )
    lines.append(
        f"\nN = {result.n_obs}({result.n_entities} 国 × {result.n_times} 年),"
        f"组内 R² = {result.r2_within:.4f},双向固定效应 ✓"
    )
    return "\n".join(lines)


def generate(year: int | None = None) -> str:
    """生成报告并返回文件路径。year 为指标摘要引用的截面年份。"""
    panel = _load_panel()
    years = processed_years()
    year = year or max(years)
    snap = panel[panel["year"] == year].set_index("country")

    top_backward = snap["backward_fva_share"].nlargest(5)
    top_forward = snap["forward_share"].nlargest(5)
    top_between = snap["betweenness_centrality"].nlargest(5)

    sections = [
        "# 贸易政策冲击对全球价值链结构的影响\n",
        "> 供应链仿真系统自动生成的实验报告(演示版:冲击数据为风格化演示数据,"
        "结论仅用于验证系统链路,不构成研究结论)\n",
        f"- 数据:OECD ICIO {min(years)}–{max(years)}(指标截面:{year} 年)",
        "- 方法:双向固定效应面板回归,标准误按国家聚类",
        f"- 生成日期:{date.today().isoformat()}\n",
        "## 一、数据与质检",
        f"覆盖 {snap.shape[0]} 个国家/地区、{len(years)} 个年份。"
        f"质检结果见 data/processed/qc_{year}.json(维度一致性、会计恒等式、"
        "里昂惕夫逆矩阵性质等)。\n",
        "## 二、GVC 指标摘要",
        f"**后向参与度最高(出口最依赖进口中间品)**:"
        + "、".join(f"{c} ({v:.3f})" for c, v in top_backward.items()),
        f"\n**前向参与度最高(增加值最常被他国转手出口)**:"
        + "、".join(f"{c} ({v:.3f})" for c, v in top_forward.items()),
        f"\n**介数中心性最高(供应链枢纽)**:"
        + "、".join(f"{c} ({v:.3f})" for c, v in top_between.items()) + "\n",
        "## 三、回归结果",
    ]

    for step in sorted(STEP_DEPVARS):
        design = RegressionDesign(step=step)
        result = run_step_regression(step, panel)
        sections += [
            f"### 步骤{step}:{design.depvar_label}",
            f"模型:`{design.equation()}`\n",
            _coef_table(result),
            "",
        ]

    sections += [
        "## 四、结论与限制",
        "- 本报告验证了“数据 → 指标 → 回归 → 报告”闭环可自动运行。",
        "- 冲击变量目前为风格化演示数据;接入 PIIE/WTO 真实数据后本报告即具备研究意义。",
        "- 指标采用简化版分解(详见 README 方法论说明),论文级精度需替换为 KWW/WWYZ 完整分解。",
    ]

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORTS_DIR / f"experiment_report_{year}.md"
    out.write_text("\n".join(sections), encoding="utf-8")
    return str(out)
