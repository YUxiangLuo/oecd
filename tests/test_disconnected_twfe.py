"""Disconnected TWFE: independent rank-revealing dummy OLS / CR1 references."""

from dataclasses import replace

import numpy as np
import pandas as pd
import pytest
from scipy import stats

from gvcsim.regression import panel
from gvcsim.regression.design import RegressionDesign


def _sample(blocks, *, per_block=6, shared_clusters=False):
    rng = np.random.default_rng(151)
    rows = []
    for component, years in enumerate(blocks):
        for entity in range(per_block):
            country = f"C{entity}" if shared_clusters else f"C{component}_{entity}"
            for offset, year in enumerate(years):
                shock = (0.04 + 0.03 * rng.random()) * (offset >= 1)
                outcome = 0.2 + 0.01 * entity + 0.004 * offset + 0.3 * shock + rng.normal(0, 0.005)
                rows.append(
                    dict(
                        country=country,
                        industry=f"S{component}",
                        entity_id=f"{country}_S{component}",
                        year=year,
                        tariff_shock=shock,
                        treated=int(shock > 0),
                        FVA_share=outcome,
                    )
                )
    return pd.DataFrame(rows)


def _dummy_reference(model):
    """No component counting, within demeaning, or PanelOLS in the reference."""
    frame = model.data
    effects = np.column_stack(
        [pd.get_dummies(frame[model.entity], dtype=float), pd.get_dummies(frame[model.time], dtype=float)]
    )
    x = np.column_stack([frame[model.xcols].to_numpy(dtype=float), effects])
    y = frame[model.depvar].to_numpy(dtype=float)
    beta, _, rank, _ = np.linalg.lstsq(x, y, rcond=None)
    residual = y - x @ beta
    clusters = frame[model.cluster].unique()
    scores = np.array([x[frame[model.cluster].eq(c)].T @ residual[frame[model.cluster].eq(c)] for c in clusters])
    # Moore-Penrose inverse permits all redundant dummies; rank is from SVD,
    # not the E+T-C formula used by the implementation under test.
    bread = np.linalg.pinv(x.T @ x)
    n, g = len(frame), len(clusters)
    covariance = g / (g - 1) * (n - 1) / (n - rank) * bread @ (scores.T @ scores) @ bread
    k = len(model.xcols)
    return beta[:k], covariance[:k, :k], int(np.linalg.matrix_rank(effects))


@pytest.mark.parametrize(
    ("blocks", "per_block", "shared_clusters", "extra_control"),
    [
        ([(2016, 2017, 2018, 2019, 2020)], 12, False, False),
        ([(2016, 2017, 2018), (2018, 2019, 2020)], 6, False, False),  # connected through 2018
        ([(2016, 2017), (2018, 2019, 2020)], 6, False, False),
        ([(2016, 2018), (2017, 2019, 2020)], 6, False, False),  # interleaved calendars
        ([(2014, 2015), (2016, 2017), (2018, 2019, 2020)], 6, False, True),
        ([(2016, 2017, 2018, 2019), (2020,)], 12, False, False),  # singleton component
        ([(2016, 2017), (2018, 2019, 2020)], 12, True, True),  # country clusters span components
    ],
)
def test_twfe_and_panelols_match_independent_dummy_cr1(blocks, per_block, shared_clusters, extra_control):
    frame = _sample(blocks, per_block=per_block, shared_clusters=shared_clusters)
    granularity = "country_industry" if shared_clusters else "country"
    design = RegressionDesign(outcome="trade", granularity=granularity, method="twfe_intensity")
    model = panel.prepare_design_model(frame, design)
    if extra_control:
        # Exercise collision-safe nuisance names without changing a user's column.
        control = "__gvcsim_time_effect_0"
        model = replace(
            model,
            data=model.data.assign(**{control: np.random.default_rng(31).normal(size=len(model.data))}),
            xcols=[*model.xcols, control],
            control_cols=[control],
        )
    beta, covariance, _ = _dummy_reference(model)

    own = panel._within_ols(model)
    reference = panel._panelols_estimate(model, model.xcols, [])
    assert panel._summarize_benchmark(model, own, reference)["benchmark_passed"] is True
    for result in (own, reference):
        assert [item.name for item in result.coefs] == model.xcols  # no nuisance year dummies leak out
        for i, coefficient in enumerate(result.coefs):
            expected_se = np.sqrt(covariance[i, i])
            critical = stats.t.ppf(0.975, result.n_clusters - 1)
            assert coefficient.coef == pytest.approx(beta[i], abs=1e-9)
            assert coefficient.se == pytest.approx(expected_se, rel=1e-6, abs=1e-10)
            assert coefficient.p == pytest.approx(2 * stats.t.sf(abs(beta[i] / expected_se), result.n_clusters - 1))
            assert coefficient.ci_low == pytest.approx(beta[i] - critical * expected_se, abs=1e-9)
            assert coefficient.ci_high == pytest.approx(beta[i] + critical * expected_se, abs=1e-9)
    # Keep PanelOLS's original entity-within R² definition: explicit nuisance
    # time dummies must not silently become part of the reported X-beta fit.
    entities = pd.get_dummies(model.data[model.entity], dtype=float).to_numpy()
    values = model.data[[model.depvar, *model.xcols]].to_numpy()
    within_entity = values - entities @ np.linalg.lstsq(entities, values, rcond=None)[0]
    residual = within_entity[:, 0] - within_entity[:, 1:] @ beta
    expected_r2 = 1 - residual @ residual / (within_entity[:, 0] @ within_entity[:, 0])
    assert reference.r2_within == pytest.approx(expected_r2, abs=1e-9)


