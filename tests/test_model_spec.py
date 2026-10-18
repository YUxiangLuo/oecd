"""Model specs (steps 11–14 default and the workbench): normalisation, estimation oracle, lags and omissions."""

import itertools
import math

import numpy as np
import pandas as pd
import pytest
from scipy import stats

from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.estimation import CONSTANT, demean_and_prune, within_ols
from gvcsim.regression.model import prepare_design_model
from gvcsim.regression.panel import run_design_with_benchmark
from gvcsim.regression.spec import (
    CONTROLS,
    EXCHANGE_RATE_COLUMN,
    FIXED_EFFECTS,
    X_LAG_COLUMNS,
    ModelSpec,
)
from gvcsim.regression.teaching import X_COLUMN

GOODS = ("A01", "C26", "C29")
SERVICES = ("G", "K")


def _panel(countries: int = 30, seed: int = 20261010) -> pd.DataFrame:
    """A teaching-shaped panel: two tariff waves on goods, X lags from the schedule, four controls, one Y."""
    rng = np.random.default_rng(seed)
    rows = []
    names = [f"C{index:02d}" for index in range(countries)]
    start = {name: (2018 if index % 3 == 0 else 2019 if index % 3 == 1 else None) for index, name in enumerate(names)}
    level = {name: rng.normal() for name in names}
    for country in names:
        for industry in (*GOODS, *SERVICES):
            w = rng.uniform(0.05, 0.6)
            for year in range(2016, 2021):
                row = {"country": country, "industry": industry, "year": year, "entity_id": f"{country}_{industry}"}
                for lag, column in X_LAG_COLUMNS.items():
                    taxed = start[country] is not None and industry in GOODS and year - lag >= start[country]
                    row[column] = w * 0.25 if taxed else 0.0
                row[EXCHANGE_RATE_COLUMN] = rng.normal() - (6.0 if start[country] == 2018 and year >= 2018 else 0.0)
                row["log_gdp_proxy"] = 10 + level[country] + 0.03 * (year - 2016) + 0.05 * rng.normal()
                row["export_intensity"] = 0.4 + 0.1 * level[country] + 0.02 * rng.normal()
                row["manufacturing_va_share"] = 0.2 + 0.01 * rng.normal()
                rows.append(row)
    panel = pd.DataFrame(rows)
    macro_rng = np.random.default_rng(seed + 1)
    for key in ("teaching_log_gdp", "teaching_population_growth", "teaching_trade_openness", "teaching_fdi_gdp"):
        panel[key] = macro_rng.normal(size=len(panel))
    # Country-level controls are one value per country and year.
    for column in CONTROLS:
        panel[column] = panel.groupby(["country", "year"])[column].transform("first")
    unit = panel.groupby("entity_id")["year"].transform(lambda s: rng.normal())
    panel["teaching_y_trade"] = (
        unit
        - 0.33 * panel[X_LAG_COLUMNS[0]]
        - 0.22 * panel[X_LAG_COLUMNS[1]]
        + 0.005 * panel[EXCHANGE_RATE_COLUMN]
        + 0.01 * (panel["year"] - 2016)
        + 0.01 * rng.normal(size=len(panel))
    )
    panel["teaching_treated"] = panel[X_COLUMN].gt(0).astype(int)
    return panel


def _normalised_effect_sets() -> list[tuple[str, ...]]:
    sets = set()
    for size in range(len(FIXED_EFFECTS) + 1):
        for chosen in itertools.combinations(FIXED_EFFECTS, size):
            sets.add(ModelSpec((0,), (), chosen).canonical().fixed_effects)
    return sorted(sets)


X_COMBOS = [combo for size in (1, 2, 3) for combo in itertools.combinations((0, 1, 2), size)]


