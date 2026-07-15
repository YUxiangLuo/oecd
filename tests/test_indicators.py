"""指标计算的数学性质测试(合成小矩阵,不依赖真实数据)。

贸易流分解另有一份"按 WWZ (2013) Table A2 逐项直译"的暴力实现,
用来对照模块里向量化/化简后的公式,防止推导错误。
"""

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from conftest import FakeIOSystem
from gvcsim.indicators import length, network, production, tradeflow
from gvcsim.indicators.core import build_arrays


class _FactorInputs:
    def __init__(self, F: pd.DataFrame):
        self.F = F


def with_tls(io: FakeIOSystem, tls_ratio: float = 0.2) -> FakeIOSystem:
    """给测试夹具补上 factor_inputs.F(把残差 VA 拆成 VA 与 TLS 两行)。"""
    residual = io.x["indout"].to_numpy() - io.Z.to_numpy().sum(axis=0)
    F = pd.DataFrame(
        [residual * tls_ratio, residual * (1 - tls_ratio)],
        index=pd.Index(["TLS", "VA"], name="inputtype"),
        columns=io.Z.index,
    )
    io.factor_inputs = _FactorInputs(F)
    return io


def test_build_arrays_basics(fake_io):
    arr = build_arrays(fake_io)
    # 无 factor_inputs 时回退残差 VA:va = x - 中间投入列和,taxsub = 0
    assert np.allclose(arr.va, arr.x - arr.Z.sum(axis=0))
    assert np.allclose(arr.taxsub, 0.0)
    # 总产出完全分解:(v + t)'B = 1
    assert np.allclose((arr.v + arr.t) @ arr.B, np.ones(4))
    # AAA-s1 的出口 = 卖给 BBB 的中间品 (4+2) + 卖给 BBB 的最终品 (10)
    assert arr.E[0] == pytest.approx(16.0)


def test_build_arrays_with_tls(fake_io):
    arr = build_arrays(with_tls(fake_io))
    assert (arr.taxsub > 0).all()
    assert np.allclose(arr.va + arr.taxsub, arr.x - arr.Z.sum(axis=0))
    assert np.allclose((arr.v + arr.t) @ arr.B, np.ones(4))


def test_tradeflow_preserves_negative_net_subsidy_and_closure(fake_io):
    """负 TLS 沿供应链传播后仍可为负,但六项分解必须继续闭合。"""
    arr = build_arrays(with_tls(fake_io, tls_ratio=-0.1))
    df = tradeflow.sector_tradeflow(arr)
    exporting = arr.E > 0

    assert (arr.taxsub < 0).all()
    assert (df.loc[exporting, "taxsub"] < 0).all()
    assert np.allclose(tradeflow.gross_exports(df), arr.E)
    assert np.allclose((arr.v + arr.t) @ arr.B, np.ones(4))


# ---------------------------------------------------------------------------
# WWZ 16 项暴力实现(逐 (s, r) 双边直译 Table A2,再按伙伴求和)
# ---------------------------------------------------------------------------


