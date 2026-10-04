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
    assert set(first.teaching_tariff_rate_tau.unique()) == {0.0, 0.1}
    post = first.loc[first.year.ge(2018)]
    assert post.groupby("entity_id")[X_COLUMN].nunique().eq(1).all()
    assert post.groupby("country").teaching_tariff_rate_tau.nunique().eq(1).all()
    assert first.groupby("entity_id")[X_COLUMN].max().eq(0).any()
    assert first.loc[first.industry.eq("s1"), "teaching_export_share_w"].eq(0.4).all()
    assert first.loc[first.industry.eq("s3"), "teaching_export_share_w"].eq(0.8).all()
    np.testing.assert_allclose(first[X_COLUMN], first.teaching_export_share_w * first.teaching_tariff_rate_tau)


def test_v2_preserves_randomization_and_halves_noise_without_changing_effects():
    import hashlib
    from gvcsim.regression import teaching
    from gvcsim.regression.design import OUTCOME_DEPVARS

    source = _source()
    panel = build_teaching_panel(source, _exposure(source))
    alternate = build_teaching_panel(source, _exposure(source), seed=1000)
    np.testing.assert_array_equal(panel[X_COLUMN], alternate[X_COLUMN])
    assert not panel[Y_COLUMNS["trade"]].equals(alternate[Y_COLUMNS["trade"]])

    def draw(value, salt):
        raw = hashlib.sha256(f"step10-tariff-teaching-v1|20260913|{salt}|{value}".encode()).digest()
        return 2 * int.from_bytes(raw[:8], "big") / (2**64 - 1) - 1

    # Independent fixed acceptance values, not expectations read from CALIBRATION.
    for outcome, low, span, beta, scale in (
        ("trade", 0.25, 0.30, -0.55, 0.006),
        ("production", 0.20, 0.25, -0.40, 0.005),
        ("length", 3.0, 2.0, -1.8, 0.030),
        ("network", 2000.0, 2000.0, -6000.0, 60.0),
    ):
        baseline = panel.loc[panel.year.eq(2016)].set_index("entity_id")[OUTCOME_DEPVARS[outcome][0]].rank(pct=True)
        expected = []
        for row in panel.itertuples():
            noise = draw(f"{row.entity_id}|{row.year}", outcome) + draw(
                f"{row.country}|{row.year}", f"cluster-{outcome}"
            )
            expected.append(
                low
                + span * baseline[row.entity_id]
                + beta * row.teaching_tariff_exposure
                + scale * (noise + (row.year - 2018) * 0.2)
            )
        np.testing.assert_allclose(panel[Y_COLUMNS[outcome]], expected, rtol=1e-12, atol=1e-12)
    snapshot = model_snapshot("trade")
    assert snapshot["version"] == "step10-tariff-teaching-v2"
    assert snapshot["randomization_version"] == "step10-tariff-teaching-v1"
    assert snapshot["tariff_path"] == [0, 0, 0.1, 0.1, 0.1]
    assert teaching.SEED == 20260913


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


