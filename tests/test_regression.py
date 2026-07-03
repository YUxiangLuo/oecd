"""面板回归引擎测试:模拟含双向固定效应的数据,检验系数恢复。"""

import numpy as np
import pandas as pd
import pytest

from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.panel import twoway_fe

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


def test_design_equation_text():
    d = RegressionDesign(step=13)
    assert d.depvar == "backward_fva_share"
    assert d.granularity == "国家–行业级"  # 默认粒度已切到行业级
    eq = d.equation()
    assert "α_ij" in eq and "λ_t" in eq and "tariff_shock" in eq
    eq_c = RegressionDesign(step=13, granularity="国家级").equation()
    assert "α_ij" not in eq_c and "α_i" in eq_c


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
                rows.append({
                    "country": c, "entity_id": f"{c}_s{j}",
                    "year": 2015 + t, "x": x, "y": y,
                })
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
