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
                        "weighted degree": 1000 + 10 * industry_index,
                        "weighted indegree": 400 + 5 * industry_index,
                        "weighted outdegree": 600 + 5 * industry_index,
                    }
                )
    return pd.DataFrame(rows)


def _exposure(source):
    frame = source[["country", "industry", "year"]].rename(columns={"industry": "sector"}).copy()
    frame["imposer"] = "USA"
    frame["export_exposure"] = frame.sector.map({"s1": 0.4, "s2": 0.1, "s3": 0.8})
    frame.loc[frame.year.gt(2016), "export_exposure"] = 0.02
    frame["bilateral_exports"] = 0.0
    return pd.concat([frame, _goods_flows(sorted(source.country.unique()))], ignore_index=True)


def _goods_flows(countries, surplus=lambda index: 1500.0 if index % 2 == 0 else -500.0):
    """Goods flows with the USA (sector C10T12, not in the source panel): every other country has a surplus of
    1,500 (taxed under the ≥ 1,000 rule), the rest a deficit (untaxed)."""
    rows = []
    for index, country in enumerate(countries):
        balance = surplus(index)
        to_us, from_us = 2000.0, 2000.0 - balance
        rows.append({"country": country, "sector": "C10T12", "imposer": "USA", "year": 2016,
                     "export_exposure": 0.5, "bilateral_exports": to_us})
        rows.append({"country": "USA", "sector": "C10T12", "imposer": country, "year": 2016,
                     "export_exposure": 0.1, "bilateral_exports": from_us})
    return pd.DataFrame(rows)


def test_teaching_panel_is_separate_reproducible_and_has_transparent_tariff_path():
    source = _source()
    original = source.copy(deep=True)
    first = build_teaching_panel(source, _exposure(source))
    second = build_teaching_panel(source.sample(frac=1, random_state=3), _exposure(source))

    pd.testing.assert_frame_equal(source, original)
    pd.testing.assert_frame_equal(first, second)
    assert set(Y_COLUMNS.values()).isdisjoint(source.columns)
    assert first.loc[first.year.isin([2016, 2017]), X_COLUMN].eq(0).all()
    assert set(first.teaching_tariff_rate_tau.unique()) == {0.0, 0.25}
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
        ("production", 0.14, 0.16, -0.40, 0.005),
        ("length", 3.0, 2.0, -1.8, 0.030),
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
    # v6: the network family's fixed Y is weighted in-degree + out-degree, row by row.
    np.testing.assert_allclose(
        panel[Y_COLUMNS["network"]],
        panel[teaching.y_column("network", "weighted_indegree")]
        + panel[teaching.y_column("network", "weighted_outdegree")],
        rtol=1e-12,
        atol=1e-9,
    )
    snapshot = model_snapshot("trade")
    assert snapshot["version"] == "step10-tariff-teaching-v7"
    assert snapshot["randomization_version"] == "step10-tariff-teaching-v1"
    assert snapshot["tariff_path"] == [0, 0, 0.25, 0.25, 0.25]
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
        ("network", -4000, 600),
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
    assert "课程" in snapshot["disclaimer"] and "模拟" not in snapshot["disclaimer"]


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
    assert result["industries"] == sorted(panel.industry.unique())
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


def test_run_returns_a_binned_scatter_whose_bins_follow_the_estimate():
    """The binned scatter is the regression's own picture: 20 equal-count bins of the within-transformed X."""
    from gvcsim.regression.design import RegressionDesign
    from gvcsim.regression.panel import run_design_with_benchmark

    source = _source(tuple(f"C{i:02}" for i in range(30)))
    panel = build_teaching_panel(source, _exposure(source), seed=29)
    result, _benchmark = run_design_with_benchmark(panel, RegressionDesign("trade", teaching=True))
    binscatter = result.binscatter
    assert binscatter is not None
    assert binscatter["transform"] == "twoway_demeaned"
    assert binscatter["slope"] == result.coefs[0].coef
    bins = binscatter["bins"]
    assert len(bins) == 20
    assert sum(point["n"] for point in bins) == result.n_obs
    xs = [point["x"] for point in bins]
    assert xs == sorted(xs)
    # Within-transformed X and Y both average to zero across the sample.
    assert abs(sum(point["x"] * point["n"] for point in bins)) < 1e-9
    assert abs(sum(point["y"] * point["n"] for point in bins)) < 1e-9
    assert all("binscatter" in result.to_dict() for _ in [0])


