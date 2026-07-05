"""ICIO-derived export exposure tests."""

import numpy as np
import pytest

from gvcsim.data import exposure
from gvcsim.indicators.core import build_arrays


def test_export_exposure_matches_bilateral_exports(fake_io):
    arr = build_arrays(fake_io)
    df = exposure.build_export_exposure(arr, 2020).set_index(["country", "imposer"])

    assert df.loc[("AAA", "AAA"), "export_exposure"] == 0.0
    assert df.loc[("BBB", "BBB"), "export_exposure"] == 0.0
    assert df.loc[("AAA", "BBB"), "bilateral_exports"] == pytest.approx(24.0)
    assert df.loc[("AAA", "BBB"), "total_exports"] == pytest.approx(arr.E[arr.pos["AAA"]].sum())
    assert df.loc[("AAA", "BBB"), "export_exposure"] == pytest.approx(1.0)
    assert df.loc[("BBB", "AAA"), "export_exposure"] == pytest.approx(1.0)
    assert np.isfinite(df["export_exposure"]).all()
    assert df["export_exposure"].between(0, 1).all()


def test_eu_aggregate_is_available(fake_io):
    arr = build_arrays(fake_io)
    df = exposure.build_export_exposure(arr, 2020)
    eu = df[df["imposer"] == "EU"]
    assert set(eu["country"]) == set(arr.regions)
    assert np.allclose(eu["export_exposure"], 0.0)
