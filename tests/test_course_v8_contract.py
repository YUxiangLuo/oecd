from gvcsim import quizzes, teaching_report
from gvcsim.report_saved_run import _parse_saved_run
from gvcsim.regression.teaching import VERSION, X_COLUMN, Y_COLUMNS, model_snapshot, variable_catalog
from gvcsim.steps import STEPS


def _run(outcome: str, *, version: str = VERSION, coefficient: str = X_COLUMN) -> dict:
    snapshot = model_snapshot(outcome)
    snapshot["version"] = version
    return {
        "design": {
            "outcome": outcome,
            "granularity": "country_industry",
            "shock_type": "tariff",
            "method": "twfe_intensity",
            "control_mode": "none",
            "interaction": False,
            "scenario": "clean",
        },
        "result": {
            "status": "ok",
            "support": {"status": "ok", "suppress_inference": False, "reasons": []},
            "diagnostics": {"study_contract": "economics-v2"},
            "coefs": [{
                "name": coefficient, "coef": 1.0, "se": 0.2, "t": 5.0,
                "p": 0.01, "ci_low": 0.6, "ci_high": 1.4,
            }],
        },
        "model_snapshot": snapshot,
        "variable_catalog": variable_catalog(outcome),
    }


def test_v8_quiz_rejects_old_answers():
    assert quizzes.QUIZ_VERSION == "course-quiz-v8"
    try:
        quizzes.grade(10, "course-quiz-v7", {"s10-role": "a", "s10-types": "b"})
    except ValueError as error:
        assert "版本已更新" in str(error)
    else:
        raise AssertionError("旧题库答案不应通过")


def test_saved_run_requires_version_and_actual_x_y_contract():
    assert _parse_saved_run(_run("trade"), "trade") is not None
    assert _parse_saved_run(_run("trade", version="old-did"), "trade") is None
    assert _parse_saved_run(_run("trade", coefficient="treated"), "trade") is None
    wrong_y = _run("trade")
    wrong_y["model_snapshot"]["y_column"] = Y_COLUMNS["network"]
    assert _parse_saved_run(wrong_y, "trade") is None


def test_step10_gate_requires_complete_current_panel_state():
    session = {"steps": {"10": {"data": {"viewed_teaching_panel": True, "teaching_panel_version": VERSION}}}}
    blocked = teaching_report.check_material_gate(session)
    assert any(item["step"] == 10 for item in blocked)
    session["steps"]["10"]["data"].update(
        teaching_country="CHN",
        teaching_year=2019,
        teaching_observation={
            "country": "CHN",
            "industry": "C26",
            "year": 2019,
            "teaching_export_share_w": 0.2,
            "teaching_tariff_rate_tau": 0.1,
            "teaching_tariff_exposure": 0.02,
            "version": VERSION,
        },
    )
    blocked = teaching_report.check_material_gate(session)
    assert not any(item["step"] == 10 for item in blocked)


def test_regression_stage_task_goals_match_the_beginner_workflow():
    by_number = {step["n"]: step for step in STEPS}
    assert "两个国家和一个行业" in by_number[10]["tasks"][0]
    assert "年份" not in by_number[10]["tasks"][0]
    assert "跨境生产长度" in by_number[13]["goal"]
    assert "模拟网络位置" in by_number[14]["goal"]
    for step in (13, 14):
        assert "Y₃" not in by_number[step]["goal"]
        assert "Y₄" not in by_number[step]["goal"]
        assert "固定模型" not in by_number[step]["goal"]