def test_group_trends_report_the_mean_exposure_of_taxed_units():
    from gvcsim.regression.teaching import group_trends

    source = _source(tuple(f"C{i:02}" for i in range(30)))
    panel = build_teaching_panel(source, _exposure(source))
    trends = group_trends(panel)
    taxed = panel.groupby("country").teaching_tariff_rate_tau.max().gt(0)
    policy = panel.loc[panel.country.map(taxed) & panel.year.ge(trends["policy_year"]), X_COLUMN]
    assert trends["mean_exposure_taxed"] == pytest.approx(float(policy.mean()))
    assert trends["mean_exposure_taxed"] > 0


def _full_source(countries=("AAA", "BBB", "CCC", "DDD")) -> pd.DataFrame:
    """The minimal source panel plus every column an alternative baseline is calibrated from."""
    frame = _source(countries)
    index = frame.industry.map({"s1": 1, "s2": 2, "s3": 3})
    frame["DVAex"] = frame.gross_exports * (0.5 + index / 20)
    frame["FDC"] = frame.gross_exports * (0.02 + index / 100)
    frame["SVA"] = 100 + index
    frame["3_VA_GVC_share"] = 0.2 + index / 100
    frame["3a_VA_GVC_S"] = 10 + index
    frame["1_VA_D"] = 50 + index
    frame["PLy_GVC"] = 2.5 + index / 10
    frame["GVCPs"] = -0.2 + index / 10
    frame["weighted indegree"] = 400 + 5 * index
    frame["weighted outdegree"] = 600 + 5 * index
    frame["2_VA_RT"] = 20 + index
    frame["FGY"] = 120 + index
    frame["3_FGY_GVC"] = 30 + index
    frame["3b_FGY_GVC_C"] = 15 + index
    frame["closnesscentrality"] = 0.3 + index / 50
    return frame


def test_alternative_baselines_add_their_own_y_without_changing_the_family_defaults():
    from gvcsim.regression.teaching import BASELINES, variable_catalog, y_column

    source, full = _source(), _full_source()
    thin = build_teaching_panel(source, _exposure(source))
    panel = build_teaching_panel(full, _exposure(full))
    # The fixed Y of every family is bit-for-bit the v3 generation.
    for column in Y_COLUMNS.values():
        np.testing.assert_array_equal(thin[column], panel[column])
    assert set(thin.columns) < set(panel.columns)
    from gvcsim.regression.teaching import sources_present

    for outcome, items in BASELINES.items():
        assert y_column(outcome, items[0].key) == Y_COLUMNS[outcome]
        for item in items[1:]:
            column = y_column(outcome, item.key)
            # The thin fixture only carries the alternatives whose sources it has (betweenness).
            assert (column in thin.columns) == sources_present(item, source.columns)
            assert column in panel.columns
            assert np.isfinite(panel[column]).all()
            # Independent draws: the alternative is not the default shifted by a constant.
            assert (panel[column] - panel[Y_COLUMNS[outcome]]).std() > 0
    snapshot = model_snapshot("trade", "DVAex_share")
    assert snapshot["baseline"] == "DVAex_share"
    assert snapshot["beta"] == 0.55 and snapshot["y_column"] == "teaching_y_trade_DVAex_share"
    assert snapshot["baseline_kind"] == "share" and snapshot["version"] == "step10-tariff-teaching-v7"
    assert model_snapshot("trade")["baseline"] == "FVA_share"
    with pytest.raises(ValueError):
        model_snapshot("trade", "PLy_GVC")  # a length baseline is not in the trade family
    catalog = variable_catalog("length", "GVCPs")
    assert catalog[1]["baseline"] == "GVCPs" and "位置" in catalog[1]["unit"]
    assert variable_catalog("length")[1]["baseline"] == "PLv_GVC"


