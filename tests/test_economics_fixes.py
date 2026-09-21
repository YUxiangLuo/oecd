"""Economic counterexamples, independent numeric references and boundary controls."""

import numpy as np
import pandas as pd
import pytest

from conftest import FakeIOSystem
from gvcsim import artifacts, pipeline, shocks
from gvcsim.data import controls, output_quality, quality
from gvcsim.indicators.core import build_arrays
from gvcsim.regression import panel
from gvcsim.regression.design import RegressionDesign


def test_section_201_product_specific_exemptions_and_2019_removals():
    countries = ["USA", "CAN", "PHL", "BRA", "IND", "TUR", "JPN"]
    data = shocks.demo_shock_panel(
        countries, ["C26", "C27"], list(range(2016, 2021)), allow_stylized_fallback=True
    ).set_index(["country", "sector", "year"])
    for year in (2018, 2019, 2020):
        assert data.loc[("CAN", "C27", year), "tariff_shock"] == 0
        assert data.loc[("CAN", "C26", year), "tariff_shock"] > 0
        assert data.loc[("PHL", "C27", year), "tariff_shock"] == 0
        assert data.loc[("PHL", "C26", year), "tariff_shock"] > 0
        for sector in ("C26", "C27"):
            assert data.loc[("BRA", sector, year), "tariff_shock"] == 0
            assert data.loc[("JPN", sector, year), "tariff_shock"] > 0
    for country, days, date in (("TUR", 229, "2019-05-17"), ("IND", 210, "2019-06-05")):
        for sector, rate in (("C26", 0.012), ("C27", 0.026)):
            assert data.loc[(country, sector, 2018), "treated"] == 0
            current = data.loc[(country, sector, 2019)]
            assert current.tariff_shock == pytest.approx(rate * days / 365 * shocks._EXPOSURE_TO_USA[country])
            assert current.effective_date == date
            assert current.treated == 1


@pytest.mark.parametrize(("before", "after"), [(0.0, 10.0), (10.0, 0.0), (10.0, 10.0), (0.0, 0.0)])
def test_contemporaneous_column_is_independent_of_primary_weight_mode(before, after):
    exposure = pd.concat(
        [
            shocks.build_export_exposure(
                build_arrays(
                    FakeIOSystem(np.zeros((2, 2)), np.array([[100.0, 0.0], [flow, 100.0]]), ["USA", "BRN"], ["C24"])
                ),
                year,
            )
            for year, flow in ((2017, before), (2018, after))
        ],
        ignore_index=True,
    )
    outputs = [
        shocks.demo_shock_panel(["USA", "BRN"], ["C24"], [2017, 2018], exposure, exposure_mode=mode)
        for mode in ("fixed_pretreatment", "contemporaneous")
    ]
    expected_current = 0.2 * 284 / 365 if after > 0 else 0.0
    for result in outputs:
        row = result.loc[result.country.eq("BRN") & result.year.eq(2018)].iloc[0]
        assert row.tariff_shock_contemporaneous == pytest.approx(expected_current)
        assert row.treated_contemporaneous == int(after > 0)
    row = outputs[0].loc[outputs[0].country.eq("BRN") & outputs[0].year.eq(2018)].iloc[0]
    assert row.tariff_shock == pytest.approx(0.2 * 284 / 365 if before > 0 else 0.0)
    if before == 0:
        assert row.note == "" and row.effective_date == ""


@pytest.mark.parametrize(
    ("groups", "sectors", "unbalanced"), [(12, 1, False), (20, 1, True), (20, 3, False), (76, 1, False)]
)
def test_twfe_cr1_matches_full_dummy_ols_and_does_not_reject_supported_design(groups, sectors, unbalanced):
    rng = np.random.default_rng(151)
    rows = []
    for country in range(groups):
        for sector in range(sectors):
            for year in range(2016, 2021):
                x = (0.04 + 0.015 * rng.random()) * (year >= 2018)
                y = 0.2 + 0.01 * country + 0.02 * sector + 0.004 * (year - 2016) + 0.3 * x + rng.normal(0, 0.005)
                if not (unbalanced and country % 3 == 0 and year == 2020):
                    rows.append(
                        {
                            "country": f"C{country:02d}",
                            "entity_id": f"C{country:02d}_{sector}",
                            "year": year,
                            "tariff_shock": x,
                            "treated": int(x > 0),
                            "FVA_share": y,
                        }
                    )
    data = pd.DataFrame(rows)
    design = RegressionDesign(
        "trade", granularity="country" if sectors == 1 else "country_industry", method="twfe_intensity"
    )
    model = panel.prepare_design_model(data, design)
    result, benchmark = panel.run_design_with_benchmark(data, design)
    data = model.data
    X = np.column_stack(
        [
            np.ones(len(data)),
            data.tariff_shock,
            pd.get_dummies(data[design.entity], drop_first=True, dtype=float),
            pd.get_dummies(data.year, drop_first=True, dtype=float),
        ]
    )
    beta, _, rank, _ = np.linalg.lstsq(X, data.FVA_share.to_numpy(), rcond=None)
    residual = data.FVA_share.to_numpy() - X @ beta
    scores = np.array([X[data.country.eq(c)].T @ residual[data.country.eq(c)] for c in data.country.unique()])
    bread = np.linalg.inv(X.T @ X)
    covariance = groups / (groups - 1) * (len(data) - 1) / (len(data) - rank) * bread @ (scores.T @ scores) @ bread
    assert model.support.status == result.status == "ok"
    assert benchmark["benchmark_passed"] is True
    assert result.coefs[0].coef == pytest.approx(beta[1], abs=1e-10)
    assert result.coefs[0].se == pytest.approx(np.sqrt(covariance[1, 1]), abs=1e-10)


