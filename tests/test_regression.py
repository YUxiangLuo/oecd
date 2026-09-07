"""面板回归引擎测试:模拟含双向固定效应的数据,检验系数恢复。"""

import numpy as np
import pandas as pd
import pytest
from scipy import stats

from gvcsim import regression_routes, shocks
from gvcsim.regression import panel as panel_module
from gvcsim.data.controls import CONTROL_COLUMNS, MACRO_CONTROL_COLUMNS
from gvcsim.regression.design import (
    CONTROL_MODE_ICIO,
    CONTROL_MODE_MACRO,
    PRICE_MODE_REAL,
    SCENARIO_CONFOUNDED,
    SCENARIO_NOISY,
    RegressionDesign,
)
from gvcsim.regression.panel import (
    _apply_price_mode,
    _attach_baseline_gvc,
    _freeze_baseline_gvc,
    _freeze_treatment_timing,
    _prepare_did_model,
    _prepare_event_model,
    _prepare_fe_model,
    _pretrend_diagnostic,
    benchmark_linearmodels,
    did,
    event_study,
    linearmodels_panel_ols,
    placebo_did_distribution,
    prepare_design_model,
    run_design,
    run_design_with_benchmark,
    twoway_fe,
)

rng = np.random.default_rng(42)


def _simulate_panel(beta: float = -0.5, n_entities: int = 40, n_times: int = 8) -> pd.DataFrame:
    entities = [f"C{i:02d}" for i in range(n_entities)]
    alpha = dict(zip(entities, rng.normal(0, 2, n_entities)))
    lam = dict(zip(range(n_times), rng.normal(0, 1, n_times)))
    rows = []
    for e in entities:
        for t in range(n_times):
            x = rng.normal(0, 1)
            y = beta * x + alpha[e] + lam[t] + rng.normal(0, 0.1)
            rows.append({"country": e, "year": 2000 + t, "x": x, "y": y})
    return pd.DataFrame(rows)


def test_recovers_true_beta():
    df = _simulate_panel(beta=-0.5)
    result = twoway_fe(df, "y", ["x"])
    coef = result.coefs[0]
    assert coef.name == "x"
    assert abs(coef.coef - (-0.5)) < 0.02
    assert coef.se > 0
    assert coef.p < 0.01  # 信噪比很高,必须显著
    critical = stats.t.ppf(0.975, result.n_clusters - 1)
    assert coef.ci_low == pytest.approx(coef.coef - critical * coef.se)
    assert coef.ci_high == pytest.approx(coef.coef + critical * coef.se)
    assert coef.ci_low < -0.5 < coef.ci_high
    assert result.depvar_mean == pytest.approx(df["y"].mean())
    assert result.depvar_std == pytest.approx(df["y"].std(ddof=1))
    assert result.n_entities == 40
    assert result.n_times == 8
    assert result.r2_within > 0.9


def test_null_effect_not_significant():
    df = _simulate_panel(beta=0.0)
    # 噪声放大,x 与 y 无关
    df["y"] = df["y"] + rng.normal(0, 1, len(df))
    result = twoway_fe(df, "y", ["x"])
    assert abs(result.coefs[0].coef) < 0.2


def test_drops_missing_rows():
    df = _simulate_panel()
    df.loc[df.index[:10], "x"] = np.nan
    result = twoway_fe(df, "y", ["x"])
    assert result.n_obs == len(df) - 10


def _regrel_boundary_panel() -> pd.DataFrame:
    local_rng = np.random.default_rng(712)
    rows = []
    for index in range(12):
        for offset in range(5):
            x = local_rng.normal()
            rows.append(
                {
                    "country": f"B{index:02d}",
                    "year": 2000 + offset,
                    "x": x,
                    "control": local_rng.normal(),
                    "y": index * 0.1 + offset * 0.2 - 0.4 * x + local_rng.normal(0, 0.05),
                }
            )
    return pd.DataFrame(rows)


def test_null_outcome_and_control_remain_complete_case_attrition():
    df = _regrel_boundary_panel()
    df.loc[0, "y"] = np.nan
    df.loc[1, "control"] = np.nan

    model = _prepare_fe_model(df, "y", ["x"], controls=["control"])
    result = twoway_fe(df, "y", ["x"], controls=["control"])

    assert result.n_obs == len(df) - 2
    assert model.sample_flow["dropped_rows_total"] == 2
    assert model.sample_flow["missing_by_field"]["y"] == 1
    assert model.sample_flow["missing_by_field"]["control"] == 1
    assert {item["code"] for item in model.sample_flow["dropped_by_reason"]} == {
        "missing_outcome",
        "missing_control",
    }


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda frame: frame.assign(country=np.where(frame.index == 0, " ", frame["country"])), "标识变量"),
        (lambda frame: frame.assign(year=np.where(frame.index == 0, "2000", frame["year"])), "数值变量 year"),
        (lambda frame: frame.assign(year=np.where(frame.index == 0, 2000.5, frame["year"])), "数学整数"),
        (lambda frame: frame.assign(y=np.where(frame.index == 0, "1.2", frame["y"])), "数值变量 y"),
        (lambda frame: frame.assign(x=np.where(frame.index == 0, object(), frame["x"])), "数值变量 x"),
        (lambda frame: frame.assign(x=np.where(frame.index == 0, np.inf, frame["x"])), "数值变量 x"),
        (lambda frame: frame.assign(control=np.where(frame.index == 0, "3", frame["control"])), "数值变量 control"),
    ],
    ids=[
        "blank-entity",
        "string-time",
        "fractional-time",
        "string-outcome",
        "object-regressor",
        "infinite-regressor",
        "string-control",
    ],
)
def test_regrel_runtime_boundary_rejects_nonsemantic_values(mutation, message):
    df = _regrel_boundary_panel()
    with pytest.raises(ValueError, match=message):
        twoway_fe(mutation(df), "y", ["x"], controls=["control"])


def test_regrel_runtime_boundary_rejects_duplicate_keys_constant_outcome_and_inadequate_counts():
    df = _regrel_boundary_panel()
    with pytest.raises(ValueError, match="entity-time 唯一"):
        twoway_fe(pd.concat([df, df.iloc[[0]]], ignore_index=True), "y", ["x"])
    with pytest.raises(ValueError, match="正的有限方差"):
        twoway_fe(df.assign(y=1.0), "y", ["x"])
    with pytest.raises(ValueError, match="至少需要 2 个实体"):
        twoway_fe(df[df["country"] == "B00"], "y", ["x"])
    with pytest.raises(ValueError, match="至少需要 2 个时间期"):
        twoway_fe(df[df["year"] == df["year"].min()], "y", ["x"])


def test_controls_recover_policy_effect_with_confounder():
    rows = []
    beta, gamma = -0.7, 1.3
    years = range(2016, 2022)
    for i in range(50):
        e = f"C{i:02d}"
        fe = rng.normal(0, 1)
        loading = rng.normal(0.5, 0.2)
        for t, year in enumerate(years):
            control = loading * t + rng.normal(0, 0.05)
            x = 0.6 * control + rng.normal(0, 0.2)
            y = beta * x + gamma * control + fe + 0.2 * t + rng.normal(0, 0.03)
            rows.append({"country": e, "year": year, "x": x, "control": control, "y": y})
    df = pd.DataFrame(rows)

    naive = twoway_fe(df, "y", ["x"])
    controlled = twoway_fe(df, "y", ["x"], controls=["control"])

    assert abs(controlled.coefs[0].coef - beta) < 0.05
    assert abs(naive.coefs[0].coef - beta) > 0.2
    assert any(c.name == "control" for c in controlled.coefs)


def test_cluster_inference_rejects_single_cluster():
    df = _simulate_panel(beta=-0.4, n_entities=8, n_times=4)
    df["one_cluster"] = "ALL"
    with pytest.raises(ValueError, match="至少需要 2 个聚类"):
        twoway_fe(df, "y", ["x"], cluster="one_cluster")


def test_collinear_control_is_dropped_but_policy_kept():
    df = _simulate_panel(beta=-0.4)
    df["absorbed_control"] = df["year"] - df["year"].min()
    result = twoway_fe(df, "y", ["x"], controls=["absorbed_control"])
    assert [c.name for c in result.coefs] == ["x"]
    assert any("absorbed_control" in n for n in result.notes)