def test_out_of_domain_alternative_source_leaves_only_that_y_missing_for_that_unit():
    full = _full_source()
    full.loc[full.entity_id.eq("AAA_s1"), "closnesscentrality"] = -1.0
    full.loc[full.entity_id.eq("BBB_s2"), "DVAex"] = np.nan
    panel = build_teaching_panel(full, _exposure(full))
    assert panel.entity_id.nunique() == 12
    closeness = "teaching_y_network_closnesscentrality"
    assert panel.loc[panel.entity_id.eq("AAA_s1"), closeness].isna().all()
    assert panel.loc[panel.entity_id.ne("AAA_s1"), closeness].notna().all()
    assert panel.loc[panel.entity_id.eq("BBB_s2"), "teaching_y_trade_DVAex_share"].isna().all()
    assert panel.loc[panel.entity_id.ne("BBB_s2"), "teaching_y_trade_DVAex_share"].notna().all()
    assert panel[list(Y_COLUMNS.values())].notna().all().all()


def test_group_trends_list_the_baselines_a_panel_carries_with_their_series():
    from gvcsim.regression.teaching import group_trends

    countries = ("AAA", "BBB", "CCC", "DDD", "EEE", "FFF")
    full = _full_source(countries)
    trends = group_trends(build_teaching_panel(full, _exposure(full)))
    assert [option["key"] for option in trends["baselines"]["trade"]] == ["FVA_share", "DVAex_share"]
    assert trends["baselines"]["trade"][0]["default"] is True and trends["baselines"]["trade"][1]["default"] is False
    assert (
        trends["baselines"]["network"][0]["key"] == "weighted_degree" and trends["baselines"]["network"][0]["default"]
    )
    assert trends["baselines"]["network"][3] == {
        "key": "betweenesscentrality",
        "label": "网络介数（全正边二值）",
        "kind": "network",
        "unit": "中心性单位",
        "default": False,
        "column": "teaching_y_network_betweenesscentrality",
        "source": "betweenesscentrality",
    }
    assert trends["series"]["trade"]["FVA_share"] == trends["outcomes"]["trade"]
    assert set(trends["series"]["length"]) == {"PLv_GVC", "PLy_GVC", "GVCPs"}
    assert trends["series"]["length"]["GVCPs"]["taxed"][0]["year"] == 2016
    source = _source(countries)
    thin = group_trends(build_teaching_panel(source, _exposure(source)))
    assert [option["key"] for option in thin["baselines"]["trade"]] == ["FVA_share"]
    assert list(thin["series"]["production"]) == ["3b_VA_GVC_C_share"]


def test_design_with_an_alternative_baseline_runs_and_recovers_its_own_relation():
    from gvcsim.regression.design import RegressionDesign
    from gvcsim.regression.panel import run_design_with_benchmark

    full = _full_source(tuple(f"C{i:02}" for i in range(30)))
    panel = build_teaching_panel(full, _exposure(full), seed=29)
    design = RegressionDesign("production", teaching=True, baseline="1_VA_D_share")
    assert design.depvar == "teaching_y_production_1_VA_D_share"
    assert design.depvar_kind == "share" and design.baseline_label == "纯国内生产份额"
    assert design.depvar_label == "纯国内生产份额"
    assert "teaching_y_production_1_VA_D_share_ijt" in design.equation()
    result, benchmark = run_design_with_benchmark(panel, design)
    assert benchmark["benchmark_passed"]
    coefficient = result.coefs[0]
    assert coefficient.ci_low is not None and coefficient.ci_low > 0  # the implied relation is positive
    # v6: 纯国内 = 1 − 简单 GVC − 复杂 GVC − 传统贸易, so its relation is −(−0.30 − 0.40 − 0.30) = 1.0.
    assert abs(coefficient.coef - 1.00) < 0.1
    assert result.binscatter is not None and result.binscatter["slope"] == coefficient.coef
    # The default design is untouched and a cross-family or observed-panel choice is refused.
    assert RegressionDesign("production", teaching=True).baseline == "3b_VA_GVC_C_share"
    with pytest.raises(ValueError):
        RegressionDesign("production", teaching=True, baseline="FVA_share")
    with pytest.raises(ValueError):
        RegressionDesign("trade", baseline="DVAex_share")
    assert RegressionDesign("length", baseline="PLy_GVC").depvar == "PLy_GVC"


