from gvcsim import quizzes, teaching_report
from gvcsim.regression.teaching import VERSION, X_COLUMN, Y_COLUMNS, model_snapshot, variable_catalog


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
        "result": {"coefs": [{"name": coefficient, "coef": 1.0}]},
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
    assert teaching_report._parse_saved_run(_run("trade"), "trade") is not None
    assert teaching_report._parse_saved_run(_run("trade", version="old-did"), "trade") is None
    assert teaching_report._parse_saved_run(_run("trade", coefficient="treated"), "trade") is None
    wrong_y = _run("trade")
    wrong_y["model_snapshot"]["y_column"] = Y_COLUMNS["network"]
    assert teaching_report._parse_saved_run(wrong_y, "trade") is None


def test_step10_gate_requires_complete_current_panel_state():
    session = {"steps": {"10": {"data": {"viewed_teaching_panel": True, "teaching_panel_version": VERSION}}}}
    blocked = teaching_report.check_material_gate(session)
    assert any(item["step"] == 10 for item in blocked)
    session["steps"]["10"]["data"].update(teaching_country="CHN", teaching_year=2019)
    blocked = teaching_report.check_material_gate(session)
    assert not any(item["step"] == 10 for item in blocked)