def test_design_equation_text():
    d = RegressionDesign(outcome="trade")
    assert d.depvar == "FVA_share"
    assert d.granularity == "country_industry"  # 默认粒度已切到行业级
    assert d.method == "did"  # 默认方法已切到 DID
    assert d.exclude_row is True
    assert "排除 ROW" in d.sample_filter
    eq = d.equation()
    assert "ATT^{overall}" in eq and "C_{g,t}" in eq and "g−1" in eq
    eq_c = RegressionDesign(outcome="trade", granularity="country").equation()
    assert "ATT^{overall}" in eq_c and "已处理" not in eq_c

    eq_fe = RegressionDesign(outcome="trade", method="twfe_intensity").equation()
    assert "tariff_shock" in eq_fe
    eq_ev = RegressionDesign(outcome="trade", method="event_study").equation()
    assert "ATT_k" in eq_ev and "C_{g,g+k}" in eq_ev
    eq_inter = RegressionDesign(outcome="trade", interaction=True).equation()
    assert "不支持 cohort-aware 交互" in eq_inter
    eq_ctrl = RegressionDesign(outcome="trade", method="twfe_intensity", control_mode=CONTROL_MODE_ICIO).equation()
    assert "Controls_ct" in eq_ctrl
    macro = RegressionDesign(outcome="trade", control_mode=CONTROL_MODE_MACRO)
    assert set(macro.controls) == set(MACRO_CONTROL_COLUMNS)
    assert "GDP规模" in macro.control_labels["macro_log_gdp_usd"]
    d_sanction = RegressionDesign(outcome="trade", shock_type="sanctions")
    assert d_sanction.shock_col == "sanction_shock"
    assert d_sanction.treated_col == "sanction_treated"
    assert "ATT^{overall}" in d_sanction.equation()
    real = RegressionDesign(outcome="trade", price_mode=PRICE_MODE_REAL)
    assert real.price_mode == PRICE_MODE_REAL
    noisy = RegressionDesign(outcome="trade", scenario=SCENARIO_NOISY)
    assert noisy.scenario_label.startswith("测量误差")


def test_design_panel_spec():
    d = RegressionDesign(outcome="production")
    assert d.panel_file == "panel_industry.csv"
    assert d.entity == "entity_id"
    assert d.cluster == "country"
    d_c = RegressionDesign(outcome="production", granularity="country")
    assert d_c.panel_file == "panel_country.csv"
    assert d_c.entity == d_c.cluster == "country"
    with pytest.raises(ValueError, match="介数中心性恒为 0"):
        RegressionDesign(outcome="network", granularity="country")


def test_cluster_se_differs_from_entity_se():
    """国家×行业面板:entity=国家_行业 做FE,cluster=国家。

    冲击在国家层面共同变动,组内相关会让按国聚类的标准误明显大于
    按个体聚类的标准误;系数本身不受聚类方式影响。
    """
    n_countries, n_sectors, n_times = 20, 6, 6
    rows = []
    for i in range(n_countries):
        c = f"C{i:02d}"
        # 国家层面的共同冲击路径
        shock_path = rng.normal(0, 1, n_times)
        common_noise = rng.normal(0, 0.5, n_times)
        for j in range(n_sectors):
            fe = rng.normal(0, 1)
            for t in range(n_times):
                x = shock_path[t] + rng.normal(0, 0.2)
                y = -0.4 * x + fe + common_noise[t] * 1.0 + rng.normal(0, 0.1)
                rows.append(
                    {
                        "country": c,
                        "entity_id": f"{c}_s{j}",
                        "year": 2015 + t,
                        "x": x,
                        "y": y,
                    }
                )
    df = pd.DataFrame(rows)

    by_country = twoway_fe(df, "y", ["x"], entity="entity_id", cluster="country")
    by_entity = twoway_fe(df, "y", ["x"], entity="entity_id")

    assert by_country.n_entities == n_countries * n_sectors
    assert by_country.n_clusters == n_countries
    assert by_entity.n_clusters == n_countries * n_sectors
    assert by_country.coefs[0].coef == pytest.approx(by_entity.coefs[0].coef)
    assert abs(by_country.coefs[0].coef - (-0.4)) < 0.05
    # 按国聚类应给出更保守(更大)的标准误
    assert by_country.coefs[0].se > by_entity.coefs[0].se


# ---------------------------------------------------------------------------
# DID / 事件研究
# ---------------------------------------------------------------------------


def _simulate_did_panel(
    effects: dict[int, float], t0: int = 2018, n_entities: int = 60, years=range(2016, 2021)
) -> pd.DataFrame:
    """处理组(前一半个体)在 t0 起获得 effects[k](k=年份-t0)的处理效应。"""
    rows = []
    for i in range(n_entities):
        e = f"E{i:02d}"
        is_treated = i < n_entities // 2
        fe = rng.normal(0, 2)
        for y in years:
            k = y - t0
            effect = effects.get(k, 0.0) if is_treated else 0.0
            rows.append(
                {
                    "country": e,
                    "year": y,
                    "y": fe + 0.3 * (y - 2016) + effect + rng.normal(0, 0.05),
                    "treated": int(is_treated and k >= 0),
                }
            )
    return pd.DataFrame(rows)


def test_did_recovers_average_change():
    """处理后恒定效应 -0.6:DID 系数应恢复设定的平均变化。"""
    df = _simulate_did_panel({0: -0.6, 1: -0.6, 2: -0.6})
    result = did(df, "y")
    c = result.coefs[0]
    assert c.name == "treated×post"
    assert abs(c.coef - (-0.6)) < 0.03
    assert c.p < 0.01
    assert any("首次冲击年 G_i" in n for n in result.notes)
    assert any("2018:30" in n for n in result.notes)
    assert any("t(" in n and "小样本校正" in n for n in result.notes)


def test_did_requires_treated_rows():
    df = _simulate_did_panel({})
    df["treated"] = 0
    with pytest.raises(ValueError):
        did(df, "y")


def test_entity_specific_did_uses_each_entity_first_treatment_year():
    rows = []
    years = range(2016, 2021)
    for i in range(90):
        e = f"E{i:02d}"
        first = 2018 if i < 30 else 2019 if i < 60 else None
        fe = rng.normal(0, 1)
        for year in years:
            post = first is not None and year >= first
            rows.append(
                {
                    "country": e,
                    "year": year,
                    "y": fe + 0.2 * (year - 2016) - 0.6 * float(post) + rng.normal(0, 0.02),
                    "treated": int(post),
                }
            )
    df = pd.DataFrame(rows)

    design = RegressionDesign(outcome="trade", granularity="country")
    model = prepare_design_model(df.rename(columns={"y": "FVA_share"}), design)
    e2019_pre = model.data[(model.data["country"] == "E30") & (model.data["year"] == 2018)]
    e2019_at = model.data[(model.data["country"] == "E30") & (model.data["year"] == 2019)]
    assert e2019_pre["treated×post"].iloc[0] == 0
    assert e2019_at["treated×post"].iloc[0] == 1

    result = did(df, "y")
    assert result.coefs[0].coef == pytest.approx(-0.6, abs=0.04)
    assert any("2018:30" in n and "2019:30" in n for n in result.notes)


def test_event_study_dynamic_path():
    """动态效应 0.2→0.5→0.8:事件研究应恢复路径,且前趋势系数≈0。"""
    effects = {0: 0.2, 1: 0.5, 2: 0.8}
    df = _simulate_did_panel(effects)
    result = event_study(df, "y")

    by_name = {c.name: c for c in result.coefs}
    # 基期 k=-1(2017)被省略;其余 4 年各一个系数
    assert set(by_name) == {"k=-2", "k=0", "k=+1", "k=+2"}
    # 冲击前系数接近 0
    assert abs(by_name["k=-2"].coef) < 0.05
    # 处理后动态路径
    for name, true_val in [("k=0", 0.2), ("k=+1", 0.5), ("k=+2", 0.8)]:
        assert abs(by_name[name].coef - true_val) < 0.05, name
    assert by_name["k=+2"].p < 0.01
    pretrend = result.diagnostics["pretrend"]
    assert pretrend["available"] is True
    assert pretrend["terms"] == ["k=-2"]
    assert pretrend["p"] > 0.05
    assert "不能" in pretrend["interpretation"]


def _reg01_staggered_panel(late_cohort: int = 11) -> pd.DataFrame:
    rows = []
    n_early = 13
    n_treated = n_early + late_cohort
    for i in range(n_treated + 12):
        country = f"R{i:02d}"
        first = 2019 if i < n_early else 2020 if i < n_treated else None
        for year in range(2016, 2023):
            post = first is not None and year >= first
            rows.append(
                {
                    "country": country,
                    "year": year,
                    "treated": int(post),
                    "y": (
                        i * 0.013
                        + (year - 2016) * 0.1
                        + (i % 3) * (year - 2016) * 0.001
                        - int(post) * (0.2 + i * 0.003)
                    ),
                    "control": (i % 4) * (year - 2015) * 0.002,
                    "3_VA_GVC_share": 0.1 + i * 0.005,
                }
            )
    return pd.DataFrame(rows)


