"""指标计算的数学性质测试(合成小矩阵,不依赖真实数据)。"""

import networkx as nx
import numpy as np
import pytest

from gvcsim.indicators import length, network, production, tradeflow
from gvcsim.indicators.core import build_arrays


def test_build_arrays_basics(fake_io):
    arr = build_arrays(fake_io)
    # 测试夹具没有 factor_inputs 表时,增加值回退为 x - 中间投入列和。
    assert np.allclose(arr.va, arr.x - arr.Z.sum(axis=0))
    assert np.allclose(arr.t, 0.0)
    # 增加值系数与全球逆矩阵的恒等式:v'B = 1(每单位最终品的增加值总含量为1)
    assert np.allclose(arr.v @ arr.B, np.ones(4))
    # AAA-s1 的出口 = 卖给 BBB 的中间品 (4+2) + 卖给 BBB 的最终品 (10)
    assert arr.E[0] == pytest.approx(16.0)


def test_tradeflow_customer_columns_and_identities(fake_io):
    arr = build_arrays(fake_io)
    df = tradeflow.country_tradeflow(arr)
    assert list(df.columns) == tradeflow.TRADE_COLUMNS
    accounted = tradeflow.gross_exports(df)
    assert np.allclose(accounted, df[["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"]].sum(axis=1))
    assert np.allclose(df["EXDVA"], df["DVAex"] + df["DVArt"])
    assert np.allclose(df["taxsub"], 0.0)

    industry = tradeflow.sector_tradeflow(arr)
    assert list(industry.index.names) == ["country", "industry"]
    assert list(industry.columns) == tradeflow.TRADE_COLUMNS
    assert np.allclose(tradeflow.gross_exports(industry), industry[["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"]].sum(axis=1))


def test_tradeflow_bm_source_coefficients_match_cut_inverse(fake_io):
    """BM 快速公式应等于显式切断出口国对外中间投入后的 Leontief 逆。"""
    arr = build_arrays(fake_io)
    eye = np.eye(len(arr.x))
    for country in arr.regions:
        p = arr.pos[country]
        mask = np.ones(len(arr.x), dtype=bool)
        mask[p] = False
        f = np.where(mask)[0]

        A_cut = arr.A.copy()
        A_cut[np.ix_(p, f)] = 0.0
        B_cut = np.linalg.inv(eye - A_cut)

        domestic_source, domestic_full, foreign_source, foreign_full = tradeflow._bm_source_coefficients(arr, country)
        assert np.allclose(domestic_source, arr.v[p] @ B_cut[np.ix_(p, p)])
        assert np.allclose(domestic_full, arr.v[p] @ arr.B[np.ix_(p, p)])
        assert np.allclose(foreign_source, arr.v[f] @ B_cut[np.ix_(f, p)])
        assert np.allclose(foreign_full, arr.v[f] @ arr.B[np.ix_(f, p)])


def test_tradeflow_bm_source_small_system_values(fake_io, cycle_io):
    """2国与3国循环小系统的 BM source-based 聚合值固定。"""
    fake = tradeflow.country_tradeflow(build_arrays(fake_io))
    assert fake.loc["AAA", "DVAex"] == pytest.approx(20.401203, abs=1e-6)
    assert fake.loc["AAA", "DVArt"] == pytest.approx(1.698414, abs=1e-6)
    assert fake.loc["AAA", "DDC"] == pytest.approx(0.187618, abs=1e-6)
    assert fake.loc["AAA", "FVA"] == pytest.approx(1.698346, abs=1e-6)
    assert fake.loc["AAA", "FDC"] == pytest.approx(0.014418, abs=1e-6)

    cycle = tradeflow.country_tradeflow(build_arrays(cycle_io))
    assert cycle.loc["BBB", "DVAex"] == pytest.approx(10.657258, abs=1e-6)
    assert cycle.loc["BBB", "DVArt"] == pytest.approx(1.342742, abs=1e-6)
    assert cycle.loc["BBB", "DDC"] == pytest.approx(0.580645, abs=1e-6)
    assert cycle.loc["BBB", "FVA"] == pytest.approx(7.076923, abs=1e-6)
    assert cycle.loc["BBB", "FDC"] == pytest.approx(0.342432, abs=1e-6)