def _wwz_bruteforce(arr) -> pd.DataFrame:
    n = len(arr.x)
    regions = arr.regions
    col_of = {r: i for i, r in enumerate(regions)}

    def blk(r):
        return arr.pos[r]

    def Y(r, c):  # 国家 r 生产、国家 c 消费的最终品向量
        return arr.Yd[blk(r), col_of[c]]

    out = {k: np.zeros(n) for k in ["DVAex", "DVArt", "DDC", "FVA", "FDC"]}
    for s in regions:
        p = blk(s)
        L_ss = arr.L_dd[s]
        vB_ss = arr.v[p] @ arr.B[np.ix_(p, p)]
        vL_ss = arr.v[p] @ L_ss
        others = [r for r in regions if r != s]
        # 外国增加值系数(t≠s 全部来源)
        f_coef = np.zeros(len(p))
        for t_ in others:
            f_coef += arr.v[blk(t_)] @ arr.B[np.ix_(blk(t_), p)]
        for r in others:
            q = blk(r)
            A_sr = arr.A[np.ix_(p, q)]
            B_rr = arr.B[np.ix_(q, q)]
            L_rr = arr.L_dd[r]
            third = [t_ for t_ in regions if t_ not in (s, r)]

            t1 = vB_ss * Y(s, r)
            t2 = vL_ss * (A_sr @ (B_rr @ Y(r, r)))
            t3 = np.zeros(len(p))
            t4 = vL_ss * (A_sr @ (B_rr @ sum((Y(r, t_) for t_ in third), np.zeros(len(q)))))
            t5 = np.zeros(len(p))
            for t_ in third:
                B_rt = arr.B[np.ix_(q, blk(t_))]
                t3 += vL_ss * (A_sr @ (B_rt @ Y(t_, t_)))
                y_tu = sum((Y(t_, u) for u in regions if u not in (s, t_)), np.zeros(len(blk(t_))))
                t5 += vL_ss * (A_sr @ (B_rt @ y_tu))
            t6 = vL_ss * (A_sr @ (B_rr @ Y(r, s)))
            t7 = np.zeros(len(p))
            for t_ in third:
                B_rt = arr.B[np.ix_(q, blk(t_))]
                t7 += vL_ss * (A_sr @ (B_rt @ Y(t_, s)))
            B_rs = arr.B[np.ix_(q, p)]
            t8 = vL_ss * (A_sr @ (B_rs @ Y(s, s)))
            y_s_exp = sum((Y(s, t_) for t_ in others), np.zeros(len(p)))
            t9 = vL_ss * (A_sr @ (B_rs @ y_s_exp))
            t10_left = np.zeros(len(p))
            for t_ in others:
                t10_left += vL_ss @ (arr.A[np.ix_(p, blk(t_))] @ arr.B[np.ix_(blk(t_), p)])
            t10 = t10_left * (A_sr @ arr.x[q])
            t11_14 = f_coef * Y(s, r) + f_coef * (A_sr @ (L_rr @ Y(r, r)))
            t15_16 = f_coef * (A_sr @ (L_rr @ arr.E[q]))

            out["DVAex"][p] += t1 + t2 + t3 + t4 + t5
            out["DVArt"][p] += t6 + t7 + t8
            out["DDC"][p] += t9 + t10
            out["FVA"][p] += t11_14
            out["FDC"][p] += t15_16
    df = pd.DataFrame(out, index=arr.index)
    df["taxsub"] = (arr.t @ arr.B) * arr.E
    df["EXDVA"] = df["DVAex"] + df["DVArt"]
    df.index.names = ["country", "industry"]
    return df


@pytest.mark.parametrize("fixture_name", ["fake_io", "cycle_io"])
def test_tradeflow_matches_wwz_bruteforce(fixture_name, request):
    """向量化贸易流分解 = 逐项直译的 WWZ 16 项(两套独立实现互证)。"""
    io = with_tls(request.getfixturevalue(fixture_name))
    arr = build_arrays(io)
    got = tradeflow.sector_tradeflow(arr)
    expected = _wwz_bruteforce(arr)
    for col in tradeflow.TRADE_COLUMNS:
        assert np.allclose(got[col], expected[col]), col


def test_tradeflow_closure(fake_io, cycle_io):
    """六个闭合项之和恒等于毛出口(含 TLS 与不含 TLS 两种口径)。"""
    for io in (fake_io, with_tls(cycle_io)):
        arr = build_arrays(io)
        df = tradeflow.sector_tradeflow(arr)
        assert np.allclose(tradeflow.gross_exports(df), arr.E)
        assert np.allclose(df["EXDVA"], df["DVAex"] + df["DVArt"])
        country = tradeflow.country_tradeflow(arr, df)
        agg = df.groupby(level=0).sum()
        assert np.allclose(country.values, agg[tradeflow.TRADE_COLUMNS].values)


