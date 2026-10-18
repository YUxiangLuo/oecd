import json

import pytest
from fastapi import HTTPException
from scipy import stats

from gvcsim import quizzes, teaching_report
from gvcsim.classroom import routes as classroom_routes
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.service import design_info
from gvcsim.report_saved_run import _parse_saved_run
from gvcsim.regression.teaching import VERSION, X_COLUMN, Y_COLUMNS, model_snapshot, variable_catalog
from gvcsim.session import empty_session, make_record
from gvcsim.steps import STEPS


def _run(outcome: str, *, version: str = VERSION, coefficient: str = X_COLUMN) -> dict:
    snapshot = json.loads(json.dumps(model_snapshot(outcome)))
    snapshot["version"] = version
    design = RegressionDesign(outcome, teaching=True)
    critical = stats.t.ppf(0.975, 3)

    def estimate(name: str, coef: float, se: float = 0.2) -> dict:
        return {
            "name": name,
            "coef": coef,
            "se": se,
            "t": coef / se,
            "p": float(2 * stats.t.sf(abs(coef / se), 3)),
            "ci_low": float(coef - critical * se),
            "ci_high": float(coef + critical * se),
        }

    names = [coefficient, *design.regressors[1:], *design.controls]
    return {
        "design": design_info(design),
        "result": {
            "status": "ok",
            "n_obs": 20,
            "n_entities": 4,
            "n_times": 5,
            "n_clusters": 4,
            "support": {"status": "ok", "suppress_inference": False, "reasons": []},
            "diagnostics": {"study_contract": "economics-v2"},
            "coefs": [estimate(name, coef) for name, coef in zip(names, (0.6, 0.4, 0.1, 0.03, 0.001), strict=True)],
            "cumulative": estimate("cumulative", 1.0, 0.2),
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
    assert _parse_saved_run(_run("trade", version="step10-tariff-teaching-v1"), "trade") is None
    assert _parse_saved_run(_run("trade", coefficient="treated"), "trade") is None
    wrong_y = _run("trade")
    wrong_y["model_snapshot"]["y_column"] = Y_COLUMNS["network"]
    assert _parse_saved_run(wrong_y, "trade") is None


@pytest.mark.parametrize("field", ["role", "name"])
@pytest.mark.parametrize("value", [[], {}], ids=["list", "object"])
def test_session_rejects_nontext_variable_identity_without_server_error(field, value):
    run = _run("trade")
    run["variable_catalog"][0][field] = value
    session = empty_session()
    session["steps"]["11"] = make_record({"run": run})

    with pytest.raises(HTTPException) as error:
        classroom_routes.put_session(
            classroom_routes.SessionRequest(session=session, base_updated_at=None), {"sub": "student"}
        )

    assert error.value.status_code == 422
    assert "步骤 11 保存的回归结果已过期" in error.value.detail
    assert "“计算贸易流回归”" in error.value.detail and "teaching-v" not in error.value.detail


@pytest.mark.parametrize("reasons", [None, [], [" "], [None], ["支持不足", 42]])
def test_stopped_run_requires_nonempty_text_diagnostic_reasons(reasons):
    run = _run("trade")
    run["result"].update(
        status="insufficient",
        support={"status": "insufficient", "suppress_inference": True, "reasons": reasons},
    )
    run["result"]["coefs"][0].update(p=None, ci_low=None, ci_high=None)

    assert _parse_saved_run(run, "trade") is None


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
    # Step 10 leads with the course's US tariff (two waves, goods), then X on one example, then every country's X.
    assert "课程模拟" in by_number[10]["tasks"][0] and "两批" in by_number[10]["tasks"][0]
    assert "不是真实政策" in by_number[10]["tasks"][0]
    assert "国家和行业" in by_number[10]["tasks"][1] and "对照国家" in by_number[10]["tasks"][1]
    assert "X = w × τ" in by_number[10]["tasks"][1] and "关税暴露 X" in by_number[10]["tasks"][1]
    assert "排名" in by_number[10]["tasks"][2]
    assert "前向 GVC 段长度" in by_number[13]["goal"]
    assert "网络指标" in by_number[14]["goal"]
    for step in (13, 14):
        assert "Y₃" not in by_number[step]["goal"]
        assert "Y₄" not in by_number[step]["goal"]
        assert "固定模型" not in by_number[step]["goal"]
    # The cumulative reading starts in the second year of sustained exposure, not a one-year change.
    for step in (11, 12, 13, 14):
        shown = " ".join([by_number[step]["goal"], *by_number[step]["tasks"]])
        assert "X 持续高 1 个百分点" in by_number[step]["goal"]
        assert "从第二年起" in by_number[step]["goal"]
        assert "每增加" not in shown and "平均变化" not in shown and "X 增加" not in shown