def test_tradeflow_autarky(autarky_io):
    """封闭经济没有出口。"""
    arr = build_arrays(autarky_io)
    assert np.allclose(arr.E, 0)
    df = tradeflow.country_tradeflow(arr)
    assert np.allclose(tradeflow.gross_exports(df), 0.0)


def test_production_decomposition_adds_up(fake_io):
    """客户资料生产字段的四段分解之和 = 增加值总额。"""
    arr = build_arrays(fake_io)
    df = production.country_production(arr)
    parts = df[["1_VA_D", "2_VA_RT", "3a_VA_GVC_S", "3b_VA_GVC_C"]].sum(axis=1)
    assert np.allclose(parts, df["SVA"])
    assert np.allclose(df["3_VA_GVC"], df["3a_VA_GVC_S"] + df["3b_VA_GVC_C"])
    fgy_parts = df[["1_FGY_D", "2_FGY_RT", "3a_FGY_GVC_S", "3b_FGY_GVC_C"]].sum(axis=1)
    assert np.allclose(fgy_parts, df["FGY"])
    assert np.allclose(df["3_FGY_GVC"], df["3a_FGY_GVC_S"] + df["3b_FGY_GVC_C"])

    va_by_country = {r: arr.va[arr.pos[r]].sum() for r in arr.regions}
    for r in arr.regions:
        assert df.loc[r, "SVA"] == pytest.approx(va_by_country[r])


def test_production_autarky(autarky_io):
    """封闭经济:增加值 100% 是纯国内,GVC 各段为 0。"""
    arr = build_arrays(autarky_io)
    df = production.country_production(arr)
    assert np.allclose(df["1_VA_D"], df["SVA"])
    assert np.allclose(df["2_VA_RT"], 0.0, atol=1e-9)
    assert np.allclose(df["3a_VA_GVC_S"], 0.0, atol=1e-9)
    assert np.allclose(df["3b_VA_GVC_C"], 0.0, atol=1e-9)


def test_sector_production_adds_up(fake_io):
    """行业级四段之和 = 行业增加值;按国加总 = 国家级分解。"""
    arr = build_arrays(fake_io)
    sec = production.sector_production(arr)
    assert list(sec.index.names) == ["country", "industry"]
    parts = sec[["1_VA_D", "2_VA_RT", "3a_VA_GVC_S", "3b_VA_GVC_C"]].sum(axis=1)
    assert np.allclose(parts, sec["SVA"])
    assert np.allclose(sec["3_VA_GVC"], sec["3a_VA_GVC_S"] + sec["3b_VA_GVC_C"])

    country = production.country_production(arr)
    agg = sec[production.PRODUCTION_COLUMNS].groupby(level=0).sum()
    assert np.allclose(agg[country.columns].values, country.values)


def test_sector_production_autarky(autarky_io):
    arr = build_arrays(autarky_io)
    sec = production.sector_production(arr)
    assert np.allclose(sec["2_VA_RT"], 0.0, atol=1e-9)
    assert np.allclose(sec["3a_VA_GVC_S"], 0.0, atol=1e-9)
    assert np.allclose(sec["3b_VA_GVC_C"], 0.0, atol=1e-9)


def test_cycle_has_return_and_double_counting(cycle_io):
    """循环跨境链条应识别出返回国内增加值、重复计算与复杂 GVC。"""
    arr = build_arrays(cycle_io)
    tf = tradeflow.country_tradeflow(arr)
    assert (tf["DVArt"] > 0).all()
    assert ((tf["DDC"] + tf["FDC"]) > 0).all()
    assert np.allclose(tradeflow.gross_exports(tf), tf[["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"]].sum(axis=1))

    prod = production.country_production(arr)
    assert (prod["3b_VA_GVC_C"] > 0).all()


