"""第 16 步报告：答题门槛、自动快照、可选学生回归与溯源绑定。"""

from __future__ import annotations

import pytest

from gvcsim import artifacts, quizzes
from gvcsim.config import PROCESSED_DIR
from gvcsim.regression.design import RegressionDesign
from gvcsim.session import empty_session, make_record
from gvcsim.teaching_report import (
    GATE_STEPS,
    ReportGateError,
    ReportReplayError,
    _fingerprint,
    _rerun_recorded,
    _snapshot_lines,
    build,
    check_gate,
)

needs_artifacts = pytest.mark.skipif(
    not (PROCESSED_DIR / "panel_industry.csv").exists(),
    reason="需要 gvcsim compute 产出的面板与产物清单",
)


def _complete_session(manifest_id: str) -> dict:
    """只有答题与少量自动保存快照，没有回归运行。"""
    session = empty_session(manifest_id)
    snapshots = {
        1: {
            "slice": {"year": 2020, "table": "z", "row_country": "CHN", "col_country": "USA"},
            "observation": {"row": "CHN_D01T02", "column": "USA_D01T02", "value": 1.0},
        },
        11: {
            "viewed_shock_types": ["tariff", "sanctions", "export_control"],
            "viewed_events": ["美国301对华关税"],
        },
        4: {"year": 2020, "metric": "FVA_share", "compared": ["CHN", "USA"]},
        8: {"year": 2020, "chart": "quadrant", "compared": ["CHN", "USA"]},
    }
    for step in GATE_STEPS:
        session["steps"][str(step)] = make_record({**snapshots.get(step, {}), "quiz": quizzes.correct_quiz(step)})
    return session


def _add_trade_run(session: dict) -> None:
    data = session["steps"]["12"]["data"]
    data["run"] = {
        "settings": {
            "shockType": "export_control",
            "method": "did",
            "granularity": "country_industry",
            "controlMode": "none",
            "interaction": False,
            "priceMode": "nominal",
            "scenario": "clean",
            "weightMode": "fixed_pretreatment",
        },
    }


def test_gate_lists_every_incomplete_step_and_excludes_report_step():
    blocked = check_gate(empty_session("mid"))
    assert [item["step"] for item in blocked] == list(GATE_STEPS)
    assert all(item["missing"] for item in blocked)
    assert 16 not in GATE_STEPS


def test_gate_is_quiz_only():
    session = _complete_session("mid")
    assert check_gate(session) == []
    for step in GATE_STEPS:
        data = session["steps"][str(step)]["data"]
        assert set(data) == {"quiz"} or "quiz" in data


def test_build_refuses_when_quizzes_are_missing():
    with pytest.raises(ReportGateError) as excinfo:
        build(empty_session("mid"), "同学", 1)
    assert len(excinfo.value.missing) == len(GATE_STEPS)


def test_report_fingerprint_distinguishes_regression_weight_modes():
    session = empty_session("mid")
    design = RegressionDesign(outcome="trade")
    fixed = [{"design": design, "weight_mode": "fixed_pretreatment"}]
    current = [{"design": design, "weight_mode": "contemporaneous"}]
    assert _fingerprint(session, "mid", fixed, "同学") != _fingerprint(session, "mid", current, "同学")


def test_untrusted_snapshot_text_is_single_line_bounded_markdown():
    lines = _snapshot_lines(
        {
            "chart": "rank\n# forged heading | `code`",
            "compared": ["CHN", "x" * 300],
            "viewed_shock_types": ["tariff"],
        }
    )
    rendered = "\n".join(lines)
    assert "\n# forged" not in rendered
    assert "¦" in rendered and "ʼ" in rendered
    assert "关税冲击" in rendered
    assert len(max(lines, key=len)) < 400


def test_recorded_run_replay_failure_is_not_mislabeled_as_missing(monkeypatch):
    session = _complete_session("mid")
    _add_trade_run(session)

    def unavailable_panel(_design):
        raise OSError("test-only missing panel")

    monkeypatch.setattr("gvcsim.teaching_report._load_panel", unavailable_panel)
    with pytest.raises(ReportReplayError) as excinfo:
        _rerun_recorded(session, subject=None, require_trusted=False)

    assert excinfo.value.step == 12
    assert "已记录回归" in str(excinfo.value)
    assert "未记录学生运行" not in str(excinfo.value)