def test_spec_normalisation_drops_contained_effects_and_orders_terms():
    spec = ModelSpec(
        (1, 0),
        (("log_gdp_proxy", 1), (EXCHANGE_RATE_COLUMN, 0)),
        ("year", "country", "country_industry", "industry"),
    ).canonical()
    assert spec.x_lags == (0, 1)
    assert spec.controls == ((EXCHANGE_RATE_COLUMN, 0), ("log_gdp_proxy", 1))
    assert spec.fixed_effects == ("country_industry", "year")
    assert ModelSpec((0,), (), ("country_year", "year", "country")).canonical().fixed_effects == ("country_year",)
    both = ModelSpec((0,), (), ("country_year", "country_industry", "year", "industry")).canonical()
    assert both.fixed_effects == ("country_industry", "country_year")
    assert (
        spec.summary()
        == "X + L1.X；汇率变动、L1.增加值总额对数；国家×行业 + 年份 FE；显式加入同期汇率；实际省略情况见结果"
    )
    assert "仅加入滞后汇率" in ModelSpec((0, 1), ((EXCHANGE_RATE_COLUMN, 1),), ("year",)).summary()
    for controls in ((), ((EXCHANGE_RATE_COLUMN, 0),), ((EXCHANGE_RATE_COLUMN, 1),)):
        assert "同期汇率由国家×年份 FE 吸收" in ModelSpec((0, 1), controls, ("country_year",)).summary()
    assert ModelSpec.from_dict(spec.to_dict()) == spec


@pytest.mark.parametrize(
    ("spec", "message"),
    [
        (ModelSpec((), (), ()), "至少"),
        (ModelSpec((3,), (), ()), "滞后期"),
        (ModelSpec((0, 0), (), ()), "重复"),
        (ModelSpec((0,), (("macro_log_population", 0),), ()), "不提供的控制变量"),
        (ModelSpec((0,), (("log_gdp_proxy", 0), ("log_gdp_proxy", 1)), ()), "只能放入一次"),
        (ModelSpec((0,), (("log_gdp_proxy", 2),), ()), "控制变量的滞后期"),
        (ModelSpec((0,), (), ("country_month",)), "不提供的固定效应"),
        (ModelSpec((True,), (), ()), "滞后期"),
    ],
)
def test_spec_rejects_what_the_whitelist_does_not_offer(spec, message):
    with pytest.raises(ValueError, match=message):
        spec.canonical()


def test_spec_from_dict_rejects_unknown_shapes():
    with pytest.raises(ValueError, match="只能包含"):
        ModelSpec.from_dict({"x_lags": [0], "controls": [], "fixed_effects": [], "extra": 1})
    with pytest.raises(ValueError, match="name, lag"):
        ModelSpec.from_dict({"x_lags": [0], "controls": [{"name": "log_gdp_proxy"}], "fixed_effects": []})


