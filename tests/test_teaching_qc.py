"""Release QC of the teaching panel (teaching data v10): τ and the lags of X follow the published tariff schedule."""

import pandas as pd
import pytest

from gvcsim.data.output_quality import _teaching_panel_contract
from gvcsim.regression.teaching import (
    BASELINES,
    EXCHANGE_RATE_COLUMN,
    EXCHANGE_RATE_DEPRECIATION,
    SURPLUS_COLUMN,
    TARIFF_RATE,
    WAVE_COLUMN,
    X_LAG_COLUMNS,
    Y_COLUMNS,
    y_column,
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
                    SURPLUS_COLUMN: {1: 15000.0, 2: 1500.0, 0: -500.0}[wave],
                    EXCHANGE_RATE_COLUMN: 0.5 + (EXCHANGE_RATE_DEPRECIATION if wave == 1 and year >= 2018 else 0),
                    "teaching_log_gdp": 20 + wave + 0.02 * (year - 2016),
                    "teaching_population_growth": -0.2 + wave,
                    "teaching_trade_openness": 80 + 30 * wave,
                    "teaching_fdi_gdp": -1 + wave,
                    **{column: 0.3 for column in Y_COLUMNS.values()},
                    y_column("network", "weighted_indegree"): 0.1,
                    y_column("network", "weighted_outdegree"): 0.2,
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


@pytest.mark.parametrize(
    "outcome,item", [(outcome, item) for outcome, items in BASELINES.items() for item in items if item.combine]
)
def test_each_family_identity_is_checked_row_by_row(outcome, item):
    panel = _panel()
    constant, terms = item.combine
    expected = pd.Series(constant, index=panel.index, dtype=float)
    for key, coefficient in terms:
        part = y_column(outcome, key)
        if part not in panel:
            panel[part] = 0.1
        expected += coefficient * panel[part]
    target = y_column(outcome, item.key)
    panel[target] = expected
    assert _check(panel)["passed"]
    panel.loc[0, target] += 0.05
    assert not _check(panel)["passed"]


@pytest.mark.parametrize(
    "mutation",
    [
        "wave",
        "depreciation",
        "industry_exchange",
        "identity",
        "missing_part",
        "surplus",
        "industry_gdp",
        "missing_macro",
        "negative_openness",
    ],
)
def test_teaching_structure_mutations_fail(mutation):
    panel = _panel()
    if mutation == "wave":
        # Rewrite the entire schedule consistently; the surplus rule must still reject the new wave.
        mask = panel.country.eq("AAA")
        panel.loc[mask, WAVE_COLUMN] = 2
        for lag, column in X_LAG_COLUMNS.items():
            panel.loc[mask, column] = (
                0.2 * TARIFF_RATE * (panel.loc[mask, "industry"].eq("C29") & (panel.loc[mask, "year"] - lag).ge(2019))
            )
        panel.loc[mask, "teaching_tariff_rate_tau"] = (
            panel.loc[mask, X_LAG_COLUMNS[0]] / panel.loc[mask, "teaching_export_share_w"]
        )
        panel.loc[mask, "teaching_treated"] = panel.loc[mask, X_LAG_COLUMNS[0]].gt(0).astype(int)
    elif mutation == "depreciation":
        panel.loc[panel.country.eq("AAA") & panel.year.ge(2018), EXCHANGE_RATE_COLUMN] -= EXCHANGE_RATE_DEPRECIATION
    elif mutation == "industry_exchange":
        panel.loc[0, EXCHANGE_RATE_COLUMN] += 0.1
    elif mutation == "identity":
        panel.loc[0, Y_COLUMNS["network"]] += 0.05
    elif mutation == "missing_part":
        panel = panel.drop(columns=y_column("network", "weighted_indegree"))
    elif mutation == "industry_gdp":
        panel.loc[0, "teaching_log_gdp"] += 0.1
    elif mutation == "missing_macro":
        panel = panel.drop(columns="teaching_fdi_gdp")
    elif mutation == "negative_openness":
        panel["teaching_trade_openness"] = -1.0
    else:
        panel.loc[0, SURPLUS_COLUMN] += 1
    assert not _check(panel)["passed"]


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