def test_tradeflow_cycle_has_return_and_double_counting(cycle_io):
    """循环跨境链条应识别出返回国内增加值与国内/外国重复计算。"""
    arr = build_arrays(cycle_io)
    df = tradeflow.country_tradeflow(arr)
    assert (df["DVArt"] > 0).all()
    assert (df["DDC"] > 0).all()
    assert (df["FDC"] > 0).all()


def test_tradeflow_autarky(autarky_io):
    """封闭经济:没有出口,六项全为 0。"""
    arr = build_arrays(autarky_io)
    df = tradeflow.sector_tradeflow(arr)
    assert np.allclose(arr.E, 0)
    assert np.allclose(df[tradeflow.TRADE_COLUMNS], 0.0)


# ---------------------------------------------------------------------------
# 生产分解(WWYZ 2017a,前向 + 后向)
# ---------------------------------------------------------------------------


def test_production_forward_identities(fake_io):
    """前向:1+2+3 = SVA,3a+3b = 3,SVA = 增加值。"""
    arr = build_arrays(fake_io)
    df = production.sector_production(arr)
    assert np.allclose(df["1_VA_D"] + df["2_VA_RT"] + df["3_VA_GVC"], df["SVA"])
    assert np.allclose(df["3a_VA_GVC_S"] + df["3b_VA_GVC_C"], df["3_VA_GVC"])
    assert np.allclose(df["SVA"], arr.va)

    country = production.country_production(arr, df)
    agg = df.groupby(level=0).sum()
    assert np.allclose(country.values, agg[production.PRODUCTION_COLUMNS].values)


def test_production_backward_identities(fake_io):
    """后向:1+2+3 = FGY,3a+3b = 3;全球 FGY 总额 = 全球 SVA 总额。"""
    arr = build_arrays(with_tls(fake_io))
    df = production.sector_production(arr)
    assert np.allclose(df["1_FGY_D"] + df["2_FGY_RT"] + df["3_FGY_GVC"], df["FGY"])
    assert np.allclose(df["3a_FGY_GVC_S"] + df["3b_FGY_GVC_C"], df["3_FGY_GVC"])
    assert df["FGY"].sum() == pytest.approx(df["SVA"].sum())


def test_production_autarky(autarky_io):
    """封闭经济:增加值 100% 是纯国内,GVC/传统贸易段为 0(前向与后向)。"""
    arr = build_arrays(autarky_io)
    df = production.sector_production(arr)
    assert np.allclose(df["1_VA_D"], df["SVA"])
    for col in ["2_VA_RT", "3_VA_GVC", "3a_VA_GVC_S", "3b_VA_GVC_C"]:
        assert np.allclose(df[col], 0.0, atol=1e-9)
    assert np.allclose(df["1_FGY_D"], df["FGY"])
    for col in ["2_FGY_RT", "3_FGY_GVC"]:
        assert np.allclose(df[col], 0.0, atol=1e-9)


def test_production_cycle_has_complex_gvc(cycle_io):
    arr = build_arrays(cycle_io)
    df = production.country_production(arr)
    assert (df["3b_VA_GVC_C"] > 0).all()
    assert (df["3b_FGY_GVC_C"] > 0).all()


# ---------------------------------------------------------------------------
# 生产长度(WWYZ 2017b)
# ---------------------------------------------------------------------------


def test_length_properties(fake_io):
    arr = build_arrays(fake_io)
    df = length.sector_length(arr)
    # 每段长度至少为 1(增加值至少被自身产出计一次)
    for col in ["PLv", "PLv_D", "PLv_RT", "PLy", "PLy_D", "PLy_RT"]:
        assert (df[col] >= 1 - 1e-9).all(), col
    # GVC 段至少跨两个生产阶段
    assert (df["PLv_GVC"] >= 2 - 1e-9).all()
    assert (df["PLy_GVC"] >= 2 - 1e-9).all()
    # 位置指数定义
    assert np.allclose(df["Pos_TPL"], df["PLv"] / df["PLy"])
    assert np.allclose(df["GVCPs"], df["PLv_GVC"] / df["PLy_GVC"])
    # 后向的纯国内段与传统贸易段长度相同(最终品去向在比值中约去)
    assert np.allclose(df["PLy_D"], df["PLy_RT"])


