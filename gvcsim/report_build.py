from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from typing import Any

import numpy as np

from gvcsim import config, quizzes
from gvcsim.artifacts import (
    NETWORK_ALGORITHM,
    ArtifactContractError,
    dataset_metadata,
    read_csv_artifact,
    validate_release_cached,
)
from gvcsim.config import COURSE_RELEASE, processed_years
from gvcsim.data.citations import (
    is_ci_synthetic_source,
    report_source_disclosures,
    report_source_label,
    validate_data_sources,
)
from gvcsim.regression.teaching import (
    GENERATED_DATA_NOTE,
    MARKET,
    VERSION as TEACHING_VERSION,
    X_COLUMN,
    country_exposure_overview,
)
from gvcsim.session import SESSION_VERSION
from gvcsim.report_common import ReportGateError, TeachingReport, _safe
from gvcsim.report_gate import _step_data, check_gate
from gvcsim.report_observed import (
    _observed_evidence_section,
    _quiz_sections,
    _reflection_section,
    _viewed_shock_event_sources,
)
from gvcsim.report_render import (
    _evidence_summary,
    _experiment_sections,
    _qc_disclosure_section,
    _qc_release_summary,
    _run_sections,
)
from gvcsim.report_saved_run import _saved_runs


def _regression_overview() -> dict[str, Any] | None:
    """The course's estimate of every Y (the step 11–14 bars), from the release's teaching panel and computed once
    per release: the same cached panel and result the teaching-overview endpoint serves. A failure leaves each
    chart with the saved Y alone instead of blocking the report."""
    from gvcsim.regression_routes import _ESTIMATE_OVERVIEW_CACHE, _cached_on_panel, _estimate_overview

    try:
        # Resolved at call time (not data_routes' import-time PROCESSED_DIR); the artifact cache returns the same
        # DataFrame object for the same file, so the overview cache is shared with the endpoint.
        panel = read_csv_artifact(config.PROCESSED_DIR / "panel_teaching.csv")
        return _cached_on_panel(_ESTIMATE_OVERVIEW_CACHE, panel, _estimate_overview)
    except (
        ArtifactContractError,
        OSError,
        ValueError,
        KeyError,
        np.linalg.LinAlgError,
        FloatingPointError,
        OverflowError,
    ):
        return None


# The method references: authors and year, title, the series it appeared in, and its address.
_REFERENCES = (
    (
        "Yamano et al. (2023), ",
        "Development of the OECD Inter-Country Input-Output Database 2023",
        "",
        "https://doi.org/10.1787/5a5d0665-en",
    ),
    (
        "OECD (2023), ",
        "Guide to OECD TiVA Indicators",
        "",
        "https://www.oecd.org/content/dam/oecd/en/topics/policy-sub-issues/trade-in-value-added/tiva-indicators-guide-2023.pdf",
    ),
    (
        "Koopman, Wang & Wei (2014), ",
        "Tracing Value-Added and Double Counting in Gross Exports",
        "",
        "https://doi.org/10.1257/aer.104.2.459",
    ),
    (
        "Wang, Wei & Zhu (2018), NBER w19677, ",
        "Quantifying International Production Sharing at the Bilateral and Sector Levels",
        "",
        "https://www.nber.org/papers/w19677",
    ),
    (
        "Wang, Wei, Yu & Zhu (2017), NBER w23222, ",
        "Measures of Participation in Global Value Chains and Global Business Cycles",
        "",
        "https://www.nber.org/papers/w23222",
    ),
    (
        "Wang, Wei, Yu & Zhu (2017), NBER w23261, ",
        "Characterizing Global Value Chains: Production Length and Upstreamness",
        "",
        "https://www.nber.org/papers/w23261",
    ),
    (
        "Brandes (2001), ",
        "A Faster Algorithm for Betweenness Centrality",
        "",
        "https://doi.org/10.1080/0022250X.2001.9990249",
    ),
    ("Gephi 项目讨论 #2145：", "特征向量中心性的实现说明", "", "https://github.com/gephi/gephi/issues/2145"),
    (
        "Wasserstein & Lazar (2016), ",
        "The ASA Statement on p-Values",
        "",
        "https://doi.org/10.1080/00031305.2016.1154108",
    ),
    (
        "Cameron & Miller (2015), ",
        "A Practitioner’s Guide to Cluster-Robust Inference",
        "",
        "https://doi.org/10.3368/jhr.50.2.317",
    ),
)


