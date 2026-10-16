import pandas as pd
import numpy as np
import pytest

from gvcsim.regression.spec import ModelSpec
from gvcsim.regression.teaching import (
    BETAS,
    EXCHANGE_RATE_COLUMN,
    VERSION,
    WAVE_COLUMN,
    X_COLUMN,
    X_LAG_COLUMNS,
    Y_COLUMNS,
    build_teaching_panel,
    model_snapshot,
)

# The single-X model with unit and year effects (the course model before data v10): tests about the sample flow and
# the binned scatter use it, since they are about one regressor.
SINGLE_X = ModelSpec((0,), (), ("country_industry", "year"))


def _source(countries=("AAA", "BBB", "CCC", "DDD")) -> pd.DataFrame:
    rows = []
    for country in countries:
        for industry_index, industry in enumerate(("C1", "C2", "S3"), 1):
            for year in range(2016, 2021):
                rows.append(
                    {
                        "country": country,
                        "industry": industry,
                        "entity_id": f"{country}_{industry}",
                        "year": year,
                        "log_gdp_proxy": 10.0 + countries.index(country) / 10,
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
    frame["export_exposure"] = frame.sector.map({"C1": 0.4, "C2": 0.1, "S3": 0.8})
    frame.loc[frame.year.gt(2016), "export_exposure"] = 0.02
    frame["bilateral_exports"] = 0.0
    return pd.concat([frame, _goods_flows(sorted(source.country.unique()))], ignore_index=True)


def _goods_flows(countries, surplus=lambda index: (15000.0, 1500.0, -500.0)[index % 3]):
    """Goods flows with the USA (sector C10T12, not in the source panel), in turn a surplus of 15,000 (first wave,
    ≥ 10,000), of 1,500 (second wave, ≥ 1,000) and a deficit (untaxed)."""
    rows = []
    for index, country in enumerate(countries):
        balance = surplus(index)
        to_us, from_us = 2000.0, 2000.0 - balance
        rows.append(
            {
                "country": country,
                "sector": "C10T12",
                "imposer": "USA",
                "year": 2016,
                "export_exposure": 0.5,
                "bilateral_exports": to_us,
            }
        )
        rows.append(
            {
                "country": "USA",
                "sector": "C10T12",
                "imposer": country,
                "year": 2016,
                "export_exposure": 0.1,
                "bilateral_exports": from_us,
            }
        )
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
    # Two waves (v10): the first from 2018, the second from 2019; X is flat once a unit's wave has started.
    start = first[WAVE_COLUMN].map({1: 2018, 2: 2019})
    for wave, year in ((1, 2018), (2, 2019)):
        rows = first.loc[first[WAVE_COLUMN].eq(wave) & first.industry.ne("S3")]
        assert rows.loc[rows.year.lt(year), X_COLUMN].eq(0).all()
        assert rows.loc[rows.year.ge(year)].groupby("entity_id")[X_COLUMN].nunique().eq(1).all()
    post = first.loc[first.year.ge(2018)]
    # One rate per country on its goods industries (C1, C2) in the last year; services (S3) are never taxed (v8).
    goods = first.loc[first.year.eq(2020) & first.industry.str[0].isin(["A", "B", "C"])]
    assert goods.groupby("country").teaching_tariff_rate_tau.nunique().eq(1).all()
    assert set(goods.teaching_tariff_rate_tau) == {0.0, 0.25}
    assert post.loc[post.industry.eq("S3"), ["teaching_tariff_rate_tau", X_COLUMN]].eq(0).all().all()
    # Lags of X are the schedule's earlier rates times w: exact zeros before a unit's wave starts.
    for lag, column in X_LAG_COLUMNS.items():
        taxed = first.industry.ne("S3") & start.notna() & (first.year - lag).ge(start)
        np.testing.assert_array_equal(first[column], first.teaching_export_share_w * 0.25 * taxed)
    assert first.groupby("entity_id")[X_COLUMN].max().eq(0).any()
    assert first.loc[first.industry.eq("C1"), "teaching_export_share_w"].eq(0.4).all()
    assert first.loc[first.industry.eq("S3"), "teaching_export_share_w"].eq(0.8).all()
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
        ("trade", 0.27, 0.30, -0.55, 0.006),
        ("production", 0.19, 0.16, -0.40, 0.005),
        ("length", 3.0, 2.0, -1.8, 0.030),
    ):
        baseline = panel.loc[panel.year.eq(2016)].set_index("entity_id")[OUTCOME_DEPVARS[outcome][0]].rank(pct=True)
        expected = []
        for row in panel.itertuples():
            noise = draw(f"{row.entity_id}|{row.year}", outcome) + draw(
                f"{row.country}|{row.year}", f"cluster-{outcome}"
            )
            # v10: 60% of the relation in the tariff's year, 40% the next; the exchange rate moves Y by
            # −0.0095 × β per point (the tariff's direction). v13: GDP by 0.5 × β per log point (first-wave economies
            # grow 4% a year faster, all 1.5%), openness by −0.006 × β per point (first-wave openness +4 a year), and a
            # common zigzag of 0, 0, −4, +2, −4 noise units.
            effect = 0.6 * getattr(row, X_LAG_COLUMNS[0]) + 0.4 * getattr(row, X_LAG_COLUMNS[1])
            zigzag = {2016: 0.0, 2017: 0.0, 2018: -4.0, 2019: 2.0, 2020: -4.0}[row.year]
            expected.append(
                low
                + span * baseline[row.entity_id]
                + beta * effect
                - 0.0095 * beta * getattr(row, EXCHANGE_RATE_COLUMN)
                + beta
                * (
                    0.5
                    * (
                        0.015 * (row.year - 2016)
                        + 0.04 * (row.year - 2016) * (getattr(row, WAVE_COLUMN) == 1)
                        + 0.025 * draw(f"{row.country}|{row.year}", "macro-growth")
                    )
                    - 0.006
                    * (
                        4 * (row.year - 2016) * (getattr(row, WAVE_COLUMN) == 1)
                        + 4 * draw(f"{row.country}|{row.year}", "openness")
                    )
                )
                + scale * (noise + zigzag)
            )
        np.testing.assert_allclose(panel[Y_COLUMNS[outcome]], expected, rtol=1e-12, atol=1e-12)
    # The exchange-rate change: uniform country × year noise with SD 1 point, minus 8 points for the first wave
    # from 2018.
    for row in panel.drop_duplicates(["country", "year"]).itertuples():
        shift = -8.0 if getattr(row, WAVE_COLUMN) == 1 and row.year >= 2018 else 0.0
        expected_rate = draw(f"{row.country}|{row.year}", "exchange-rate") * 3**0.5 + shift
        assert getattr(row, EXCHANGE_RATE_COLUMN) == pytest.approx(expected_rate, abs=1e-12)
    # v6: the network family's fixed Y is weighted in-degree + out-degree, row by row.
    np.testing.assert_allclose(
        panel[Y_COLUMNS["network"]],
        panel[teaching.y_column("network", "weighted_indegree")]
        + panel[teaching.y_column("network", "weighted_outdegree")],
        rtol=1e-12,
        atol=1e-9,
    )
    snapshot = model_snapshot("trade")
    assert snapshot["version"] == "step10-tariff-teaching-v13"
    assert snapshot["randomization_version"] == "step10-tariff-teaching-v1"
    assert snapshot["tariff_rate"] == 0.25 and snapshot["lag_shares"] == [0.6, 0.4]
    assert [wave["start_year_offset"] for wave in snapshot["taxed_rule"]["waves"]] == [2, 3]
    assert snapshot["exchange_rate"]["first_wave_depreciation"] == -8.0
    assert teaching.SEED == 20260913


def test_invalid_baselines_are_excluded_not_clipped_and_years_are_checked():
    source = _source()
    source.loc[source.entity_id.eq("AAA_C1") & source.year.eq(2016), "FVA_share"] = -0.01
    result = build_teaching_panel(source, _exposure(source))
    assert "AAA_C1" not in set(result.entity_id)
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
            # The course model's headline: the cumulative relation of X and L1.X.
            estimates[outcome].append(result.cumulative.coef)
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
    assert first["source_panel_sha256"] == hashlib.sha256((tmp_path / "panel_industry.csv").read_bytes()).hexdigest()
    assert first["source_read_contract"] == {
        "panel_float_precision": "round_trip",
        "exposure_float_precision": "default",
    }
    row = first["per_seed_results"]["trade:FVA_share"][0]
    assert row["seed"] == 1000
    assert abs(row["cumulative"]["estimate"] + 0.55) == pytest.approx(
        first["summary"]["trade:FVA_share"]["cumulative"]["rmse"]
    )
    assert first["source_exposure"] == {"path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    snapshot = first["generator_snapshots"]["trade"]
    assert snapshot["randomization_version"] == "step10-tariff-teaching-v1"
    assert snapshot["beta"] == -0.55
    assert snapshot["calibration"] == (0.27, 0.30, 0.006)
    assert snapshot["common_year_trend"] == [0.0, 0.0, -4.0, 2.0, -4.0]
    from gvcsim.regression.teaching import simulation_parameters

    assert simulation_parameters()["common_year_trend"]["values"] == snapshot["common_year_trend"]
    assert first["model"] == {
        "x_lags": [0, 1],
        "controls": [
            {"name": name, "lag": 0} for name in (EXCHANGE_RATE_COLUMN, "teaching_log_gdp", "teaching_trade_openness")
        ],
        "fixed_effects": ["country_industry", "year"],
    }
    trade = first["summary"]["trade:FVA_share"]
    assert trade["cumulative"]["target"] == -0.55
    assert trade["x"]["target"] == pytest.approx(-0.33) and trade["lag1"]["target"] == pytest.approx(-0.22)
    assert "trade:FVA_share" in first["independent_benchmark_checks"]
    # Halving w halves X and its lag: with the same noise draws, every X-term error doubles exactly.
    exposure["export_exposure"] *= 0.5
    exposure.to_csv(path, index=False)
    second = evaluate(tmp_path, range(1000, 1001))
    assert first["source_panel_sha256"] == second["source_panel_sha256"]
    assert first["source_exposure"]["sha256"] != second["source_exposure"]["sha256"]
    assert second["summary"]["trade:FVA_share"]["cumulative"]["rmse"] == pytest.approx(
        2 * first["summary"]["trade:FVA_share"]["cumulative"]["rmse"]
    )


def test_macro_controls_are_national_reproducible_and_population_is_not_derived_from_gdp():
    from gvcsim.regression.teaching import GDP_COLUMN, MACRO_CONTROLS, FDI_COLUMN, POPULATION_COLUMN, OPENNESS_COLUMN

    source = _source(tuple(f"C{i:02}" for i in range(30)))
    panel = build_teaching_panel(source, _exposure(source))
    scaled = build_teaching_panel(source.assign(log_gdp_proxy=source.log_gdp_proxy + np.log(2)), _exposure(source))
    for column in MACRO_CONTROLS:
        assert np.isfinite(panel[column]).all()
        assert panel.groupby(["country", "year"])[column].nunique().eq(1).all()
    np.testing.assert_allclose(scaled[GDP_COLUMN] - panel[GDP_COLUMN], np.log(2))
    for column in (POPULATION_COLUMN, OPENNESS_COLUMN, FDI_COLUMN, *Y_COLUMNS.values()):
        np.testing.assert_allclose(scaled[column], panel[column])
    assert panel[POPULATION_COLUMN].lt(0).any()
    assert panel[FDI_COLUMN].lt(0).any()
    assert panel[OPENNESS_COLUMN].gt(100).any() and panel[OPENNESS_COLUMN].gt(0).all()


def test_snapshot_publishes_actual_columns_and_prespecified_parameters():
    snapshot = model_snapshot("network")
    assert snapshot["x_columns"] == [X_COLUMN, X_LAG_COLUMNS[1]]
    assert snapshot["y_column"] == Y_COLUMNS["network"]
    assert snapshot["beta"] == BETAS["network"]
    assert snapshot["controls"] == [EXCHANGE_RATE_COLUMN, "teaching_log_gdp", "teaching_trade_openness"]
    assert snapshot["interactions"] == []
    assert snapshot["fixed_effects"] == ["entity_id", "year"]
    assert model_snapshot("network", spec=SINGLE_X)["x_columns"] == [X_COLUMN]
    assert "课程" in snapshot["disclaimer"] and "模拟" in snapshot["disclaimer"]


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
    assert (row["country"], row["industry"], row["year"]) == ("DDD", "C1", 2020)
    expected = panel.loc[panel.country.eq("DDD") & panel.industry.eq("C1") & panel.year.eq(2020), X_COLUMN].iloc[0]
    assert row[X_COLUMN] == expected
    with pytest.raises(HTTPException) as error:
        asyncio.run(regression_routes.teaching_panel(country="DDD", year=2021, limit=1))
    assert error.value.status_code == 422


def test_step10_series_returns_two_countries_all_years_and_teaching_outcomes(monkeypatch):
    import asyncio
    from gvcsim import regression_routes

    panel = build_teaching_panel(_source(), _exposure(_source()))
    monkeypatch.setattr(regression_routes, "_read_csv", lambda _name: panel)

    response = asyncio.run(regression_routes.teaching_panel(countries="AAA,DDD", industry="C1", limit=200))

    assert response["total"] == 10
    assert {(row["country"], row["industry"]) for row in response["rows"]} == {("AAA", "C1"), ("DDD", "C1")}
    assert {row["year"] for row in response["rows"]} == {2016, 2017, 2018, 2019, 2020}
    assert all(set(Y_COLUMNS.values()).issubset(row) for row in response["rows"])


@pytest.mark.parametrize("has_treated", [True, False])
def test_sample_flow_reconciles_exclusions_and_overlapping_missing_values(has_treated):
    from gvcsim.regression.design import RegressionDesign
    from gvcsim.regression.model import prepare_design_model

    design = RegressionDesign("trade", teaching=True, spec=SINGLE_X)
    frame = pd.DataFrame(
        {
            "country": ["ROW", "A", "B", "C", "D", "E"],
            "entity_id": ["ROW_C1", "A_C1", "B_C1", "C_C1", "D_C1", "E_C1"],
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
    wave = panel.groupby("country")[WAVE_COLUMN].max()
    taxed = wave.gt(0)
    assert result["policy_year"] == 2018 and result["policy_years"] == [2018, 2019]
    assert result["years"] == [2016, 2017, 2018, 2019, 2020]
    assert result["sample"] == {
        "rows": len(panel),
        "entities": panel.entity_id.nunique(),
        "countries": panel.country.nunique(),
        "industries": 3,
        "taxed_countries": int(taxed.sum()),
        "untaxed_countries": int((~taxed).sum()),
        "first_wave_countries": int(wave.eq(1).sum()),
        "second_wave_countries": int(wave.eq(2).sum()),
    }
    assert result["industries"] == sorted(panel.industry.unique())
    groups = (
        ("first", wave[wave.eq(1)].index),
        ("second", wave[wave.eq(2)].index),
        ("untaxed", wave[wave.eq(0)].index),
    )
    for outcome, column in Y_COLUMNS.items():
        assert set(result["outcomes"][outcome]) == {"first", "second", "untaxed"}
        for name, members in groups:
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
    # The course model has three regressors: no single-regressor picture to draw.
    assert run_design_with_benchmark(panel, RegressionDesign("trade", teaching=True))[0].binscatter is None
    result, _benchmark = run_design_with_benchmark(panel, RegressionDesign("trade", teaching=True, spec=SINGLE_X))
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


def _full_source(countries=("AAA", "BBB", "CCC", "DDD")) -> pd.DataFrame:
    """The minimal source panel plus every column an alternative baseline is calibrated from."""
    frame = _source(countries)
    index = frame.industry.map({"C1": 1, "C2": 2, "S3": 3})
    frame["DVAex"] = frame.gross_exports * (0.5 + index / 20)
    frame["FDC"] = frame.gross_exports * (0.02 + index / 100)
    # The other parts of gross exports (v10: they make the domestic-VA export share 1 − FVA share − their share).
    frame["DVArt"] = frame.gross_exports * (0.01 + index / 200)
    frame["DDC"] = frame.gross_exports * 0.02
    frame["taxsub"] = frame.gross_exports * 0.01
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
    assert snapshot["baseline_kind"] == "share" and snapshot["version"] == VERSION
    assert model_snapshot("trade")["baseline"] == "FVA_share"
    with pytest.raises(ValueError):
        model_snapshot("trade", "PLy_GVC")  # a length baseline is not in the trade family
    catalog = variable_catalog("length", "GVCPs")
    assert catalog[-1]["baseline"] == "GVCPs" and "位置" in catalog[-1]["unit"]
    assert variable_catalog("length")[-1]["baseline"] == "PLv_GVC"
    # v10: the domestic-VA export share is 1 − FVA share − the other parts' share, so the two stay below 1.
    share = panel[Y_COLUMNS["trade"]] + panel["teaching_y_trade_DVAex_share"]
    np.testing.assert_allclose(share, 1 - panel["teaching_y_trade_trade_rest_share"], atol=1e-12)
    assert share.lt(1).all()


def test_position_is_generated_length_ratio_without_a_linear_target():
    from gvcsim.regression.teaching import variable_catalog, y_column

    full = _full_source().drop(columns="GVCPs")
    full.loc[full.entity_id.eq("AAA_C1"), "PLy_GVC"] = np.nan
    panel = build_teaching_panel(full, _exposure(full))
    expected = panel[y_column("length", "PLv_GVC")] / panel[y_column("length", "PLy_GVC")]
    np.testing.assert_allclose(panel[y_column("length", "GVCPs")], expected, equal_nan=True)
    assert expected.isna().sum() == 5
    assert model_snapshot("length", "GVCPs")["beta"] is None
    assert "÷" in variable_catalog("length", "GVCPs")[-1]["source"]


def test_out_of_domain_alternative_source_leaves_only_that_y_missing_for_that_unit():
    full = _full_source()
    full.loc[full.entity_id.eq("AAA_C1"), "closnesscentrality"] = -1.0
    # The domestic-VA export share follows the other parts' share (v10), so a unit without them has no such Y.
    full.loc[full.entity_id.eq("BBB_C2"), "DVArt"] = np.nan
    panel = build_teaching_panel(full, _exposure(full))
    assert panel.entity_id.nunique() == 12
    closeness = "teaching_y_network_closnesscentrality"
    assert panel.loc[panel.entity_id.eq("AAA_C1"), closeness].isna().all()
    assert panel.loc[panel.entity_id.ne("AAA_C1"), closeness].notna().all()
    assert panel.loc[panel.entity_id.eq("BBB_C2"), "teaching_y_trade_DVAex_share"].isna().all()
    assert panel.loc[panel.entity_id.ne("BBB_C2"), "teaching_y_trade_DVAex_share"].notna().all()
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
    assert trends["series"]["length"]["GVCPs"]["first"][0]["year"] == 2016
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
    coefficient = result.cumulative
    assert coefficient.ci_low is not None and coefficient.ci_low > 0  # the implied relation is positive
    # v6: 纯国内 = 1 − 简单 GVC − 复杂 GVC − 传统贸易, so its relation is −(−0.30 − 0.40 − 0.30) = 1.0.
    assert abs(coefficient.coef - 1.00) < 0.1
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
        # The mean is over the goods industries (C1, C2): services (S3) are never taxed, so mean X = mean w × τ.
        goods = last.loc[last.country.eq(item["country"]) & last.industry.ne("S3")]
        assert item["mean_exposure"] == pytest.approx(float(goods[X_COLUMN].mean()))
        assert item["mean_exposure"] == pytest.approx(
            float(goods.teaching_export_share_w.mean()) * (0.25 if item["taxed"] else 0.0)
        )
        assert (item["industries"], item["goods_industries"]) == (len(rows), len(goods))
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
            coef = result.to_dict()["cumulative"]
            assert item["coef"] == pytest.approx(coef["coef"])
            assert item["ci_low"] == pytest.approx(coef["ci_low"]) and item["ci_high"] == pytest.approx(coef["ci_high"])


def test_taxed_countries_are_those_with_a_first_year_goods_surplus_with_the_market():
    from gvcsim.regression.teaching import SURPLUS_COLUMN, TAXED_SURPLUS_MIN, market_goods_surplus

    countries = ("AAA", "BBB", "CCC", "DDD")
    source = _source(countries)
    exposure = _exposure(source)
    # Services flows (sector not A–C) and later years do not count towards the goods surplus.
    exposure = pd.concat(
        [
            exposure,
            pd.DataFrame(
                [
                    {
                        "country": "BBB",
                        "sector": "G",
                        "imposer": "USA",
                        "year": 2016,
                        "export_exposure": 0.1,
                        "bilateral_exports": 9e9,
                    },
                    {
                        "country": "BBB",
                        "sector": "C10T12",
                        "imposer": "USA",
                        "year": 2017,
                        "export_exposure": 0.1,
                        "bilateral_exports": 9e9,
                    },
                ]
            ),
        ],
        ignore_index=True,
    )
    surplus = market_goods_surplus(exposure, 2016)
    assert surplus.to_dict() == {"AAA": 15000.0, "BBB": 1500.0, "CCC": -500.0, "DDD": 15000.0}
    panel = build_teaching_panel(source, exposure)
    taxed = panel.groupby("country").teaching_tariff_rate_tau.max().gt(0)
    assert taxed.to_dict() == {country: surplus[country] >= TAXED_SURPLUS_MIN for country in countries}
    assert panel.groupby("country")[SURPLUS_COLUMN].first().to_dict() == surplus.to_dict()
    # Waves by the size of the surplus: ≥ 10,000 first (from 2018), ≥ 1,000 second (from 2019).
    assert panel.groupby("country")[WAVE_COLUMN].first().to_dict() == {"AAA": 1, "BBB": 2, "CCC": 0, "DDD": 1}


def test_teaching_panel_refuses_exposure_without_bilateral_flows():
    source = _source()
    with pytest.raises(ValueError, match="双边出口额"):
        build_teaching_panel(source, _exposure(source).drop(columns="bilateral_exports"))


def test_hidden_identity_parts_are_neither_offered_nor_runnable():
    from gvcsim.regression.design import RegressionDesign
    from gvcsim.regression.teaching import baseline_options, selectable_baselines

    assert [item.key for item in selectable_baselines("trade")] == ["FVA_share", "DVAex_share"]
    assert [option["key"] for option in baseline_options("trade")] == ["FVA_share", "DVAex_share"]
    with pytest.raises(ValueError):
        RegressionDesign("trade", teaching=True, baseline="trade_rest_share")


def test_build_check_reports_out_of_domain_values_and_trade_shares_above_gross_exports():
    from gvcsim.regression.teaching import generated_problems

    full = _full_source()
    panel = build_teaching_panel(full, _exposure(full))
    assert generated_problems(panel) == []
    broken = panel.copy()
    broken.loc[0, Y_COLUMNS["network"]] = -1.0
    broken.loc[1, "teaching_y_trade_DVAex_share"] = 0.99
    problems = generated_problems(broken)
    assert any(Y_COLUMNS["network"] in problem for problem in problems)
    assert any("超过 1" in problem for problem in problems)


def test_country_overview_reports_each_country_wave_and_start_year():
    from gvcsim.regression.teaching import country_exposure_overview

    source = _source(tuple(f"C{i:02}" for i in range(9)))
    overview = country_exposure_overview(build_teaching_panel(source, _exposure(source)))
    assert overview["policy_years"] == [2018, 2019]
    assert [(wave["wave"], wave["start_year"], wave["countries"]) for wave in overview["waves"]] == [
        (1, 2018, 3),
        (2, 2019, 3),
    ]
    for item in overview["countries"]:
        expected = {0: None, 1: 2018, 2: 2019}[item["wave"]]
        assert item["start_year"] == expected and item["taxed"] == (item["wave"] > 0)


def test_a_signed_other_parts_share_is_ranked_not_dropped():
    """taxsub is a signed account: a unit whose other-parts share is negative still gets a domestic-VA export share."""
    full = _full_source()
    full.loc[full.entity_id.eq("AAA_C1"), "taxsub"] = -full.loc[full.entity_id.eq("AAA_C1"), "gross_exports"]
    panel = build_teaching_panel(full, _exposure(full))
    rows = panel.loc[panel.entity_id.eq("AAA_C1")]
    assert rows[["teaching_y_trade_DVAex_share", "teaching_y_trade_trade_rest_share"]].notna().all().all()
    # The generated part keeps its share domain (it is a rank, not the signed source value).
    assert panel["teaching_y_trade_trade_rest_share"].between(0, 1).all()


def test_first_wave_decomposition_splits_the_chart_change_by_the_fitted_coefficients():
    from gvcsim.regression.design import RegressionDesign
    from gvcsim.regression.panel import run_design_with_benchmark
    from gvcsim.regression.teaching import first_wave_decomposition

    source = _source(tuple(f"C{i:02}" for i in range(30)))
    panel = build_teaching_panel(source, _exposure(source))
    result, _ = run_design_with_benchmark(panel, RegressionDesign("trade", method="twfe_intensity", teaching=True))
    coefs = {item.name: item.coef for item in result.coefs}
    split = first_wave_decomposition(panel, Y_COLUMNS["trade"], coefs)
    assert split is not None and split["group"] == "first" and split["wave_start"] == 2018 and split["year"] == 2020
    assert split["pre_years"] == [2016, 2017]
    first = panel[panel[WAVE_COLUMN].eq(1)]
    observed = (
        first[first.year.eq(2020)][Y_COLUMNS["trade"]].mean() - first[first.year.lt(2018)][Y_COLUMNS["trade"]].mean()
    )
    assert split["observed"] == pytest.approx(observed)
    names = [item["name"] for item in split["terms"]]
    assert names[0] == "x_terms" and set(names[1:]) == set(coefs) - set(X_LAG_COLUMNS.values())
    assert split["terms"][1]["label"] == "汇率变动"
    # The X part is each X coefficient times the first wave's change in that regressor, summed.
    x_part = sum(
        coefs[column] * (first[first.year.eq(2020)][column].mean() - first[first.year.lt(2018)][column].mean())
        for column in (X_LAG_COLUMNS[0], X_LAG_COLUMNS[1])
    )
    assert split["terms"][0]["change"] == pytest.approx(x_part)
    assert split["observed"] == pytest.approx(sum(item["change"] for item in split["terms"]) + split["remainder"])
    # A panel without the wave column (another course's fixture) has no decomposition, and no error.
    assert first_wave_decomposition(panel.drop(columns=[WAVE_COLUMN]), Y_COLUMNS["trade"], coefs) is None
    # Root MSE: the residual standard error over the residual degrees of freedom.
    assert result.root_mse is not None and 0 < result.root_mse < result.depvar_within_std
