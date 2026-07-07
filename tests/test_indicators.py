"""指标计算的数学性质测试(合成小矩阵,不依赖真实数据)。"""

import numpy as np
import networkx as nx
import pandas as pd
import pytest

from gvcsim.indicators import length, network, production, tradeflow
from gvcsim.indicators.core import build_arrays


def test_build_arrays_basics(fake_io):
    arr = build_arrays(fake_io)
    # 增加值恒等式:va = x - 中间投入列和
    assert np.allclose(arr.va, arr.x - arr.Z.sum(axis=0))
    # 增加值系数与全球逆矩阵的恒等式:v'B = 1(每单位最终品的增加值总含量为1)
    assert np.allclose(arr.v @ arr.B, np.ones(4))
    # AAA-s1 的出口 = 卖给 BBB 的中间品 (4+2) + 卖给 BBB 的最终品 (10)
    assert arr.E[0] == pytest.approx(16.0)


def test_tradeflow_bounds(fake_io):
    arr = build_arrays(fake_io)
    df = tradeflow.country_tradeflow(arr)
    accounted = df[["trade_dva", "trade_rdv", "trade_ddc", "trade_fva", "trade_fdc"]].sum(axis=1)
    assert np.allclose(accounted, df["trade_gross_exports"])
    assert np.allclose(df["trade_pdc"], df["trade_ddc"] + df["trade_fdc"])
    assert np.allclose(df["exdva"], df["dvaex"] + df["dvart"])
    assert np.allclose(df["dvaex"], df["trade_dva"])
    assert df["taxsub"].isna().all()
    assert df["share_trade_backward_gvc"].between(0, 1).all()
    assert (df["share_trade_forward_gvc"] > 0).all()

    sector = tradeflow.sector_tradeflow(arr)
    accounted_s = sector[["trade_dva", "trade_rdv", "trade_ddc", "trade_fva", "trade_fdc"]].sum(axis=1)
    assert np.allclose(accounted_s, sector["trade_gross_exports"])
    assert sector["share_trade_dva"].between(0, 1).all()


def test_tradeflow_sector_forward_share_requires_export_sector():
    """小出口行业的无界前向/总参与度置空,但有界 FVA/DVA 占比仍保留。"""
    idx = pd.MultiIndex.from_tuples(
        [("AAA", "major"), ("AAA", "minor")],
        names=["country", "sector"],
    )
    df = pd.DataFrame(
        {
            "trade_gross_exports": [1000.0, 5.0],
            "trade_dva": [700.0, 3.5],
            "trade_fva": [200.0, 1.0],
            "trade_pdc": [10.0, 0.05],
            "trade_fdc": [5.0, 0.02],
            "trade_forward_va_in_foreign_exports": [100.0, 100.0],
        },
        index=idx,
    )

    out = tradeflow._add_trade_shares(df.copy())

    assert out.loc[("AAA", "major"), "share_trade_forward_gvc"] == pytest.approx(0.1)
    assert pd.isna(out.loc[("AAA", "minor"), "share_trade_forward_gvc"])
    assert pd.isna(out.loc[("AAA", "minor"), "share_trade_gvc_participation"])
    assert out.loc[("AAA", "minor"), "share_trade_fva"] == pytest.approx(0.2)

    flat = df.reset_index()
    flat_out = tradeflow._add_trade_shares(flat.copy())
    assert pd.isna(flat_out.loc[1, "share_trade_forward_gvc"])
    assert flat_out.loc[1, "share_trade_fva"] == pytest.approx(0.2)


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
    assert fake.loc["AAA", "trade_dva"] == pytest.approx(20.401203, abs=1e-6)
    assert fake.loc["AAA", "trade_rdv"] == pytest.approx(1.698414, abs=1e-6)
    assert fake.loc["AAA", "trade_ddc"] == pytest.approx(0.187618, abs=1e-6)
    assert fake.loc["AAA", "trade_fva"] == pytest.approx(1.698346, abs=1e-6)
    assert fake.loc["AAA", "trade_fdc"] == pytest.approx(0.014418, abs=1e-6)

    cycle = tradeflow.country_tradeflow(build_arrays(cycle_io))
    assert cycle.loc["BBB", "trade_dva"] == pytest.approx(10.657258, abs=1e-6)
    assert cycle.loc["BBB", "trade_rdv"] == pytest.approx(1.342742, abs=1e-6)
    assert cycle.loc["BBB", "trade_ddc"] == pytest.approx(0.580645, abs=1e-6)
    assert cycle.loc["BBB", "trade_fva"] == pytest.approx(7.076923, abs=1e-6)
    assert cycle.loc["BBB", "trade_fdc"] == pytest.approx(0.342432, abs=1e-6)


def test_tradeflow_autarky(autarky_io):
    """封闭经济:没有出口,参与度无从谈起(出口为0)。"""
    arr = build_arrays(autarky_io)
    assert np.allclose(arr.E, 0)


def test_production_decomposition_adds_up(fake_io):
    """四段分解之和 = 增加值总额(WWYZ 分解的核心恒等式)。"""
    arr = build_arrays(fake_io)
    df = production.country_production(arr)
    parts = df[["prod_pure_domestic", "prod_traditional", "prod_simple_gvc", "prod_complex_gvc"]].sum(axis=1)
    assert np.allclose(parts, df["prod_va_total"])
    assert np.allclose(df["prod_gvc_total"], df["prod_simple_gvc"] + df["prod_complex_gvc"])
    assert np.allclose(df["sva"], df["va_d"] + df["va_rt"] + df["va_gvc"])
    assert np.allclose(df["va_gvc"], df["va_gvc_s"] + df["va_gvc_c"])
    assert np.allclose(df["fgy"], df["fgy_d"] + df["fgy_rt"] + df["fgy_gvc"])
    assert np.allclose(df["fgy_gvc"], df["fgy_gvc_s"] + df["fgy_gvc_c"])
    # 总增加值应等于 va 向量按国加总
    va_by_country = {r: arr.va[arr.pos[r]].sum() for r in arr.regions}
    for r in arr.regions:
        assert df.loc[r, "prod_va_total"] == pytest.approx(va_by_country[r])
    shares = df[[c for c in df.columns if c.startswith("share_")]].sum(axis=1)
    assert np.allclose(shares - df["share_prod_gvc_total"], 1.0)


