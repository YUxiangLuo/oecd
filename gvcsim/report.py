"""步骤16:生成实验报告(Markdown)。

HTTP 请求路径只构建内存中的 Markdown，不写入共享文件；CLI 通过
``generate`` 将同一份文档写到 ``reports/experiment_report_<year>.md``。
图表使用版本化的 ``gvcsim-chart`` fenced JSON，由前端的受控组件渲染，
报告本身不包含原始 HTML。
"""

import json
from dataclasses import dataclass
from datetime import date

import pandas as pd

from gvcsim.artifacts import dataset_metadata, read_csv_artifact
from gvcsim.config import PROCESSED_DIR, REPORTS_DIR, processed_years
from gvcsim.data.citations import report_source_disclosures, report_source_label
from gvcsim.regression.design import (
    CONTROL_MODE_NONE,
    GRANULARITY_COUNTRY,
    GRANULARITY_COUNTRY_INDUSTRY,
    METHOD_DID,
    METHOD_EVENT_STUDY,
    OUTCOME_DEPVARS,
    OUTCOME_GRANULARITIES,
    PRICE_MODE_NOMINAL,
    RegressionDesign,
)
from gvcsim.shocks import SHOCK_TARIFF
from gvcsim.regression.panel import RegressionResult, run_design, run_design_with_benchmark


@dataclass(frozen=True)
class ReportDocument:
    markdown: str
    suggested_filename: str

    def to_dict(self) -> dict[str, str]:
        return {"markdown": self.markdown, "suggested_filename": self.suggested_filename}


def _load_panel_file(name: str) -> pd.DataFrame:
    path = PROCESSED_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"缺少 {name},请先运行 gvcsim compute")
    # NOTE: 返回的是共享缓存 DataFrame,截面切片/派生前必须 .copy()(见 gvcsim/artifacts.py)。
    return read_csv_artifact(path, require_current=True)


def _load_panel(design: RegressionDesign) -> pd.DataFrame:
    """按当前设计读取回归面板。"""
    return _load_panel_file(design.panel_file)


def run_outcome_regression(
    outcome: str,
    panel: pd.DataFrame | None = None,
    granularity: str = GRANULARITY_COUNTRY_INDUSTRY,
    method: str | None = None,
    control_mode: str = CONTROL_MODE_NONE,
    interaction: bool = False,
    price_mode: str = PRICE_MODE_NOMINAL,
    exclude_row: bool = True,
) -> RegressionResult:
    """跑指定 outcome 的回归（主要供 ``gvcsim regress`` 使用）。"""
    kwargs = {"method": method} if method else {}
    design = RegressionDesign(
        outcome=outcome,
        granularity=granularity,
        control_mode=control_mode,
        interaction=interaction,
        price_mode=price_mode,
        exclude_row=exclude_row,
        **kwargs,
    )
    return run_design(panel if panel is not None else _load_panel(design), design)


def _coef_table(result: RegressionResult, design: RegressionDesign) -> str:
    lines = [
        "| 变量 | 系数 | 聚类标准误 | 95% 置信区间 | t | p | 显著性 |",
        "|---|---:|---:|---:|---:|---:|:---:|",
    ]
    for coef in result.coefs:
        # 推断被抑制时留空,不能退回显示 0 或"不显著"。
        ci = f"[{coef.ci_low:.4f}, {coef.ci_high:.4f}]" if coef.ci_low is not None else "—"
        p_text = f"{coef.p:.3f}" if coef.p is not None else "—"
        lines.append(
            f"| {coef.name} | {coef.coef:.4f} | {coef.se:.4f} | {ci} | {coef.t:.2f} | {p_text} | {coef.stars} |"
        )
    entity_label = "国家" if design.granularity == GRANULARITY_COUNTRY else "国家×行业"
    lines.append(
        f"\nN = {result.n_obs}({result.n_entities} 个{entity_label} × {result.n_times} 年,"
        f"标准误按 {result.n_clusters} 国聚类),组内 R² = {result.r2_within:.4f},"
        "双向固定效应 ✓"
    )
    if result.support and result.support.get("suppress_inference"):
        lines.append(
            f"\n> **本设计不可作统计推断({result.status})**,p 值、置信区间与显著性标记已抑制。\n>\n"
            + "\n>\n".join(f"> {reason}" for reason in result.status_reasons)
        )
    return "\n".join(lines)