@pytest.mark.parametrize(("late_cohort", "supported"), [(11, False), (12, True)])
def test_reg01_event_period_boundary_is_eleven_vs_exactly_twelve_clusters(late_cohort, supported):
    result = event_study(_reg01_staggered_panel(late_cohort), "y")
    period = next(item for item in result.event_support["periods"] if item["term"] == "k=-4")
    coefficient = next(item for item in result.coefs if item.name == "k=-4")

    assert period["contributing_clusters"] == late_cohort
    assert period["contributing_entities"] == late_cohort
    assert period["cohorts"] == {"2020": late_cohort}
    assert period["period_supported"] is supported
    assert period["inference_supported"] is supported
    assert (coefficient.p is not None) is supported
    assert (coefficient.ci_low is not None) is supported
    assert coefficient.se > 0 and np.isfinite(coefficient.t)
    assert coefficient.stars == (coefficient.stars if supported else "")


def test_reg01_staggered_thin_leads_are_local_and_excluded_from_pretrend():
    result = event_study(_reg01_staggered_panel(), "y")
    by_name = {coefficient.name: coefficient for coefficient in result.coefs}

    assert result.status == "ok"
    assert by_name["k=-4"].p is None
    assert by_name["k=-3"].ci_low is not None
    assert by_name["k=-2"].p is not None
    assert by_name["k=0"].p is not None
    diagnostic = result.diagnostics["pretrend"]
    assert diagnostic["available"] is True
    assert diagnostic["terms"] == ["k=-3", "k=-2"]
    assert [item["term"] for item in diagnostic["excluded_terms"]] == ["k=-4"]
    assert "已排除" in diagnostic["interpretation"]
    serialized = result.to_dict()["event_support"]
    assert serialized["policy_is_statistical_theorem"] is False
    assert serialized["cluster"] == "country"
    assert serialized["reference_term"] == "k=-1"
    assert serialized["min_contributing_clusters"] == 12
    assert next(item for item in serialized["periods"] if item["term"] == "k=-1")["estimated"] is False


def test_reg01_single_cluster_remote_lead_is_point_only_without_aborting_public_event_study():
    frame = _reg01_staggered_panel(late_cohort=1).rename(columns={"y": "FVA_share"})
    frame["tariff_shock"] = frame["treated"] * 0.02
    design = RegressionDesign(outcome="trade", granularity="country", method="event_study")

    result, benchmark = run_design_with_benchmark(frame, design)

    by_name = {coefficient.name: coefficient for coefficient in result.coefs}
    thin = next(item for item in result.event_support["periods"] if item["term"] == "k=-4")
    assert thin["contributing_clusters"] == 1
    assert thin["inference_supported"] is False
    assert by_name["k=-4"].coef is not None
    assert by_name["k=-4"].se is None and by_name["k=-4"].t is None
    assert by_name["k=-4"].p is None and by_name["k=-4"].ci_low is None
    assert by_name["k=0"].se is not None and by_name["k=0"].p is not None
    diagnostic = result.diagnostics["pretrend"]
    assert "k=-4" not in diagnostic["terms"]
    assert "k=-4" in {item["term"] for item in diagnostic["excluded_terms"]}
    audit = next(item for item in benchmark["policy_coefs"] if item["name"] == "k=-4")
    assert audit["own_se"] is None and audit["audit_se"] is None
    assert benchmark["benchmark_passed"] is True


def test_reg01_zero_jackknife_variation_returns_invalid_point_only_result_instead_of_crashing():
    rows = []
    for index in range(30):
        country = f"Z{index:02d}"
        first = 2020 if index == 0 else 2018 if index < 12 else None
        for year in range(2016, 2023):
            post = first is not None and year >= first
            rows.append(
                {
                    "country": country,
                    "year": year,
                    "FVA_share": index * 0.01 + (year - 2016) * 0.1 + (0.2 if post else 0.0),
                    "tariff_shock": 0.02 if post else 0.0,
                    "treated": int(post),
                }
            )
    design = RegressionDesign(outcome="trade", granularity="country", method="event_study")

    result, benchmark = run_design_with_benchmark(pd.DataFrame(rows), design)

    thin = next(coefficient for coefficient in result.coefs if coefficient.name == "k=-4")
    assert thin.se is None and thin.p is None
    assert result.status == "invalid_design"
    assert result.support["suppress_inference"] is True
    assert all(coefficient.p is None and coefficient.ci_low is None for coefficient in result.coefs)
    assert benchmark["benchmark_passed"] is False
    assert any("jackknife 变异" in reason for reason in result.status_reasons)


def test_reg01_thin_reference_suppresses_all_event_and_marginal_inference():
    df = _reg01_staggered_panel()
    for i in range(13):
        df.loc[(df["country"] == f"R{i:02d}") & (df["year"] == 2018), "y"] = np.nan
    result = event_study(df, "y", interaction=True)
    reference = next(item for item in result.event_support["periods"] if item["is_reference"])

    assert reference["contributing_clusters"] == 11
    assert reference["period_supported"] is False
    assert all(coefficient.p is None for coefficient in result.coefs if coefficient.name.startswith("k="))
    assert all(effect["p"] is None and effect["ci_low"] is None for effect in result.marginal_effects)
    assert any(
        "insufficient_reference_clusters" in period["reason_codes"]
        for period in result.event_support["periods"]
        if period["estimated"]
    )


def test_reg01_interaction_inherits_main_period_and_industry_clusters_are_deduplicated():
    df = _reg01_staggered_panel()
    result = event_study(df, "y", interaction=True)
    by_name = {coefficient.name: coefficient for coefficient in result.coefs}
    assert by_name["k=-4"].p is None and by_name["k=-4×base_gvc"].p is None
    assert by_name["k=0"].p is not None and by_name["k=0×base_gvc"].p is not None
    assert all(effect["p"] is None for effect in result.marginal_effects if effect["policy_term"] == "k=-4")
    assert all(effect["p"] is not None for effect in result.marginal_effects if effect["policy_term"] == "k=0")
    tests = result.diagnostics["pretrend_tests"]
    assert set(tests) == {"main", "interaction", "joint"}
    assert [item["term"] for item in tests["main"]["excluded_terms"]] == ["k=-4"]
    assert [item["term"] for item in tests["interaction"]["excluded_terms"]] == ["k=-4×base_gvc"]
    assert {item["term"] for item in tests["joint"]["excluded_terms"]} == {
        "k=-4",
        "k=-4×base_gvc",
    }
    assert result.diagnostics["pretrend"] == tests["joint"]

    industry = pd.concat(
        [df.assign(entity_id=df["country"] + "_A"), df.assign(entity_id=df["country"] + "_B")],
        ignore_index=True,
    )
    model = _prepare_event_model(industry, "y", entity="entity_id", cluster="country")
    thin = next(item for item in model.event_support["periods"] if item["term"] == "k=-4")
    assert thin["contributing_rows"] == 22
    assert thin["contributing_entities"] == 22
    assert thin["contributing_clusters"] == 11
    assert thin["inference_supported"] is False


def test_reg01_support_uses_final_rows_frozen_timing_and_is_order_invariant():
    df = _reg01_staggered_panel()
    # Remove one thin-period outcome row after G_i has been frozen from the valid shock history.
    df.loc[(df["country"] == "R13") & (df["year"] == 2016), "y"] = np.nan
    first = _prepare_event_model(df, "y")
    shuffled = _prepare_event_model(df.sample(frac=1, random_state=19), "y")
    first_thin = next(item for item in first.event_support["periods"] if item["term"] == "k=-4")
    shuffled_thin = next(item for item in shuffled.event_support["periods"] if item["term"] == "k=-4")
    assert first.timing.first_by_entity["R13"] == 2020
    assert first_thin == shuffled_thin
    assert first_thin["contributing_clusters"] == 10


def test_reg01_numeric_entity_ids_preserve_frozen_cohort_composition():
    df = _reg01_staggered_panel()
    numeric_ids = {country: index for index, country in enumerate(df["country"].unique())}
    df["country"] = df["country"].map(numeric_ids)
    model = _prepare_event_model(df, "y")
    thin = next(item for item in model.event_support["periods"] if item["term"] == "k=-4")

    assert thin["contributing_entities"] == 11
    assert thin["contributing_clusters"] == 11
    assert thin["cohorts"] == {"2020": 11}


def test_reg02_sparse_global_support_suppresses_pretrend_before_period_gate():
    df = _simulate_did_panel({0: -0.3, 1: -0.3, 2: -0.3}, n_entities=8)
    df["control"] = [(i % 3) * (year - 2015) for i, year in enumerate(df["year"])]
    result = event_study(df, "y", controls=["control"])
    diagnostic = result.diagnostics["pretrend"]
    assert result.status == "insufficient"
    assert result.support["suppress_inference"] is True
    assert diagnostic["available"] is False
    assert diagnostic["reason"] == "global_inference_suppressed"
    assert diagnostic["support_status"] == "insufficient"
    assert diagnostic["statistic"] is None and diagnostic["p"] is None
    assert diagnostic["df_num"] == 0
    assert diagnostic["terms"] == []
    assert diagnostic["excluded_terms"][0]["term"] == "k=-2"
    assert "未执行" in diagnostic["interpretation"]
    assert "不能说明冲击前趋势" in diagnostic["interpretation"]
    # The whole-run gate has priority and therefore suppresses the control as well.
    assert all(coefficient.p is None for coefficient in result.coefs)