def test_country_exposure_overview_lists_every_sample_country_taxed_or_not():
    from gvcsim.regression.teaching import MARKET, country_exposure_overview

    source = _source(tuple(f"C{i:02}" for i in range(30)))
    panel = build_teaching_panel(source, _exposure(source))
    overview = country_exposure_overview(panel)
    countries = overview["countries"]
    # Step 10 shows the whole sample before any example: every country once, the market not among them.
    assert sorted(item["country"] for item in countries) == sorted(panel.country.unique())
    assert MARKET not in {item["country"] for item in countries}
    taxed = panel.groupby("country").teaching_tariff_rate_tau.max().gt(0)
    assert overview["taxed_countries"] == int(taxed.sum())
    assert overview["untaxed_countries"] == int((~taxed).sum())
    last = panel.loc[panel.year.eq(overview["year"])]
    for item in countries:
        rows = last.loc[last.country.eq(item["country"]), X_COLUMN]
        assert item["mean_exposure"] == pytest.approx(float(rows.mean()))
        assert item["exposed_industries"] == int(rows.gt(0).sum())
        assert item["taxed"] == bool(taxed[item["country"]])
        if not item["taxed"]:
            assert item["mean_exposure"] == 0
    # Sorted from the highest mean exposure down.
    means = [item["mean_exposure"] for item in countries]
    assert means == sorted(means, reverse=True)
    assert overview["policy_year"] == min(panel.loc[panel.teaching_tariff_rate_tau.gt(0), "year"])


def test_estimate_overview_matches_a_single_run_for_every_baseline():
    from gvcsim.regression.design import RegressionDesign
    from gvcsim.regression.panel import run_design_with_benchmark
    from gvcsim.regression.teaching import BASELINES, available_baselines
    from gvcsim.regression_routes import _estimate_overview

    source = _full_source(tuple(f"C{i:02}" for i in range(30)))
    panel = build_teaching_panel(source, _exposure(source))
    overview = _estimate_overview(panel)
    for outcome, items in overview["outcomes"].items():
        assert [item["key"] for item in items] == [b.key for b in available_baselines(outcome, panel.columns)]
        assert [item["default"] for item in items].count(True) == 1
        assert items[0]["key"] == BASELINES[outcome][0].key and items[0]["default"]
        for item in items:
            # The bar for each Y is the same estimate the run endpoint saves for that Y.
            result, _ = run_design_with_benchmark(panel, RegressionDesign(outcome, teaching=True, baseline=item["key"]))
            coef = result.to_dict()["coefs"][0]
            assert item["coef"] == pytest.approx(coef["coef"])
            assert item["ci_low"] == pytest.approx(coef["ci_low"]) and item["ci_high"] == pytest.approx(coef["ci_high"])


def test_taxed_countries_are_those_with_a_first_year_goods_surplus_with_the_market():
    from gvcsim.regression.teaching import SURPLUS_COLUMN, TAXED_SURPLUS_MIN, market_goods_surplus

    countries = ("AAA", "BBB", "CCC", "DDD")
    source = _source(countries)
    exposure = _exposure(source)
    # Services flows (sector not A–C) and later years do not count towards the goods surplus.
    exposure = pd.concat([exposure, pd.DataFrame([
        {"country": "BBB", "sector": "G", "imposer": "USA", "year": 2016, "export_exposure": 0.1, "bilateral_exports": 9e9},
        {"country": "BBB", "sector": "C10T12", "imposer": "USA", "year": 2017, "export_exposure": 0.1, "bilateral_exports": 9e9},
    ])], ignore_index=True)
    surplus = market_goods_surplus(exposure, 2016)
    assert surplus.to_dict() == {"AAA": 1500.0, "BBB": -500.0, "CCC": 1500.0, "DDD": -500.0}
    panel = build_teaching_panel(source, exposure)
    taxed = panel.groupby("country").teaching_tariff_rate_tau.max().gt(0)
    assert taxed.to_dict() == {country: surplus[country] >= TAXED_SURPLUS_MIN for country in countries}
    assert panel.groupby("country")[SURPLUS_COLUMN].first().to_dict() == surplus.to_dict()


def test_teaching_panel_refuses_exposure_without_bilateral_flows():
    source = _source()
    with pytest.raises(ValueError, match="双边出口额"):
        build_teaching_panel(source, _exposure(source).drop(columns="bilateral_exports"))
