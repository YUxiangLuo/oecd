"""当前回归数值实现的收敛与对照门禁，不依赖课堂数据库。"""

from dataclasses import replace

import numpy as np
import pandas as pd
import pytest

from gvcsim import concurrency
from gvcsim.regression import panel
from gvcsim.regression.design import RegressionDesign


def test_no_effect_library_benchmark_preserves_level_coefficients_and_clustered_se():
    from gvcsim.regression.benchmark import absorbing_estimate, summarize_benchmark
    from gvcsim.regression.estimation import CONSTANT, within_ols
    from gvcsim.regression.model import PreparedModel

    rng = np.random.default_rng(41)
    n = 600
    x = rng.normal(size=n)
    frame = pd.DataFrame(
        {
            "country": np.repeat(np.arange(30), 20),
            "year": np.tile(np.arange(20), 30),
            "x": x,
            "control": 20 + 0.01 * x + 0.001 * rng.normal(size=n),
            "small": 1e-6 * rng.normal(size=n),
        }
    )
    frame["y"] = 4000 + 200 * x - 150 * frame.control + 3e6 * frame.small + rng.normal(size=n)
    model = PreparedModel(frame, "y", ["x", "control", "small"], ["x"], "country", "year", "country", [], fe_columns=())
    own = within_ols(model)
    reference = absorbing_estimate(model, ["x", "control", "small", CONSTANT], [])
    benchmark = summarize_benchmark(model, own, reference)
    assert benchmark["backend"] == "linearmodels.IV2SLS"
    assert benchmark["benchmark_passed"]
    assert len(benchmark["policy_coefs"]) == 4
    # In particular the level intercept SE needs slope/intercept cross-covariances.
    intercept = next(c for c in reference.coefs if c.name == CONSTANT)
    np.testing.assert_allclose([intercept.coef, intercept.se], [own.constant.coef, own.constant.se], rtol=1e-6)
    assert reference.r2 == pytest.approx(own.r2, abs=1e-12)


@pytest.mark.parametrize("effects", [(), ("country",), ("country", "year"), ("country", "industry", "year")])
@pytest.mark.parametrize("scale", [1e-12, 1e-6, 1e8, 1e12])
def test_estimates_and_omissions_are_independent_of_column_units(effects, scale):
    from gvcsim.regression.estimation import within_ols
    from gvcsim.regression.model import PreparedModel

    rng = np.random.default_rng(12)
    frame = pd.DataFrame(
        {
            "country": np.repeat(np.arange(16), 15),
            "year": np.tile(np.arange(5), 48),
            "industry": np.tile(np.repeat(np.arange(3), 5), 16),
        }
    )
    frame = frame.loc[(frame.country + frame.year + frame.industry) % 4 != 0].copy()
    frame["x"] = rng.normal(size=len(frame))
    frame["control"] = rng.normal(size=len(frame))
    frame["constant_control"] = 2.0
    frame["duplicate"] = 3 * frame.x
    frame["y"] = 2 * frame.x - frame.control + rng.normal(size=len(frame))

    def fit(data):
        return within_ols(
            PreparedModel(
                data,
                "y",
                ["x", "control", "constant_control", "duplicate"],
                ["x"],
                "country",
                "year",
                "country",
                [],
                fe_columns=effects,
            )
        )

    expected = fit(frame.copy())
    scaled = frame.copy()
    scaled["y"] *= scale
    scaled["x"] *= 1 / scale
    scaled["control"] *= scale
    scaled["constant_control"] *= 1 / scale
    scaled["duplicate"] *= scale
    actual = fit(scaled)
    assert actual.omitted == expected.omitted
    for index, factor in enumerate((scale**2, 1.0)):
        np.testing.assert_allclose(
            [actual.coefs[index].coef / factor, actual.coefs[index].se / factor],
            [expected.coefs[index].coef, expected.coefs[index].se],
            rtol=1e-8,
            atol=1e-10,
        )