def test_length_weighted_average_identity(fake_io):
    """总长度 = 各段长度按对应增加值份额的加权平均(WWYZ Figure 1)。"""
    arr = build_arrays(with_tls(fake_io))
    df = length.sector_length(arr)
    prod = production.sector_production(arr)
    lhs = (prod["1_VA_D"] * df["PLv_D"] + prod["2_VA_RT"] * df["PLv_RT"] + prod["3_VA_GVC"] * df["PLv_GVC"]) / prod[
        "SVA"
    ]
    assert np.allclose(lhs, df["PLv"])
    rhs = (prod["1_FGY_D"] * df["PLy_D"] + prod["2_FGY_RT"] * df["PLy_RT"] + prod["3_FGY_GVC"] * df["PLy_GVC"]) / prod[
        "FGY"
    ]
    assert np.allclose(rhs, df["PLy"])


def test_length_autarky(autarky_io):
    """封闭经济:GVC 段无从谈起(NaN),总长度 = 纯国内段长度。"""
    arr = build_arrays(autarky_io)
    df = length.sector_length(arr)
    assert df["PLv_GVC"].isna().all()
    assert df["PLy_GVC"].isna().all()
    assert df["GVCPs"].isna().all()
    assert np.allclose(df["PLv"], df["PLv_D"])


def test_country_length_is_va_weighted(fake_io):
    """国家级长度 = 分量按国加总后取比值,介于行业级最小/最大之间。"""
    arr = build_arrays(fake_io)
    sec = length.sector_length(arr)
    country = length.country_length(arr, sec)
    assert set(country.index) == {"AAA", "BBB"}
    for r in ["AAA", "BBB"]:
        lo, hi = sec.loc[r, "PLv"].min(), sec.loc[r, "PLv"].max()
        assert lo - 1e-9 <= country.loc[r, "PLv"] <= hi + 1e-9


# ---------------------------------------------------------------------------
# 网络指标（Gephi-compatible）
# ---------------------------------------------------------------------------


def test_network_metrics(fake_io):
    arr = build_arrays(fake_io)
    F = network.country_flow_matrix(arr)
    # 对角线(国内交易)不计入
    assert np.allclose(np.diag(F.values), 0)
    # AAA→BBB 总流 = 中间品块 (4+2+2+1) + 最终品 (10+5)
    assert F.loc["AAA", "BBB"] == pytest.approx(24.0)

    df = network.country_network(arr)
    assert list(df.columns) == network.NETWORK_COLUMNS
    # 两国互相连接:度 = 入度 + 出度 = 2
    assert np.allclose(df["degree"], 2.0)
    assert np.allclose(df["indegree"], 1.0)
    assert np.allclose(df["weighted degree"], df["weighted indegree"] + df["weighted outdegree"])
    assert df.loc["AAA", "weighted outdegree"] == pytest.approx(24.0)
    assert np.allclose(df["Eccentricity"], 1.0)
    assert np.allclose(df["closnesscentrality"], 1.0)
    assert np.allclose(df["harmonicclosnesscentrality"], 1.0)
    assert df["eigencentrality"].max() == pytest.approx(1.0)


