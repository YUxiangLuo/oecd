"""Independent statistical/IO oracles for the 2026-09-24 review (no database).

The regression oracle fits the full dummy-variable design, including its cluster
sandwich. The IO oracle sums production paths by their number of border crossings;
it does not reuse the application's inverse-matrix decomposition formulas.
"""

import numpy as np
import pandas as pd
import pytest
from scipy import stats

from conftest import FakeIOSystem
from gvcsim.indicators import length, production, tradeflow
from gvcsim.indicators.core import build_arrays
from gvcsim.regression.estimation import fixed_effect_structure, within_ols
from gvcsim.regression.model import PreparedModel


def _model(layout="balanced"):
    rng = np.random.default_rng(924)
    entity = np.repeat(np.arange(24), 6)
    year = np.tile(np.arange(6), 24)
    if layout == "unbalanced":
        keep = (entity + year) % 4 != 0
    elif layout == "disconnected":
        keep = (entity < 12) == (year < 3)
    else:
        keep = np.ones(len(entity), dtype=bool)
    entity, year = entity[keep], year[keep]
    country = entity // 2
    x = rng.uniform(0, 1, len(entity))
    y = 0.6 * x + rng.normal(size=24)[entity] + rng.normal(size=6)[year]
    y += rng.normal(size=(12, 6))[country, year] + rng.normal(size=len(entity))
    frame = pd.DataFrame({"entity": entity, "year": year, "country": country, "x": x, "y": y})
    return PreparedModel(frame, "y", ["x"], ["x"], "entity", "year", "country", [])


def _dummy_ols(model):
    d = model.data
    effects = np.column_stack([pd.get_dummies(d.entity, dtype=float), pd.get_dummies(d.year, dtype=float)])
    design = np.column_stack([d.x, effects])
    # A pseudoinverse permits redundant FE columns and disconnected panels.
    inverse = np.linalg.pinv(design)
    beta = inverse @ d.y
    residual = d.y.to_numpy() - design @ beta
    # Each row of the pseudoinverse maps the original observations to a slope.
    scores = np.array([(inverse[:, d.country == c] @ residual[d.country == c]) for c in d.country.unique()])
    n, g = len(d), d.country.nunique()
    rank = np.linalg.matrix_rank(design)
    covariance = g / (g - 1) * (n - 1) / (n - rank) * scores.T @ scores
    se = np.sqrt(covariance[0, 0])
    critical = stats.t.ppf(0.975, g - 1)
    return beta[0], se, 2 * stats.t.sf(abs(beta[0] / se), g - 1), beta[0] + np.array([-1, 1]) * critical * se


@pytest.mark.parametrize("layout", ["balanced", "unbalanced", "disconnected"])
def test_twfe_and_cr1_match_full_dummy_ols(layout):
    model = _model(layout)
    expected_beta, expected_se, expected_p, expected_ci = _dummy_ols(model)
    result = within_ols(model)
    coefficient = result.coefs[0]
    np.testing.assert_allclose(
        [coefficient.coef, coefficient.se, coefficient.p], [expected_beta, expected_se, expected_p], atol=2e-10
    )
    np.testing.assert_allclose([coefficient.ci_low, coefficient.ci_high], expected_ci, atol=2e-10)
    structure = fixed_effect_structure(model.data, "entity", "year")
    assert structure.components == (2 if layout == "disconnected" else 1)
    assert (coefficient.p < 0.05) == (coefficient.ci_low > 0 or coefficient.ci_high < 0)


@pytest.mark.parametrize(("x_scale", "y_scale"), [(100, 1), (1, 100), (0.01, 0.01), (-1, 1)])
def test_regression_is_invariant_to_units_fixed_effect_offsets_and_row_order(x_scale, y_scale):
    model = _model("unbalanced")
    original = within_ols(model)
    d = model.data.copy()
    d.x *= x_scale
    d.y = y_scale * (d.y + 4 * d.entity - 3 * d.year)
    model.data = d.sample(frac=1, random_state=24).reset_index(drop=True)
    actual = within_ols(model)
    before, after = original.coefs[0], actual.coefs[0]
    np.testing.assert_allclose(after.coef, before.coef * y_scale / x_scale, rtol=1e-8)
    np.testing.assert_allclose(after.se, before.se * abs(y_scale / x_scale), rtol=1e-8)
    np.testing.assert_allclose(after.p, before.p, atol=1e-9)
    np.testing.assert_allclose(actual.r2_within, original.r2_within, atol=1e-9)
    np.testing.assert_allclose(
        [after.ci_low, after.ci_high], np.sort(np.array([before.ci_low, before.ci_high]) * y_scale / x_scale), atol=1e-8
    )


def _random_io(seed, scale=1.0):
    rng = np.random.default_rng(seed)
    a = rng.uniform(0.01, 0.06, (6, 6))
    final = rng.uniform(1, 10, (6, 3)) * scale
    output = np.linalg.solve(np.eye(6) - a, final.sum(axis=1))
    return FakeIOSystem(a * output[None, :], final, regions=["A", "B", "C"], sectors=["s1", "s2"])