def test_production_autarky(autarky_io):
    """封闭经济:增加值 100% 是纯国内,GVC 各段为 0。"""
    arr = build_arrays(autarky_io)
    df = production.country_production(arr)
    assert np.allclose(df["share_prod_pure_domestic"], 1.0)
    assert np.allclose(df["prod_traditional"], 0.0, atol=1e-9)
    assert np.allclose(df["prod_simple_gvc"], 0.0, atol=1e-9)
    assert np.allclose(df["prod_complex_gvc"], 0.0, atol=1e-9)


def test_sector_production_adds_up(fake_io):
    """行业级四段之和 = 行业增加值;按国加总 = 国家级分解。"""
    arr = build_arrays(fake_io)
    sec = production.sector_production(arr)
    parts = sec[["prod_pure_domestic", "prod_traditional", "prod_simple_gvc", "prod_complex_gvc"]].sum(axis=1)
    assert np.allclose(parts, sec["prod_va_total"])
    assert np.allclose(sec["sva"], sec["va_d"] + sec["va_rt"] + sec["va_gvc"])
    assert np.allclose(sec["va_gvc"], sec["va_gvc_s"] + sec["va_gvc_c"])

    country = production.country_production(arr)
    agg = (
        sec[["prod_va_total", "prod_pure_domestic", "prod_traditional", "prod_simple_gvc", "prod_complex_gvc"]]
        .groupby(level=0)
        .sum()
    )
    assert np.allclose(agg.values, country[agg.columns].values)

    # 行业级四分类占比加总为 1;share_prod_gvc_total 是 simple+complex 的汇总列
    shares = sec[[c for c in sec.columns if c.startswith("share_")]].sum(axis=1)
    assert np.allclose(shares - sec["share_prod_gvc_total"], 1.0)


def test_sector_production_autarky(autarky_io):
    arr = build_arrays(autarky_io)
    sec = production.sector_production(arr)
    assert np.allclose(sec["prod_traditional"], 0.0, atol=1e-9)
    assert np.allclose(sec["prod_simple_gvc"], 0.0, atol=1e-9)
    assert np.allclose(sec["prod_complex_gvc"], 0.0, atol=1e-9)


def test_cycle_has_return_and_double_counting(cycle_io):
    """循环跨境链条应识别出返回国内增加值、重复计算与复杂 GVC。"""
    arr = build_arrays(cycle_io)
    tf = tradeflow.country_tradeflow(arr)
    assert (tf["trade_rdv"] > 0).all()
    assert (tf["trade_pdc"] > 0).all()
    assert np.allclose(
        tf[["trade_dva", "trade_rdv", "trade_ddc", "trade_fva", "trade_fdc"]].sum(axis=1),
        tf["trade_gross_exports"],
    )

    prod = production.country_production(arr)
    assert (prod["prod_complex_gvc"] > 0).all()


def test_length_properties(fake_io, autarky_io):
    arr = build_arrays(fake_io)
    df = length.sector_length(arr)
    # 上游度至少为1(所有产出至少要经过自己这一个阶段)
    assert (df["upstreamness"] >= 1 - 1e-9).all()
    assert (df["upstreamness_domestic"] <= df["upstreamness"] + 1e-9).all()
    assert (df["upstreamness_cross"] >= -1e-9).all()
    assert np.allclose(df["plv"], df["upstreamness"])
    assert np.allclose(df["plv_d"], df["upstreamness_domestic"])
    assert np.isfinite(df["ply"]).all()
    assert np.isfinite(df["pos_tpl"]).all()

    # 封闭经济:跨境段为0,总长度=国内段
    arr_a = build_arrays(autarky_io)
    df_a = length.sector_length(arr_a)
    assert np.allclose(df_a["upstreamness_cross"], 0.0, atol=1e-9)
    assert df_a["gvcps"].isna().all()

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
    assert df["degree_centrality"].between(0, 2).all()
    for col in [
        "degree",
        "indegree",
        "outdegree",
        "weighted_degree",
        "weighted_indegree",
        "weighted_outdegree",
        "eccentricity",
        "closeness_centrality",
        "harmonic_closeness_centrality",
    ]:
        assert col in df.columns
    assert (df["eigenvector_centrality"] > 0).all()


def test_sector_network(fake_io):
    """行业级网络:索引齐全,数值性质合理。"""
    arr = build_arrays(fake_io)
    df = network.sector_network(arr)
    assert list(df.index.names) == ["country", "sector"]
    assert len(df) == 4  # 2 国 × 2 行业全覆盖
    assert not df.isna().any().any()
    assert df["degree_centrality"].between(0, 2).all()
    assert np.allclose(df["degree"], df["indegree"] + df["outdegree"])
    assert np.allclose(df["weighted_degree"], df["weighted_indegree"] + df["weighted_outdegree"])
    assert (df["betweenness_centrality"] >= 0).all()
    # fake_io 中所有行业间都有流量,度中心性应处处为正
    assert (df["degree_centrality"] > 0).all()


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
    expected = nx.betweenness_centrality(G, weight=None, normalized=True)

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