def test_nearly_absorbed_non_nested_effects_retain_within_accuracy():
    from gvcsim.regression.estimation import multiway_demean, within_ols
    from gvcsim.regression.model import PreparedModel

    rng = np.random.default_rng(21)
    country = np.repeat(np.arange(20), 5)
    year = np.tile(np.arange(5), 20)
    keep = (country + year) % 4 != 0
    country, year = country[keep], year[keep]
    base = country / 16 + year / 4
    values = base + 1e-7 * rng.normal(size=len(base))
    # Remove the exactly represented, known absorbed component before the independent dummy projection, so
    # the oracle does not itself lose the small residual by subtracting two fitted large values.
    delta = values - base
    dummies = np.column_stack([pd.get_dummies(country, dtype=float), pd.get_dummies(year, dtype=float)])
    expected = delta - dummies @ np.linalg.lstsq(dummies, delta, rcond=None)[0]
    actual = multiway_demean(values[:, None], [country, year])[:, 0]
    assert np.linalg.norm(actual - expected) / np.linalg.norm(expected) < 1e-8
    frame = pd.DataFrame(
        {
            "country": country,
            "year": year,
            "control": values,
            "x": rng.normal(size=len(values)),
            "y": rng.normal(size=len(values)),
        }
    )
    model = PreparedModel(
        frame, "y", ["x", "control"], ["x"], "country", "year", "country", [], fe_columns=("country", "year")
    )
    raw = frame[["y", "x"]].to_numpy()
    projected = raw - dummies @ np.linalg.lstsq(dummies, raw, rcond=None)[0]
    reference = within_ols(model, (projected[:, 0], np.column_stack([projected[:, 1], expected]), ["x", "control"], []))
    result = within_ols(model)
    assert not result.omitted
    np.testing.assert_allclose([c.coef for c in result.coefs], [c.coef for c in reference.coefs], rtol=1e-8)
    np.testing.assert_allclose([c.se for c in result.coefs], [c.se for c in reference.coefs], rtol=1e-8)


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


@pytest.mark.parametrize("expired", [False, True], ids=["last-waiter-cancelled", "deadline-expired"])
def test_regression_stops_before_benchmark_when_work_ends_after_demeaning(monkeypatch, expired):
    model, _ = _benchmark_inputs()
    original = panel._demean_and_prune
    work = concurrency._Work()
    benchmark_called = False

    def finish_waiting(prepared_model):
        prepared = original(prepared_model)
        if expired:
            work.deadline = 0
        else:
            work.cancelled.set()
        return prepared

    def benchmark(*args):
        nonlocal benchmark_called
        benchmark_called = True
        return original_benchmark(*args)

    original_benchmark = panel._panelols_estimate
    monkeypatch.setattr(panel, "_demean_and_prune", finish_waiting)
    monkeypatch.setattr(panel, "_panelols_estimate", benchmark)
    token = concurrency._CURRENT_WORK.set(work)
    try:
        with pytest.raises(concurrency.WorkUnavailable) as error:
            panel.run_design_with_benchmark(model.data, RegressionDesign("trade", granularity="country"))
        assert error.value.code == "work_cancelled_or_expired"
        assert not benchmark_called
    finally:
        concurrency._CURRENT_WORK.reset(token)


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


def test_panelols_gate_requires_every_policy_term():
    model, own = _benchmark_inputs()
    with pytest.raises(ValueError, match="缺少政策系数"):
        panel._summarize_benchmark(model, replace(own, coefs=own.coefs[:1]), own)
    # A term the library dropped is not compared, so the gate fails (the run's inference is then suppressed).
    benchmark = panel._summarize_benchmark(model, own, replace(own, coefs=own.coefs[:1]))
    assert benchmark["missing_in_reference"] == [own.coefs[1].name]
    assert benchmark["coef_check_passed"] is False and benchmark["benchmark_passed"] is False


@pytest.mark.parametrize(("field", "value"), [("coef", np.nan), ("se", np.inf)])
def test_panelols_gate_rejects_nonfinite_comparison_values(field, value):
    model, own = _benchmark_inputs()
    reference = replace(own, coefs=[replace(coef) for coef in own.coefs])
    reference.coefs[0] = replace(reference.coefs[0], **{field: value})

    with pytest.raises(ValueError, match="非有限"):
        panel._summarize_benchmark(model, own, reference)
