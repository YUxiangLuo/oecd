"""Frozen outro evidence must retain the report's units, model span and inference limits."""

import copy

import pytest

from gvcsim.regression.spec import DEFAULT_SPEC, ModelSpec, X_LAG_COLUMNS
from gvcsim.report_review import build_review, review_estimate


def run(kind="share", coefficient=-0.55, low=-0.7, high=-0.4):
    return {
        "design": {"depvar_kind": kind, "baseline_label": "测试 Y"},
        "result": {
            "status": "ok",
            "n_obs": 100,
            "sample_flow": {"years": [2017, 2020]},
            "cumulative": {"coef": coefficient, "ci_low": low, "ci_high": high},
        },
    }


@pytest.mark.parametrize(
    "kind,unit,scale",
    [
        ("share", "百分点", 1),
        ("length", "长度单位", 0.01),
        ("position", "比值，无单位", 0.01),
        ("network", "模拟分数单位", 0.01),
    ],
)
def test_each_y_keeps_its_own_unit_per_one_point_of_x(kind, unit, scale):
    result = review_estimate(11, "trade", run(kind), DEFAULT_SPEC)
    assert result["value"] == pytest.approx(-0.55 * scale)
    assert result["interval"] == pytest.approx((-0.7 * scale, -0.4 * scale))
    assert result["unit"] == unit
    assert result["inference"] == "negative"
    assert result["years"] == [2017, 2020]
    assert result["n_obs"] == 100


@pytest.mark.parametrize(
    "coefficient,low,high,inference",
    [
        (0, -0.1, 0.1, "uncertain"),
        (0.02, 0, 0.05, "uncertain"),
        (0.02, 0.01, 0.05, "positive"),
        (0.0000001, -0.0000003, 0.0000004, "uncertain"),
    ],
)
def test_interval_drives_reading_even_for_zero_and_tiny_estimates(coefficient, low, high, inference):
    result = review_estimate(11, "trade", run(coefficient=coefficient, low=low, high=high), DEFAULT_SPEC)
    assert result["inference"] == inference
    assert result["value"] == coefficient
    assert result["value_text"] != "—"
    if coefficient != 0:
        assert float(result["value_text"]) != 0


@pytest.mark.parametrize(
    "status,support",
    [
        ("insufficient", {}),
        ("ok", {"suppress_inference": True}),
        ("ok", {"status": "insufficient"}),
    ],
)
def test_suppressed_inference_never_shows_a_confidence_interval(status, support):
    response = run()
    response["result"].update(status=status, support=support)
    result = review_estimate(11, "trade", response, DEFAULT_SPEC)
    assert result["value"] == -0.55
    assert result["interval"] is None
    assert result["interval_text"] == "无法推断"
    assert result["inference"] == "unavailable"


def test_missing_sum_is_not_replaced_by_a_single_surviving_coefficient():
    response = run()
    response["result"]["coefs"] = [{"name": X_LAG_COLUMNS[0], "coef": -0.3}]
    response["result"].pop("cumulative")
    result = review_estimate(11, "trade", response, DEFAULT_SPEC)
    assert result["value"] is None
    assert result["value_text"] == "—"
    assert result["inference"] == "unavailable"


def test_single_lag_model_uses_its_coefficient_and_never_calls_it_a_cumulative_effect():
    response = run()
    response["result"]["coefs"] = [{"name": X_LAG_COLUMNS[1], "coef": 0.23, "ci_low": -0.1, "ci_high": 0.4}]
    result = review_estimate(11, "trade", response, ModelSpec((1,), (), ()))
    assert result["value"] == 0.23
    assert result["x_span"] == "仅 L1.X"
    assert result["inference"] == "uncertain"


def test_failed_optional_model_keeps_its_selected_y_and_unit():
    result = review_estimate(13, "length", "not estimable", DEFAULT_SPEC, baseline_key="GVCPs")
    assert "位置" in result["y_label"]
    assert result["unit"] == "比值，无单位"
    assert result["value"] is None
    assert result["n_obs"] is None


def test_review_does_not_follow_later_workspace_edits_or_conflate_material_scopes():
    session = {"steps": {"15": {"data": {"research_question": "比较两个经济体", "limitations": "模拟情景的局限"}}}}
    materials = [
        {
            "step": 6,
            "charts": [{"title": "2020 出口构成"}],
            "observations": [{"country": "CHN", "year": 2020}, {"country": "USA", "year": 2020}],
        },
        {
            "step": 9,
            "charts": [{"title": "行业网络趋势"}],
            "observations": [
                {"country": "CAN", "industry": "C26", "year": 2016},
                {"country": "CAN", "industry": "C26", "year": 2020},
            ],
        },
    ]
    runs = [{"step": 11, "outcome": "trade", **run()}]
    spec = ModelSpec((1,), (), ())
    alternate = run()
    alternate["result"]["coefs"] = [{"name": X_LAG_COLUMNS[1], "coef": 0.2, "ci_low": -0.1, "ci_high": 0.5}]
    tables = [
        {
            "step": 11,
            "outcome": "trade",
            "baseline": "FVA_share",
            "columns": [
                {"name": "默认模型", "spec": DEFAULT_SPEC, "run": run()},
                {"name": "仅滞后一期", "spec": spec, "run": alternate},
            ],
        }
    ]
    review = build_review(session, runs, materials, tables)
    frozen = copy.deepcopy(review)
    session["steps"]["15"]["data"]["research_question"] = "后来修改"
    runs[0]["result"]["cumulative"]["coef"] = 999
    materials[0]["observations"][0]["year"] = 2030
    assert review == frozen
    assert review["evidence"][0]["industry_scope"] == "国家整体"
    assert review["evidence"][0]["years"] == [2020]
    assert review["evidence"][1]["countries"] == ["CAN 加拿大"]
    assert review["evidence"][1]["industry_scope"] == "C26 计算机电子光学"
    assert review["evidence"][1]["years"] == [2016, 2020]
    assert review["custom_models"][0]["result"]["x_span"] == "仅 L1.X"
    assert review["custom_models"][0]["reference"]["x_span"] == "当期＋滞后合计"