def _pretrend_summary(result: RegressionResult) -> str | None:
    diagnostic = result.diagnostics.get("pretrend")
    if not diagnostic:
        return None
    if not diagnostic["available"]:
        return f"冲击前趋势联合检验：不可评估。{diagnostic['interpretation']}"
    return (
        f"冲击前趋势联合检验：F({diagnostic['df_num']}, {diagnostic['df_denom']})="
        f"{diagnostic['statistic']:.3f}, p={diagnostic['p']:.3f}。{diagnostic['interpretation']}"
    )


def _design_summary(design: RegressionDesign) -> str:
    controls = "、".join(design.control_labels.values()) if design.controls else "不加控制变量"
    interaction = (
        "开启:冲击×处理前GVC生产份额(处理个体取首次处理前最后至多两期；按样本个体均值中心化)"
        if design.interaction
        else "未开启"
    )
    return "\n".join(
        [
            f"- 粒度:{design.granularity_label}",
            f"- 冲击类型:{design.shock_type_label}",
            f"- 估计方法:{design.method_label}",
            f"- 控制变量:{controls}",
            f"- 交互项:{interaction}",
            f"- 价格口径:{design.price_mode_label}",
            f"- 回归样本:{design.sample_filter}",
            "- 教学场景:正式报告固定使用 clean 基准场景",
        ]
    )


def _chart_block(payload: dict) -> str:
    """输出严格 v1 图表块；``allow_nan=False`` 防止非标准 JSON 渗入报告。"""
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return f"```gvcsim-chart\n{encoded}\n```"


def _bar_chart(title: str, values: pd.Series, y_label: str, x_label: str = "经济体") -> str:
    return _chart_block(
        {
            "version": 1,
            "type": "bar",
            "title": title,
            "x_label": x_label,
            "y_label": y_label,
            "items": [{"label": str(label), "value": float(value)} for label, value in values.items()],
        }
    )


def _industry_network_top(panel: pd.DataFrame, year: int, exclude_row: bool) -> pd.Series:
    """返回全球行业网络中介数最高的五个国家×行业节点。"""
    required = {"year", "country", "industry", "betweenesscentrality"}
    missing = sorted(required - set(panel.columns))
    if missing:
        raise ValueError(f"panel_industry.csv 缺少网络摘要字段：{missing}")
    snapshot = panel[panel["year"] == year].copy()
    if exclude_row:
        snapshot = snapshot[snapshot["country"].astype(str) != "ROW"]
    if snapshot.empty:
        raise ValueError(f"panel_industry.csv 中没有 {year} 年截面")
    labels = snapshot["country"].astype(str) + " · " + snapshot["industry"].astype(str)
    values = pd.to_numeric(snapshot["betweenesscentrality"], errors="coerce")
    return pd.Series(values.to_numpy(), index=labels).nlargest(5)


def _event_chart(
    title: str,
    result: RegressionResult,
    *,
    interaction: bool,
) -> str | None:
    suffix = "×base_gvc"
    coefs = [
        coef
        for coef in result.coefs
        if coef.name.startswith("k=") and (coef.name.endswith(suffix) if interaction else suffix not in coef.name)
    ]
    if not coefs:
        return None
    # 推断被抑制时没有置信区间:整点省略 ci 字段(图表契约里 ci 本就可选),
    # 渲染成一个没有须的点。不能退回 float(None),也不能拿 0 冒充区间。
    points = [
        {
            "label": coef.name.removesuffix(suffix),
            "value": float(coef.coef),
            **(
                {"ci_low": float(coef.ci_low), "ci_high": float(coef.ci_high)}
                if coef.ci_low is not None and coef.ci_high is not None
                else {}
            ),
        }
        for coef in coefs
    ]
    return _chart_block(
        {
            "version": 1,
            "type": "event-study",
            "title": title,
            "x_label": "相对首次冲击年 k",
            "y_label": "回归系数",
            "points": points,
        }
    )