def test_length_properties(fake_io, autarky_io):
    arr = build_arrays(fake_io)
    df = length.sector_length(arr)
    assert list(df.index.names) == ["country", "industry"]
    assert list(df.columns) == length.LENGTH_COLUMNS
    assert (df["PLv"] >= 1 - 1e-9).all()
    assert (df["PLv_D"] <= df["PLv"] + 1e-9).all()
    assert np.allclose(df[["PLv_D", "PLv_RT", "PLv_GVC"]].sum(axis=1), df["PLv"])
    assert np.allclose(df[["PLy_D", "PLy_RT", "PLy_GVC"]].sum(axis=1), df["PLy"])
    assert np.isfinite(df["PLy"]).all()
    assert np.isfinite(df["Pos_TPL"]).all()

    arr_a = build_arrays(autarky_io)
    df_a = length.sector_length(arr_a)
    assert np.allclose(df_a["PLv_RT"], 0.0, atol=1e-9)
    assert np.allclose(df_a["PLv_GVC"], 0.0, atol=1e-9)
    assert np.allclose(df_a["PLy_RT"], 0.0, atol=1e-9)
    assert np.allclose(df_a["PLy_GVC"], 0.0, atol=1e-9)
    assert df_a["GVCPs"].isna().all()

    country = length.country_length(arr, df)
    assert set(country.index) == {"AAA", "BBB"}


def test_network_metrics(fake_io):
    arr = build_arrays(fake_io)
    F = network.country_flow_matrix(arr)
    # 对角线(国内交易)不计入
    assert np.allclose(np.diag(F.values), 0)
    # AAA→BBB 总流 = 中间品块 (4+2+2+1) + 最终品 (10+5)
    assert F.loc["AAA", "BBB"] == pytest.approx(24.0)

    df = network.country_network(arr)
    assert list(df.columns) == network.NETWORK_COLUMNS
    assert np.allclose(df["degree"], df["indegree"] + df["outdegree"])
    assert np.allclose(df["weighted degree"], df["weighted indegree"] + df["weighted outdegree"])
    assert (df["betweenesscentrality"] >= 0).all()
    assert (df["eigencentrality"] > 0).all()


def test_sector_network(fake_io):
    """行业级网络:索引齐全,数值性质合理。"""
    arr = build_arrays(fake_io)
    df = network.sector_network(arr)
    assert list(df.index.names) == ["country", "industry"]
    assert len(df) == 4  # 2 国 × 2 行业全覆盖
    assert not df.isna().any().any()
    assert np.allclose(df["degree"], df["indegree"] + df["outdegree"])
    assert np.allclose(df["weighted degree"], df["weighted indegree"] + df["weighted outdegree"])
    assert (df["betweenesscentrality"] >= 0).all()
    # fake_io 中所有行业间都有流量,度数应处处为正
    assert (df["degree"] > 0).all()


def test_betweenness_is_exact_under_node_limit(fake_io):
    arr = build_arrays(fake_io)
    total = float(arr.Z.sum())
    nodes = list(arr.index)
    G = nx.DiGraph()
    G.add_nodes_from(nodes)
    src, dst = np.where(arr.Z / total > network.SECTOR_EDGE_SHARE_THRESHOLD)
    for i, j in zip(src, dst):
        if i != j:
            w = float(arr.Z[i, j])
            G.add_edge(nodes[i], nodes[j], weight=w)

    got = network._betweenness_centrality(G)
    expected = nx.betweenness_centrality(G, weight=None, normalized=False)

    for node in nodes:
        assert got[node] == pytest.approx(expected[node])


def test_eigenvector_prefers_numpy_backend_on_connected_graph():
    G = nx.Graph()
    G.add_edge("A", "B", weight=2.0)
    G.add_edge("B", "C", weight=1.0)

    got = network._eigenvector_centrality(G)
    expected = nx.eigenvector_centrality_numpy(G, weight="weight")

    for node in G.nodes:
        assert got[node] == pytest.approx(expected[node], abs=1e-9)
