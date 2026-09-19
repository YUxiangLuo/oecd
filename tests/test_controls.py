import numpy as np
import pandas as pd
import pytest

from gvcsim.data import regression_quality

from gvcsim.data.controls import (
    ALL_CONTROL_COLUMNS,
    MACRO_CONTROL_COLUMNS,
    PRICE_COLUMNS,
    build_controls,
)
from gvcsim.data.quality import check_controls_country


def _fixtures():
    countries = ["AAA", "BBB"]
    years = [2018, 2019, 2020]
    sectors = ["C10T12", "G", "A01_02"]
    country_rows = []
    sector_rows = []
    for c_i, c in enumerate(countries):
        for y_i, year in enumerate(years):
            va = 1000 + c_i * 200 + y_i * 100
            exp = 200 + c_i * 50 + y_i * 20
            # 项目口径：总出口 = 五类 WWZ 聚合项 + OECD TLS 扩展项，GDP proxy = SVA。
            country_rows.append(
                {
                    "country": c,
                    "year": year,
                    "SVA": va,
                    "DVAex": exp * 0.70,
                    "DVArt": exp * 0.02,
                    "DDC": exp * 0.03,
                    "FVA": exp * 0.18,
                    "FDC": exp * 0.04,
                    "taxsub": exp * 0.03,
                }
            )
            sector_rows.extend(
                [
                    {"country": c, "year": year, "industry": sectors[0], "SVA": va * 0.40},
                    {"country": c, "year": year, "industry": sectors[1], "SVA": va * 0.35},
                    {"country": c, "year": year, "industry": sectors[2], "SVA": va * 0.25},
                ]
            )
    return pd.DataFrame(country_rows), pd.DataFrame(sector_rows)


def test_build_controls_from_processed_indicators_shape_and_values():
    country, sector = _fixtures()
    controls = build_controls(country, sector)

    assert list(controls.columns) == ["country", "year", *ALL_CONTROL_COLUMNS]
    assert controls[["country", "year"]].duplicated().sum() == 0
    assert set(controls["country"]) == {"AAA", "BBB"}
    growth = ["gdp_proxy_growth", "exports_proxy_growth"]
    assert np.isfinite(controls[[column for column in ALL_CONTROL_COLUMNS if column not in growth]].to_numpy()).all()

    first = controls.sort_values(["country", "year"]).groupby("country").head(1)
    assert first["gdp_proxy_growth"].isna().all()
    assert first["exports_proxy_growth"].isna().all()
    assert np.allclose(first["trade_gross_exports_index"], 1.0)
    assert np.allclose(first["prod_va_total_index"], 1.0)
    assert np.allclose(first["gdp_deflator"], 1.0)
    assert np.allclose(first["inflation_rate"], 0.0)

    assert np.allclose(controls["manufacturing_va_share"], 0.40)
    assert np.allclose(controls["services_va_share"], 0.35)

    assert set(MACRO_CONTROL_COLUMNS).issubset(controls.columns)
    assert np.allclose(
        controls["macro_log_gdp_usd"] - controls["macro_log_population"],
        controls["macro_log_gdp_per_capita"],
    )
    assert controls["macro_exchange_rate_change"].between(-0.12, 0.12).all()
    assert controls["macro_fdi_inflow_gdp"].between(0.0, 0.15).all()
    assert set(PRICE_COLUMNS).issubset(controls.columns)
    assert controls["gdp_deflator"].ge(1.0).all()
    assert controls["inflation_rate"].between(0.0, 0.08).all()