def test_review_witness_is_correct_through_public_benchmark_entry():
    frame = _sample([(2016, 2017), (2018, 2019, 2020)])
    design = RegressionDesign(outcome="trade", granularity="country", method="twfe_intensity")
    result, benchmark = panel.run_design_with_benchmark(frame, design)

    assert result.status == "ok"
    assert result.coefs[0].coef == pytest.approx(0.493399676755, abs=1e-10)
    assert result.coefs[0].se == pytest.approx(0.196916031112, abs=1e-10)
    assert benchmark["benchmark_passed"] is True
    assert benchmark["policy_coefs"][0]["panelols_se"] == pytest.approx(0.196916031112, abs=1e-10)


def test_precheck_accepts_one_true_residual_degree_of_freedom():
    frame = _sample([(2016, 2017), (2018, 2019)], per_block=2)
    design = RegressionDesign(outcome="trade", granularity="country", method="twfe_intensity")
    model = panel.prepare_design_model(frame, design)
    beta, covariance, fe_rank = _dummy_reference(model)
    assert len(frame) - fe_rank - len(model.xcols) == 1

    result, benchmark = panel.run_design_with_benchmark(frame, design)

    assert result.coefs[0].coef == pytest.approx(beta[0], abs=1e-9)
    assert result.coefs[0].se == pytest.approx(np.sqrt(covariance[0, 0]), rel=1e-6)
    assert result.status == "insufficient"  # four clusters still do not clear the teaching gate
    assert result.coefs[0].p is None and result.coefs[0].ci_low is None
    assert benchmark["benchmark_passed"] is True
    # Genuine zero residual capacity must still fail.
    saturated = replace(model, xcols=[*model.xcols, "extra"], data=model.data.assign(extra=np.arange(len(frame))))
    with pytest.raises(ValueError, match="自由度"):
        panel._within_ols(saturated)


def test_rank_is_computed_after_complete_case_attrition_and_independent_of_row_order():
    frame = _sample([(2016, 2017), (2018, 2019, 2020)])
    bridge = frame.iloc[:2].assign(country="BRIDGE", year=[2017, 2018], FVA_share=np.nan)
    frame = pd.concat([frame, bridge], ignore_index=True).sample(frac=1, random_state=43)
    design = RegressionDesign(outcome="trade", granularity="country", method="twfe_intensity")
    model = panel.prepare_design_model(frame, design)
    assert len(model.data) == 30
    beta, covariance, _ = _dummy_reference(model)

    result, benchmark = panel.run_design_with_benchmark(frame, design)

    assert result.coefs[0].coef == pytest.approx(beta[0], abs=1e-9)
    assert result.coefs[0].se == pytest.approx(np.sqrt(covariance[0, 0]), rel=1e-6)
    assert benchmark["benchmark_passed"] is True


def test_effect_structure_does_not_require_a_dense_dummy_matrix(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("fixed-effect rank must not materialize/factor a dense dummy matrix")

    monkeypatch.setattr(pd, "get_dummies", forbidden)
    monkeypatch.setattr(np.linalg, "matrix_rank", forbidden)
    entity = np.arange(5000)
    frame = pd.DataFrame(
        {"entity": np.repeat(entity, 2), "time": np.column_stack([entity % 5, (entity + 1) % 5]).ravel()}
    )
    structure = panel._fixed_effect_structure(frame, "entity", "time")
    assert structure.rank == 5004
    assert structure.components == 1