def test_reg02_invalid_global_gate_suppresses_pretrend_with_all_local_periods_supported():
    df = _reg01_staggered_panel(late_cohort=12)
    treated_countries = {f"R{i:02d}" for i in range(12)}
    # A one-year policy reversal makes the absorbing design invalid without thinning any event-time cell.
    df.loc[df["country"].isin(treated_countries) & (df["year"] == 2021), "treated"] = 0
    result = event_study(df, "y")
    diagnostic = result.diagnostics["pretrend"]

    assert result.status == "invalid_design"
    assert result.support["suppress_inference"] is True
    assert all(period["period_supported"] for period in result.event_support["periods"])
    assert all(period["inference_supported"] for period in result.event_support["periods"])
    assert all(coefficient.p is None and coefficient.ci_low is None for coefficient in result.coefs)
    assert diagnostic["available"] is False
    assert diagnostic["reason"] == "global_inference_suppressed"
    assert diagnostic["support_status"] == "invalid_design"
    assert diagnostic["terms"] == [] and diagnostic["df_num"] == 0
    assert diagnostic["statistic"] is None and diagnostic["p"] is None
    assert {item["term"] for item in diagnostic["excluded_terms"]} == {"k=-4", "k=-3", "k=-2"}
    assert all(item["reasons"] for item in diagnostic["excluded_terms"])


def test_reg02_global_suppression_precedes_covariance_for_every_interaction_scope():
    df = _simulate_did_panel({0: -0.3, 1: -0.3, 2: -0.3}, n_entities=8)
    df["3_VA_GVC_share"] = np.tile(np.linspace(0.1, 0.8, 8), 5)
    result = event_study(df, "y", interaction=True)

    tests = result.diagnostics["pretrend_tests"]
    assert set(tests) == {"main", "interaction", "joint"}
    assert result.diagnostics["pretrend"] == tests["joint"]
    for scope, diagnostic in tests.items():
        assert diagnostic["scope"] == scope
        assert diagnostic["available"] is False
        assert diagnostic["reason"] == "global_inference_suppressed"
        assert diagnostic["terms"] == []
        assert diagnostic["statistic"] is None and diagnostic["p"] is None
        assert diagnostic["excluded_terms"]


def test_reg02_reversal_stops_pretrend_even_when_its_share_is_small():
    df = _reg01_staggered_panel(late_cohort=12)
    # Any reversal is incompatible with the absorbing design.
    df.loc[(df["country"] == "R00") & (df["year"] == 2021), "treated"] = 0
    result = event_study(df, "y")
    diagnostic = result.diagnostics["pretrend"]

    assert result.status == "invalid_design"
    assert result.support["suppress_inference"] is True
    assert diagnostic["available"] is False
    assert diagnostic["statistic"] is None and diagnostic["p"] is None


def test_interaction_pretrend_main_can_pass_while_interaction_and_joint_reject():
    local_rng = np.random.default_rng(2027)
    rows = []
    years = range(2016, 2023)
    for index in range(80):
        country = f"I{index:02d}"
        first = 2019 if index < 40 else None
        baseline = 0.1 + 0.8 * ((index % 40) / 39)
        entity_effect = local_rng.normal(0, 0.4)
        for year in years:
            event_time = year - first if first is not None else None
            pre_interaction = 1.2 * (baseline - 0.5) if event_time == -2 else 0.0
            rows.append(
                {
                    "country": country,
                    "year": year,
                    "treated": int(first is not None and year >= first),
                    "3_VA_GVC_share": baseline,
                    "y": entity_effect + 0.08 * (year - 2016) + pre_interaction + local_rng.normal(0, 0.04),
                }
            )
    result = event_study(pd.DataFrame(rows), "y", interaction=True)
    tests = result.diagnostics["pretrend_tests"]

    assert tests["main"]["available"] is True
    assert tests["main"]["p"] > 0.05
    assert tests["interaction"]["available"] is True
    assert tests["interaction"]["p"] < 0.05
    assert tests["joint"]["available"] is True
    assert tests["joint"]["p"] < 0.05
    assert result.diagnostics["pretrend"] == tests["joint"]


def test_interaction_joint_pretrend_counts_event_times_not_restrictions():
    diagnostics = _pretrend_diagnostic(
        ["k=-2", "k=-2×base_gvc"],
        np.zeros(2),
        np.eye(2),
        n_clusters=20,
    )
    joint = diagnostics["pretrend_tests"]["joint"]

    assert joint["df_num"] == 2
    assert joint["terms"] == ["k=-2", "k=-2×base_gvc"]
    assert "只有 1 个受支持的冲击前时期" in joint["interpretation"]
    assert "共 2 条联合限制" in joint["interpretation"]
    assert "覆盖 2 个受支持的冲击前时期" not in joint["interpretation"]


def test_diagnostic_scope_refactor_does_not_change_event_coef_se_or_t(monkeypatch):
    df = _reg01_staggered_panel(late_cohort=6)
    baseline = event_study(df, "y", interaction=True)
    monkeypatch.setattr(
        panel_module,
        "_pretrend_diagnostic",
        lambda *_args, **_kwargs: {"pretrend": {"available": False}, "pretrend_tests": {}},
    )
    without_diagnostics = event_study(df, "y", interaction=True)

    expected = {coefficient.name: coefficient for coefficient in baseline.coefs}
    actual = {coefficient.name: coefficient for coefficient in without_diagnostics.coefs}
    assert set(actual) == set(expected)
    for name in expected:
        assert actual[name].coef == pytest.approx(expected[name].coef, abs=1e-14)
        assert actual[name].se == pytest.approx(expected[name].se, abs=1e-14)
        assert actual[name].t == pytest.approx(expected[name].t, abs=1e-14)


def test_pretrend_diagnostic_rejects_too_many_restrictions_for_cluster_df():
    diagnostic = _pretrend_diagnostic(
        ["k=-3", "k=-2", "k=0"],
        np.array([8.0, 0.0, 0.0]),
        np.diag([0.01, 0.01, 0.01]),
        n_clusters=2,
    )["pretrend"]
    assert diagnostic["available"] is False
    assert diagnostic["reason"] == "insufficient_cluster_df"
    assert diagnostic["p"] is None
    assert "不可评估" in diagnostic["interpretation"]


def test_pretrend_diagnostic_rejects_singular_restriction_covariance():
    diagnostic = _pretrend_diagnostic(
        ["k=-2", "k=0"],
        np.array([5.0, 0.0]),
        np.diag([0.0, 0.01]),
        n_clusters=20,
    )["pretrend"]
    assert diagnostic["available"] is False
    assert diagnostic["reason"] == "singular_covariance"
    assert diagnostic["p"] is None
    assert "不得据此判断没有" in diagnostic["interpretation"]


def test_event_study_rejects_sample_without_any_true_preperiod():
    df = _simulate_did_panel({0: 0.2, 1: 0.3}, years=range(2018, 2020))
    with pytest.raises(ValueError, match=r"k<0"):
        event_study(df, "y")


def test_event_study_uses_nearest_negative_base_and_serializes_base_k():
    df = _simulate_did_panel({0: 0.2, 1: 0.3, 2: 0.4})
    df.loc[(df["year"] == 2017) & df["country"].str.startswith("E"), "y"] = np.nan
    # Frozen treatment timing still comes from the complete shock history; after
    # outcome attrition k=-2 is the nearest observed negative event period.
    result = event_study(df, "y")
    assert result.event_support["base_k"] == -2
    assert result.event_support["reference_term"] == "k=-2"
    reference = next(period for period in result.event_support["periods"] if period["is_reference"])
    assert reference["event_time"] == -2
    assert reference["term"] == "k=-2"


def test_event_study_without_estimable_preperiod_reports_unavailable():
    df = _simulate_did_panel({0: 0.2, 1: 0.3, 2: 0.4}, years=range(2017, 2021))
    result = event_study(df, "y")
    pretrend = result.diagnostics["pretrend"]
    assert pretrend["available"] is False
    assert pretrend["p"] is None
    assert "无法评估" in pretrend["interpretation"]


def test_design_regressions_exclude_row_by_default():
    df = _simulate_did_panel({0: -0.5, 1: -0.5, 2: -0.5}).rename(columns={"y": "FVA_share"})
    row_rows = []
    for year in range(2016, 2021):
        row_rows.append(
            {
                "country": "ROW",
                "year": year,
                "FVA_share": 999.0 if year >= 2018 else -999.0,
                "treated": int(year >= 2018),
            }
        )
    df = pd.concat([df, pd.DataFrame(row_rows)], ignore_index=True)

    design = RegressionDesign(outcome="trade", granularity="country")
    model = prepare_design_model(df, design)
    assert "ROW" not in set(model.data["country"])
    result = run_design(df, design)
    assert result.n_entities == 60
    assert result.n_clusters == 60
    assert any("排除 ROW" in n for n in result.notes)

    included = prepare_design_model(df, RegressionDesign(outcome="trade", granularity="country", exclude_row=False))
    assert "ROW" in set(included.data["country"])


