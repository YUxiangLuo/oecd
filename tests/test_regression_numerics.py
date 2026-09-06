"""当前回归数值实现的收敛与对照门禁，不依赖课堂数据库。"""

from dataclasses import replace
from statistics import mean, variance

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


@pytest.mark.parametrize(("small_se", "passed"), [(0.0101, True), (0.02, False)])
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


@pytest.mark.parametrize("method", ["did", "event_study"])
def test_public_cohort_att_matches_raw_pair_reference(method):
    """从原始观察对独立复算当前 ATT 和删国家标准误，不复用引擎单元或样本。"""
    years = range(2016, 2021)
    countries = [f"C{i:02d}" for i in range(30)]
    first = {country: 2018 if i < 12 else 2019 if i < 24 else None for i, country in enumerate(countries)}
    observations = {}
    rows = []
    for i, country in enumerate(countries):
        cohort = first[country]
        for year in years:
            post = cohort is not None and year >= cohort
            value = (
                i * 0.1
                + (year - 2016) * (0.01 * i + 0.2)
                + ((i * 7 + year * 3) % 11) * 0.003
                + ((1 + i * 0.02) * (year - cohort + 1) if post else 0)
            )
            # 缺基期、缺某一 post、缺对照观察：参考必须按每个单元的成对观察计权。
            missing = (country, year) in {("C00", 2017), ("C01", 2019), ("C24", 2017)}
            if not missing:
                observations[country, year] = value
            rows.append(
                {
                    "country": country,
                    "year": year,
                    "FVA_share": np.nan if missing else value,
                    "treated": int(post),
                    "tariff_shock": 0.02 if post else 0.0,
                }
            )

    def reference(omitted_country=None):
        terms = {}
        for cohort in (2018, 2019):
            for year in years:
                k = year - cohort
                if k == -1 or (method == "did" and k < 0):
                    continue
                treated, controls = [], []
                for country in countries:
                    if country == omitted_country:
                        continue
                    if (country, year) not in observations or (country, cohort - 1) not in observations:
                        continue
                    delta = observations[country, year] - observations[country, cohort - 1]
                    if first[country] == cohort:
                        treated.append(delta)
                    elif first[country] is None or first[country] > max(cohort, year):
                        controls.append(delta)
                if treated and controls:
                    term = "treated×post" if method == "did" else f"k={k:+d}" if k else "k=0"
                    terms.setdefault(term, []).extend([mean(treated) - mean(controls)] * len(treated))
        return {term: mean(values) for term, values in terms.items()}

    expected = reference()
    leave_one = [reference(country) for country in countries]
    result, benchmark = panel.run_design_with_benchmark(
        pd.DataFrame(rows), RegressionDesign(outcome="trade", granularity="country", method=method)
    )

    assert {coefficient.name for coefficient in result.coefs} == set(expected)
    assert benchmark["benchmark_passed"] is True
    assert result.n_clusters == len(countries)
    for coefficient in result.coefs:
        assert coefficient.coef == pytest.approx(expected[coefficient.name], abs=1e-12)
        deletes = [values[coefficient.name] for values in leave_one]
        # statistics.variance 与生产代码的矩阵协方差/伪值实现独立。
        expected_se = np.sqrt(variance(deletes) * (len(countries) - 1) ** 2 / len(countries))
        assert coefficient.se == pytest.approx(expected_se, abs=1e-12)