def test_controls_country_quality_checks_pass_and_fail():
    country, sector = _fixtures()
    controls = build_controls(country, sector)
    countries = sorted(country["country"].unique())
    years = sorted(country["year"].unique())

    checks = check_controls_country(controls, countries=countries, years=years)
    assert len(checks) == 5
    assert all(c.passed for c in checks), [(c.name, c.detail, c.warnings) for c in checks]

    missing_col = controls.drop(columns=["macro_log_population"])
    schema = check_controls_country(missing_col, countries=countries, years=years)
    assert not schema[0].passed
    assert "macro_log_population" in schema[0].warnings[0]

    bad = controls.copy()
    bad.loc[0, "manufacturing_va_share"] = 1.4
    bad.loc[1, "macro_log_gdp_per_capita"] += 0.5
    bad_checks = {c.name: c for c in check_controls_country(bad, countries=countries, years=years)}
    assert not bad_checks["控制变量构造恒等式"].passed
    assert not bad_checks["控制变量经济范围"].passed


def test_nominal_growth_requires_the_previous_calendar_year_and_recovers_after_gap():
    country, sector = _fixtures()
    # Keep BBB continuous; AAA has 2016, 2018, 2019 with values 100, 121, 133.1.
    country["year"] -= 2
    sector["year"] -= 2
    for frame in (country, sector):
        frame.loc[frame.country.eq("AAA") & frame.year.ge(2017), "year"] += 1
    country["SVA"] = country["SVA"].astype(float)
    country.loc[country.country.eq("AAA"), "SVA"] = [100.0, 121.0, 133.1]
    for column in ["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"]:
        country.loc[country.country.eq("AAA"), column] = [100.0, 121.0, 133.1] if column == "DVAex" else 0.0
    controls = build_controls(country.sample(frac=1, random_state=13), sector).set_index(["country", "year"])

    for column in ("gdp_proxy_growth", "exports_proxy_growth"):
        assert np.isnan(controls.loc[("AAA", 2016), column])
        assert np.isnan(controls.loc[("AAA", 2018), column])  # not 21%, and not annualized to 10%
        assert controls.loc[("AAA", 2019), column] == pytest.approx(0.1)
        assert np.isfinite(controls.loc[("BBB", 2018), column])


@pytest.mark.parametrize("gap_value", [0.21, np.nan])
def test_release_qc_rejects_nonannual_controls_even_if_gap_growth_is_filled(gap_value):
    country, sector = _fixtures()
    controls = build_controls(country, sector).query("year != 2019").copy()
    for column in ("gdp_proxy_growth", "exports_proxy_growth"):
        controls.loc[controls.year.eq(2020), column] = gap_value
        # The current release contract allows only first-year structural nulls;
        # do not widen it to publish gapped annual control/price/mock trajectories.
        assert regression_quality._growth_null_policy_valid(controls, column) is False
        industry_panel = pd.concat([controls.assign(industry="A"), controls.assign(industry="B")], ignore_index=True)
        assert regression_quality._growth_null_policy_valid(industry_panel, column) is False
    checks = {c.name: c for c in check_controls_country(controls, years=[2018, 2020])}
    assert checks["控制变量维度对齐(country×year)"].passed is False
    assert any("连续" in warning for warning in checks["控制变量维度对齐(country×year)"].warnings)


def test_growth_null_qc_keeps_valid_country_and_industry_panels():
    country, sector = _fixtures()
    controls = build_controls(country, sector)
    for frame in (controls, pd.concat([controls, controls], ignore_index=True)):
        frame = frame.sample(frac=1, random_state=53)
        frame.index = pd.Index(np.arange(len(frame)) + 100)
        for column in ("gdp_proxy_growth", "exports_proxy_growth"):
            assert regression_quality._growth_null_policy_valid(frame, column) is True
            filled = frame.fillna({column: 0.0})
            assert regression_quality._growth_null_policy_valid(filled, column) is False


def test_controls_country_quality_is_independent_of_dataframe_index_labels():
    country, sector = _fixtures()
    controls = build_controls(country, sector).sample(frac=1, random_state=9)
    controls.index = pd.Index(range(100, 100 + len(controls)), name="external_row_id")

    checks = check_controls_country(
        controls,
        countries=sorted(country["country"].unique()),
        years=sorted(country["year"].unique()),
    )

    assert all(check.passed for check in checks), [(check.name, check.detail, check.warnings) for check in checks]