def test_run_design_dispatch():
    """run_design 按 method 分发到正确引擎(从系数名可辨认)。"""
    df = _simulate_did_panel({0: -0.5, 1: -0.5, 2: -0.5})
    df["entity_id"] = df["country"]
    df["tariff_shock"] = df["treated"] * 0.1

    def names(method):
        design = RegressionDesign(outcome="trade", granularity="country", method=method)
        r = run_design(df.rename(columns={"y": design.depvar}), design)
        return [c.name for c in r.coefs]

    assert names("did") == ["treated×post"]
    assert names("twfe_intensity") == ["tariff_shock"]
    assert names("event_study") == ["k=-2", "k=0", "k=+1", "k=+2"]


def test_public_staggered_estimators_use_cohort_time_att_and_not_yet_treated_controls():
    rows = []
    for index in range(40):
        country = f"C{index:02d}"
        first = 2018 if index < 12 else 2019 if index < 24 else None
        effect = 1.0 if index < 12 else 3.0
        for year in range(2016, 2021):
            treated = first is not None and year >= first
            rows.append(
                {
                    "country": country,
                    "year": year,
                    "FVA_share": (
                        0.05 * index
                        + 0.1 * (year - 2016)
                        + 0.001 * ((index * 7 + year * 3) % 11)
                        + (effect if treated else 0.0)
                    ),
                    "tariff_shock": 0.02 if treated else 0.0,
                    "treated": int(treated),
                }
            )
    frame = pd.DataFrame(rows)

    did_result, did_audit = run_design_with_benchmark(
        frame, RegressionDesign(outcome="trade", granularity="country", method="did")
    )
    did_coef = next(coefficient for coefficient in did_result.coefs if coefficient.name == "treated×post")
    assert did_result.diagnostics["estimator"] == "cohort_time_att_not_yet_treated"
    assert did_audit["backend"] == "cohort_time_cell_reaggregation_and_jackknife_formula_audit"
    assert did_audit["benchmark_passed"] is True
    assert did_coef.coef == pytest.approx(1.8, abs=0.02)
    assert did_coef.se > 0 and did_coef.ci_low is not None

    event_result, event_audit = run_design_with_benchmark(
        frame, RegressionDesign(outcome="trade", granularity="country", method="event_study")
    )
    by_name = {coefficient.name: coefficient for coefficient in event_result.coefs}
    assert event_audit["benchmark_passed"] is True
    assert by_name["k=0"].coef == pytest.approx(2.0, abs=0.02)
    assert by_name["k=+1"].coef == pytest.approx(2.0, abs=0.02)
    assert by_name["k=+2"].coef == pytest.approx(1.0, abs=0.02)
    assert abs(by_name["k=-2"].coef) < 0.02
    assert did_audit["policy_coefs"][0]["audit_coef"] == pytest.approx(did_coef.coef)
    assert did_audit["policy_coefs"][0]["audit_se"] == pytest.approx(did_coef.se)


def test_public_thin_support_keeps_cohort_time_point_without_legacy_twfe_fallback():
    rows = []
    for index in range(20):
        country = f"T{index:02d}"
        first = 2018 if index == 0 else 2019 if index == 1 else None
        effect = 1.0 if index == 0 else 3.0
        for year in range(2016, 2021):
            treated = first is not None and year >= first
            rows.append(
                {
                    "country": country,
                    "year": year,
                    "FVA_share": 0.03 * index + 0.1 * (year - 2016) + (effect if treated else 0.0),
                    "tariff_shock": 0.02 if treated else 0.0,
                    "treated": int(treated),
                }
            )
    frame = pd.DataFrame(rows)
    design = RegressionDesign(outcome="trade", granularity="country", method="did")

    result, audit = run_design_with_benchmark(frame, design)
    coefficient = next(item for item in result.coefs if item.name == "treated×post")

    assert result.status == "insufficient"
    assert result.diagnostics["estimator"] == "cohort_time_att_not_yet_treated"
    assert coefficient.coef == pytest.approx(1.8)
    assert coefficient.se is None and coefficient.t is None
    assert coefficient.p is None and coefficient.ci_low is None and coefficient.ci_high is None
    assert audit["backend"] == "cohort_time_cell_reaggregation_point_audit"
    assert audit["coef_check_passed"] is True
    assert audit["se_check_passed"] is False
    assert audit["policy_coefs"][0]["audit_coef"] == pytest.approx(coefficient.coef)
    assert any("绝不回退" in note for note in result.notes)


def test_cohort_time_arithmetic_audit_can_fail_closed(monkeypatch):
    frame = pd.DataFrame(
        [
            {
                "country": f"A{index:02d}",
                "year": year,
                "FVA_share": 0.01 * index + 0.1 * (year - 2016) + (0.5 if index < 12 and year >= 2018 else 0.0),
                "tariff_shock": 0.02 if index < 12 and year >= 2018 else 0.0,
                "treated": int(index < 12 and year >= 2018),
            }
            for index in range(24)
            for year in range(2016, 2021)
        ]
    )
    original = panel_module._reaggregate_cohort_time_cells

    def corrupted(cells, terms):
        values = original(cells, terms)
        return {term: value + 0.01 for term, value in values.items()}

    monkeypatch.setattr(panel_module, "_reaggregate_cohort_time_cells", corrupted)
    with pytest.raises(ValueError, match="算术复核失败"):
        run_design_with_benchmark(
            frame,
            RegressionDesign(outcome="trade", granularity="country", method="did"),
        )


def test_placebo_cohort_points_do_not_run_cluster_jackknife(monkeypatch):
    frame = _simulate_did_panel({0: -0.6, 1: -0.6, 2: -0.6}).rename(columns={"y": "FVA_share"})

    def forbidden(*_args, **_kwargs):
        raise AssertionError("placebo point estimates must not run the full cluster jackknife")

    monkeypatch.setattr(panel_module, "_cohort_time_result", forbidden)
    result = placebo_did_distribution(
        frame,
        RegressionDesign(outcome="trade", granularity="country", method="did"),
        n_draws=10,
        seed=17,
    )

    assert result["n_draws"] == 10
    assert result["estimator"] == "cohort_time_att_not_yet_treated"


def test_teaching_scenarios_add_expected_notes_and_pretrend():
    df = _simulate_did_panel({0: -0.5, 1: -0.5, 2: -0.5})
    df = df.rename(columns={"y": "FVA_share"})

    noisy = run_design(
        df,
        RegressionDesign(outcome="trade", granularity="country", scenario=SCENARIO_NOISY),
    )
    assert any("noisy" in n for n in noisy.notes)

    confounded = run_design(
        df,
        RegressionDesign(
            outcome="trade",
            granularity="country",
            method="event_study",
            scenario=SCENARIO_CONFOUNDED,
        ),
    )
    pre = next(c for c in confounded.coefs if c.name == "k=-2")
    assert abs(pre.coef) > 0.05
    assert confounded.diagnostics["pretrend"]["available"] is True
    assert confounded.diagnostics["pretrend"]["p"] < 0.05
    assert "谨慎" in confounded.diagnostics["pretrend"]["interpretation"]
    assert any("confounded" in n for n in confounded.notes)


def test_placebo_did_distribution_is_reproducible():
    df = _simulate_did_panel({0: -0.6, 1: -0.6, 2: -0.6})
    df = df.rename(columns={"y": "FVA_share"})
    design = RegressionDesign(outcome="trade", granularity="country", method="did")

    result = placebo_did_distribution(df, design, n_draws=12, seed=7)
    again = placebo_did_distribution(df, design, n_draws=12, seed=7)

    assert result["policy_name"] == "treated×post"
    assert abs(result["true_coef"] - (-0.6)) < 0.03
    assert len(result["placebo_coefs"]) == 12
    assert result["placebo_coefs"] == again["placebo_coefs"]
    assert result["cohorts"] == {"2018": 30}
    assert "cohort" in result["note"]
    extreme_count = sum(abs(coef) >= abs(result["true_coef"]) for coef in result["placebo_coefs"])
    assert result["extreme_count"] == extreme_count
    assert result["tail_share"] == pytest.approx(extreme_count / len(result["placebo_coefs"]))
    assert result["adjusted_tail_share"] == pytest.approx((extreme_count + 1) / (len(result["placebo_coefs"]) + 1))
    assert result["empirical_p"] == result["adjusted_tail_share"]
    assert result["calibrated_inference"] is False
    assert "国家聚类结构" in result["assignment_not_preserved"]


