import pandas as pd
import numpy as np
import pytest

from gvcsim.regression.teaching import BETAS, X_COLUMN, Y_COLUMNS, build_teaching_panel, model_snapshot


def _source(countries=("AAA", "BBB", "CCC", "DDD")) -> pd.DataFrame:
    rows = []
    for country in countries:
        for industry_index, industry in enumerate(("s1", "s2", "s3"), 1):
            for year in range(2016, 2021):
                rows.append(
                    {
                        "country": country,
                        "industry": industry,
                        "entity_id": f"{country}_{industry}",
                        "year": year,
                        "gross_exports": industry_index * 10 + year - 2016,
                        "FVA_share": 0.1 + industry_index / 100,
                        "3b_VA_GVC_C_share": 0.05 + industry_index / 100,
                        "PLv_GVC": 3 + industry_index / 10,
                        "betweenesscentrality": 100 + industry_index,
                    }
                )
    return pd.DataFrame(rows)


def _exposure(source):
    frame = source[["country", "industry", "year"]].rename(columns={"industry": "sector"}).copy()
    frame["imposer"] = "USA"
    frame["export_exposure"] = frame.sector.map({"s1": 0.4, "s2": 0.1, "s3": 0.8})
    frame.loc[frame.year.gt(2016), "export_exposure"] = 0.02
    return frame


def test_teaching_panel_is_separate_reproducible_and_has_transparent_tariff_path():
    source = _source()
    original = source.copy(deep=True)
    first = build_teaching_panel(source, _exposure(source))
    second = build_teaching_panel(source.sample(frac=1, random_state=3), _exposure(source))

    pd.testing.assert_frame_equal(source, original)
    pd.testing.assert_frame_equal(first, second)
    assert set(Y_COLUMNS.values()).isdisjoint(source.columns)
    assert first.loc[first.year.isin([2016, 2017]), X_COLUMN].eq(0).all()
    assert first.loc[first.year.eq(2020), X_COLUMN].max() == 0.55 * first.loc[first.year.eq(2019), X_COLUMN].max()
    assert first.groupby("entity_id")[X_COLUMN].max().eq(0).any()
    assert first.loc[first.industry.eq("s1"), "teaching_export_share_w"].eq(0.4).all()
    assert first.loc[first.industry.eq("s3"), "teaching_export_share_w"].eq(0.8).all()
    np.testing.assert_allclose(first[X_COLUMN], first.teaching_export_share_w * first.teaching_tariff_rate_tau)


def test_invalid_baselines_are_excluded_not_clipped_and_years_are_checked():
    source = _source()
    source.loc[source.entity_id.eq("AAA_s1") & source.year.eq(2016), "FVA_share"] = -0.01
    result = build_teaching_panel(source, _exposure(source))
    assert "AAA_s1" not in set(result.entity_id)
    for outcome in ("trade", "production"):
        assert result[Y_COLUMNS[outcome]].between(0, 1).all()
    assert result[Y_COLUMNS["length"]].gt(0).all()
    assert result[Y_COLUMNS["network"]].ge(0).all()
    with pytest.raises(ValueError, match="连续五年"):
        build_teaching_panel(source.loc[source.year.ne(2017)], _exposure(source))


def test_prespecified_seed_family_recovers_relations_without_selecting_significance():
    from gvcsim.regression.design import RegressionDesign
    from gvcsim.regression.panel import run_design_with_benchmark

    source = _source(tuple(f"C{i:02}" for i in range(30)))
    estimates = {outcome: [] for outcome in Y_COLUMNS}
    for seed in (11, 29, 83):
        panel = build_teaching_panel(source, _exposure(source), seed=seed)
        for outcome in Y_COLUMNS:
            result, benchmark = run_design_with_benchmark(
                panel, RegressionDesign(outcome, method="twfe_intensity", teaching=True)
            )
            assert benchmark["benchmark_passed"]
            coefficient = next(coef for coef in result.coefs if coef.name == X_COLUMN)
            estimates[outcome].append(coefficient.coef)
    # Independent acceptance bounds around the declared experimental mechanisms.
    for outcome, expected, tolerance in (
        ("trade", -0.55, 0.08),
        ("production", -0.4, 0.08),
        ("length", -1.8, 0.5),
        ("network", -6000, 900),
    ):
        assert abs(np.mean(estimates[outcome]) - expected) < tolerance


def test_snapshot_publishes_actual_columns_and_prespecified_parameters():
    snapshot = model_snapshot("network")
    assert snapshot["x_columns"] == [X_COLUMN]
    assert snapshot["y_column"] == Y_COLUMNS["network"]
    assert snapshot["beta"] == BETAS["network"]
    assert snapshot["controls"] == snapshot["interactions"] == []
    assert "虚构" in snapshot["disclaimer"]


def test_step10_filters_before_limiting_and_reads_the_regression_artifact(monkeypatch):
    import asyncio
    from fastapi import HTTPException
    from gvcsim import regression_routes

    panel = build_teaching_panel(_source(), _exposure(_source()))
    reads = []

    def read(name):
        reads.append(name)
        return panel

    monkeypatch.setattr(regression_routes, "_read_csv", read)
    response = asyncio.run(regression_routes.teaching_panel(country="DDD", year=2020, limit=1))
    assert reads == ["panel_teaching.csv"]
    assert response["total"] == 3
    assert len(response["rows"]) == 1
    row = response["rows"][0]
    assert (row["country"], row["industry"], row["year"]) == ("DDD", "s1", 2020)
    expected = panel.loc[panel.country.eq("DDD") & panel.industry.eq("s1") & panel.year.eq(2020), X_COLUMN].iloc[0]
    assert row[X_COLUMN] == expected
    with pytest.raises(HTTPException) as error:
        asyncio.run(regression_routes.teaching_panel(country="DDD", year=2021, limit=1))
    assert error.value.status_code == 422