def test_benchmark_binds_exposure_bytes_and_generator_parameters(tmp_path):
    import hashlib
    from scripts.benchmark_teaching_design import evaluate

    source = _source(tuple(f"C{i:02}" for i in range(30)))
    exposure = _exposure(source)
    source.to_csv(tmp_path / "panel_industry.csv", index=False)
    path = tmp_path / "export_exposure_2016.csv"
    exposure.to_csv(path, index=False)
    first = evaluate(tmp_path, range(1000, 1001))
    assert first["source_exposure"] == {"path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    snapshot = first["generator_snapshots"]["trade"]
    assert snapshot["randomization_version"] == "step10-tariff-teaching-v1"
    assert snapshot["beta"] == -0.55
    assert snapshot["calibration"] == (0.25, 0.30, 0.006)
    exposure["export_exposure"] *= 0.5
    exposure.to_csv(path, index=False)
    second = evaluate(tmp_path, range(1000, 1001))
    assert first["source_panel_sha256"] == second["source_panel_sha256"]
    assert first["source_exposure"]["sha256"] != second["source_exposure"]["sha256"]
    assert second["summary"]["flat_half_noise"]["trade"]["rmse"] == pytest.approx(
        2 * first["summary"]["flat_half_noise"]["trade"]["rmse"]
    )


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


def test_step10_series_returns_two_countries_all_years_and_teaching_outcomes(monkeypatch):
    import asyncio
    from gvcsim import regression_routes

    panel = build_teaching_panel(_source(), _exposure(_source()))
    monkeypatch.setattr(regression_routes, "_read_csv", lambda _name: panel)

    response = asyncio.run(regression_routes.teaching_panel(countries="AAA,DDD", industry="s1", limit=200))

    assert response["total"] == 10
    assert {(row["country"], row["industry"]) for row in response["rows"]} == {("AAA", "s1"), ("DDD", "s1")}
    assert {row["year"] for row in response["rows"]} == {2016, 2017, 2018, 2019, 2020}
    assert all(set(Y_COLUMNS.values()).issubset(row) for row in response["rows"])


@pytest.mark.parametrize("has_treated", [True, False])
def test_sample_flow_reconciles_exclusions_and_overlapping_missing_values(has_treated):
    from gvcsim.regression.design import RegressionDesign
    from gvcsim.regression.model import prepare_design_model

    design = RegressionDesign("trade", teaching=True)
    frame = pd.DataFrame(
        {
            "country": ["ROW", "A", "B", "C", "D", "E"],
            "entity_id": ["ROW_s1", "A_s1", "B_s1", "C_s1", "D_s1", "E_s1"],
            "year": [2020] * 6,
            design.depvar: [np.nan, np.nan, np.nan, 0.4, 0.5, 0.6],
            design.shock_col: [np.nan, np.nan, 0.2, np.nan, 0.3, 0.4],
            design.treated_col: [0, 0, 0, 0, np.nan, 0],
        }
    )
    if not has_treated:
        frame = frame.drop(columns=design.treated_col)
    original = frame.copy(deep=True)
    model = prepare_design_model(frame, design)
    pd.testing.assert_frame_equal(frame, original)
    flow = model.sample_flow
    assert list(model.data.country) == (["E"] if has_treated else ["D", "E"])
    assert flow["input_rows"] == 6
    assert flow["row_excluded_rows"] == 1
    assert flow["complete_case_input_rows"] == 5
    assert flow["estimation_rows"] == (1 if has_treated else 2)
    assert flow["dropped_rows_total"] == (5 if has_treated else 4)
    assert flow["missing_by_field"] == {
        design.depvar: 2,
        design.shock_col: 2,
        **({design.treated_col: 1} if has_treated else {}),
    }
    assert flow["missing_by_field_counts_overlap"] is True
    assert flow["dropped_by_reason"] == [
        {"code": "excluded_row", "field": "country", "rows": 1},
        {"code": "missing", "field": design.depvar, "rows": 2},
        {"code": "missing", "field": design.shock_col, "rows": 1},
        *([{"code": "missing", "field": design.treated_col, "rows": 1}] if has_treated else []),
    ]
    assert sum(reason["rows"] for reason in flow["dropped_by_reason"]) == flow["dropped_rows_total"]


def test_group_trends_compare_taxed_and_untaxed_changes_against_their_own_pre_policy_mean(monkeypatch):
    import asyncio
    from gvcsim import regression_routes
    from gvcsim.regression.teaching import group_trends

    panel = build_teaching_panel(_source(("AAA", "BBB", "CCC", "DDD", "EEE", "FFF")), _exposure(_source()))
    result = group_trends(panel)
    taxed = panel.groupby("country").teaching_tariff_rate_tau.max().gt(0)
    assert result["policy_year"] == 2018
    assert result["years"] == [2016, 2017, 2018, 2019, 2020]
    assert result["sample"] == {
        "rows": len(panel),
        "entities": panel.entity_id.nunique(),
        "countries": panel.country.nunique(),
        "industries": 3,
        "taxed_countries": int(taxed.sum()),
        "untaxed_countries": int((~taxed).sum()),
    }
    for outcome, column in Y_COLUMNS.items():
        for name, members in (("taxed", taxed[taxed].index), ("untaxed", taxed[~taxed].index)):
            series = result["outcomes"][outcome][name]
            if not len(members):
                assert series == []
                continue
            means = panel.loc[panel.country.isin(members)].groupby("year")[column].mean()
            pre = means.loc[[2016, 2017]].mean()
            assert [point["year"] for point in series] == result["years"]
            assert [point["change"] for point in series] == pytest.approx(list(means - pre))
            # Each line is centred on its own pre-policy mean.
            assert series[0]["change"] + series[1]["change"] == pytest.approx(0)

    monkeypatch.setattr(regression_routes, "_read_csv", lambda _name: panel)
    assert asyncio.run(regression_routes.teaching_groups()) == result
