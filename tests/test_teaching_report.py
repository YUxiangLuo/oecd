"""第 16 步报告：答题门槛、自动快照、可选学生回归与溯源绑定。"""

from __future__ import annotations

import pytest

from gvcsim import artifacts, quizzes
from gvcsim.config import PROCESSED_DIR
from gvcsim.data.citations import OECD_ICIO_DATASET_URL, OECD_ICIO_METHODOLOGY_URL, OECD_ICIO_TERMS_URL
from gvcsim.regression.design import RegressionDesign
from gvcsim.session import empty_session, make_record
from gvcsim.teaching_report import (
    GATE_STEPS,
    ReportGateError,
    ReportReplayError,
    _display_entity_code,
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


def _add_trade_placebo(session: dict, *, empirical_p: float = 0.05) -> None:
    settings = dict(session["steps"]["12"]["data"]["run"]["settings"])
    session["steps"]["12"]["data"].update(
        {
            "placebo_run": {
                "settings": settings,
                "response": {
                    "design": {"outcome": "trade", "method": "did"},
                    "placebo": {
                        "policy_name": "treated×post",
                        "true_coef": -0.25,
                        "placebo_coefs": [-0.05, 0.02, 0.12],
                        "empirical_p": empirical_p,
                        "n_draws": 3,
                        "requested_draws": 10,
                        "seed": 2026,
                        "treated_entities": 10,
                        "total_entities": 100,
                        "cohorts": {"2019": 10},
                        "note": "test",
                    },
                    "disclaimer": "test",
                },
            },
            "placebo_id": "test-only-receipt",
        }
    )


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


def test_observation_snapshot_preserves_industry_codes_and_uses_metric_precision():
    lines = _snapshot_lines(
        {
            "year": 2019,
            "metric": "FVA_share",
            "observations": [
                {
                    "entity": "USA·A01_02",
                    "country": "USA",
                    "industry": "A01_02",
                    "year": 2019,
                    "value": 0.0800925449831696,
                }
            ],
        }
    )
    assert _display_entity_code("USA_A01_02") == "USA · A01_02"
    assert _display_entity_code("USA·A01_02") == "USA · A01_02"
    assert any("USA · A01_02（2019 年） = 8.01%" in line for line in lines)
    assert "0.0800925449831696" not in "\n".join(lines)


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
    assert "来源：学生实际运行，服务器已校验并重新估计" in report.markdown
    assert "| 变量 | 系数 |" in report.markdown
    assert "步骤 13" in report.markdown and "未记录学生运行" in report.markdown


@needs_artifacts
def test_trusted_report_path_verifies_the_exact_saved_placebo(monkeypatch):
    session = _complete_session(artifacts.manifest_id())
    _add_trade_run(session)
    _add_trade_placebo(session)
    design = {
        "outcome": "trade",
        "granularity": "country_industry",
        "shock_type": "export_control",
        "method": "did",
        "control_mode": "none",
        "interaction": False,
        "price_mode": "nominal",
        "scenario": "clean",
        "exclude_row": True,
        "weight_mode": "fixed_pretreatment",
    }
    seen: dict = {}
    monkeypatch.setattr(
        "gvcsim.teaching_report.trusted_evidence.verify_regression_run",
        lambda *_args, **_kwargs: {"design": design},
    )

    def verify_placebo(*_args, **kwargs):
        seen.update(kwargs)
        return {"design": design}

    monkeypatch.setattr(
        "gvcsim.teaching_report.trusted_evidence.verify_placebo_run",
        verify_placebo,
    )

    runs = _rerun_recorded(session, subject="student", require_trusted=True)

    assert runs[0]["placebo"]["result"]["empirical_p"] == 0.05
    assert seen["subject"] == "student"
    assert seen["step"] == 12
    assert seen["result"]["n_draws"] == 3


@needs_artifacts
def test_report_persists_and_proves_an_actual_placebo_result():
    session = _complete_session(artifacts.manifest_id())
    _add_trade_run(session)
    without_placebo = build(session, "同学", 1)

    _add_trade_placebo(session, empirical_p=0.05)
    report = build(session, "同学", 2)

    assert report.report_key != without_placebo.report_key
    assert "学生实际运行的安慰剂稳健性检验" in report.markdown
    assert "随机化完成：3 / 10" in report.markdown
    assert "经验 p 值：0.050" in report.markdown
    assert "不能证明因果关系" in report.markdown
    placebo = report.provenance["runs"][0]["placebo"]
    assert placebo["source"] == "student_placebo"
    assert placebo["n_draws"] == 3
    assert placebo["empirical_p"] == 0.05
    assert len(placebo["result_sha256"]) == 64


@needs_artifacts
def test_report_does_not_attach_a_placebo_from_different_main_settings():
    session = _complete_session(artifacts.manifest_id())
    _add_trade_run(session)
    _add_trade_placebo(session)
    session["steps"]["12"]["data"]["placebo_run"]["settings"]["controlMode"] = "icio_derived"

    report = build(session, "同学", 1)

    assert "学生实际运行的安慰剂稳健性检验" not in report.markdown
    assert "placebo" not in report.provenance["runs"][0]


@needs_artifacts
def test_report_records_meaningful_final_snapshots_without_a_click_timeline():
    report = build(_complete_session(artifacts.manifest_id()), "同学", 1)
    assert "自动记录的实验过程" in report.markdown
    assert "查看筛选结果" in report.markdown
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
    assert "行方经济体×行业向列方经济体×行业提供的中间投入" in report.markdown
    assert "国家×行业" not in report.markdown
    assert "个体基期 GVC 减去样本个体均值" in report.markdown
    assert "拟真教学面板" in report.markdown
    assert "报告编号" in report.markdown
    assert "技术溯源（供核验）" in report.markdown
    assert "数据引用与许可提示" in report.markdown
    assert "report_key" not in report.markdown
    assert "manifest_id" not in report.markdown
    assert "教学 mock" not in report.markdown


@needs_artifacts
def test_ci_synthetic_teaching_report_does_not_claim_real_oecd_data(monkeypatch):
    mid = artifacts.manifest_id()
    monkeypatch.setattr(
        artifacts,
        "manifest_provenance",
        lambda: {
            "data_sources": {
                "ci_synthetic_icio": {
                    "citation": "Deterministic CI-only fixture; contains no OECD observations.",
                    "production_data": False,
                }
            }
        },
    )

    report = build(_complete_session(mid), "同学", 1)

    assert "CI-only 确定性合成" in report.markdown
    assert "不得冒充 OECD 数据" in report.markdown
    assert OECD_ICIO_DATASET_URL not in report.markdown


@needs_artifacts
def test_oecd_teaching_report_includes_stable_attribution(monkeypatch):
    mid = artifacts.manifest_id()
    provenance = artifacts.manifest_provenance()
    monkeypatch.setattr(
        artifacts,
        "manifest_provenance",
        lambda: {**provenance, "data_sources": {"oecd_icio": {}}},
    )

    report = build(_complete_session(mid), "同学", 1)

    assert OECD_ICIO_DATASET_URL in report.markdown
    assert OECD_ICIO_METHODOLOGY_URL in report.markdown
    assert OECD_ICIO_TERMS_URL in report.markdown
    assert "不代表 OECD 审核、参与或背书" in report.markdown


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
    receipts_changed["steps"]["12"]["data"]["placebo_id"] = "new-random-placebo-receipt"
    assert build(receipts_changed, "同学", 3).report_key == first.report_key


@needs_artifacts
def test_report_is_portable_markdown_with_summary_and_limitations():
    report = build(_complete_session(artifacts.manifest_id()), "同学", 1)
    assert "gvcsim-chart" not in report.markdown
    assert "GVC 指标摘要" in report.markdown
    assert "FVA 份额最高" in report.markdown
    assert "GVC 位置指数最高" in report.markdown
    assert "网络介数中心性最高" in report.markdown
    assert "| 经济体代码 | FVA 份额 |" in report.markdown
    assert "| 经济体×行业代码 | 介数中心性 |" in report.markdown
    assert "## 6. 结论与限制" in report.markdown
    assert "## 7. 技术溯源（供核验）" in report.markdown
    assert "WWZ（2013）" in report.markdown
    assert "WWYZ（2017）" in report.markdown
    assert "Gephi" in report.markdown
    assert "GDP 平减指数为拟真教学数据" in report.markdown
    assert "出口方×进口方×行业" in report.markdown
    assert "exporter-importer-sector" not in report.markdown


@needs_artifacts
def test_report_suggests_a_filename_bound_to_the_report_key():
    report = build(_complete_session(artifacts.manifest_id()), "同学", 1)
    assert report.suggested_filename.endswith(".md")
    assert report.report_key in report.suggested_filename