def _reg04_panel() -> pd.DataFrame:
    rows = []
    for country in ("A", "B", "C", "D", "E", "F"):
        first = 2018 if country in {"A", "B", "C"} else None
        for year in range(2016, 2021):
            treated = int(first is not None and year >= first)
            rows.append(
                {
                    "country": country,
                    "year": year,
                    "FVA_share": 0.1 * (year - 2015) - 0.2 * treated + ord(country) / 1000,
                    "other_outcome": 0.2 * (year - 2015) - 0.1 * treated + ord(country) / 1000,
                    "control": float(year - 2015),
                    "treated": treated,
                    "tariff_shock": 0.1 * treated,
                    "3_VA_GVC_share": 0.1 + ord(country) / 1000,
                }
            )
    return pd.DataFrame(rows)


def _baseline_freeze_panel() -> pd.DataFrame:
    rows = []
    for index, country in enumerate([*[f"T{i}" for i in range(6)], *[f"C{i}" for i in range(6)]]):
        first = 2019 if country.startswith("T") else None
        entity_baseline = 0.18 + 0.035 * index
        for year in range(2017, 2022):
            treated = int(first is not None and year >= first)
            shock = treated * (0.06 + 0.004 * (year - 2019))
            centered = entity_baseline - 0.3725
            noise = 0.003 * (((index + 2) * (year - 2015)) % 7 - 3)
            outcome = 0.4 * index + 0.07 * (year - 2017) - 0.45 * treated - 0.9 * treated * centered + noise
            rows.append(
                {
                    "country": country,
                    "year": year,
                    "FVA_share": outcome,
                    "control": 0.2 * index + 0.03 * (year - 2017),
                    "treated": treated,
                    "tariff_shock": shock,
                    "3_VA_GVC_share": entity_baseline + 0.002 * (year - 2017),
                }
            )
    return pd.DataFrame(rows)


def test_interaction_baseline_freezes_before_outcome_attrition_across_model_paths():
    frame = _baseline_freeze_panel()
    # KHM-like treated entity: its only pre-estimation outcomes are unavailable,
    # while the structurally sourced pre-treatment moderator remains finite.
    frame.loc[frame["country"].eq("T0") & frame["year"].lt(2019), "FVA_share"] = np.nan
    # A retained post row need not carry the raw moderator after entity baseline freeze.
    frame.loc[frame["country"].eq("T0") & frame["year"].eq(2020), "3_VA_GVC_share"] = np.nan

    models = [
        _prepare_did_model(frame, "FVA_share", interaction=True, intensity_col="tariff_shock"),
        _prepare_event_model(frame, "FVA_share", interaction=True, intensity_col="tariff_shock"),
        _prepare_fe_model(
            frame,
            "FVA_share",
            ["tariff_shock"],
            interaction=True,
            treated_col="treated",
        ),
    ]
    for model in models:
        retained = model.data.loc[model.data["country"].eq("T0")]
        assert set(retained["year"]) == {2019, 2020, 2021}
        assert retained["base_gvc_participation"].nunique() == 1
        assert model.timing.first_by_entity["T0"] == 2019
        assert model.sample_flow["baseline_source_structural_null_rows"] == 1
        assert "3_VA_GVC_share" not in model.sample_flow["missing_by_field"]

    placebo = placebo_did_distribution(
        frame,
        RegressionDesign(outcome="trade", granularity="country", method="did", interaction=True),
        n_draws=2,
        seed=17,
    )
    assert placebo["n_draws"] == 2


def test_frozen_baseline_values_are_invariant_to_baseline_year_control_attrition():
    frame = _baseline_freeze_panel()
    complete = _prepare_did_model(
        frame,
        "FVA_share",
        controls=["control"],
        interaction=True,
        intensity_col="tariff_shock",
    )
    frame.loc[frame["country"].eq("T1") & frame["year"].eq(2018), "control"] = np.nan
    attrited = _prepare_did_model(
        frame,
        "FVA_share",
        controls=["control"],
        interaction=True,
        intensity_col="tariff_shock",
    )
    complete_values = complete.data.groupby("country")["base_gvc_participation"].first().sort_index()
    attrited_values = attrited.data.groupby("country")["base_gvc_participation"].first().sort_index()
    pd.testing.assert_series_equal(attrited_values, complete_values)
    assert attrited.sample_flow["missing_by_field"]["control"] == 1


def test_interaction_baseline_missing_entity_is_dropped_across_model_paths_without_zero_fabrication():
    frame = _baseline_freeze_panel()
    missing_rows = frame["country"].eq("T0")
    frame.loc[missing_rows & frame["year"].lt(2019), "3_VA_GVC_share"] = np.nan

    models = [
        _prepare_did_model(frame, "FVA_share", interaction=True, intensity_col="tariff_shock"),
        _prepare_event_model(frame, "FVA_share", interaction=True, intensity_col="tariff_shock"),
        _prepare_fe_model(
            frame,
            "FVA_share",
            ["tariff_shock"],
            interaction=True,
            treated_col="treated",
        ),
    ]
    for model in models:
        assert "T0" not in set(model.data["country"])
        assert np.isfinite(model.data["base_gvc_participation"]).all()
        assert model.sample_flow["baseline_derived_missing_entities"] == ["T0"]
        assert model.sample_flow["baseline_derived_dropped_entities"] == 1
        assert model.sample_flow["baseline_derived_dropped_rows"] == int(missing_rows.sum())
        assert model.sample_flow["missing_by_field"]["base_gvc_participation"] == int(missing_rows.sum())
        assert model.sample_flow["estimation_rows"] + model.sample_flow["dropped_rows_total"] == len(frame)
        assert any("1 个实体（T0）" in note and "5 行" in note and "未以 0 填补" in note for note in model.notes)

    placebo_frame = frame.copy()
    placebo_frame.loc[placebo_frame["country"].eq("T0"), "3_VA_GVC_share"] = np.nan
    placebo = placebo_did_distribution(
        placebo_frame,
        RegressionDesign(outcome="trade", granularity="country", method="did", interaction=True),
        n_draws=2,
        seed=23,
    )
    assert placebo["n_draws"] == 2


def test_frozen_baseline_skips_structural_nulls_before_selecting_last_two_finite_values():
    frame = pd.DataFrame(
        [
            {"country": "treated", "year": 2016, "3_VA_GVC_share": 0.1},
            {"country": "treated", "year": 2017, "3_VA_GVC_share": 0.2},
            {"country": "treated", "year": 2018, "3_VA_GVC_share": np.nan},
            {"country": "treated", "year": 2019, "3_VA_GVC_share": 0.9},
            {"country": "control", "year": 2016, "3_VA_GVC_share": np.nan},
            {"country": "control", "year": 2017, "3_VA_GVC_share": 0.3},
            {"country": "control", "year": 2018, "3_VA_GVC_share": 0.5},
        ]
    )
    frozen = _freeze_baseline_gvc(frame, "country", "year", pd.Series({"treated": 2019}))
    assert frozen.to_dict() == pytest.approx({"treated": 0.15, "control": 0.4})


@pytest.mark.parametrize("bad", [float("inf"), "0.3"])
def test_frozen_baseline_rejects_nonnull_nonfinite_or_malformed_values(bad):
    frame = pd.DataFrame({"country": ["A"], "year": [2018], "3_VA_GVC_share": [bad]})
    with pytest.raises(ValueError, match="真实数值且有限"):
        _freeze_baseline_gvc(frame, "country", "year")


def test_complete_interaction_fixture_has_exact_stable_coefficient_se_and_t():
    result = run_design(
        _baseline_freeze_panel(),
        RegressionDesign(outcome="trade", granularity="country", method="did", interaction=True),
    )
    stats_by_name = {coefficient.name: coefficient for coefficient in result.coefs}
    main = stats_by_name["treated×post"]
    interaction = stats_by_name["treated×post×base_gvc"]
    assert (main.coef, main.se, main.t) == pytest.approx(
        (-0.44974999999999943, 0.005279733365955605, -85.18422594975058), rel=1e-12, abs=1e-12
    )
    assert (interaction.coef, interaction.se, interaction.t) == pytest.approx(
        (-0.885714285714285, 0.028734230051915746, -30.824361192696493), rel=1e-12, abs=1e-12
    )


