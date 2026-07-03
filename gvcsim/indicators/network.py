"""步骤7:全球生产网络指标。

把国家间贸易流(中间品+最终品)看作带权有向图,计算三类中心性:
  degree_centrality       加权度(强度):贸易连接的总量
  betweenness_centrality  介数:作为供应链"咽喉/中转枢纽"的重要性
  eigenvector_centrality  特征向量:与重要节点相连的程度
"""

import networkx as nx
import numpy as np
import pandas as pd

from gvcsim.indicators.core import IcioArrays

# 过滤掉占总流量比例低于该阈值的边,去噪并让介数中心性可解释
EDGE_SHARE_THRESHOLD = 1e-4


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
    # 特征向量中心性在有向图上可能不收敛,退化为无向图计算(幂迭代,免 scipy)
    eigen = nx.eigenvector_centrality(G.to_undirected(), weight="weight", max_iter=1000)

    df = pd.DataFrame(
        {
            "degree_centrality": strength,
            "betweenness_centrality": betweenness,
            "eigenvector_centrality": eigen,
        }
    )
    df.index.name = "country"
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