@needs_artifacts
def test_build_refuses_a_session_from_other_artifacts():
    with pytest.raises(ReportGateError):
        build(_complete_session("deadbeefdeadbeef"), "同学", 1)


@needs_artifacts
def test_report_without_student_runs_does_not_invent_models_or_coefficients():
    report = build(_complete_session(artifacts.manifest_id()), "同学", 7)
    assert report.provenance["runs"] == []
    for step in range(12, 16):
        assert f"步骤 {step}" in report.markdown
    assert report.markdown.count("未记录学生运行") >= 4
    assert "| 变量 | 系数 |" not in report.markdown
    assert "默认模型" in report.markdown


@needs_artifacts
def test_report_reruns_only_an_actual_student_run_and_records_its_source():
    session = _complete_session(artifacts.manifest_id())
    _add_trade_run(session)
    report = build(session, "同学", 7)
    assert [run["step"] for run in report.provenance["runs"]] == [12]
    assert report.provenance["runs"][0]["source"] == "student_run"
    assert "来源：学生实际运行，服务端已校验并复估" in report.markdown
    assert "| 变量 | 系数 |" in report.markdown
    assert "步骤 13" in report.markdown and "未记录学生运行" in report.markdown


@needs_artifacts
def test_report_records_meaningful_final_snapshots_without_a_click_timeline():
    report = build(_complete_session(artifacts.manifest_id()), "同学", 1)
    assert "自动记录的实验过程" in report.markdown
    assert "查看切片" in report.markdown
    assert "选中单元格" in report.markdown
    assert "打开过的政策事件" in report.markdown
    assert "图表视角" in report.markdown
    assert "不追踪逐次点击" in report.markdown
    assert "未由服务端重算验证" in report.markdown


@needs_artifacts
def test_report_binds_provenance_and_selected_quiz_answers():
    mid = artifacts.manifest_id()
    report = build(_complete_session(mid), "同学", 7)
    assert report.provenance["manifest_id"] == mid
    assert report.provenance["session_revision"] == 7
    assert report.report_key in report.markdown
    assert mid in report.markdown
    assert "Z 表的一格应该怎样解释" in report.markdown
    assert "行方国家×行业向列方国家×行业提供的中间投入" in report.markdown
    assert "mock" in report.markdown and "OECD ICIO" in report.markdown


@needs_artifacts
def test_report_key_tracks_report_content_but_ignores_random_receipts():
    mid = artifacts.manifest_id()
    first = build(_complete_session(mid), "同学", 1)
    again = build(_complete_session(mid), "同学", 2)
    assert first.report_key == again.report_key
    assert first.markdown == again.markdown

    changed = _complete_session(mid)
    changed["steps"]["8"] = make_record({"chart": "line", "compared": ["CHN", "VNM"], "quiz": quizzes.correct_quiz(8)})
    assert build(changed, "同学", 1).report_key != first.report_key

    receipts_changed = _complete_session(mid)
    receipts_changed["steps"]["1"]["data"]["quiz_id"] = "new-random-quiz-receipt"
    receipts_changed["steps"]["12"]["data"]["run_id"] = "new-random-run-receipt"
    assert build(receipts_changed, "同学", 3).report_key == first.report_key


@needs_artifacts
def test_report_is_portable_markdown_with_summary_and_limitations():
    report = build(_complete_session(artifacts.manifest_id()), "同学", 1)
    assert "gvcsim-chart" not in report.markdown
    assert "GVC 指标摘要" in report.markdown
    assert "FVA 份额最高" in report.markdown
    assert "GVC 位置指数最高" in report.markdown
    assert "网络介数中心性最高" in report.markdown
    assert "| 经济体 | FVA 份额 |" in report.markdown
    assert "| 国家×行业节点 | 介数中心性 |" in report.markdown
    assert "结论与限制" in report.markdown
    assert "WWZ (2013)" in report.markdown
    assert "WWYZ (2017)" in report.markdown
    assert "Gephi" in report.markdown
    assert "GDP 平减指数为拟真 mock" in report.markdown
    assert "不输出 exporter-importer-sector" in report.markdown


@needs_artifacts
def test_report_suggests_a_filename_bound_to_the_report_key():
    report = build(_complete_session(artifacts.manifest_id()), "同学", 1)
    assert report.suggested_filename.endswith(".md")
    assert report.report_key in report.suggested_filename