def _path_totals(io):
    """Accumulate 60 path lengths, recording 0, 1, or >=2 intermediate crossings.

    A path with no intermediate crossing is domestic or traditional trade.
    A path with exactly one intermediate crossing and domestic final absorption
    is simple GVC. All other intermediate-crossing paths are complex GVC.
    Each path's production length is its number of production nodes.
    """
    a = io.A.to_numpy()
    v = io.factor_inputs.F.loc["VA"].to_numpy() / io.x.indout.to_numpy()
    countries = np.repeat(np.arange(3), 2)
    final = io.Y.to_numpy()
    domestic = final[np.arange(6), countries]
    exported = final.sum(axis=1) - domestic
    paths = np.zeros((3, 6, 6))
    paths[0] = np.diag(v)
    amounts = np.zeros((4, 6, 6))
    lengths = np.zeros_like(amounts)
    for nodes in range(1, 61):
        ended = np.stack(
            [
                paths[0] * domestic,
                paths[0] * exported,
                paths[1] * domestic,
                paths[1] * exported + paths[2] * final.sum(axis=1),
            ]
        )
        amounts += ended
        lengths += nodes * ended
        extended = np.zeros_like(paths)
        for crossings in range(3):
            for current in range(6):
                for following in range(6):
                    target = min(2, crossings + int(countries[current] != countries[following]))
                    extended[target, :, following] += paths[crossings, :, current] * a[current, following]
        paths = extended
    # With max row sum below .36, the omitted geometric tail is negligible.
    assert np.abs(paths).sum() < 1e-28
    return amounts, lengths


@pytest.mark.parametrize("seed", [7, 19, 924, 2026])
def test_production_and_length_match_border_counted_paths(seed):
    io = _random_io(seed)
    arr = build_arrays(io)
    observed_production = production.sector_production(arr)
    observed_length = length.sector_length(arr)
    country_length = length.country_length(arr)
    amounts, lengths = _path_totals(io)
    for direction, axis, prefix in [("v", 2, "VA"), ("y", 1, "FGY")]:
        values, weighted_lengths = amounts.sum(axis=axis), lengths.sum(axis=axis)
        total_name = "SVA" if direction == "v" else "FGY"
        mapping = {
            total_name: values.sum(axis=0),
            f"1_{prefix}_D": values[0],
            f"2_{prefix}_RT": values[1],
            f"3_{prefix}_GVC": values[2:].sum(axis=0),
            f"3a_{prefix}_GVC_S": values[2],
            f"3b_{prefix}_GVC_C": values[3],
        }
        for name, expected in mapping.items():
            np.testing.assert_allclose(observed_production[name], expected, rtol=1e-12)
        for suffix, categories in [("", [0, 1, 2, 3]), ("_D", [0]), ("_RT", [1]), ("_GVC", [2, 3])]:
            denominator = values[categories].sum(axis=0)
            numerator = weighted_lengths[categories].sum(axis=0)
            column = f"PL{direction}{suffix}"
            np.testing.assert_allclose(observed_length[column], numerator / denominator, rtol=1e-12)
            expected_country = numerator.reshape(3, 2).sum(axis=1) / denominator.reshape(3, 2).sum(axis=1)
            np.testing.assert_allclose(country_length[column], expected_country, rtol=1e-12)
    np.testing.assert_allclose(observed_length.GVCPs, observed_length.PLv_GVC / observed_length.PLy_GVC)


@pytest.mark.parametrize("scale", [0.01, 100.0])
def test_currency_unit_scales_amounts_but_preserves_lengths_and_shares(scale):
    base, scaled = build_arrays(_random_io(924)), build_arrays(_random_io(924, scale))
    for compute in [tradeflow.sector_tradeflow, production.sector_production]:
        np.testing.assert_allclose(compute(scaled), compute(base) * scale, rtol=1e-12)
    np.testing.assert_allclose(length.sector_length(scaled), length.sector_length(base), rtol=1e-12)
    np.testing.assert_allclose(length.country_length(scaled), length.country_length(base), rtol=1e-12)
    t, ts = tradeflow.sector_tradeflow(base), tradeflow.sector_tradeflow(scaled)
    np.testing.assert_allclose(t.FVA / tradeflow.gross_exports(t), ts.FVA / tradeflow.gross_exports(ts), rtol=1e-12)


def _complex_chain_arrays():
    """Two-sector chain: A's primary good (VA 40) feeds B's processor (VA 60), which sells 100 to C."""
    regions = ["A", "B", "C"]
    index = pd.MultiIndex.from_product([regions, ["primary", "processing"]], names=["region", "sector"])
    n = len(index)
    z = np.zeros((n, n))
    y = np.zeros((n, len(regions)))
    origin = index.get_loc(("A", "primary"))
    processor = index.get_loc(("B", "processing"))
    z[origin, processor] = 40.0
    y[processor, regions.index("C")] = 100.0
    x = z.sum(axis=1) + y.sum(axis=1)
    va = x - z.sum(axis=0)
    a = np.divide(z, x, out=np.zeros_like(z), where=x > 0)

    class _IO:
        Z = pd.DataFrame(z, index=index, columns=index)
        Y = pd.DataFrame(y, index=index, columns=pd.MultiIndex.from_product([regions, ["final"]]))
        A = pd.DataFrame(a, index=index, columns=index)
        L = pd.DataFrame(np.linalg.inv(np.eye(n) - a), index=index, columns=index)

        class factor_inputs:
            F = pd.DataFrame([np.zeros(n), va], index=["TLS", "VA"], columns=index)

    _IO.x = pd.DataFrame({"indout": x}, index=index)
    return build_arrays(_IO()), origin, processor


def test_no_final_demand_has_no_observed_backward_length():
    # A creates 40 of intermediate value; B adds 60, then sells 100 to C.
    # No final product is completed in A, so its observed backward length is
    # undefined. The hypothetical unit-product ratio is a different quantity.
    arr, origin, processor = _complex_chain_arrays()
    lengths = length.sector_length(arr)
    assert arr.Yd[origin].sum() == 0
    assert lengths.iloc[origin]["PLv"] == pytest.approx(2)
    assert not np.isfinite(lengths.iloc[origin]["PLy"])
    assert lengths.iloc[processor]["PLy"] == pytest.approx((40 * 2 + 60) / 100)
