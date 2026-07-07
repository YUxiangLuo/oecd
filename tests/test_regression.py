"""面板回归引擎测试:模拟含双向固定效应的数据,检验系数恢复。"""

import numpy as np
import pandas as pd
import pytest

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
    benchmark_linearmodels,
    did,
    event_study,
    placebo_did_distribution,
    prepare_design_model,
    run_design,
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


def test_collinear_control_is_dropped_but_policy_kept():
    df = _simulate_panel(beta=-0.4)
    df["absorbed_control"] = df["year"] - df["year"].min()
    result = twoway_fe(df, "y", ["x"], controls=["absorbed_control"])
    assert [c.name for c in result.coefs] == ["x"]
    assert any("absorbed_control" in n for n in result.notes)


def test_design_equation_text():
    d = RegressionDesign(step=13)
    assert d.depvar == "share_trade_fva"
    assert d.granularity == "国家–行业级"  # 默认粒度已切到行业级
    assert d.method == "双重差分 (DID)"  # 默认方法已切到 DID
    assert d.exclude_row is True
    assert "排除 ROW" in d.sample_filter
    eq = d.equation()
    assert "α_ij" in eq and "λ_t" in eq and "treated_ij × 1[t≥G_ij]" in eq
    eq_c = RegressionDesign(step=13, granularity="国家级").equation()
    assert "α_ij" not in eq_c and "α_i" in eq_c and "treated_i × 1[t≥G_i]" in eq_c

    eq_fe = RegressionDesign(step=13, method="双向固定效应").equation()
    assert "tariff_shock" in eq_fe
    eq_ev = RegressionDesign(step=13, method="事件研究").equation()
    assert "Σ_k" in eq_ev and "t-G_ij" in eq_ev
    eq_inter = RegressionDesign(step=13, interaction=True).equation()
    assert "BaseGVC" in eq_inter
    eq_ctrl = RegressionDesign(step=13, control_mode=CONTROL_MODE_ICIO).equation()
    assert "Controls_ct" in eq_ctrl
    macro = RegressionDesign(step=13, control_mode=CONTROL_MODE_MACRO)
    assert set(macro.controls) == set(MACRO_CONTROL_COLUMNS)
    assert "GDP规模" in macro.control_labels["macro_log_gdp_usd"]
    d_sanction = RegressionDesign(step=13, shock_type="制裁清单")
    assert d_sanction.shock_col == "sanction_shock"
    assert d_sanction.treated_col == "sanction_treated"
    assert "sanction_treated_ij" in d_sanction.equation()
    real = RegressionDesign(step=13, price_mode=PRICE_MODE_REAL)
    assert real.price_mode == PRICE_MODE_REAL
    noisy = RegressionDesign(step=13, scenario=SCENARIO_NOISY)
    assert noisy.scenario_label.startswith("测量误差")


def test_design_panel_spec():
    d = RegressionDesign(step=14)
    assert d.panel_file == "panel_sector.csv"
    assert d.entity == "entity_id"
    assert d.cluster == "country"
    d_c = RegressionDesign(step=14, granularity="国家级")
    assert d_c.panel_file == "panel_country.csv"
    assert d_c.entity == d_c.cluster == "country"


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


def test_did_recovers_att():
    """处理后恒定效应 -0.6:DID 系数应恢复 ATT。"""
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

    design = RegressionDesign(step=13, granularity="国家级")
    model = prepare_design_model(df.rename(columns={"y": "share_trade_fva"}), design)
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
    # 平行趋势:处理前系数不显著异于 0
    assert abs(by_name["k=-2"].coef) < 0.05
    # 处理后动态路径
    for name, true_val in [("k=0", 0.2), ("k=+1", 0.5), ("k=+2", 0.8)]:
        assert abs(by_name[name].coef - true_val) < 0.05, name
    assert by_name["k=+2"].p < 0.01


def test_design_regressions_exclude_row_by_default():
    df = _simulate_did_panel({0: -0.5, 1: -0.5, 2: -0.5}).rename(columns={"y": "share_trade_fva"})
    row_rows = []
    for year in range(2016, 2021):
        row_rows.append(
            {
                "country": "ROW",
                "year": year,
                "share_trade_fva": 999.0 if year >= 2018 else -999.0,
                "treated": int(year >= 2018),
            }
        )
    df = pd.concat([df, pd.DataFrame(row_rows)], ignore_index=True)

    design = RegressionDesign(step=13, granularity="国家级")
    model = prepare_design_model(df, design)
    assert "ROW" not in set(model.data["country"])
    result = run_design(df, design)
    assert result.n_entities == 60
    assert result.n_clusters == 60
    assert any("排除 ROW" in n for n in result.notes)

    included = prepare_design_model(df, RegressionDesign(step=13, granularity="国家级", exclude_row=False))
    assert "ROW" in set(included.data["country"])


def test_run_design_dispatch():
    """run_design 按 method 分发到正确引擎(从系数名可辨认)。"""
    df = _simulate_did_panel({0: -0.5, 1: -0.5, 2: -0.5})
    df["entity_id"] = df["country"]
    df["tariff_shock"] = df["treated"] * 0.1

    def names(method):
        design = RegressionDesign(step=13, granularity="国家级", method=method)
        r = run_design(df.rename(columns={"y": design.depvar}), design)
        return [c.name for c in r.coefs]

    assert names("双重差分 (DID)") == ["treated×post"]
    assert names("双向固定效应") == ["tariff_shock"]
    assert names("事件研究") == ["k=-2", "k=0", "k=+1", "k=+2"]


