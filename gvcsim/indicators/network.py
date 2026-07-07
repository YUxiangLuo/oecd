"""步骤7:全球生产网络指标。

国家级:国家间贸易流(中间品+最终品)构成带权有向图。
行业级:以 (国家, 行业) 为节点、中间品流 Z 为边的全球生产网络
(含国内行业间边;最终需求不是生产节点,不计入)。

客户资料/Gephi 风格指标:
  degree / indegree / outdegree                    无权有向边数量
  weighted_degree / weighted_indegree / weighted_outdegree  边权重强度
  eccentricity / closeness_centrality / harmonic_closeness_centrality
  betweenness_centrality / eigenvector_centrality

兼容字段:
  degree_centrality = weighted_degree / 全图流量,供旧前端和回归链路继续使用。
"""

import networkx as nx
import numpy as np
import pandas as pd
from scipy.sparse.linalg import ArpackNoConvergence

from gvcsim.indicators.core import IcioArrays

# 过滤掉占总流量比例低于该阈值的边,去噪并让介数中心性可解释
EDGE_SHARE_THRESHOLD = 1e-4

# 行业级图更稀疏,阈值放低才能保留有意义的国内/跨境链条
SECTOR_EDGE_SHARE_THRESHOLD = 1e-6

# 行业级图约 3465 个节点,离线 compute 默认跑精确 Brandes。
# 若将来接更细粒度行业/企业图,超过该阈值后自动退回固定 seed 的源点抽样。
BETWEENNESS_EXACT_NODE_LIMIT = 5000
BETWEENNESS_SAMPLE_K = 1200
BETWEENNESS_SEED = 12345


def country_flow_matrix(arr: IcioArrays) -> pd.DataFrame:
    """国家×国家双边总贸易流 F_rs(r 卖给 s,不含国内交易)。"""
    n_r = arr.n_regions
    col_of = {r: j for j, r in enumerate(arr.regions)}
    F = np.zeros((n_r, n_r))
    for i, r in enumerate(arr.regions):
        p = arr.pos[r]
        for j, s in enumerate(arr.regions):
            if s == r:
                continue
            F[i, j] = arr.Z[np.ix_(p, arr.pos[s])].sum() + arr.Yd[p, col_of[s]].sum()
    return pd.DataFrame(F, index=arr.regions, columns=arr.regions)


def country_network(arr: IcioArrays) -> pd.DataFrame:
    F = country_flow_matrix(arr)
    total = float(F.values.sum())

    G = nx.DiGraph()
    G.add_nodes_from(F.index)
    for r in F.index:
        for s in F.columns:
            w = F.loc[r, s]
            if total > 0 and r != s and w / total > EDGE_SHARE_THRESHOLD:
                G.add_edge(r, s, weight=float(w))

    df = _gephi_like_metrics(G, list(F.index), total)
    df.index.name = "country"
    return df


def _eigenvector_centrality(
    G: nx.Graph | nx.DiGraph,
    *,
    max_iter: int = 2000,
    tol: float = 1e-6,
) -> dict:
    """特征向量中心性:优先使用 scipy/ARPACK,断连或不收敛时回退幂迭代。"""
    H = G.to_undirected()
    if H.number_of_edges() == 0:
        return {n: 0.0 for n in H.nodes}
    if H.number_of_nodes() <= 2:
        values = nx.eigenvector_centrality(H, weight="weight", max_iter=max_iter, tol=tol)
        return {n: float(values.get(n, 0.0)) for n in H.nodes}
    try:
        values = nx.eigenvector_centrality_numpy(H, weight="weight")
    except (ArpackNoConvergence, nx.NetworkXException, TypeError, ValueError):
        values = nx.eigenvector_centrality(H, weight="weight", max_iter=max_iter, tol=tol)
    return {n: float(values.get(n, 0.0)) for n in H.nodes}