def build(
    year: int | None = None,
    *,
    granularity: str = GRANULARITY_COUNTRY_INDUSTRY,
    shock_type: str = SHOCK_TARIFF,
    method: str = METHOD_DID,
    control_mode: str = CONTROL_MODE_NONE,
    interaction: bool = False,
    price_mode: str = PRICE_MODE_NOMINAL,
    exclude_row: bool = True,
) -> ReportDocument:
    """纯构建报告：读取预计算产物并返回 Markdown，不产生磁盘副作用。"""
    country_panel = _load_panel_file("panel_country.csv")
    years = processed_years()
    if not years:
        raise FileNotFoundError("缺少指标产物,请先运行 gvcsim compute")
    report_year = int(year if year is not None else max(years))
    if report_year not in years:
        raise ValueError(f"指标截面年份 {report_year} 不可用,可选年份为 {years}")

    snap = country_panel[country_panel["year"] == report_year].copy()
    if exclude_row:
        snap = snap[snap["country"].astype(str) != "ROW"]
    if snap.empty:
        raise ValueError(f"panel_country.csv 中没有 {report_year} 年截面")
    snap = snap.set_index("country")

    design_preview = RegressionDesign(
        outcome="trade",
        granularity=granularity,
        shock_type=shock_type,
        method=method,
        control_mode=control_mode,
        interaction=interaction,
        price_mode=price_mode,
        exclude_row=exclude_row,
    )
    industry_panel = _load_panel_file("panel_industry.csv")
    top_fva = snap["FVA_share"].nlargest(5)
    top_gvcpos = snap["GVCPs"].nlargest(5)
    top_between = _industry_network_top(industry_panel, report_year, exclude_row)
    comparison_scope = (
        "四组因变量共用同一套国家–行业级设定"
        if granularity == GRANULARITY_COUNTRY_INDUSTRY
        else "贸易流、生产与长度共用国家级设定；网络回归因国家图退化而不运行"
    )
    data_sources = dataset_metadata().get("data_sources") or {}
    source_label = report_source_label(data_sources)

    sections = [
        "# GVC 指标与政策冲击：教学估计报告\n",
        "> 供应链仿真系统自动生成的实验报告(演示版:冲击数据为覆盖全部经济体的"
        "拟真演示面板,以 2018–2020 全球贸易摩擦为原型,结论仅用于验证系统链路,"
        "不构成研究结论)\n",
        f"- 数据:{source_label} {min(years)}–{max(years)}(指标截面:{report_year} 年)",
        f"- 方法:本报告按下列统一设定重新估计四类教学模型;{comparison_scope}。因果解释仍依赖冲击外生性、趋势可比性等识别假设",
        _design_summary(design_preview),
        f"- 生成日期:{date.today().isoformat()}\n",
        "## 一、数据与质检",
        f"覆盖 {snap.shape[0]} 个国家/地区、{len(years)} 个年份。"
        f"质检结果见 data/processed/qc_{report_year}.json(维度/索引、原始 OUT 双侧恒等式、"
        "VA/TLS 定义域与里昂惕夫数值稳定性等)\n",
        "## 二、GVC 指标摘要",
        "**FVA 份额最高(WWZ 口径,出口中外国增加值占毛出口比重)**:"
        + "、".join(f"{country} ({value:.3f})" for country, value in top_fva.items()),
        _bar_chart("FVA 份额 Top 5", top_fva, "FVA 份额"),
        "\n**GVC 位置指数最高(WWYZ 口径,前向/后向 GVC 生产长度之比,越大越上游)**:"
        + "、".join(f"{country} ({value:.3f})" for country, value in top_gvcpos.items()),
        _bar_chart("GVC 位置指数 Top 5", top_gvcpos, "GVCPs"),
        "\n**全球国家×行业网络介数中心性最高(有向无权拓扑中介位置)**:"
        + "、".join(f"{node} ({value:.1f})" for node, value in top_between.items()),
        _bar_chart("国家×行业介数中心性 Top 5", top_between, "介数中心性", "国家×行业节点"),
        "\n## 三、回归结果",
    ]

    for outcome in OUTCOME_DEPVARS:
        if granularity not in OUTCOME_GRANULARITIES[outcome]:
            sections.extend(
                [
                    f"### {OUTCOME_DEPVARS[outcome][1]}",
                    "本项未运行：国家级贸易图在全部正流量边下为完全有向图，Gephi 介数中心性恒为 0，"
                    "不具备回归所需的截面变异。网络回归仅支持国家–行业级面板。",
                    "",
                ]
            )
            continue
        design = RegressionDesign(
            outcome=outcome,
            granularity=granularity,
            shock_type=shock_type,
            method=method,
            control_mode=control_mode,
            interaction=interaction,
            price_mode=price_mode,
            exclude_row=exclude_row,
        )
        panel = _load_panel_file(design.panel_file)
        # 自写引擎与 PanelOLS 对照共用一次 prepare/within 结果。
        result, benchmark = run_design_with_benchmark(panel, design)
        sections.extend(
            [
                f"### {design.depvar_label}",
                f"模型:`{design.equation()}`\n",
                _coef_table(result, design),
            ]
        )
        if method == METHOD_EVENT_STUDY:
            pretrend = _pretrend_summary(result)
            if pretrend:
                sections.extend(["#### 冲击前趋势检查", pretrend])
            main_chart = _event_chart(f"{design.depvar_label}主政策效应动态", result, interaction=False)
            if main_chart:
                sections.extend(["#### 主政策效应动态", main_chart])
            if interaction:
                heterogeneity_chart = _event_chart(
                    f"{design.depvar_label}处理前 GVC 异质性动态",
                    result,
                    interaction=True,
                )
                if heterogeneity_chart:
                    sections.extend(["#### 处理前 GVC 异质性动态", heterogeneity_chart])
        sections.extend(
            [
                f"PanelOLS 代码实现一致性检查:{'通过' if benchmark['coef_check_passed'] else '需复核'},"
                f"最大政策系数差异={benchmark['max_abs_coef_diff']:.2e};"
                f"标准误最大差异={benchmark['max_abs_se_diff']:.2e},仅作参考"
                "(不同实现的小样本/自由度修正规则可能不同)。",
                "",
            ]
        )

    sections.extend(
        [
            "## 四、结论与限制",
            f"- 本报告验证了“数据 → 指标 → 回归 → 报告”闭环可自动运行(本次回归粒度:{granularity})。",
            "- 冲击变量为拟真演示面板(事件与量级参考公开资料的手工编码,"
            f"出口暴露度由 {source_label} 双边流向计算)。即使未来接入真实 PIIE/WTO 数据与官方 HS→ICIO 映射，"
            "仍需论证冲击外生性、趋势可比性、处理效应异质性并完成稳健性检验，才能形成研究结论。",
            "- 控制变量支持 ICIO 内生派生与 WDI/IMF 风格宏观 mock,用于稳健性演示;"
            "GDP 平减指数为拟真 mock,不是官方价格指数。论文级研究仍需接入真实 WDI/IMF/"
            "行业价格指数。",
            "- 指标采用公开文献口径:WWZ (2013) 总贸易核算法、WWYZ (2017) 生产分解与"
            "生产长度，以及 Gephi 有向全正边网络中心性；国家网络指标如实输出，"
            "网络回归仅使用存在节点差异的国家–行业级结果;"
            "本报告不输出 exporter-importer-sector 双边矩阵明细。",
            "",
            "## 五、数据来源与许可提示",
            *report_source_disclosures(data_sources),
        ]
    )

    return ReportDocument(
        markdown="\n".join(sections),
        suggested_filename=f"experiment_report_{report_year}.md",
    )


def generate(
    year: int | None = None,
    *,
    granularity: str = GRANULARITY_COUNTRY_INDUSTRY,
    shock_type: str = SHOCK_TARIFF,
    method: str = METHOD_DID,
    control_mode: str = CONTROL_MODE_NONE,
    interaction: bool = False,
    price_mode: str = PRICE_MODE_NOMINAL,
    exclude_row: bool = True,
) -> str:
    """CLI 落盘入口：构建报告后写入 ``reports/`` 并返回路径。"""
    document = build(
        year,
        granularity=granularity,
        shock_type=shock_type,
        method=method,
        control_mode=control_mode,
        interaction=interaction,
        price_mode=price_mode,
        exclude_row=exclude_row,
    )
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    output = REPORTS_DIR / document.suggested_filename
    output.write_text(document.markdown, encoding="utf-8")
    return str(output)
