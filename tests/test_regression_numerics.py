"""当前回归数值实现的收敛与对照门禁，不依赖课堂数据库。"""

from dataclasses import replace

import numpy as np
import pandas as pd
import pytest

from gvcsim.regression import panel
from gvcsim.regression.design import RegressionDesign


@pytest.mark.parametrize("unbalanced", [False, True])
def test_twoway_demean_matches_independent_dummy_projection(unbalanced):
    rng = np.random.default_rng(20260907)
    entity = np.repeat(np.arange(12), 5)
    time = np.tile(np.arange(5), 12)
    values = rng.normal(size=(len(entity), 3))
    if unbalanced:
        keep = (entity + time) % 4 != 0
        entity, time, values = entity[keep], time[keep], values[keep]
    original = values.copy()
    # 显式虚拟变量最小二乘是独立参考，不复用交替去均值。
    effects = np.column_stack([pd.get_dummies(entity, dtype=float), pd.get_dummies(time, dtype=float)])
    expected = values - effects @ np.linalg.lstsq(effects, values, rcond=None)[0]

    actual = panel._twoway_demean(values, entity, time)

    np.testing.assert_allclose(actual, expected, atol=1e-9, rtol=0)
    np.testing.assert_array_equal(values, original)
    for groups in (entity, time):
        assert pd.DataFrame(actual).groupby(groups).mean().abs().to_numpy().max() < 1e-10


def test_twoway_demean_accepts_convergence_on_final_iteration():
    entity = np.repeat(np.arange(4), 3)
    time = np.tile(np.arange(3), 4)
    values = np.random.default_rng(1).normal(size=(12, 2))

    actual = panel._twoway_demean(values, entity, time, max_iter=1)

    for groups in (entity, time):
        assert pd.DataFrame(actual).groupby(groups).mean().abs().to_numpy().max() < 1e-10


def test_twoway_demean_rejects_unconverged_sparse_panel():
    entity = np.repeat(np.arange(100), 2)
    time = np.column_stack([np.arange(100), (np.arange(100) + 1) % 100]).ravel()
    values = np.random.default_rng(1).normal(size=(200, 2))

    with pytest.raises(ValueError, match="去均值.*200.*未收敛"):
        panel._twoway_demean(values, entity, time)


@pytest.mark.parametrize("value", [np.nan, np.inf, -np.inf])
def test_twoway_demean_rejects_nonfinite_values(value):
    values = np.array([[value], [1.0], [2.0], [3.0]])
    with pytest.raises(ValueError, match="非有限"):
        panel._twoway_demean(values, np.array([0, 0, 1, 1]), np.array([0, 1, 0, 1]))


@pytest.mark.parametrize("kwargs", [{"max_iter": 0}, {"tol": 0}, {"tol": np.nan}, {"tol": np.inf}])
def test_twoway_demean_rejects_invalid_iteration_settings(kwargs):
    with pytest.raises(ValueError, match="容差|迭代次数"):
        panel._twoway_demean(np.ones((4, 1)), np.array([0, 0, 1, 1]), np.array([0, 1, 0, 1]), **kwargs)


def _benchmark_inputs():
    rng = np.random.default_rng(17)
    frame = pd.DataFrame(
        {
            "country": np.repeat([f"C{i:02d}" for i in range(16)], 5),
            "year": np.tile(np.arange(2016, 2021), 16),
            "FVA_share": rng.normal(size=80),
            "tariff_shock": rng.normal(size=80),
        }
    )
    model = panel.prepare_design_model(
        frame, RegressionDesign(outcome="trade", granularity="country", method="twfe_intensity")
    )
    own = panel._within_ols(model)
    first = replace(own.coefs[0], name="tariff_shock", se=100.0)
    second = replace(own.coefs[0], name="tariff_shock×base_gvc", se=0.01)
    model = replace(model, policy_xcols=[first.name, second.name])
    own = replace(own, coefs=[first, second])
    return model, own


def _industry_model_input():
    return pd.DataFrame(
        {
            "country": ["A", "A", "B", "B"],
            "entity_id": ["A_S1", "A_S1", "B_S1", "B_S1"],
            "year": [2019, 2020, 2019, 2020],
            "FVA_share": [0.1, 0.2, 0.3, 0.5],
            "tariff_shock": [0.0, 0.1, 0.0, 0.2],
        }
    )


def test_prepare_design_rejects_missing_year_instead_of_silently_dropping_it():
    frame = _industry_model_input()
    frame.loc[0, "year"] = np.nan

    with pytest.raises(ValueError, match="year.*不得缺失"):
        panel.prepare_design_model(frame, RegressionDesign(outcome="trade"))


def test_prepare_design_rejects_entity_that_moves_between_clusters():
    frame = _industry_model_input()
    frame.loc[1, "country"] = "B"

    with pytest.raises(ValueError, match="一个实体只能映射到一个聚类"):
        panel.prepare_design_model(frame, RegressionDesign(outcome="trade"))


def test_within_estimator_rejects_zero_cluster_robust_standard_error():
    model, _ = _benchmark_inputs()
    x = np.arange(1, len(model.data) + 1, dtype=float).reshape(-1, 1)

    with pytest.raises(ValueError, match="标准误必须为正"):
        panel._within_ols(model, (np.zeros(len(model.data)), x, [model.xcols[0]], []))


@pytest.mark.parametrize(("small_se", "passed"), [(0.010000001, True), (0.0101, False), (0.02, False)])
def test_panelols_standard_error_gate_checks_each_policy_term(small_se, passed):
    model, own = _benchmark_inputs()
    reference = replace(own, coefs=[own.coefs[0], replace(own.coefs[1], se=small_se)])

    benchmark = panel._summarize_benchmark(model, own, reference)

    assert benchmark["coef_check_passed"] is True
    assert benchmark["se_check_passed"] is passed
    assert benchmark["benchmark_passed"] is passed


@pytest.mark.parametrize("missing_from", ["own", "reference"])
def test_panelols_gate_requires_every_policy_term(missing_from):
    model, own = _benchmark_inputs()
    reference = replace(own)
    if missing_from == "own":
        own = replace(own, coefs=own.coefs[:1])
    else:
        reference = replace(reference, coefs=reference.coefs[:1])

    with pytest.raises(ValueError, match="缺少政策系数"):
        panel._summarize_benchmark(model, own, reference)


@pytest.mark.parametrize(("field", "value"), [("coef", np.nan), ("se", np.inf)])
def test_panelols_gate_rejects_nonfinite_comparison_values(field, value):
    model, own = _benchmark_inputs()
    reference = replace(own, coefs=[replace(coef) for coef in own.coefs])
    reference.coefs[0] = replace(reference.coefs[0], **{field: value})

    with pytest.raises(ValueError, match="非有限"):
        panel._summarize_benchmark(model, own, reference)
