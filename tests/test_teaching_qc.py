"""Release QC of the teaching panel (teaching data v10): τ and the lags of X follow the published tariff schedule."""

import pandas as pd

from gvcsim.data.output_quality import _teaching_panel_contract
from gvcsim.regression.teaching import (
    EXCHANGE_RATE_COLUMN,
    TARIFF_RATE,
    WAVE_COLUMN,
    X_LAG_COLUMNS,
    Y_COLUMNS,
)


def _panel() -> pd.DataFrame:
    """Three countries (first wave, second wave, untaxed) × a goods and a services industry × 2016–2020."""
    rows = []
    for country, wave, start in (("AAA", 1, 2018), ("BBB", 2, 2019), ("CCC", 0, None)):
        for industry, w in (("C29", 0.2), ("K", 0.1)):
            for year in range(2016, 2021):
                row = {
                    "country": country,
                    "industry": industry,
                    "entity_id": f"{country}_{industry}",
                    "year": year,
                    "teaching_export_share_w": w,
                    WAVE_COLUMN: wave,
                    EXCHANGE_RATE_COLUMN: 0.5,
                    **{column: 0.3 for column in Y_COLUMNS.values()},
                }
                for lag, column in X_LAG_COLUMNS.items():
                    taxed = start is not None and industry == "C29" and year - lag >= start
                    row[column] = w * TARIFF_RATE if taxed else 0.0
                row["teaching_tariff_rate_tau"] = row[X_LAG_COLUMNS[0]] / w
                row["teaching_treated"] = int(row[X_LAG_COLUMNS[0]] > 0)
                rows.append(row)
    return pd.DataFrame(rows)


def _check(frame: pd.DataFrame) -> dict:
    return _teaching_panel_contract({"panel_teaching": frame}, 2020)


def test_a_panel_on_the_schedule_passes():
    assert _check(_panel())["passed"]


def test_a_unit_missing_a_year_keeps_its_scheduled_lags():
    panel = _panel()
    gap = panel.drop(panel.index[panel["entity_id"].eq("AAA_C29") & panel["year"].eq(2018)])
    assert _check(gap)["passed"]


def test_a_lag_off_the_schedule_fails():
    panel = _panel()
    panel.loc[panel["entity_id"].eq("AAA_C29") & panel["year"].eq(2020), X_LAG_COLUMNS[2]] = 0.0
    assert not _check(panel)["passed"]


def test_duplicate_keys_fail_the_check_instead_of_raising():
    panel = _panel()
    result = _check(pd.concat([panel, panel.iloc[:2]], ignore_index=True))
    assert not result["passed"] and "violations=" in result["detail"]


def test_the_weak_y_check_stops_a_release_whose_library_check_fails(monkeypatch):
    import pytest

    from gvcsim import pipeline
    from gvcsim.regression import panel as panel_module

    class Result:
        def to_dict(self):
            return {"status": "invalid_design", "coefs": [{"ci_low": None, "ci_high": None}], "cumulative": None}

    monkeypatch.setattr(
        panel_module, "run_design_with_benchmark", lambda *_args: (Result(), {"benchmark_passed": False})
    )
    with pytest.raises(ValueError, match="未通过标准库对照"):
        pipeline._check_weak_teaching_y(pd.DataFrame())
    # An estimable release whose check passed but whose design suppresses inference is left to the release QC.
    monkeypatch.setattr(
        panel_module, "run_design_with_benchmark", lambda *_args: (Result(), {"benchmark_passed": True})
    )
    pipeline._check_weak_teaching_y(pd.DataFrame())
