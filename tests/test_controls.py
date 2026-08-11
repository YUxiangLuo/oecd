import numpy as np
import pandas as pd

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
            # 项目口径：毛出口 = 五类 WWZ 聚合项 + OECD TLS 扩展项，GDP proxy = SVA。
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
    assert np.isfinite(controls[ALL_CONTROL_COLUMNS].to_numpy()).all()

    first = controls.sort_values(["country", "year"]).groupby("country").head(1)
    assert np.allclose(first["gdp_proxy_growth"], 0.0)
    assert np.allclose(first["exports_proxy_growth"], 0.0)
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
