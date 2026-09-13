"""Structural export support must not depend on floating-point cancellation."""

import numpy as np
import pandas as pd
import pytest

from conftest import FakeIOSystem
from gvcsim.data_routes import _clean, _with_derived
from gvcsim.indicators import production, tradeflow
from gvcsim.indicators.core import build_arrays


def _domestic_io(order="C"):
    # Unlike integer-only autarky fixtures, decimal domestic blocks expose the
    # different reduction orders of a whole row and its domestic submatrix.
    regions = ["AAA", "BBB", "CCC"]
    sectors = [f"s{i}" for i in range(45)]
    rng = np.random.default_rng(20260910)
    z = np.zeros((135, 135), order=order)
    y = np.zeros((135, 3), order=order)
    for country in range(3):
        p = slice(country * 45, (country + 1) * 45)
        z[p, p] = rng.uniform(0, 10, (45, 45))
        y[p, country] = 1000
    io = FakeIOSystem(z, y, regions=regions, sectors=sectors)
    # Nonzero TLS propagates a spurious export into a spurious positive gross
    # denominator (and thus false nonnull shares) on the pre-fix implementation.
    factors = io.factor_inputs.F
    factors.loc["TLS"] = factors.loc["VA"] * 0.2
    factors.loc["VA"] *= 0.8
    return io


def _domestic_io_with_usa(order="C"):
    io = _domestic_io(order)
    io._regions = ["USA", "BBB", "CCC"]
    labels = io.Z.index
    renamed = [("USA" if country == "AAA" else country, sector) for country, sector in labels]
    for frame_name in ("Z", "A", "L"):
        frame = getattr(io, frame_name)
        frame.index = pd.MultiIndex.from_tuples(renamed, names=frame.index.names)
        frame.columns = pd.MultiIndex.from_tuples(renamed, names=frame.columns.names)
    io.Y.index = pd.MultiIndex.from_tuples(renamed, names=io.Y.index.names)
    io.Y.columns = pd.MultiIndex.from_tuples(
        [("USA" if country == "AAA" else country, category) for country, category in io.Y.columns],
        names=io.Y.columns.names,
    )
    io.x.index = pd.MultiIndex.from_tuples(renamed, names=io.x.index.names)
    io.factor_inputs.F.columns = pd.MultiIndex.from_tuples(renamed, names=io.factor_inputs.F.columns.names)
    return io


@pytest.mark.parametrize("order", ["C", "F"])
def test_decimal_autarky_has_exact_zero_exports_and_null_api_shares(order):
    arr = build_arrays(_domestic_io(order))
    np.testing.assert_array_equal(arr.E, np.zeros(135))
    np.testing.assert_array_equal(arr.y_export(), np.zeros(135))
    trade = tradeflow.sector_tradeflow(arr)
    # Exact zeros, not allclose: an arbitrarily small positive gross would turn
    # an undefined ratio into a valid zero in the API and regression baseline.
    assert (trade == 0).all().all()
    gross = tradeflow.gross_exports(trade)
    assert (gross == 0).all()
    assert (trade["FVA"] / gross).where(gross > 0).isna().all()
    rows = _clean(_with_derived(trade.join(production.sector_production(arr))).to_dict("records"))
    assert all(r["gross_exports"] == 0 and r["FVA_share"] is None and r["DVAex_share"] is None for r in rows)


@pytest.mark.parametrize("kind", ["intermediate", "final"])
@pytest.mark.parametrize("amount", [1e-20, 1e-4])
def test_real_small_foreign_trade_is_not_lost_or_thresholded(kind, amount):
    io = _domestic_io()
    if kind == "intermediate":
        io.Z.iloc[0, 45] = amount
    else:
        # A large domestic final demand must never swallow a genuine foreign
        # flow through (total - domestic), even far below a proposed epsilon.
        io.Y.iloc[0, 0] = 1e16
        io.Y.iloc[0, 1] = amount
    # build_arrays consumes precomputed A/L; this test isolates flow extraction,
    # not decomposition of the deliberately modified IOSystem.
    arr = build_arrays(io)
    assert arr.E[0] == amount
    assert arr.y_export()[0] == (amount if kind == "final" else 0)


@pytest.mark.parametrize("amount", [-1e-20, -1e-4])
def test_signed_foreign_final_demand_is_not_clipped(amount):
    io = _domestic_io()
    io.Y.iloc[0, 0] = 1e16
    io.Y.iloc[0, 2] = amount
    arr = build_arrays(io)
    before = arr.Yd.copy()
    assert arr.E[0] == amount
    assert arr.y_export()[0] == amount
    np.testing.assert_array_equal(arr.Yd, before)


def test_export_selection_uses_country_labels_not_contiguous_blocks():
    io = _domestic_io()
    io.Z.iloc[0, 45] = 0.25
    io.Y.iloc[0, 2] = -0.125
    # Interleave the three countries and change their first-appearance order.
    permutation = np.arange(135).reshape(3, 45)[[2, 0, 1]].T.ravel()
    for key in ("Z", "A", "L"):
        setattr(io, key, getattr(io, key).iloc[permutation, permutation])
    io.Y = io.Y.iloc[permutation]
    io.x = io.x.iloc[permutation]
    arr = build_arrays(io)
    i = arr.index.get_loc(("AAA", "s0"))
    assert arr.E[i] == 0.125
    assert arr.y_export()[i] == -0.125


def test_pipeline_persists_structural_zero_export_shares_as_missing(tmp_path, monkeypatch):
    from gvcsim import config, pipeline, shocks
    from gvcsim.data import controls, quality

    processed = tmp_path / "processed"
    for module in (config, pipeline, controls, shocks):
        monkeypatch.setattr(module, "PROCESSED_DIR", processed)
    base = _domestic_io_with_usa("F")
    z = base.Z.to_numpy(copy=True)
    # Keep national exports positive (required for the controls growth domain),
    # while all 44 other industries per country have structurally zero exports.
    for country in range(3):
        z[country * 45, ((country + 1) % 3) * 45] = 0.25
    io = FakeIOSystem(z, base.Y.to_numpy(), regions=base.get_regions(), sectors=base.get_sectors())
    factors = io.factor_inputs.F
    factors.loc["TLS"] = factors.loc["VA"] * 0.2
    factors.loc["VA"] *= 0.8
    monkeypatch.setattr(pipeline.loader, "load", lambda _year: io)
    monkeypatch.setattr(quality, "KEY_REGIONS", ["USA", "BBB", "CCC"])

    def write_exposure(arr, year):
        # Synthetic country/sector codes, but the genuine flow calculation and
        # complete exposure schema; no fabricated regression observations.
        frame = shocks.build_export_exposure(arr, year)
        frame.to_csv(processed / f"export_exposure_{year}.csv", index=False)
        return frame

    monkeypatch.setattr(shocks, "write_export_exposure", write_exposure)
    for year in range(2018, 2023):
        pipeline.compute_year(year, verbose=False)
    pipeline.build_panel()
    persisted = pd.read_csv(processed / "panel_industry.csv")
    assert len(persisted) == 675
    no_exports = persisted[persisted["industry"] != "s0"]
    assert len(no_exports) == 660
    assert (no_exports["gross_exports"] == 0).all()
    assert no_exports["FVA_share"].isna().all()
    assert (persisted.loc[persisted["industry"] == "s0", "gross_exports"] > 0).all()


def test_one_country_has_no_foreign_columns():
    io = FakeIOSystem(np.array([[0.1]]), np.array([[1.0]]), regions=["AAA"], sectors=["s0"])
    arr = build_arrays(io)
    assert arr.E[0] == arr.y_export()[0] == 0