def test_macro_calibration_preserves_million_usd_scale_and_population_identity():
    country = pd.DataFrame(
        [
            {
                "country": "AAA",
                "year": 2016,
                "SVA": 1000.0,
                **{name: 1.0 for name in ("DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub")},
            }
        ]
    )
    sector = pd.DataFrame([{"country": "AAA", "year": 2016, "industry": "C26", "SVA": 1000.0}])
    result = controls.build_controls(country, sector).iloc[0]
    assert np.expm1(result.macro_log_gdp_usd) == pytest.approx(957112312.3123124)
    assert 40000 < np.expm1(result.macro_log_population) < 50000
    assert result.macro_log_gdp_usd - result.macro_log_population == pytest.approx(result.macro_log_gdp_per_capita)


def test_inverse_corruption_blocks_release_but_economic_disclosure_does_not():
    io = FakeIOSystem(
        np.array([[10.0, 2.0], [2.0, 10.0]]), np.array([[100.0, 2.0], [2.0, 100.0]]), ["AAA", "BBB"], ["s1"]
    )
    blocking = artifacts.publication_policy_metadata()["blocking_kinds"]["icio"]
    structure = quality.QcCheck("structure", "结构", True)
    economic = quality.QcCheck("signed account", "经济含义", False, severity="warning")
    assert pipeline._gate_integrity("test", [structure, quality.check_leontief_inverse(io), economic], blocking)[
        "passed"
    ]
    io.L.iloc[0, 0] += 0.5
    with pytest.raises(pipeline.QualityGateError, match="里昂惕夫"):
        pipeline._gate_integrity("test", [structure, quality.check_leontief_inverse(io)], blocking)


def test_source_account_gate_allows_rounding_but_blocks_material_imbalance():
    io = FakeIOSystem(
        np.array([[10.0, 2.0], [2.0, 10.0]]), np.array([[100.0, 2.0], [2.0, 100.0]]), ["AAA", "BBB"], ["s1"]
    )
    blocking = artifacts.publication_policy_metadata()["blocking_kinds"]["icio"]
    io.reported_output.iloc[0] += 0.5  # Million USD: within the source rounding tolerance.
    assert pipeline._gate_integrity("test", [quality.check_accounting_identity(io)], blocking)["passed"]
    io.reported_output.iloc[0] += 10.0  # Beyond both 1 Million USD and 1%.
    with pytest.raises(pipeline.QualityGateError, match="会计恒等式"):
        pipeline._gate_integrity("test", [quality.check_accounting_identity(io)], blocking)


def test_signed_shares_keep_correct_ratios_as_disclosure_but_wrong_ratios_are_fatal():
    frame = pd.DataFrame(
        {
            "gross_exports": [100.0],
            "FVA": [-2.0],
            "SVA": [100.0],
            "3b_VA_GVC_C": [120.0],
            "3_VA_GVC": [130.0],
            "FVA_share": [-0.02],
            "3b_VA_GVC_C_share": [1.2],
            "3_VA_GVC_share": [1.3],
        }
    )
    frames = {"panel_country_year": frame, "panel_industry_year": frame}
    identity = output_quality._panel_shares(frames, 2020)
    economic = output_quality._panel_share_economic_domains(frames, 2020)
    assert identity["passed"] and identity["kind"] == "mathematical"
    assert not economic["passed"] and economic["severity"] == "warning"
    assert frame.FVA_share.iloc[0] == -0.02  # No clipping to force a conventional domain.
    frame.loc[0, "FVA_share"] = 0.0
    assert output_quality._panel_shares(frames, 2020)["severity"] == "fatal"