def _oracle(panel: pd.DataFrame, spec: ModelSpec) -> dict:
    """Explicit dummy-variable OLS with the course's CR1 (fixed-effect rank counted), independent of demeaning."""
    data = panel.copy()
    lagged = {}
    for key, lag in spec.controls:
        if lag:
            earlier = data[["entity_id", "year", key]].assign(year=data["year"] + lag)
            name = f"{key}__lag{lag}"
            data = data.merge(earlier.rename(columns={key: name}), on=["entity_id", "year"], how="left")
            lagged[name] = True
    data["_fe_country_year"] = data["country"] + "|" + data["year"].astype(str)
    regressors = [*spec.x_columns, *spec.control_columns]
    data = data.dropna(subset=["teaching_y_trade", *regressors]).reset_index(drop=True)
    y = data["teaching_y_trade"].to_numpy(float)
    X = data[regressors].to_numpy(float)
    if spec.fixed_effects:
        D = np.column_stack(
            [pd.get_dummies(data[column], dtype=float).to_numpy() for column in spec.fixed_effect_columns]
        )
        rank = np.linalg.matrix_rank(D)
        Xt = X - D @ np.linalg.lstsq(D, X, rcond=None)[0]
        yt = y - D @ np.linalg.lstsq(D, y, rcond=None)[0]
        names = list(regressors)
    else:
        rank = 0
        Xt = np.column_stack([X, np.ones(len(y))])
        yt = y
        names = [*regressors, CONSTANT]
    beta = np.linalg.lstsq(Xt, yt, rcond=None)[0]
    e = yt - Xt @ beta
    bread = np.linalg.inv(Xt.T @ Xt)
    groups = data["country"].to_numpy()
    meat = sum(
        np.outer(Xt[groups == g].T @ e[groups == g], Xt[groups == g].T @ e[groups == g]) for g in np.unique(groups)
    )
    G, n, k = len(np.unique(groups)), len(y), len(names)
    covariance = G / (G - 1) * (n - 1) / (n - k - rank) * bread @ meat @ bread
    weights = np.array([1.0 if name in spec.x_columns else 0.0 for name in names])
    slope = [i for i, name in enumerate(names) if name != CONSTANT]
    b, v = beta[slope], covariance[np.ix_(slope, slope)]
    rss = float(e @ e)
    tss = float(((y - y.mean()) ** 2).sum())
    r2 = 1 - rss / tss
    return {
        "coef": dict(zip(names, beta)),
        "se": dict(zip(names, np.sqrt(np.diag(covariance)))),
        "cumulative": (float(weights @ beta), math.sqrt(float(weights @ covariance @ weights))),
        "r2": r2,
        "r2_adj": 1 - (1 - r2) * (n - 1) / (n - k - rank),
        "r2_within": 1 - rss / (float(yt @ yt) if spec.fixed_effects else tss),
        "f": float(b @ np.linalg.solve(v, b)) / len(slope),
        "n": n,
    }


@pytest.mark.parametrize("effects", _normalised_effect_sets())
@pytest.mark.parametrize("x_lags", X_COMBOS)
def test_estimator_matches_dummy_ols_for_every_effect_set_and_x_combination(effects, x_lags):
    panel = _panel()
    # Country × year effects absorb the country-level controls, so they are only added where they can be estimated.
    controls = () if "country_year" in effects else ((EXCHANGE_RATE_COLUMN, 0), ("log_gdp_proxy", 1))
    spec = ModelSpec(x_lags, controls, effects).canonical()
    design = RegressionDesign("trade", teaching=True, spec=spec)
    model = prepare_design_model(panel, design)
    result = within_ols(model, demean_and_prune(model))
    expected = _oracle(panel, spec)
    assert result.n_obs == expected["n"]
    estimated = {c.name: c for c in result.coefs}
    if result.constant is not None:
        estimated[CONSTANT] = result.constant
    assert set(estimated) == set(expected["coef"])
    for name, coefficient in estimated.items():
        assert coefficient.coef == pytest.approx(expected["coef"][name], abs=1e-9, rel=1e-8)
        assert coefficient.se == pytest.approx(expected["se"][name], abs=1e-10, rel=1e-7)
    assert result.cumulative is not None
    assert result.cumulative.coef == pytest.approx(expected["cumulative"][0], abs=1e-9, rel=1e-8)
    assert result.cumulative.se == pytest.approx(expected["cumulative"][1], abs=1e-10, rel=1e-7)
    assert result.r2 == pytest.approx(expected["r2"], abs=1e-9)
    assert result.r2_adj == pytest.approx(expected["r2_adj"], abs=1e-9)
    assert result.r2_within == pytest.approx(expected["r2_within"], abs=1e-9)
    assert result.f_stat == pytest.approx(expected["f"], rel=1e-6)
    groups = result.n_clusters
    assert result.f_df == [len(result.coefs), groups - 1]
    assert result.cumulative.p == pytest.approx(
        2 * stats.t.sf(abs(result.cumulative.coef / result.cumulative.se), groups - 1)
    )


