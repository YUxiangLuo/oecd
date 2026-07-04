import numpy as np
import pandas as pd

from gvcsim.data.controls import ALL_CONTROL_COLUMNS, build_controls


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
            country_rows.append({
                "country": c, "year": year,
                "prod_va_total": va,
                "trade_gross_exports": exp,
            })
            sector_rows.extend([
                {"country": c, "year": year, "sector": sectors[0], "prod_va_total": va * 0.40},
                {"country": c, "year": year, "sector": sectors[1], "prod_va_total": va * 0.35},
                {"country": c, "year": year, "sector": sectors[2], "prod_va_total": va * 0.25},
            ])
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

    assert np.allclose(controls["manufacturing_va_share"], 0.40)
    assert np.allclose(controls["services_va_share"], 0.35)