def _teaching_scenario(session: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Step 10 as the page shows it, from the release's teaching panel: the scenario (taxed and untaxed counts, rate,
    policy year, the surplus rule, each country's taxed flag) and the examples followed into steps 11–14 in the
    page's order, the recorded one as saved and its comparison country read from the panel in the same industry
    and year. Without the panel the report keeps the recorded example alone and leaves the scenario out."""
    step_ten = _step_data(session, 10)
    raw_observation = step_ten.get("teaching_observation")
    observation: dict[str, Any] | None = raw_observation if isinstance(raw_observation, dict) else None
    recorded = [observation] if observation is not None else []
    try:
        panel = read_csv_artifact(config.PROCESSED_DIR / "panel_teaching.csv")
        overview = country_exposure_overview(panel)
    except (ArtifactContractError, OSError, ValueError, KeyError, TypeError):
        return None, recorded
    scenario = {
        key: overview.get(key)
        for key in ("market", "policy_year", "tariff_rate", "taxed_rule", "taxed_countries", "untaxed_countries")
    }
    scenario["taxed"] = {str(item["country"]): bool(item["taxed"]) for item in overview.get("countries", [])}
    compared = step_ten.get("compared")
    if observation is None or not isinstance(compared, list) or len(compared) != 2:
        return scenario, recorded
    examples: list[dict[str, Any]] = []
    industry, year = observation.get("industry"), observation.get("year")
    for country in (str(code) for code in compared):
        if country == str(observation.get("country")):
            examples.append(observation)
        elif country == MARKET:
            examples.append({"country": country, "industry": industry, X_COLUMN: 0.0, "teaching_tariff_rate_tau": 0.0})
        else:
            rows = panel.loc[
                panel["country"].astype(str).eq(country)
                & panel["industry"].astype(str).eq(str(industry))
                & panel["year"].eq(year)
            ]
            if len(rows) == 1:
                row = rows.iloc[0]
                examples.append(
                    {
                        "country": country,
                        "industry": industry,
                        X_COLUMN: float(row[X_COLUMN]),
                        "teaching_tariff_rate_tau": float(row["teaching_tariff_rate_tau"]),
                        # With w, X reads at step 10's digits in the conversion line.
                        **(
                            {"teaching_export_share_w": float(row["teaching_export_share_w"])}
                            if "teaching_export_share_w" in row.index
                            else {}
                        ),
                    }
                )
    return scenario, examples if observation in examples else recorded


def build(session: dict[str, Any], student: str, *_unused: Any, **_unused_kw: Any) -> TeachingReport:
    blocked = check_gate(session)
    if blocked:
        raise ReportGateError(blocked)
    years = processed_years()
    if not years:
        raise ReportGateError([{"step": 0, "title": "数据不可用", "missing": ["课程数据暂时不可用，请联系老师。"]}])
    runs = _saved_runs(session)
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    # The pages show server-local wall-clock time (PostgreSQL now()) as "YYYY-MM-DD HH:MM"; the report says the same,
    # without the "+09:00" offset an ISO time carries.
    generated_local = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M")
    fingerprint = hashlib.sha256(json.dumps(session, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]
    try:
        validate_release_cached()
        metadata = dataset_metadata()
    except (ArtifactContractError, OSError, ValueError, TypeError, RuntimeError) as error:
        raise ReportGateError(
            [{"step": 0, "title": "数据不可用", "missing": ["课程数据暂时不可用，请联系老师。"]}]
        ) from error
    raw_data_sources = metadata.get("data_sources")
    data_sources: dict[str, Any] = raw_data_sources if isinstance(raw_data_sources, dict) else {}
    raw_qc_metadata = metadata.get("qc")
    qc_metadata: dict[str, Any] = raw_qc_metadata if isinstance(raw_qc_metadata, dict) else {}
    output_qc_metadata = metadata.get("output_qc")
    regression_input_qc_metadata = metadata.get("regression_input_qc")
    qc_summary = _qc_release_summary(
        {
            "inputs": qc_metadata,
            "outputs": output_qc_metadata,
            "regression_inputs": regression_input_qc_metadata,
        }
    )
    integrity_metadata = metadata.get("integrity")
    network_algorithm = str(metadata.get("network_algorithm") or NETWORK_ALGORITHM)
    shock_event_sources = _viewed_shock_event_sources(session)
    provenance = {
        "generated_at": generated_at,
        "release_id": metadata.get("release_id"),
        "years": years,
        "session_version": SESSION_VERSION,
        "quiz_version": quizzes.QUIZ_VERSION,
        "quiz_versions": {str(step): quizzes.quiz_version(step) for step in quizzes.STEP_QUIZZES},
        "course_release": COURSE_RELEASE,
        "teaching_panel_version": TEACHING_VERSION,
        "session_fingerprint": fingerprint,
        "runs": [
            {
                "step": run["step"],
                "outcome": run["outcome"],
                "design": run["design"],
                "result": run["result"],
                "model_snapshot": run["model_snapshot"],
                "variable_catalog": run["variable_catalog"],
            }
            for run in runs
        ],
        "algorithm": "WWZ/TLS and WWYZ observed indicators; separate seeded tariff simulation; entity/year fixed effects with country-clustered standard errors",
        "simulation_contract": metadata.get("simulation_contract"),
        "network_algorithm": network_algorithm,
        "viewed_shock_event_sources": shock_event_sources,
        "data_sources": data_sources,
        "indicator_data_source": data_sources.get("ci_synthetic_icio") or data_sources.get("oecd_icio"),
        "simulated_macro_controls": data_sources.get("simulated_macro_controls"),
        "qc": qc_metadata,
        "output_qc": output_qc_metadata,
        "regression_input_qc": regression_input_qc_metadata,
        "publication_policy": metadata.get("publication_policy"),
        "integrity": integrity_metadata,
    }
    # The body names the data source only; versions, hashes and the session digest are under "报告溯源".
    source = (
        report_source_label(data_sources)
        if is_ci_synthetic_source(validate_data_sources(data_sources))
        else "OECD ICIO 2023 版"
    )
    disclosures = report_source_disclosures(data_sources)
    # The regressions use no macro controls: the report does not mention them (the release still records them).
    macro_control_lines = [line for line in disclosures if line.startswith("- 宏观控制变量")]
    body_disclosures = [line for line in disclosures if line not in macro_control_lines]
    scenario, teaching_examples = _teaching_scenario(session)
    lines = [
        "# GVC 指标与关税实验报告",
        "",
        f"学生：{_safe(student)}",
        "",
        f"> **指标部分（步骤 1–9）**：覆盖 {years[0]}–{years[-1]}，数据来源：{_safe(source)}。",
        "",
        f"> **关税回归部分（步骤 10–14）**：{GENERATED_DATA_NOTE}X = 首年对美出口份额 w × 加征税率 τ（单位：个百分点）。",
        "",
        "> 步骤 11–14 用同一个模型：扣掉每个国家×行业自己的平均水平和每年的共同变化后，看 X 每高 1 个百分点，Y 平均相差多少"
        "（双向固定效应，TWFE），不加控制变量。估计值和区间描述的是 X 与 Y 的关联；四个 Y 单位不同，原始数值不能直接比较；汇总图将其统一换算为标准差后并列展示。",
        "",
        *_reflection_section(session),
        *_observed_evidence_section(session),
        *_evidence_summary(
            runs,
            metadata["simulation_contract"]["source_filter_disclosure"],
            teaching_examples,
            _regression_overview() if runs else None,
        ),
        *_quiz_sections(session),
        *_experiment_sections(session, scenario),
        *_run_sections(runs),
        *_qc_disclosure_section(qc_summary, integrity_metadata),
        "## 数据与方法说明",
        "",
        "- 指标算法：总出口按 WWZ 方法（王直、魏尚进、祝坤福）拆成国内增加值出口、返回国内的增加值、国内重复计算、外国增加值、外国重复计算五个聚合项（再归为国内增加值、外国增加值、重复计算三类），另加按 OECD ICIO 账户计算的产品税减补贴（taxsub，它不是关税），共六项。外国增加值项占比的分子不含外国重复计算（FDC），分母是这六项相加得到的总出口，所以和 OECD TiVA 公布的“出口中外国增加值占比”不完全相同。生产分解和生产长度按 WWYZ 方法（王直、魏尚进、余心玎、祝坤福）计算。",
        "- 网络算法：保留全部有向的正流量连接，包括自环（行业卖给自己的部分）。加权总度（买入 + 卖出）= 加权入度 + 加权出度，"
        "自环在买入和卖出两侧各计一次，所以它不是去重后的贸易额。路径指标只看连接、不看金额。"
        "特征向量中心性（软件近似）按 Gephi 软件的算法计算，和教科书的标准算法结果不完全相同。",
        "- 介数（只看连接、不看金额）把很小的正流量和大额流量当作同样的一条连接，所以高介数只表示在连接网络的最短路线上处于中转位置，"
        "不自动等于经济规模、关键瓶颈或不可替代。",
        "- 网络的读法：先用加权总度看流量规模，再用介数看连接结构上的位置并比较排序。本报告没有检验去掉很小的流量后，最短路线和排序会不会改变。",
        "- 关税回归：四个 Y 各自单独回归，都用同一个 X；模型固定扣掉每个国家×行业和每年的平均水平，不加控制变量和交互项。",
        "- 关税范围与 X：美国只对被加税国家的货物行业（ICIO 行业 A–C）加税，服务业 τ = 0；X 只计该国家×行业直接出口到美国的份额"
        "（分母是它的出口总额），不含经第三国或作为中间品间接进入美国的部分。",
        "- 识别前提：双向固定效应把未被加税（X = 0）的国家×行业当作对照，前提是没有关税时两组的 Y 会平行变化。"
        "加税前只有 2016、2017 两年，能检验这一前提的证据有限；被加税名单按对美货物顺差确定，不是随机分配。"
        "本课程的 Y 按设定生成，这一前提由设计保证；用真实数据时需要单独检验。",
        "- 标准差：“个标准差”用扣掉各国家×行业平均水平和每年共同变化后 Y 的标准差换算（即模型实际使用的变化），"
        "不是全部记录的总标准差。",
        "- 多个结果：每个 95% 区间只针对它自己那一项；p 值小也不代表因果关系。",
        "- 不加控制变量的原因：同一时期的其他指标本身也可能受关税影响，纳入回归反而可能导致估计偏误。",
        "- 回归结果来自你在步骤 11–14 保存的计算，生成报告时不会重算；各步图中其余 Y 的条形是课程用同一份数据、"
        "同一个模型算出的结果。",
        f"- 生成时间：{generated_local}。",
        "",
        "## 方法参考文献",
        "",
        # The title is the link text, so a screen reader announces the work, not its URL; the printed report adds the
        # URL after each link (styles.css, @media print).
        *(
            f"{number}. {authors}[*{title}*]({url}){extra}"
            for number, (authors, title, extra, url) in enumerate(_REFERENCES, 1)
        ),
        "",
        *body_disclosures,
        "",
        "## 报告溯源",
        "",
        "以下信息供老师核对数据和记录版本，读报告时可以略过。",
        "",
        f"- 指标数据版本：`{_safe(metadata.get('release_id') or '—')}`",
        f"- 关税回归数据版本：`{TEACHING_VERSION}`；X 在数据中的字段名：`{X_COLUMN}`",
        f"- 会话摘要：`{fingerprint}`",
        "",
    ]
    markdown = "\n".join(lines)
    provenance["content_sha256"] = hashlib.sha256(markdown.encode()).hexdigest()
    return TeachingReport(markdown, provenance, f"gvc_experiment_report_{fingerprint}.md")
