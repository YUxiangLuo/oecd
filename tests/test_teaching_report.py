from pathlib import Path

import pytest

from gvcsim import config, quizzes
from gvcsim.artifacts import write_dataset_metadata
from gvcsim.session import empty_session, make_record
from gvcsim.teaching_report import REFLECTION_TEXT_LIMIT, GATE_STEPS, ReportGateError, build, check_gate


def _artifacts(path: Path, *, qc=None):
    for year in (2019, 2020):
        for name in (
            f"qc_{year}.json",
            f"export_exposure_{year}.csv",
            f"indicators_country_{year}.csv",
            f"indicators_industry_{year}.csv",
            f"network_edges_{year}.csv",
        ):
            (path / name).write_text("[]" if name.endswith(".json") else "value\n1\n")
    write_dataset_metadata(
        path,
        {
            "release_id": "2" * 32,
            "years": [2019, 2020],
            "generated_at": "2026-08-13T00:00:00+00:00",
            "course_release": config.COURSE_RELEASE,
            "network_algorithm": "gephi-compatible-directed-unweighted-positive-v1",
            "data_sources": {},
            "qc": qc or {},
        },
    )


def _complete():
    session = empty_session()
    session["steps"] = {str(step): make_record({"quiz": quizzes.correct_quiz(step)}) for step in GATE_STEPS}
    session["steps"]["1"]["data"]["observation"] = {
        "row": "CHN_D01T02",
        "column": "USA_D01T02",
        "value": 1.0,
    }
    session["steps"]["7"]["data"]["compared"] = ["CHN", "USA"]
    session["steps"]["12"]["data"]["run"] = {
        "design": {"outcome": "trade", "equation": "y = policy + FE"},
        "result": {"status": "ok", "n_obs": 1, "coefs": [{"name": "treated×post", "coef": 0.0}]},
    }
    session["steps"]["16"] = make_record(
        {
            "research_question": "关税冲击是否改变出口中的外国增加值份额？",
            "evidence_interpretation": "我将描述性比较与保存的回归点估计、置信区间一起解读，只把它们视为当前设定下的证据而非自动的因果证明。",
            "limitations": "冲击是教学编码，平行趋势和无同期混杂未被证明，而且行业可能受到同一国家冲击与网络外溢。",
        }
    )
    return session


def test_gate_requires_quizzes_key_operations_run_and_reflection():
    blocked = check_gate(empty_session())
    assert set(GATE_STEPS) <= {item["step"] for item in blocked}
    assert any(item["step"] == 1 and "具体单元格" in "".join(item["missing"]) for item in blocked)
    assert any(item["step"] == 7 and "两个比较对象" in "".join(item["missing"]) for item in blocked)
    assert any(item["step"] == 12 and "有效回归" in "".join(item["missing"]) for item in blocked)
    assert any(item["step"] == 16 and "原创" in item["title"] for item in blocked)
    assert check_gate(_complete()) == []
    with pytest.raises(ReportGateError):
        build(empty_session(), "同学")


