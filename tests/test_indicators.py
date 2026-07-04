"""指标计算的数学性质测试(合成小矩阵,不依赖真实数据)。"""

import numpy as np
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
    assert df["share_trade_backward_gvc"].between(0, 1).all()
    assert (df["share_trade_forward_gvc"] > 0).all()

    sector = tradeflow.sector_tradeflow(arr)
    accounted_s = sector[["trade_dva", "trade_rdv", "trade_ddc", "trade_fva", "trade_fdc"]].sum(axis=1)
    assert np.allclose(accounted_s, sector["trade_gross_exports"])
    assert sector["share_trade_dva"].between(0, 1).all()


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
    # 总增加值应等于 va 向量按国加总
    va_by_country = {
        r: arr.va[arr.pos[r]].sum() for r in arr.regions
    }
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

    country = production.country_production(arr)
    agg = sec[["prod_va_total", "prod_pure_domestic", "prod_traditional", "prod_simple_gvc", "prod_complex_gvc"]] \
        .groupby(level=0).sum()
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

    # 封闭经济:跨境段为0,总长度=国内段
    arr_a = build_arrays(autarky_io)
    df_a = length.sector_length(arr_a)
    assert np.allclose(df_a["upstreamness_cross"], 0.0, atol=1e-9)

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
    assert (df["eigenvector_centrality"] > 0).all()


def test_sector_network(fake_io):
    """行业级网络:索引齐全,小图走精确介数,数值性质合理。"""
    arr = build_arrays(fake_io)
    df = network.sector_network(arr)
    assert list(df.index.names) == ["country", "sector"]
    assert len(df) == 4  # 2 国 × 2 行业全覆盖
    assert not df.isna().any().any()
    assert df["degree_centrality"].between(0, 2).all()
    assert (df["betweenness_centrality"] >= 0).all()
    # fake_io 中所有行业间都有流量,度中心性应处处为正
    assert (df["degree_centrality"] > 0).all()
