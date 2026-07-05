"""步骤7:全球生产网络指标。

国家级:国家间贸易流(中间品+最终品)构成带权有向图。
行业级:以 (国家, 行业) 为节点、中间品流 Z 为边的全球生产网络
(含国内行业间边;最终需求不是生产节点,不计入)。

三类中心性:
  degree_centrality       加权度(强度):贸易连接的总量
  betweenness_centrality  介数:作为供应链"咽喉/中转枢纽"的重要性
  eigenvector_centrality  特征向量:与重要节点相连的程度
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
    total = F.values.sum()

    G = nx.DiGraph()
    G.add_nodes_from(F.index)
    for r in F.index:
        for s in F.columns:
            w = F.loc[r, s]
            if r != s and w / total > EDGE_SHARE_THRESHOLD:
                G.add_edge(r, s, weight=float(w), distance=float(total / w))

    strength = {
        n: (G.out_degree(n, weight="weight") + G.in_degree(n, weight="weight")) / total
        for n in G.nodes
    }
    betweenness = nx.betweenness_centrality(G, weight="distance", normalized=True)
    eigen = _eigenvector_centrality(G)

    df = pd.DataFrame(
        {
            "degree_centrality": strength,
            "betweenness_centrality": betweenness,
            "eigenvector_centrality": eigen,
        }
    )
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
        weight="distance",
        normalized=True,
        seed=BETWEENNESS_SEED,
    )


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
    src, dst = np.where(arr.Z / total > SECTOR_EDGE_SHARE_THRESHOLD)
    for i, j in zip(src, dst):
        if i == j:
            continue
        w = float(arr.Z[i, j])
        G.add_edge(nodes[i], nodes[j], weight=w, distance=total / w)

    strength = {
        n: (G.out_degree(n, weight="weight") + G.in_degree(n, weight="weight")) / total
        for n in G.nodes
    }
    betweenness = _betweenness_centrality(G)
    eigen = _eigenvector_centrality(G)

    df = pd.DataFrame(
        {
            "degree_centrality": strength,
            "betweenness_centrality": betweenness,
            "eigenvector_centrality": eigen,
        }
    ).reindex(nodes).fillna(0.0)
    df.index = pd.MultiIndex.from_tuples(nodes, names=["country", "sector"])
    return df


def network_edges(arr: IcioArrays, top_n: int = 120) -> pd.DataFrame:
    """取流量最大的 top_n 条边,供前端网络图渲染(节点太多画不动)。"""
    F = country_flow_matrix(arr)
    edges = (
        F.stack().rename("flow").reset_index()
        .rename(columns={"level_0": "source", "level_1": "target"})
    )
    edges = edges[edges["source"] != edges["target"]]
    return edges.nlargest(top_n, "flow").reset_index(drop=True)