def test_teaching_scenarios_add_expected_notes_and_pretrend():
    df = _simulate_did_panel({0: -0.5, 1: -0.5, 2: -0.5})
    df = df.rename(columns={"y": "share_trade_fva"})

    noisy = run_design(
        df,
        RegressionDesign(step=13, granularity="国家级", scenario=SCENARIO_NOISY),
    )
    assert any("noisy" in n for n in noisy.notes)

    confounded = run_design(
        df,
        RegressionDesign(
            step=13,
            granularity="国家级",
            method="事件研究",
            scenario=SCENARIO_CONFOUNDED,
        ),
    )
    pre = next(c for c in confounded.coefs if c.name == "k=-2")
    assert abs(pre.coef) > 0.05
    assert any("confounded" in n for n in confounded.notes)


def test_placebo_did_distribution_is_reproducible():
    df = _simulate_did_panel({0: -0.6, 1: -0.6, 2: -0.6})
    df = df.rename(columns={"y": "share_trade_fva"})
    design = RegressionDesign(step=13, granularity="国家级", method="双重差分 (DID)")

    result = placebo_did_distribution(df, design, n_draws=12, seed=7)
    again = placebo_did_distribution(df, design, n_draws=12, seed=7)

    assert result["policy_name"] == "treated×post"
    assert abs(result["true_coef"] - (-0.6)) < 0.03
    assert len(result["placebo_coefs"]) == 12
    assert result["placebo_coefs"] == again["placebo_coefs"]
    assert result["cohorts"] == {"2018": 30}
    assert "cohort" in result["note"]
    assert 0 < result["empirical_p"] <= 1


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
                    "share_trade_fva": y,
                    "treated": int(did_x),
                    "share_trade_gvc_participation": base_gvc,
                }
            )
    df = pd.DataFrame(rows)
    design = RegressionDesign(step=13, granularity="国家级", interaction=True)

    result = run_design(df, design)
    by_name = {c.name: c for c in result.coefs}

    assert by_name["treated×post"].coef == pytest.approx(beta, abs=0.04)
    assert by_name["treated×post×base_gvc"].coef == pytest.approx(theta, abs=0.08)
    assert any("基期GVC" in note for note in result.notes)


def test_run_design_with_controls_and_panelols_benchmark():
    df = _simulate_panel(beta=-0.35, n_entities=35, n_times=6).rename(
        columns={"y": "share_trade_fva", "x": "tariff_shock"}
    )
    df["entity_id"] = df["country"]
    for i, col in enumerate(CONTROL_COLUMNS):
        df[col] = rng.normal(0, 1, len(df)) + 0.02 * i * (df["year"] - df["year"].min())

    design = RegressionDesign(
        step=13,
        granularity="国家级",
        method="双向固定效应",
        control_mode=CONTROL_MODE_ICIO,
    )
    result = run_design(df, design)
    assert result.coefs[0].name == "tariff_shock"
    assert any(c.name in CONTROL_COLUMNS for c in result.coefs)

    bench = benchmark_linearmodels(df, design, result)
    assert bench["backend"] == "linearmodels.PanelOLS"
    assert "passed" not in bench
    assert bench["coef_check_passed"]
    assert bench["se_check_mode"] == "informational"
    assert bench["max_abs_coef_diff"] < 1e-8
    assert any("仅针对政策系数" in n for n in bench["notes"])


def test_run_design_with_macro_controls():
    df = _simulate_panel(beta=-0.25, n_entities=30, n_times=6).rename(
        columns={"y": "share_trade_fva", "x": "tariff_shock"}
    )
    for i, col in enumerate(MACRO_CONTROL_COLUMNS):
        df[col] = rng.normal(0, 1, len(df)) + 0.03 * i * (df["year"] - df["year"].min())

    design = RegressionDesign(
        step=13,
        granularity="国家级",
        method="双向固定效应",
        control_mode=CONTROL_MODE_MACRO,
    )
    result = run_design(df, design)

    assert result.coefs[0].name == "tariff_shock"
    assert any(c.name in MACRO_CONTROL_COLUMNS for c in result.coefs)


def test_real_price_mode_deflates_amount_controls():
    df = _simulate_panel(beta=-0.2, n_entities=12, n_times=4).rename(
        columns={"y": "share_trade_fva", "x": "tariff_shock"}
    )
    df["prod_va_total"] = 1000 + 30 * (df["year"] - df["year"].min())
    df["trade_gross_exports"] = 300 + 12 * (df["year"] - df["year"].min())
    df["gdp_deflator"] = 1.0 + 0.04 * (df["year"] - df["year"].min())
    df["log_gdp_proxy"] = np.log(df["prod_va_total"] + 1.0)
    df["gdp_proxy_growth"] = 0.0
    df["log_exports_proxy"] = np.log(df["trade_gross_exports"] + 1.0)
    df["exports_proxy_growth"] = 0.0
    df["export_intensity"] = df["trade_gross_exports"] / df["prod_va_total"]
    df["manufacturing_va_share"] = 0.4
    df["services_va_share"] = 0.35

    design = RegressionDesign(
        step=13,
        granularity="国家级",
        method="双向固定效应",
        control_mode=CONTROL_MODE_ICIO,
        price_mode=PRICE_MODE_REAL,
    )
    adjusted = _apply_price_mode(df, design)
    expected = np.log(df["prod_va_total"] / df["gdp_deflator"] + 1.0)

    assert np.allclose(adjusted["log_gdp_proxy"], expected)
    result = run_design(df, design)
    assert any("实际值口径" in note for note in result.notes)
