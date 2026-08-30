"""步骤 6：按 Gephi 口径计算全球生产网络指标。

国家级图由国家间中间品与最终品贸易流构成，不含国内边；行业级图以
``(country, industry)`` 为节点，以完整中间品流量矩阵 ``Z`` 为邻接矩阵。

指标字段名沿用既有数据接口（包括 Gephi 使用的历史拼写）。计算语义与
Gephi Graph Distance / Eigenvector Centrality 的有向无权设置一致：所有正流量
都是边，自环保留；路径从节点沿出边计算；介数为未归一化的精确 Brandes
结果；``eigencentrality`` 精确复现 Gephi Toolkit 0.10.1 的 100 次累计入边
迭代。该字段是软件兼容分数，不宣称等同于标准 Perron 特征向量幂迭代。
"""

from typing import Any

import networkit as nk
import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import shortest_path

from gvcsim.indicators.core import IcioArrays

NETWORK_COLUMNS = [
    "degree",
    "indegree",
    "outdegree",
    "weighted degree",
    "weighted indegree",
    "weighted outdegree",
    "Eccentricity",
    "closnesscentrality",
    "harmonicclosnesscentrality",
    "betweenesscentrality",
    "eigencentrality",
]


def country_flow_matrix(arr: IcioArrays) -> pd.DataFrame:
    """国家×国家双边总贸易流 F_rs（r 卖给 s，不含国内交易）。"""
    n_r = arr.n_regions
    col_of = {r: j for j, r in enumerate(arr.regions)}
    flow = np.zeros((n_r, n_r))
    for i, region in enumerate(arr.regions):
        source_positions = arr.pos[region]
        for j, destination in enumerate(arr.regions):
            if destination == region:
                continue
            flow[i, j] = (
                arr.Z[np.ix_(source_positions, arr.pos[destination])].sum()
                + arr.Yd[source_positions, col_of[destination]].sum()
            )
    return pd.DataFrame(flow, index=arr.regions, columns=arr.regions)


def _positive_weights(weights: np.ndarray) -> np.ndarray:
    """返回 Gephi 会识别为边的有限正权重，保留正自环。"""
    matrix = np.asarray(weights, dtype=float)
    if matrix.ndim != 2 or matrix.shape[0] != matrix.shape[1]:
        raise ValueError("网络邻接矩阵必须是方阵")
    return np.where(np.isfinite(matrix) & (matrix > 0), matrix, 0.0)


def _degree_metrics(weights: np.ndarray) -> dict[str, np.ndarray]:
    """全部正边上的有向度与加权度；自环分别计入入度和出度。"""
    mask = weights > 0
    outdegree = mask.sum(axis=1).astype(float)
    indegree = mask.sum(axis=0).astype(float)
    weighted_outdegree = weights.sum(axis=1)
    weighted_indegree = weights.sum(axis=0)
    return {
        "degree": outdegree + indegree,
        "indegree": indegree,
        "outdegree": outdegree,
        "weighted degree": weighted_outdegree + weighted_indegree,
        "weighted indegree": weighted_indegree,
        "weighted outdegree": weighted_outdegree,
    }


