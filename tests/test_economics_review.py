"""Professional-review regressions: real pairing, treatment meaning and reportable diagnoses."""

import numpy as np
import pandas as pd
import pytest

from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.panel import run_design_with_benchmark
from gvcsim.shock_catalog import EVENTS, ENTITY_LIST_EVENTS, TREATED_THRESHOLD, composite_imposer_members
from gvcsim.teaching_report import _result_is_reportable, _valid_event_support


def paired_panel(method: str, seed: int, controls: int = 20) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    count = 20 if method == "did" else 30
    rows = []
    for index in range(count + controls):
        for year in range(2016, 2021):
            post = index < count and year >= 2018
            value = 0.3 + 0.003 * index + 0.001 * (year - 2016) + rng.normal(0, 0.002) + (0.06 if post else 0)
            if method == "did":
                missing = 2 <= index < count and year == 2017
            else:
                missing = index < count and ((index >= 16 and year == 2017) or (2 <= index < 16 and year >= 2018))
            rows.append(
                {
                    "country": f"C{index:02}",
                    "year": year,
                    "FVA_share": np.nan if missing else value,
                    "treated": int(post),
                    "tariff_shock": 0.05 if post else 0.0,
                }
            )
    return pd.DataFrame(rows)


@pytest.mark.parametrize("method", ["did", "event_study"])
@pytest.mark.parametrize("seed", [41, 42])
def test_only_two_paired_treated_countries_never_receive_inference(method, seed):
    design = RegressionDesign("trade", granularity="country", method=method)
    result, benchmark = run_design_with_benchmark(paired_panel(method, seed), design)
    payload = result.to_dict()
    assert result.status == "insufficient"
    assert result.support["treated_clusters"] == 2
    assert result.support["paired_control_clusters"] == 20
    assert result.support["support_basis"] == "paired_baseline_target"
    assert not benchmark["benchmark_passed"]
    assert all(c.p is None and c.ci_low is None and c.ci_high is None and c.stars == "" for c in result.coefs)
    if method == "event_study":
        assert _valid_event_support(payload)
        assert all(
            p["contributing_clusters"] == 2 and not p["inference_supported"]
            for p in result.event_support["periods"]
            if p["event_time"] >= 0
        )
    assert _result_is_reportable(payload, {"method": method, "interaction": False})


def test_paired_control_support_cannot_be_replaced_by_noncontributing_countries():
    frame = paired_panel("did", 2026)
    frame.loc[frame.country.isin(["C00", "C01"]), "FVA_share"] = np.nan
    # Give all 20 treated countries complete baselines, but only two controls retain them.
    frame.loc[(frame.country < "C20") & (frame.year == 2017), "FVA_share"] = 0.3
    frame.loc[(frame.country >= "C22") & (frame.year == 2017), "FVA_share"] = np.nan
    result, _ = run_design_with_benchmark(frame, RegressionDesign("trade", granularity="country"))
    assert result.support["paired_control_clusters"] == 2
    assert result.support["suppress_inference"] is True
    assert all(c.p is None for c in result.coefs)


@pytest.mark.parametrize("method", ["did", "event_study"])
def test_no_comparison_group_is_a_reportable_diagnosis_without_fabricated_coefficients(method):
    frame = paired_panel("did", 2026, controls=0)
    result, benchmark = run_design_with_benchmark(
        frame, RegressionDesign("trade", granularity="country", method=method)
    )
    assert result.coefs == [] and result.n_obs == 0 and result.n_clusters == 0
    assert result.depvar_mean is None and result.depvar_std is None
    assert result.sample_flow["estimation_rows"] == 0
    assert result.sample_flow["dropped_rows_total"] == len(frame)
    assert result.diagnostics["diagnostic_only"] is True
    assert result.support["suppress_inference"] is True
    assert not benchmark["benchmark_passed"]
    assert _result_is_reportable(result.to_dict(), {"method": method, "interaction": False})


def test_positive_exposure_includes_small_doses_and_policy_scope_includes_historical_uk():
    assert TREATED_THRESHOLD == 0
    assert 1e-12 > TREATED_THRESHOLD
    for year in (2016, 2018, 2019, 2020):
        assert "GBR" in composite_imposer_members(year)["EU"]
    assert "GBR" not in composite_imposer_members(2021)["EU"]


def test_quota_is_not_a_fabricated_tariff_and_dates_identify_the_specific_increment():
    steel = next(e for e in EVENTS if e.name == "美国232钢铝关税")
    assert steel.rate("ARG", "C24", 2019) == 0
    assert steel.rate("BRA", "C24", 2019) == pytest.approx(0.1 / 3)
    assert steel.rate("KOR", "C24", 2019) == pytest.approx(0.1 / 3)
    assert steel.rate("DEU", "C24", 2018) == pytest.approx(0.2 * 214 / 365)
    assert steel.rate("CAN", "C24", 2020) == 0
    debt = next(e for e in ENTITY_LIST_EVENTS if "Directives 1/2" in e.name)
    assert debt.announced == "2017-09-29" and debt.effective == "2017-11-28"
    assert debt.source_urls and "此前已有" in debt.timeline_note


def test_dynamic_equation_restricts_event_time_and_uses_paired_weights():
    overall = RegressionDesign("trade").equation()
    dynamic = RegressionDesign("trade", method="event_study")
    assert "g+k" in dynamic.equation() and "ω_{g,k}" in dynamic.equation()
    assert overall.split(" = ")[1] != dynamic.equation().split(" = ")[1]
    assert "n_pair" in dynamic.equation_parts()[2]["description"]