def test_cumulative_of_the_designed_lag_recovers_both_parts():
    spec = ModelSpec((0, 1), ((EXCHANGE_RATE_COLUMN, 0),), ("country_industry", "year"))
    result, benchmark = run_design_with_benchmark(_panel(60), RegressionDesign("trade", teaching=True, spec=spec))
    coefs = {c.name: c.coef for c in result.coefs}
    assert coefs[X_LAG_COLUMNS[0]] == pytest.approx(-0.33, abs=0.02)
    assert coefs[X_LAG_COLUMNS[1]] == pytest.approx(-0.22, abs=0.02)
    assert result.cumulative.coef == pytest.approx(-0.55, abs=0.02)
    assert benchmark["backend"] == "linearmodels.AbsorbingLS" and benchmark["benchmark_passed"]


@pytest.mark.parametrize(
    "effects", [(), ("country", "industry", "year"), ("industry", "country_year"), ("country_industry", "country_year")]
)
def test_library_benchmark_passes_for_other_effect_sets(effects):
    controls = () if "country_year" in effects else (("export_intensity", 0),)
    spec = ModelSpec((0, 1, 2), controls, effects)
    result, benchmark = run_design_with_benchmark(_panel(), RegressionDesign("trade", teaching=True, spec=spec))
    assert benchmark["benchmark_passed"], benchmark
    assert benchmark["backend"] == ("linearmodels.IV2SLS" if not effects else "linearmodels.AbsorbingLS")
    assert (result.constant is not None) == (not effects)


def test_control_lag_is_matched_on_the_year_not_the_row():
    panel = _panel(12)
    unit = panel["entity_id"].eq("C00_C29")
    gap = panel.loc[~(unit & panel["year"].eq(2018))].reset_index(drop=True)
    spec = ModelSpec((0,), (("log_gdp_proxy", 1),), ("country_industry", "year"))
    model = prepare_design_model(gap, RegressionDesign("trade", teaching=True, spec=spec))
    kept = model.data.loc[model.data["entity_id"].eq("C00_C29"), "year"].tolist()
    # 2016 has no earlier year; 2019's lag would be 2018, which this unit lacks: both rows leave the sample.
    assert kept == [2017, 2020]
    reasons = {item["code"] for item in model.sample_flow["dropped_by_reason"]}
    assert "lag" in reasons


def test_country_year_effects_absorb_country_controls_and_report_them():
    panel = _panel()
    panel.loc[panel.country.eq("C00"), "log_gdp_proxy"] = np.nan
    spec = ModelSpec((0, 1), ((EXCHANGE_RATE_COLUMN, 0), ("log_gdp_proxy", 1)), ("country_industry", "country_year"))
    result, benchmark = run_design_with_benchmark(panel, RegressionDesign("trade", teaching=True, spec=spec))
    omitted = {item["name"]: item for item in result.omitted}
    assert set(omitted) == {EXCHANGE_RATE_COLUMN, "log_gdp_proxy__lag1"}
    assert {item["reason"] for item in omitted.values()} == {"absorbed"}
    assert all("国家×年份" in item["by"] for item in omitted.values())
    assert {c.name for c in result.coefs} == {X_LAG_COLUMNS[0], X_LAG_COLUMNS[1]}
    assert benchmark["benchmark_passed"]
    plain, _ = run_design_with_benchmark(
        panel, RegressionDesign("trade", teaching=True, spec=ModelSpec((0, 1), (), spec.fixed_effects))
    )
    assert result.n_obs == plain.n_obs == len(panel)
    assert result.sample_flow["dropped_rows_total"] == 0
    assert result.cumulative == plain.cumulative


def test_a_model_whose_x_terms_are_all_zero_is_refused():
    panel = _panel(12)
    panel[X_LAG_COLUMNS[2]] = 0.0
    spec = ModelSpec((2,), (), ("country_industry", "year"))
    with pytest.raises(ValueError, match="全为 0"):
        run_design_with_benchmark(panel, RegressionDesign("trade", teaching=True, spec=spec))


def test_observed_panel_designs_cannot_take_a_spec():
    with pytest.raises(ValueError, match="只有教学面板"):
        RegressionDesign("trade", spec=ModelSpec((0,), (), ()))