def test_all_network_fields_match_gephi_0_10_1_golden_export():
    """冻结 Gephi Toolkit 0.10.1 的 directed/unweighted/unnormalized 输出。

    图同时覆盖正自环、非对称边、不同边权、汇点和隔离点；因此 11 个公开字段
    的方向、权重、自环、断连和特征向量语义都由同一份外部基准守护。
    """
    weights = np.zeros((5, 5))
    for source, target, value in [
        (0, 0, 5.0),
        (0, 1, 2.0),
        (1, 2, 3.0),
        (2, 0, 4.0),
        (0, 3, 7.0),
        (1, 3, 1.0),
    ]:
        weights[source, target] = value

    expected = pd.read_csv(
        Path(__file__).parent / "fixtures" / "gephi_0_10_1_directed_reference.csv",
        index_col="node",
    )
    actual = network._gephi_metrics(weights, list(expected.index))

    assert list(actual.columns) == list(expected.columns) == network.NETWORK_COLUMNS
    assert np.allclose(actual.to_numpy(), expected.to_numpy(), rtol=1e-12, atol=1e-12)


def test_path_metrics_follow_outgoing_gephi_distances():
    """断连有向链按出边计算可达数、距离和与距离倒数平均。"""
    adj = np.array(
        [
            [0, 1, 0, 0],
            [0, 0, 1, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
        ],
        dtype=bool,
    )
    got = network._path_metrics(adj)
    assert np.allclose(got["closnesscentrality"], [2 / 3, 1.0, 0.0, 0.0])
    assert np.allclose(got["harmonicclosnesscentrality"], [0.75, 1.0, 0.0, 0.0])
    assert np.allclose(got["Eccentricity"], [2.0, 1.0, 0.0, 0.0])


def test_sector_network(fake_io):
    """行业级网络:索引齐全,数值性质合理。"""
    arr = build_arrays(fake_io)
    df = network.sector_network(arr)
    assert list(df.index.names) == ["country", "industry"]
    assert len(df) == 4  # 2 国 × 2 行业全覆盖
    assert not df.isna().any().any()
    # Z 全正且保留正自环 → 每个节点出/入度均为 4，自环在总度中计两次。
    assert np.allclose(df["indegree"], 4.0)
    assert np.allclose(df["outdegree"], 4.0)
    assert np.allclose(df["degree"], 8.0)
    assert np.allclose(df["weighted outdegree"], arr.Z.sum(axis=1))
    assert np.allclose(df["weighted indegree"], arr.Z.sum(axis=0))
    assert (df["betweenesscentrality"] >= 0).all()


def test_betweenness_is_exact_directed_raw_brandes():
    # 菱形图 0→{1,2}→3 的两条等长最短路各给中间节点 1/2 原始介数。
    adj = np.array(
        [
            [0, 1, 1, 0],
            [0, 0, 0, 1],
            [0, 0, 0, 1],
            [0, 0, 0, 0],
        ],
        dtype=bool,
    )
    assert np.allclose(network._betweenness_centrality(adj), [0.0, 0.5, 0.5, 0.0])


def test_degree_keeps_positive_self_loops_and_ignores_nonpositive_values():
    weights = np.array([[5.0, -2.0], [3.0, np.nan]])
    got = network._gephi_metrics(weights, ["a", "b"])

    assert np.allclose(got["outdegree"], [1.0, 1.0])
    assert np.allclose(got["indegree"], [2.0, 0.0])
    assert np.allclose(got["degree"], [3.0, 1.0])
    assert np.allclose(got["weighted outdegree"], [5.0, 3.0])
    assert np.allclose(got["weighted indegree"], [8.0, 0.0])
    assert np.allclose(got["weighted degree"], [13.0, 3.0])


def test_eigencentrality_reproduces_gephi_directed_100_iteration_result():
    adj = np.array(
        [
            [1, 1, 0],
            [0, 0, 1],
            [1, 0, 0],
        ],
        dtype=bool,
    )
    got = network._eigencentrality(adj)

    assert np.allclose(got, [1.0, 0.68321439, 0.46445021], atol=1e-8)


def test_empty_network_maps_all_metrics_to_zero():
    got = network._gephi_metrics(np.zeros((3, 3)), ["a", "b", "c"])

    assert list(got.columns) == network.NETWORK_COLUMNS
    assert np.allclose(got.to_numpy(), 0.0)
