from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from typing import Any

from gvcsim import quizzes
from gvcsim.artifacts import NETWORK_ALGORITHM, ArtifactContractError, dataset_metadata, validate_release_cached
from gvcsim.config import COURSE_RELEASE, processed_years
from gvcsim.data.citations import report_source_disclosures, report_source_label
from gvcsim.regression.teaching import VERSION as TEACHING_VERSION, X_COLUMN
from gvcsim.session import SESSION_VERSION
from gvcsim.report_common import ReportGateError, TeachingReport, _safe
from gvcsim.report_gate import check_gate
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


def build(session: dict[str, Any], student: str, *_unused: Any, **_unused_kw: Any) -> TeachingReport:
    blocked = check_gate(session)
    if blocked:
        raise ReportGateError(blocked)
    years = processed_years()
    if not years:
        raise ReportGateError([{"step": 0, "title": "数据不可用", "missing": ["尚未生成固定数据产物"]}])
    runs = _saved_runs(session)
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    fingerprint = hashlib.sha256(json.dumps(session, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]
    try:
        validate_release_cached()
        metadata = dataset_metadata()
    except (ArtifactContractError, OSError, ValueError, TypeError, RuntimeError) as error:
        raise ReportGateError(
            [{"step": 0, "title": "数据不可用", "missing": ["数据发布质检 contract 未通过验证"]}]
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
    source = report_source_label(data_sources)
    lines = [
        "# GVC 指标与模拟关税实验报告",
        "",
        f"学生：{_safe(student)}",
        "",
        f"> **真实数据部分（步骤 1–9）**：覆盖 {years[0]}–{years[-1]}，指标来源：{_safe(source)}。模拟 Y 仅以首年有效指标的排名校准基准，不保留真实水平或轨迹。",
        "",
        f"> **模拟教学部分（步骤 10–14）**：版本 `{TEACHING_VERSION}` 的 X 与四个独立模拟 Y 均非 OECD 真实指标；X=固定冲击前销往模拟加税市场出口份额×模拟税率。",
        "",
        "> 步骤 11–14 固定使用 country_industry × tariff × twfe_intensity × 无控制 × 无交互 × clean。系数与区间只描述模拟 X、Y 的关联，不是因果效果；四个 Y 量纲不同且必须完整报告。",
        "",
        "> 本实验没有生成冲击后的投入产出表或网络，因此不能用模拟 Y 判断真实结构、链长或网络位置的变化。",
        "",
        *_reflection_section(session),
        *_observed_evidence_section(session),
        *_evidence_summary(runs, metadata["simulation_contract"]["source_filter_disclosure"]),
        *_quiz_sections(session),
        *_experiment_sections(session),
        *_run_sections(runs),
        *_qc_disclosure_section(qc_summary, integrity_metadata),
        "## 数据与方法说明",
        "",
        "- 指标算法：WWZ 16 个明细项归并为五类，另加由 OECD ICIO TLS（产品税减补贴）账户计算的 taxsub 扩展项以匹配 VA+TLS 账户闭合总出口（gross exports）；TLS/taxsub 不等于关税冲击，也不是 WWZ 原文分类。课程 FVA_share 使用 WWZ FVA（不含 FDC）作分子、VA+TLS 总出口作分母，包含 WWZ 分解中不含 FDC 的外国增加值，但不是 OECD 官方 EXGR_FVASH。生产分解与生产长度采用 WWYZ 口径。",
        "- 网络算法：保留全部有向正流量边与正自环。加权总度=加权入度+加权出度，正自环计两次；它不是去重后的贸易额。路径指标按有向无权网络计算。eigencentrality 精确复现 Gephi 0.10.1 累计入边兼容分数，不等于标准 Perron 特征向量幂迭代。",
        "- 无权路径口径把微小正边与大额边视为同样长度，因此高介数只表示这套二值拓扑上的最短路径中介位置，不自动等于经济规模、关键瓶颈或不可替代。",
        "- 网络解释顺序：先以加权度观察经济流量规模，再把无权介数作为拓扑基准并比较排序。当前报告没有边阈值敏感性分析，微小正边是否改变最短路径与排序尚未检验。",
        f"- 模拟契约：`{TEACHING_VERSION}`；X=`{X_COLUMN}`，四个 Y 为独立 seeded teaching simulation。固定国家×行业及年份效应，无控制、无交互。",
        "- 多结果与显著性：四项结果必须完整报告；95% 区间为逐项区间，不是四结果族的同时置信带；p 值不是因果结论开关。",
        "- 同期 ICIO 派生量与模拟宏观量可能是处理后变量，公开主回归禁止将其作为普通遗漏变量控制；模拟 GDP deflator 只称教学模拟平减指数。",
        "- 回归结果来自学生会话中保存的服务端运行，不在报告生成时复算。",
        f"- 生成时间：{generated_at}；会话摘要：`{fingerprint}`。",
        "",
        "## 方法参考文献",
        "",
        "1. Yamano et al. (2023), *Development of the OECD Inter-Country Input-Output Database 2023*, https://doi.org/10.1787/5a5d0665-en",
        "2. OECD (2023), *Guide to OECD TiVA Indicators*, https://www.oecd.org/content/dam/oecd/en/topics/policy-sub-issues/trade-in-value-added/tiva-indicators-guide-2023.pdf",
        "3. Koopman, Wang & Wei (2014), *Tracing Value-Added and Double Counting in Gross Exports*, https://doi.org/10.1257/aer.104.2.459",
        "4. Wang, Wei & Zhu, *Quantifying International Production Sharing at the Bilateral and Sector Levels*, NBER w19677, https://www.nber.org/papers/w19677",
        "5. Wang, Wei, Yu & Zhu, *Measures of Participation in Global Value Chains and Global Business Cycles*, NBER w23222, https://www.nber.org/papers/w23222",
        "6. Wang, Wei, Yu & Zhu, *Characterizing Global Value Chains: Production Length and Upstreamness*, NBER w23261, https://www.nber.org/papers/w23261",
        "7. Brandes (2001), *A Faster Algorithm for Betweenness Centrality*, https://doi.org/10.1080/0022250X.2001.9990249",
        "8. Gephi issue #2145, *Eigenvector centrality wrong?*, https://github.com/gephi/gephi/issues/2145",
        "9. Wasserstein & Lazar (2016), *The ASA Statement on p-Values*, https://doi.org/10.1080/00031305.2016.1154108",
        "10. Cameron & Miller (2015), *A Practitioner’s Guide to Cluster-Robust Inference*, https://doi.org/10.3368/jhr.50.2.317",
        "",
        *report_source_disclosures(data_sources),
        "",
    ]
    markdown = "\n".join(lines)
    provenance["content_sha256"] = hashlib.sha256(markdown.encode()).hexdigest()
    return TeachingReport(markdown, provenance, f"gvc_experiment_report_{fingerprint}.md")