def test_report_uses_saved_result_without_calling_estimator(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["12"]["data"]["run"] = {
        "settings": {"method": "did"},
        "design": {"outcome": "trade", "equation": "y = policy + FE"},
        "result": {
            "status": "ok",
            "n_obs": 42,
            "coefs": [{"name": "policy", "coef": 1.2, "se": 0.3, "p": 0.01, "ci_low": 0.6, "ci_high": 1.8}],
        },
    }
    report = build(session, "同学")
    assert report.provenance["years"] == [2019, 2020]
    assert report.provenance["release_id"] == "2" * 32
    assert report.provenance["quiz_version"] == quizzes.QUIZ_VERSION
    assert report.provenance["course_release"] == "2026-fall"
    assert report.provenance["runs"][0]["step"] == 12
    assert report.provenance["runs"][0]["result"]["coefs"][0]["coef"] == 1.2
    assert "1.2" in report.markdown and "不在报告生成时复算" in report.markdown
    assert "[0.6, 1.8]" in report.markdown
    assert "## 关键证据摘要" in report.markdown
    assert "处理后相对变化" in report.markdown
    assert "+120.00 个百分点" in report.markdown
    assert "## 技术附录：保存的回归结果" in report.markdown
    assert "| 政策处理项 | 1.2 | 0.3 | [0.6, 1.8] | 0.01 |" in report.markdown
    assert "政策冲击为基于公开事件手工编码的拟真教学面板" in report.markdown
    assert "有向无权网络" in report.markdown
    assert report.provenance["network_algorithm"] == "gephi-compatible-directed-unweighted-positive-v1"


def test_report_preserves_the_full_accepted_research_question(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    question = "问" * (REFLECTION_TEXT_LIMIT - 1) + "终"
    session["steps"]["16"]["data"]["research_question"] = question

    report = build(session, "同学")

    assert question in report.markdown
    frontend = (config.ROOT / "frontend" / "src" / "labs" / "steps" / "step16-report.tsx").read_text()
    assert f"export const REFLECTION_MAX_LENGTH = {REFLECTION_TEXT_LIMIT};" in frontend


def test_report_preserves_reflection_paragraphs_and_markdown_characters(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    evidence_text = "第一段引用 `treated×post` | 置信区间。\n\n第二段保留学生自己的段落结构与标点。"
    session["steps"]["16"]["data"]["evidence_interpretation"] = evidence_text

    report = build(session, "同学")

    assert evidence_text in report.markdown


def test_reflection_over_the_advertised_limit_blocks_report():
    session = _complete()
    session["steps"]["16"]["data"]["research_question"] = "问" * (REFLECTION_TEXT_LIMIT + 1)

    blocked = check_gate(session)

    assert any(item["step"] == 16 and "不能超过" in "".join(item["missing"]) for item in blocked)


def test_malformed_only_saved_run_blocks_report(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["12"]["data"]["run"] = {"design": {"outcome": "trade"}, "result": "forged"}
    blocked = check_gate(session)
    assert any(item["step"] == 12 and "有效回归" in "".join(item["missing"]) for item in blocked)
    with pytest.raises(ReportGateError):
        build(session, "同学")


@pytest.mark.parametrize("status", ["insufficient", "invalid_design", []])
def test_non_inferential_saved_run_does_not_satisfy_valid_regression_gate(status):
    session = _complete()
    session["steps"]["12"]["data"]["run"]["result"].update(
        {
            "status": status,
            "support": {"status": status, "suppress_inference": True},
        }
    )

    blocked = check_gate(session)

    assert any(item["step"] == 12 and "有效回归" in "".join(item["missing"]) for item in blocked)


def test_qualified_run_on_same_step_still_satisfies_gate_after_insufficient_latest(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["12"]["data"]["qualified_run"] = session["steps"]["12"]["data"]["run"]
    session["steps"]["12"]["data"]["run"] = {
        "design": {"outcome": "trade", "equation": "y = policy + FE", "shock_type": "export_control"},
        "result": {
            "status": "insufficient",
            "support": {"status": "insufficient", "suppress_inference": True, "treated_clusters": 1},
            "n_obs": 10,
            "coefs": [{"name": "export_control_treated×post", "coef": -0.01}],
        },
    }

    assert check_gate(session) == []
    report = build(session, "同学")
    assert "统计推断已抑制" in report.markdown or "处理支持度不足" in report.markdown
    assert "双重差分" in report.markdown or "treated×post" in report.markdown or "政策处理项" in report.markdown


def test_report_carries_release_qc_disclosures(tmp_path, monkeypatch):
    qc = {
        "years": {"2020": {"requires_disclosure": True, "warning": ["边界检查"]}},
        "shocks": {"requires_disclosure": True, "disclosure": ["教学模拟冲击"]},
    }
    _artifacts(tmp_path, qc=qc)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    report = build(_complete(), "同学")
    assert report.provenance["qc"] == qc
    assert "## 数据质量披露" in report.markdown
    assert "Warning：边界检查" in report.markdown
    assert "Disclosure：教学模拟冲击" in report.markdown


def test_report_includes_saved_experiment_snapshots_and_event_scope(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["1"]["data"].update(
        {
            "slice": {"year": 2020, "table": "z", "row_country": "CHN", "col_country": "USA"},
            "observation": {"row": "CHN_D01T02", "column": "USA_D01T02", "value": 228.0672},
        }
    )
    session["steps"]["7"]["data"].update(
        {
            "year": 2020,
            "chart": "quadrant",
            "compared": ["CHN", "USA"],
            "metric": "FVA_share",
            "observations": [
                {"entity": "CHN", "year": 2020, "value": 0.12},
                {"entity": "USA", "year": 2020, "value": 0.08},
            ],
        }
    )
    session["steps"]["11"]["data"].update(
        {
            "viewed_shock_types": ["tariff"],
            "viewed_events": ["示例事件"],
            "selected_event_key": "示例事件::2018-07-06",
        }
    )

    report = build(session, "同学")

    assert "CHN_D01T02 × USA_D01T02 = 228.1" in report.markdown
    assert "主动比较：CHN、USA" in report.markdown
    assert "| CHN | 2020 | 0.12 |" in report.markdown
    assert "仅用于探索定位，不限定下游回归样本" in report.markdown
    assert "按所选冲击类型汇总该类型全部已编码事件" in report.markdown
    assert "## 学生原创分析与反思" in report.markdown
    assert "关税冲击是否改变出口中的外国增加值份额" in report.markdown


def test_report_marks_suppressed_inference_and_reasons(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["12"]["data"]["run"] = {
        "design": {"outcome": "trade", "depvar_label": "FVA 份额", "equation": "y = policy + FE"},
        "result": {
            "status": "insufficient",
            "status_reasons": ["处理聚类不足"],
            "support": {"status": "insufficient", "suppress_inference": True, "treated_clusters": 1},
            "n_obs": 20,
            "coefs": [{"name": "policy", "coef": -0.2, "se": 0.1, "p": None, "ci_low": None, "ci_high": None}],
        },
    }
    # 无效/支持不足的运行仍可如实进入报告，但必须另有一次可报告运行才能通过门槛。
    session["steps"]["13"]["data"]["run"] = {
        "design": {"outcome": "production", "equation": "y = policy + FE"},
        "result": {"status": "ok", "n_obs": 20, "coefs": [{"name": "policy", "coef": 0.1}]},
    }

    report = build(session, "同学")

    assert "统计推断已抑制" in report.markdown
    assert "处理聚类不足" in report.markdown
    assert "| 政策处理项 | -0.2 | 0.1 | 已抑制 | 已抑制 |" in report.markdown


def test_report_translates_settings_controls_and_rounds_display_values(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["12"]["data"]["run"] = {
        "design": {
            "outcome": "trade",
            "depvar_label": "FVA 份额",
            "equation": "FVA_share_ijt = treated×post + controls",
            "granularity": "country_industry",
            "shock_type": "tariff",
            "method": "did",
            "control_mode": "icio_derived",
            "price_mode": "nominal",
            "scenario": "clean",
            "controls": ["log_gdp_proxy"],
        },
        "result": {
            "status": "warning",
            "n_obs": 16348,
            "coefs": [
                {
                    "name": "treated×post",
                    "coef": 0.0013729825631389496,
                    "se": 0.001556326861714243,
                    "p": 0.38049053387270826,
                    "ci_low": -0.0017273795304135428,
                    "ci_high": 0.0044733446566914414,
                },
                {"name": "log_gdp_proxy", "coef": -0.028947058783405005, "se": 0.014101910976155195},
            ],
        },
    }

    markdown = build(session, "同学").markdown

    assert "关税冲击 · 双重差分 (DID) · 国家–行业级 · ICIO 派生控制变量" in markdown
    assert "+0.14 个百分点" in markdown
    assert "[-0.17, +0.45] 个百分点" in markdown
    assert "证据不足，无法判断方向" in markdown
    assert "处理后相对变化（处理组 × 处理后）" in markdown
    assert "增加值规模(log, ICIO GDP proxy)" in markdown
    assert "0.0013729825631389496" not in markdown
    assert "country_industry" not in markdown
    assert "icio_derived" not in markdown


def test_report_summary_prioritizes_failed_pretrend_and_names_scenario(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["12"]["data"]["run"] = {
        "design": {
            "outcome": "trade",
            "depvar_label": "FVA 份额",
            "granularity": "country_industry",
            "shock_type": "tariff",
            "method": "event_study",
            "control_mode": "none",
            "scenario": "confounded",
            "controls": [],
            "equation": "y = event time + FE",
        },
        "result": {
            "status": "warning",
            "status_reasons": ["没有完全未处理的对照聚类"],
            "support": {
                "status": "warning",
                "suppress_inference": False,
                "treated_clusters": 76,
                "untreated_clusters": 0,
                "untreated_entities": 3075,
                "reasons": ["没有完全未处理的对照聚类"],
            },
            "n_obs": 16348,
            "coefs": [
                {
                    "name": "k=0",
                    "coef": 0.02,
                    "se": 0.004,
                    "p": 0.001,
                    "ci_low": 0.012,
                    "ci_high": 0.028,
                }
            ],
            "diagnostics": {
                "pretrend": {
                    "available": True,
                    "p": 0.00001,
                    "interpretation": "检测到明显的冲击前差异，因果解释需谨慎。",
                }
            },
        },
    }

    markdown = build(session, "同学").markdown

    assert "前趋势混杂教学面板" in markdown
    assert "冲击前趋势存在明显差异" in markdown
    assert "只能描述该数值，不能把它解释为冲击后的方向性变化证据" in markdown
    assert "最重要的设计限制：** 冲击前趋势联合检验 p=<0.0001" in markdown
    assert "发现正向变化证据" not in markdown