def test_reg04_freezes_timing_before_outcome_and_control_complete_case():
    df = _reg04_panel()
    df.loc[(df["country"] == "A") & (df["year"] == 2018), "FVA_share"] = np.nan
    event = _prepare_event_model(df, "FVA_share", controls=["control"], intensity_col="tariff_shock")
    a2019 = event.data[(event.data["country"] == "A") & (event.data["year"] == 2019)].iloc[0]
    assert a2019["k=+1"] == 1
    assert a2019.get("k=0", 0) == 0
    assert event.timing.first_by_entity["A"] == 2018

    df.loc[(df["country"] == "B") & (df["year"] == 2018), "control"] = np.nan
    did_model = _prepare_did_model(df, "FVA_share", controls=["control"], intensity_col="tariff_shock")
    b2019 = did_model.data[(did_model.data["country"] == "B") & (did_model.data["year"] == 2019)].iloc[0]
    assert b2019["treated×post"] == 1
    assert did_model.timing.first_by_entity["B"] == 2018
    assert did_model.sample_flow["missing_by_field"]["FVA_share"] == 1
    assert did_model.sample_flow["missing_by_field"]["control"] == 1
    assert {item["code"] for item in did_model.sample_flow["dropped_by_reason"]} == {
        "missing_outcome",
        "missing_control",
    }


def test_reg04_fully_missing_treated_entity_is_disclosed_not_retimed():
    df = _reg04_panel()
    df.loc[df["country"] == "A", "FVA_share"] = np.nan
    model = _prepare_did_model(df, "FVA_share", interaction=True, intensity_col="tariff_shock")
    assert model.timing.first_by_entity["A"] == 2018
    assert "A" not in set(model.data["country"])
    assert model.sample_flow["timing_treated_entities"] == 3
    assert model.sample_flow["retained_treated_entities"] == 2
    assert model.sample_flow["baseline_entities_available"] == 6
    assert model.sample_flow["baseline_retained_entities"] == 5
    entity_baselines = model.data.groupby("country")["base_gvc_participation"].first()
    assert entity_baselines.mean() == pytest.approx(0.0, abs=1e-15)


def test_reg04_timeline_cohorts_are_outcome_and_row_order_invariant():
    df = _reg04_panel()
    df.loc[(df["country"] == "A") & (df["year"] == 2018), "FVA_share"] = np.nan
    df.loc[(df["country"] == "B") & (df["year"] == 2019), "other_outcome"] = np.nan
    first = _prepare_event_model(df, "FVA_share", intensity_col="tariff_shock")
    second = _prepare_event_model(df.sample(frac=1, random_state=7), "other_outcome", intensity_col="tariff_shock")
    assert first.sample_flow["timing_cohorts"] == second.sample_flow["timing_cohorts"] == {"2018": 3}
    assert first.timing.first_by_entity.to_dict() == second.timing.first_by_entity.to_dict()
    assert set(first.timing.first_by_entity.index) == {"A", "B", "C"}
    assert set(first.data.loc[first.data["country"].isin(["D", "E", "F"]), "k=0"]) == {0}


def test_reg04_reversal_scan_uses_full_timeline_when_outcome_is_missing():
    df = _reg04_panel()
    mask = (df["country"] == "A") & (df["year"] == 2019)
    df.loc[mask, ["treated", "tariff_shock"]] = 0
    df.loc[mask, "FVA_share"] = np.nan
    model = _prepare_did_model(df, "FVA_share", intensity_col="tariff_shock")
    assert model.timing.first_by_entity["A"] == 2018
    assert "A" in model.support.reversal_entities


def test_reg04_country_timing_uses_the_selected_weight_mode_panel():
    df = _reg04_panel()
    df["tariff_shock_contemporaneous"] = df["tariff_shock"]
    df["treated_contemporaneous"] = df["treated"]
    df.loc[
        (df["country"] == "A") & (df["year"] == 2018), ["tariff_shock_contemporaneous", "treated_contemporaneous"]
    ] = 0
    selected = regression_routes._panel_for_weight_mode(
        df,
        RegressionDesign(outcome="trade", granularity="country"),
        shocks.EXPOSURE_MODE_CONTEMPORANEOUS,
    )
    model = prepare_design_model(selected, RegressionDesign(outcome="trade", granularity="country"))
    assert model.timing.first_by_entity["A"] == 2019
    assert model.timing.first_by_entity["B"] == 2018


def test_reg04_industry_timing_is_entity_specific_while_cluster_is_country():
    rows = []
    for country in ("A", "B"):
        for industry, first in (("s1", 2018), ("s2", 2019)):
            for year in range(2017, 2021):
                treated = int(country == "A" and year >= first)
                rows.append(
                    {
                        "country": country,
                        "entity_id": f"{country}_{industry}",
                        "year": year,
                        "y": float(year) + (0.1 if industry == "s2" else 0),
                        "treated": treated,
                    }
                )
    model = _prepare_event_model(pd.DataFrame(rows), "y", entity="entity_id", cluster="country")
    assert model.timing.first_by_entity.to_dict() == {"A_s1": 2018, "A_s2": 2019}
    assert model.sample_flow["timing_clusters"] == 2
    assert model.sample_flow["timing_entities"] == 4


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda frame: frame.assign(treated=np.where(frame.index == 0, np.nan, frame["treated"])), "处理状态"),
        (lambda frame: frame.assign(treated=np.where(frame.index == 0, "bad", frame["treated"])), "处理状态"),
        (lambda frame: frame.assign(treated=np.where(frame.index == 0, 2, frame["treated"])), "严格为 0/1"),
        (lambda frame: frame.assign(country=np.where(frame.index == 0, None, frame["country"])), "标识"),
        (lambda frame: frame.assign(year=np.where(frame.index == 0, "bad", frame["year"])), "非数值"),
        (lambda frame: pd.concat([frame, frame.iloc[[0]]], ignore_index=True), "entity-year 唯一"),
    ],
)
def test_reg04_invalid_timeline_fails_closed(mutate, message):
    with pytest.raises(ValueError, match=message):
        _freeze_treatment_timing(mutate(_reg04_panel()), "country", "year", "country", "treated")


def test_reg04_entity_cannot_map_to_multiple_clusters():
    df = _reg04_panel().assign(cluster=lambda frame: frame["country"])
    df.loc[(df["country"] == "A") & (df["year"] == 2020), "cluster"] = "OTHER"
    with pytest.raises(ValueError, match="多个 cluster"):
        _freeze_treatment_timing(df, "country", "year", "cluster", "treated")


def test_reg04_interaction_baseline_uses_frozen_true_cutoff():
    df = _reg04_panel()
    df.loc[(df["country"] == "A") & (df["year"] == 2018), "FVA_share"] = np.nan
    model = prepare_design_model(
        df,
        RegressionDesign(outcome="trade", granularity="country", method="twfe_intensity", interaction=True),
    )
    assert model.timing.first_by_entity["A"] == 2018
    expected = _attach_baseline_gvc(
        df.dropna(subset=["FVA_share", "tariff_shock", "3_VA_GVC_share"]),
        "country",
        "year",
        model.timing.first_by_entity,
    )
    actual = model.data.groupby("country")["base_gvc_participation"].first()
    expected_values = expected.groupby("country")["base_gvc_participation"].first()
    assert actual.to_dict() == pytest.approx(expected_values.to_dict())


def test_reg04_absorbing_support_requires_a_retained_post_row_but_fe_uses_actual_exposure():
    rows = []
    for country in [*[f"T{i}" for i in range(6)], *[f"C{i}" for i in range(6)]]:
        frozen_treated = country.startswith("T")
        for year in range(2016, 2020):
            treated = int(frozen_treated and year >= 2018)
            y = float(year)
            if country in {"T1", "T2", "T3", "T4", "T5"} and year >= 2018:
                y = np.nan
            rows.append(
                {
                    "country": country,
                    "year": year,
                    "y": y,
                    "treated": treated,
                    "shock": 0.1 * treated,
                }
            )
    df = pd.DataFrame(rows)
    did_model = _prepare_did_model(df, "y", intensity_col="shock")
    assert did_model.sample_flow["timing_treated_entities"] == 6
    assert did_model.sample_flow["retained_treated_entities"] == 6
    assert did_model.sample_flow["treated_entities_without_post_rows"] == 5
    assert did_model.sample_flow["contributing_treated_entities"] == 1
    assert did_model.sample_flow["contributing_treated_clusters"] == 1
    assert did_model.sample_flow["contributing_cohorts"] == {"2018": 1}
    assert did_model.support.treated_entities == 1
    assert did_model.support.treated_clusters == 1
    assert did_model.support.status == "insufficient"

    fe_model = _prepare_fe_model(df, "y", ["shock"], treated_col="treated")
    assert fe_model.support.treated_entities == 1
    assert fe_model.support.treated_clusters == 1


def test_reg04_placebo_uses_only_effective_frozen_cohorts():
    df = _simulate_did_panel({0: -0.6, 1: -0.6, 2: -0.6}).rename(columns={"y": "FVA_share"})
    df.loc[(df["treated"] == 1) & (df["year"] == 2018), "FVA_share"] = np.nan
    # 五个 frozen-treated 实体只保留 pre 行，不能进入真实或伪处理支持。
    pre_only = [f"E{i:02d}" for i in range(5)]
    df.loc[df["country"].isin(pre_only) & (df["year"] >= 2018), "FVA_share"] = np.nan
    result = placebo_did_distribution(
        df, RegressionDesign(outcome="trade", granularity="country", method="did"), n_draws=4, seed=9
    )
    assert result["cohorts"] == {"2018": 25}
    assert result["treated_entities"] == 25