def _betweenness_centrality(G: nx.DiGraph) -> dict:
    """介数中心性:默认精确;超大图时退回抽样,避免 compute 失控。"""
    k = None
    if G.number_of_nodes() > BETWEENNESS_EXACT_NODE_LIMIT:
        k = min(BETWEENNESS_SAMPLE_K, G.number_of_nodes())
    return nx.betweenness_centrality(
        G,
        k=k,
        weight=None,
        normalized=True,
        seed=BETWEENNESS_SEED,
    )


def _directed_eccentricity(G: nx.DiGraph) -> dict:
    """有向无权图离心率:不可达节点不计;没有可达邻点时记 0。"""
    out = {}
    for node in G.nodes:
        lengths = nx.single_source_shortest_path_length(G, node)
        vals = [d for target, d in lengths.items() if target != node]
        out[node] = float(max(vals)) if vals else 0.0
    return out


def _gephi_like_metrics(G: nx.DiGraph, nodes: list, total_weight: float) -> pd.DataFrame:
    """输出客户资料中列出的 Gephi 风格网络指标。

    路径类指标按无权有向图计算;weighted_* 与 eigenvector 使用边权重。
    """
    weighted_degree = {
        n: float(G.out_degree(n, weight="weight") + G.in_degree(n, weight="weight")) for n in nodes
    }
    weighted_indegree = {n: float(G.in_degree(n, weight="weight")) for n in nodes}
    weighted_outdegree = {n: float(G.out_degree(n, weight="weight")) for n in nodes}
    degree_centrality = {
        n: (weighted_degree[n] / total_weight if total_weight > 0 else 0.0) for n in nodes
    }

    df = pd.DataFrame(
        {
            "degree": {n: float(G.degree(n)) for n in nodes},
            "indegree": {n: float(G.in_degree(n)) for n in nodes},
            "outdegree": {n: float(G.out_degree(n)) for n in nodes},
            "weighted_degree": weighted_degree,
            "weighted_indegree": weighted_indegree,
            "weighted_outdegree": weighted_outdegree,
            "degree_centrality": degree_centrality,
            "eccentricity": _directed_eccentricity(G),
            "closeness_centrality": nx.closeness_centrality(G) if G.number_of_nodes() else {},
            "harmonic_closeness_centrality": nx.harmonic_centrality(G) if G.number_of_nodes() else {},
            "betweenness_centrality": _betweenness_centrality(G),
            "eigenvector_centrality": _eigenvector_centrality(G),
        }
    )
    return df.reindex(nodes).fillna(0.0)


def sector_network(arr: IcioArrays) -> pd.DataFrame:
    """行业级网络中心性,索引 (country, sector)。

    节点 = 国家×行业,边 = 中间品流 Z(去自环、按占比阈值过滤)。
    介数默认精确计算;超过 BETWEENNESS_EXACT_NODE_LIMIT 个节点后退回源点抽样。
    被阈值过滤成孤立点的行业中心性记 0。
    """
    total = float(arr.Z.sum())
    nodes = list(arr.index)

    G = nx.DiGraph()
    G.add_nodes_from(nodes)
    if total > 0:
        src, dst = np.where(arr.Z / total > SECTOR_EDGE_SHARE_THRESHOLD)
        for i, j in zip(src, dst):
            if i == j:
                continue
            w = float(arr.Z[i, j])
            G.add_edge(nodes[i], nodes[j], weight=w)

    df = _gephi_like_metrics(G, nodes, total)
    df.index = pd.MultiIndex.from_tuples(nodes, names=["country", "sector"])
    return df


def network_edges(arr: IcioArrays, top_n: int = 120) -> pd.DataFrame:
    """取流量最大的 top_n 条边,供前端网络图渲染(节点太多画不动)。"""
    F = country_flow_matrix(arr)
    edges = F.stack().rename("flow").reset_index().rename(columns={"level_0": "source", "level_1": "target"})
    edges = edges[edges["source"] != edges["target"]]
    return edges.nlargest(top_n, "flow").reset_index(drop=True)