def _path_metrics(adj_mask: np.ndarray) -> dict[str, np.ndarray]:
    """计算 Gephi Graph Distance 的有向、无权、沿出边路径指标。"""
    if adj_mask.shape[0] == 0:
        empty = np.zeros(0, dtype=float)
        return {
            "Eccentricity": empty.copy(),
            "closnesscentrality": empty.copy(),
            "harmonicclosnesscentrality": empty.copy(),
        }
    graph = csr_matrix(adj_mask.astype(np.int8))
    distances = shortest_path(graph, method="auto", directed=True, unweighted=True)
    np.fill_diagonal(distances, np.inf)

    reachable = np.isfinite(distances)
    reachable_count = reachable.sum(axis=1).astype(float)
    distance_sum = np.where(reachable, distances, 0.0).sum(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        eccentricity = np.where(
            reachable_count > 0,
            np.where(reachable, distances, -np.inf).max(axis=1),
            0.0,
        )
        closeness = np.where(distance_sum > 0, reachable_count / distance_sum, 0.0)
        inverse_distances = np.where(reachable, 1.0 / distances, 0.0)
        harmonic = np.where(
            reachable_count > 0,
            inverse_distances.sum(axis=1) / reachable_count,
            0.0,
        )
    return {
        "Eccentricity": eccentricity,
        "closnesscentrality": closeness,
        "harmonicclosnesscentrality": harmonic,
    }


def _betweenness_centrality(adj_mask: np.ndarray) -> np.ndarray:
    """计算有向无权图的精确、未归一化 Brandes 介数中心性。"""
    node_count = adj_mask.shape[0]
    if node_count == 0 or not adj_mask.any():
        return np.zeros(node_count)

    graph = nk.Graph(node_count, weighted=False, directed=True)
    source, target = np.nonzero(adj_mask)
    graph.addEdges((source.astype(np.int64), target.astype(np.int64)))
    algorithm = nk.centrality.Betweenness(graph, normalized=False, computeEdgeCentrality=False)
    return np.asarray(algorithm.run().scores(), dtype=float)


def _eigencentrality(adj_mask: np.ndarray) -> np.ndarray:
    """复现 Gephi 0.10.1 的累计入边兼容分数（固定 100 次）。

    ``accumulated`` 有意跨迭代保留，以匹配冻结的 Gephi 外部基准；这不是
    标准 Perron 特征向量的幂迭代，教学界面必须按兼容分数标注。
    """
    node_count = adj_mask.shape[0]
    if node_count == 0 or not adj_mask.any():
        return np.zeros(node_count)

    adjacency = csr_matrix(adj_mask.astype(float))
    centrality = np.ones(node_count, dtype=float)
    accumulated = np.zeros(node_count, dtype=float)
    for _ in range(100):
        accumulated += adjacency.T @ centrality
        maximum = float(accumulated.max(initial=0.0))
        centrality = accumulated / maximum if maximum > 0 else np.zeros(node_count)
    return centrality


def _gephi_metrics(weights: np.ndarray, nodes: list[Any]) -> pd.DataFrame:
    """在全部正流量边上计算并返回既有 11 列网络指标。"""
    positive = _positive_weights(weights)
    if positive.shape[0] != len(nodes):
        raise ValueError("节点数量与网络邻接矩阵维度不一致")

    metrics = _degree_metrics(positive)
    full_mask = positive > 0

    # 隔离节点不参与昂贵的全源最短路和 Brandes，最后映射回全零指标。
    active = full_mask.any(axis=0) | full_mask.any(axis=1)
    active_positions = np.flatnonzero(active)
    active_mask = full_mask[np.ix_(active_positions, active_positions)]

    path_metrics = _path_metrics(active_mask)
    for name, active_values in path_metrics.items():
        values = np.zeros(len(nodes), dtype=float)
        values[active_positions] = active_values
        metrics[name] = values

    eigenvector = np.zeros(len(nodes), dtype=float)
    eigenvector[active_positions] = _eigencentrality(active_mask)
    metrics["eigencentrality"] = eigenvector

    betweenness = np.zeros(len(nodes), dtype=float)
    betweenness[active_positions] = _betweenness_centrality(active_mask)
    metrics["betweenesscentrality"] = betweenness

    return pd.DataFrame(metrics, columns=NETWORK_COLUMNS, index=nodes)


def country_network(arr: IcioArrays) -> pd.DataFrame:
    """国家级网络指标，索引为 ``country``。"""
    flow = country_flow_matrix(arr)
    result = _gephi_metrics(flow.values, list(flow.index))
    result.index.name = "country"
    return result


def sector_network(arr: IcioArrays) -> pd.DataFrame:
    """全球国家×行业生产网络指标，索引为 ``(country, industry)``。"""
    nodes = list(arr.index)
    result = _gephi_metrics(arr.Z, nodes)
    result.index = pd.MultiIndex.from_tuples(nodes, names=["country", "industry"])
    return result


def network_edges(arr: IcioArrays, top_n: int = 120) -> pd.DataFrame:
    """取有限正流量最大的 ``top_n`` 条国家间边供前端网络图渲染。"""
    if isinstance(top_n, (bool, np.bool_)) or not isinstance(top_n, (int, np.integer)) or top_n <= 0:
        raise ValueError("top_n 必须是正整数")

    flow = country_flow_matrix(arr)
    edges = (
        flow.rename_axis(index="source", columns="target")
        .stack()
        .rename("flow")
        .reset_index()
        .reindex(columns=["source", "target", "flow"])
    )
    edges["flow"] = pd.to_numeric(edges["flow"], errors="coerce")
    values = edges["flow"].to_numpy(dtype=float)
    eligible = edges["source"].astype(str).ne(edges["target"].astype(str)) & np.isfinite(values) & (values > 0)
    edges = edges.loc[eligible, ["source", "target", "flow"]]
    return (
        edges.sort_values(
            ["flow", "source", "target"],
            ascending=[False, True, True],
            kind="mergesort",
        )
        .head(int(top_n))
        .reset_index(drop=True)
    )