def test_reg04_sample_flow_arithmetic_serialization_and_row_boundary():
    df = _reg04_panel()
    df.loc[(df["country"] == "A") & (df["year"] == 2018), "FVA_share"] = np.nan
    df.loc[(df["country"] == "B") & (df["year"] == 2018), ["FVA_share", "control"]] = np.nan
    row = df.loc[df["country"] == "F"].copy()
    row["country"] = "ROW"
    combined = pd.concat([df, row], ignore_index=True)
    design = RegressionDesign(outcome="trade", granularity="country", control_mode="none")
    model = prepare_design_model(combined, design)
    flow = model.sample_flow
    assert flow["input_rows"] == len(combined)
    assert flow["structural_eligible_rows"] == len(df)
    assert flow["structural_excluded_rows"] == len(row)
    assert flow["estimation_rows"] + flow["dropped_rows_total"] == flow["structural_eligible_rows"]
    assert sum(reason["rows"] for reason in flow["dropped_by_reason"]) == flow["dropped_rows_total"]
    assert flow["missing_by_field"]["FVA_share"] == 2
    assert flow["timing_cohorts"] == {"2018": 3}
    assert "ROW" not in set(model.timing.timeline_data["country"])
    result = run_design(combined, design)
    assert result.to_dict()["sample_flow"] == result.sample_flow


def test_did_with_baseline_gvc_interaction_recovers_heterogeneity():
    rows = []
    beta, theta = -0.35, -0.8
    years = range(2016, 2021)
    for i in range(70):
        c = f"C{i:02d}"
        treated_group = i < 35
        base_gvc = 0.15 + 0.7 * (i / 69)
        fe = rng.normal(0, 0.8)
        for year in years:
            post = year >= 2018
            did_x = float(treated_group and post)
            y = fe + 0.1 * (year - 2016) + beta * did_x + theta * did_x * base_gvc
            y += rng.normal(0, 0.02)
            rows.append(
                {
                    "country": c,
                    "year": year,
                    "FVA_share": y,
                    "treated": int(did_x),
                    "3_VA_GVC_share": base_gvc,
                }
            )
    df = pd.DataFrame(rows)
    design = RegressionDesign(outcome="trade", granularity="country", interaction=True)

    result = run_design(df, design)
    by_name = {c.name: c for c in result.coefs}

    # 基期 GVC 在 0.15–0.85 上等距分布，均值为 0.5；中心化后主系数
    # 表示样本个体均值处的政策效应 beta + theta × 0.5。
    assert by_name["treated×post"].coef == pytest.approx(beta + theta * 0.5, abs=0.04)
    assert by_name["treated×post×base_gvc"].coef == pytest.approx(theta, abs=0.08)
    assert [item["level"] for item in result.marginal_effects] == ["low", "mean", "high"]
    assert result.marginal_effects[0]["baseline_gvc_centered"] < 0
    assert result.marginal_effects[1]["baseline_gvc_centered"] == 0
    assert result.marginal_effects[2]["baseline_gvc_centered"] > 0
    assert result.marginal_effects[0]["effect"] > result.marginal_effects[2]["effect"]
    assert all(
        item["se"] >= 0 and item["ci_low"] <= item["effect"] <= item["ci_high"] for item in result.marginal_effects
    )
    assert any("首次处理前" in note and "均值中心化" in note for note in result.notes)


def test_baseline_gvc_never_uses_treatment_or_post_treatment_rows():
    df = pd.DataFrame(
        [
            {"country": "treated", "year": year, "3_VA_GVC_share": value}
            for year, value in [(2016, 0.10), (2017, 0.20), (2018, 0.90), (2019, 0.95)]
        ]
        + [
            {"country": "control", "year": year, "3_VA_GVC_share": value}
            for year, value in [(2016, 0.30), (2017, 0.40), (2018, 0.80), (2019, 0.85)]
        ]
    )

    attached = _attach_baseline_gvc(df, "country", "year", pd.Series({"treated": 2018}))
    values = attached.groupby("country")["base_gvc_participation"].first()

    # treated 基期=(0.10+0.20)/2，control 基期=(0.30+0.40)/2；中心化后相差 0.20。
    assert values["treated"] == pytest.approx(-0.10)
    assert values["control"] == pytest.approx(0.10)


def test_baseline_gvc_drops_entity_without_pre_treatment_observation():
    df = pd.DataFrame(
        [
            {"country": "treated", "year": 2018, "3_VA_GVC_share": 0.90},
            {"country": "treated", "year": 2019, "3_VA_GVC_share": 0.95},
            {"country": "control", "year": 2018, "3_VA_GVC_share": 0.30},
            {"country": "control", "year": 2019, "3_VA_GVC_share": 0.40},
        ]
    )

    attached = _attach_baseline_gvc(df, "country", "year", pd.Series({"treated": 2018}))

    assert set(attached["country"]) == {"control"}
    assert attached["base_gvc_participation"].eq(0.0).all()


def test_run_design_with_controls_and_panelols_benchmark():
    df = _simulate_panel(beta=-0.35, n_entities=35, n_times=6).rename(columns={"y": "FVA_share", "x": "tariff_shock"})
    df["entity_id"] = df["country"]
    for i, col in enumerate(CONTROL_COLUMNS):
        df[col] = rng.normal(0, 1, len(df)) + 0.02 * i * (df["year"] - df["year"].min())

    design = RegressionDesign(
        outcome="trade",
        granularity="country",
        method="twfe_intensity",
        control_mode=CONTROL_MODE_ICIO,
    )
    result = run_design(df, design)
    assert result.coefs[0].name == "tariff_shock"
    assert any(c.name in CONTROL_COLUMNS for c in result.coefs)

    panelols = linearmodels_panel_ols(df, design)
    for coef in panelols.coefs:
        expected_p = 2 * stats.t.sf(abs(coef.t), df=panelols.n_clusters - 1)
        assert coef.p == pytest.approx(expected_p)
        assert (coef.p < 0.05) == (coef.ci_low > 0 or coef.ci_high < 0)

    bench = benchmark_linearmodels(df, design, result)
    assert bench["backend"] == "linearmodels.PanelOLS"
    assert "passed" not in bench
    assert bench["coef_check_passed"]
    assert bench["se_check_mode"] == "relative_tolerance_2pct"
    assert bench["se_check_passed"] is True
    assert bench["benchmark_passed"] is True
    assert bench["max_abs_coef_diff"] < 1e-8
    assert any("同时门禁政策系数与聚类标准误" in n for n in bench["notes"])


def test_run_design_with_macro_controls():
    df = _simulate_panel(beta=-0.25, n_entities=30, n_times=6).rename(columns={"y": "FVA_share", "x": "tariff_shock"})
    for i, col in enumerate(MACRO_CONTROL_COLUMNS):
        df[col] = rng.normal(0, 1, len(df)) + 0.03 * i * (df["year"] - df["year"].min())

    design = RegressionDesign(
        outcome="trade",
        granularity="country",
        method="twfe_intensity",
        control_mode=CONTROL_MODE_MACRO,
    )
    result = run_design(df, design)

    assert result.coefs[0].name == "tariff_shock"
    assert any(c.name in MACRO_CONTROL_COLUMNS for c in result.coefs)


def test_real_price_mode_deflates_amount_controls():
    df = _simulate_panel(beta=-0.2, n_entities=12, n_times=4).rename(columns={"y": "FVA_share", "x": "tariff_shock"})
    df["SVA"] = 1000 + 30 * (df["year"] - df["year"].min())
    df["gross_exports"] = 300 + 12 * (df["year"] - df["year"].min())
    df["gdp_deflator"] = 1.0 + 0.04 * (df["year"] - df["year"].min())
    df["log_gdp_proxy"] = np.log(df["SVA"] + 1.0)
    df["gdp_proxy_growth"] = 0.0
    df["log_exports_proxy"] = np.log(df["gross_exports"] + 1.0)
    df["exports_proxy_growth"] = 0.0
    df["export_intensity"] = df["gross_exports"] / df["SVA"]
    df["manufacturing_va_share"] = 0.4
    df["services_va_share"] = 0.35

    design = RegressionDesign(
        outcome="trade",
        granularity="country",
        method="twfe_intensity",
        control_mode=CONTROL_MODE_ICIO,
        price_mode=PRICE_MODE_REAL,
    )
    adjusted = _apply_price_mode(df, design)
    expected = np.log(df["SVA"] / df["gdp_deflator"] + 1.0)

    assert np.allclose(adjusted["log_gdp_proxy"], expected)
    result = run_design(df, design)
    assert any("教学模拟平减口径" in note for note in result.notes)