def test_a_failed_library_check_hides_every_inferential_number(monkeypatch):
    from gvcsim.regression import panel as panel_module
    from gvcsim.report_saved_run import _result_is_reportable
    from gvcsim.regression.service import design_info

    original = panel_module._summarize_benchmark
    monkeypatch.setattr(
        panel_module, "_summarize_benchmark", lambda *args: {**original(*args), "benchmark_passed": False}
    )
    design = RegressionDesign("trade", teaching=True)
    result, benchmark = run_design_with_benchmark(_panel(), design)
    assert not benchmark["benchmark_passed"]
    assert result.status == "invalid_design"
    assert all(c.p is None and c.ci_low is None and c.stars == "" for c in result.coefs)
    assert result.cumulative is not None and result.cumulative.p is None and result.cumulative.ci_low is None
    assert result.f_p is None
    assert result.support["suppress_inference"] is True
    assert any("标准库实现对照" in reason for reason in result.support["reasons"])
    # The step's saved run is then printed as "计算设定有问题", not refused as unreportable.
    assert _result_is_reportable(result.to_dict(), design_info(design))

    no_effects = RegressionDesign("trade", teaching=True, spec=ModelSpec((0, 1), (), ()))
    result, _ = run_design_with_benchmark(_panel(), no_effects)
    assert result.constant is not None and result.constant.p is None


@pytest.mark.parametrize("dropped", [EXCHANGE_RATE_COLUMN, X_COLUMN])
def test_a_regressor_the_library_drops_fails_the_check_instead_of_the_run(monkeypatch, dropped):
    # The library's rank test can call a nearly absorbed regressor absorbed where the course keeps it.
    from gvcsim.regression import panel as panel_module

    original = panel_module._absorbing_estimate

    def without(model, keep, omitted):
        reference = original(model, keep, omitted)
        reference.coefs = [coef for coef in reference.coefs if coef.name != dropped]
        return reference

    monkeypatch.setattr(panel_module, "_absorbing_estimate", without)
    result, benchmark = run_design_with_benchmark(_panel(), RegressionDesign("trade", teaching=True))
    assert benchmark["missing_in_reference"] == [dropped]
    assert not benchmark["benchmark_passed"] and dropped not in {row["name"] for row in benchmark["policy_coefs"]}
    assert any(dropped in note for note in benchmark["notes"])
    assert result.status == "invalid_design" and result.support["suppress_inference"] is True
    assert result.cumulative is not None and result.cumulative.p is None
    assert {coef.name for coef in result.coefs} >= {X_COLUMN, EXCHANGE_RATE_COLUMN}


def test_effects_nested_in_country_split_the_sample_without_a_note():
    spec = ModelSpec((0, 1), (), ("country_industry", "country_year"))
    result, _ = run_design_with_benchmark(_panel(), RegressionDesign("trade", teaching=True, spec=spec))
    assert not any("互不重叠" in note for note in result.notes)


def test_no_x_sum_when_an_x_term_is_omitted():
    panel = _panel(12)
    panel[X_LAG_COLUMNS[2]] = 0.0
    spec = ModelSpec((0, 1, 2), (), ("country_industry", "year"))
    result, _ = run_design_with_benchmark(panel, RegressionDesign("trade", teaching=True, spec=spec))
    assert X_LAG_COLUMNS[2] in {item["name"] for item in result.omitted}
    assert result.cumulative is None


@pytest.mark.parametrize(
    "spec",
    [
        ModelSpec((0, 1.0), (), ("year",)),
        ModelSpec((0,), ((EXCHANGE_RATE_COLUMN, 1.0),), ("year",)),
        ModelSpec((True,), (), ("year",)),
        ModelSpec((0,), ((["x"], 0),), ("year",)),
        ModelSpec((0,), (), ({"a": 1},)),
    ],
)
def test_spec_terms_must_have_their_exact_types(spec):
    with pytest.raises(ValueError):
        spec.canonical()
