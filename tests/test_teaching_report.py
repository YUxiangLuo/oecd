from pathlib import Path

import pytest

from gvcsim import config, quizzes
from gvcsim.artifacts import write_dataset_metadata
from gvcsim.session import empty_session, make_record
from gvcsim.teaching_report import GATE_STEPS, ReportGateError, build, check_gate


def _artifacts(path: Path, *, qc=None):
    for year in (2019, 2020):
        for name in (
            f"qc_{year}.json",
            f"export_exposure_{year}.csv",
            f"indicators_country_{year}.csv",
            f"indicators_industry_{year}.csv",
            f"network_edges_{year}.csv",
        ):
            (path / name).write_text("value\n1\n")
    write_dataset_metadata(path, [2019, 2020], metadata={"data_sources": {}, "qc": qc or {}})


def _complete():
    session = empty_session()
    session["steps"] = {str(step): make_record({"quiz": quizzes.correct_quiz(step)}) for step in GATE_STEPS}
    return session


def test_gate_is_only_the_first_fifteen_quizzes():
    assert [item["step"] for item in check_gate(empty_session())] == list(GATE_STEPS)
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
    assert report.provenance["runs"][0]["step"] == 12
    assert "1.2" in report.markdown and "不在报告生成时复算" in report.markdown
    assert "[0.6, 1.8]" in report.markdown
    assert "政策冲击为基于公开事件手工编码的拟真教学面板" in report.markdown
    assert "有向无权网络" in report.markdown
    assert report.provenance["network_algorithm"] == "gephi-compatible-directed-unweighted-positive-v1"


def test_malformed_saved_run_is_ignored(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["12"]["data"]["run"] = {"design": {"outcome": "trade"}, "result": "forged"}
    report = build(session, "同学")
    assert report.provenance["runs"] == []
    assert "步骤 12" in report.markdown and "未记录" in report.markdown


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

    assert "CHN_D01T02 × USA_D01T02 = 228.0672" in report.markdown
    assert "主动比较：CHN、USA" in report.markdown
    assert "仅用于探索定位，不限定下游回归样本" in report.markdown
    assert "按所选冲击类型汇总该类型全部已编码事件" in report.markdown


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

    report = build(session, "同学")

    assert "统计推断已抑制" in report.markdown
    assert "处理聚类不足" in report.markdown
    assert "| policy | -0.2 | 0.1 | 已抑制 | 已抑制 |" in report.markdown
