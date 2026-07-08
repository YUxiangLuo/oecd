"""步骤7:全球生产网络指标(客户资料/Gephi 风格口径)。

国家级:国家间贸易流(中间品+最终品)构成带权有向图。
行业级:以 (国家, 行业) 为节点、中间品流 Z 为边的全球生产网络
(含国内行业间边;最终需求不是生产节点,不计入)。

输出客户样例数据的 11 列(列名与拼写照抄客户 CSV):
  degree / indegree / outdegree                      无权有向边数量(全部正流量边)
  weighted degree / weighted indegree / weighted outdegree  边权(流量金额)加总
  Eccentricity              到最远可达节点的距离(无权有向最短路)
  closnesscentrality        接近中心性(NetworkX 有向默认:其他节点到该节点的距离)
  harmonicclosnesscentrality 调和中心性(NetworkX 有向默认:其他节点到该节点的距离倒数和)
  betweenesscentrality      介数中心性(Brandes,无权最短路,原始计数不归一)
  eigencentrality           特征向量中心性(无权无向对称化,按最大值归一,Gephi 口径)

与客户的 Gephi 口径一致:度/加权度在全部正流量边上计数/求和;路径类指标、
介数与特征向量中心性在按流量占比阈值过滤后的无权图上计算。介数使用
NetworkX Brandes;其他全源最短路用 scipy C 实现复现 NetworkX 默认定义。
"""

import networkx as nx
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

# 过滤掉占总流量比例低于该阈值的边,去噪并让路径类指标可解释
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


def _degree_metrics(W: np.ndarray) -> dict[str, np.ndarray]:
    """全部正边(去自环)上的度与加权度。W 为带权邻接矩阵(行→列)。"""
    W = W.copy()
    np.fill_diagonal(W, 0.0)
    mask = W > 0
    outdeg = mask.sum(axis=1).astype(float)
    indeg = mask.sum(axis=0).astype(float)
    w_out = W.sum(axis=1)
    w_in = W.sum(axis=0)
    return {
        "degree": outdeg + indeg,
        "indegree": indeg,
        "outdegree": outdeg,
        "weighted degree": w_out + w_in,
        "weighted indegree": w_in,
        "weighted outdegree": w_out,
    }


def _path_metrics(adj_mask: np.ndarray) -> dict[str, np.ndarray]:
    """阈值图上的无权有向最短路指标。

    closeness / harmonic 复现 NetworkX 对 DiGraph 的默认定义:使用其他节点
    到该节点的距离(inward distance)。Eccentricity 沿用 Gephi 可达口径:
    取该节点出发能到达节点的最远距离;无可达节点时记 0,避免断连图报错。
    """
    n = adj_mask.shape[0]
    graph = csr_matrix(adj_mask.astype(np.int8))
    D = shortest_path(graph, method="auto", directed=True, unweighted=True)
    np.fill_diagonal(D, np.inf)  # 自身不计入
    out_finite = np.isfinite(D)
    in_finite = out_finite.T
    in_reach = in_finite.sum(axis=1).astype(float)
    in_dist_sum = np.where(in_finite, D.T, 0.0).sum(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        out_reach = out_finite.sum(axis=1)
        ecc = np.where(out_reach > 0, np.where(out_finite, D, -np.inf).max(axis=1), 0.0)
        closeness = np.where(in_dist_sum > 0, in_reach / in_dist_sum, 0.0)
        if n > 1:
            closeness *= in_reach / (n - 1)
        harmonic = np.where(in_finite, 1.0 / np.where(in_finite, D.T, 1.0), 0.0).sum(axis=1)
    return {
        "Eccentricity": ecc,
        "closnesscentrality": closeness,
        "harmonicclosnesscentrality": harmonic,
    }


def _betweenness_centrality(G: nx.DiGraph) -> dict:
    """介数中心性:无权最短路、原始计数(Gephi 风格);超大图退回源点抽样。"""
    k = None
    if G.number_of_nodes() > BETWEENNESS_EXACT_NODE_LIMIT:
        k = min(BETWEENNESS_SAMPLE_K, G.number_of_nodes())
    return nx.betweenness_centrality(G, k=k, weight=None, normalized=False, seed=BETWEENNESS_SEED)


def _eigencentrality(W: np.ndarray, *, max_iter: int = 2000, tol: float = 1e-10) -> np.ndarray:
    """特征向量中心性:无向对称化 (W+W')/2 的主特征向量,按最大值归一。

    Gephi 的 eigenvector centrality 是无权算法,调用方传入 0/1 邻接矩阵即可对齐;
    用幂迭代(对称非负矩阵的 Perron 向量),规模 ~3500 时毫秒级;全零图返回 0。
    """
    S = (W + W.T) / 2.0
    np.fill_diagonal(S, 0.0)
    if not S.any():
        return np.zeros(S.shape[0])
    scale = S.max()
    # 加单位阵位移:二部结构的图谱有 ±λ 成对特征值,裸幂迭代会震荡不收敛;
    # S/scale + I 把谱整体右移,不改变主特征向量。
    S = S / scale + np.eye(S.shape[0])
    v = np.ones(S.shape[0]) / S.shape[0]
    for _ in range(max_iter):
        nxt = S @ v
        norm = np.linalg.norm(nxt)
        if norm <= 0:
            return np.zeros(S.shape[0])
        nxt = nxt / norm
        if np.linalg.norm(nxt - v) < tol:
            v = nxt
            break
        v = nxt
    v = np.abs(v)
    peak = v.max()
    return v / peak if peak > 0 else v


def _gephi_metrics(W: np.ndarray, nodes: list, threshold_share: float) -> pd.DataFrame:
    """给定带权邻接矩阵输出 11 列指标:度类走全边,路径/介数/特征向量走阈值图。"""
    total = float(W.sum())
    full = W.copy()
    np.fill_diagonal(full, 0.0)
    metrics = _degree_metrics(full)

    thresholded = full.copy()
    if total > 0:
        thresholded[thresholded / total <= threshold_share] = 0.0
    else:
        thresholded[:] = 0.0
    threshold_mask = thresholded > 0
    metrics.update(_path_metrics(threshold_mask))
    metrics["eigencentrality"] = _eigencentrality(threshold_mask.astype(float))

    G = nx.DiGraph()
    G.add_nodes_from(range(len(nodes)))
    src, dst = np.nonzero(thresholded)
    G.add_weighted_edges_from((int(i), int(j), float(thresholded[i, j])) for i, j in zip(src, dst))
    betweenness = _betweenness_centrality(G)
    metrics["betweenesscentrality"] = np.array([betweenness.get(i, 0.0) for i in range(len(nodes))])

    return pd.DataFrame(metrics, columns=NETWORK_COLUMNS, index=nodes)


def country_network(arr: IcioArrays) -> pd.DataFrame:
    """国家级网络指标,索引 country。"""
    F = country_flow_matrix(arr)
    df = _gephi_metrics(F.values, list(F.index), EDGE_SHARE_THRESHOLD)
    df.index.name = "country"
    return df


def sector_network(arr: IcioArrays) -> pd.DataFrame:
    """行业级网络指标,索引 (country, industry)。

    节点 = 国家×行业,边 = 中间品流 Z(去自环)。度类在全部正边上计算;
    路径类/介数/特征向量在阈值化无权图上计算;介数默认精确 Brandes,超过
    BETWEENNESS_EXACT_NODE_LIMIT 个节点后退回源点抽样。
    """
    nodes = list(arr.index)
    df = _gephi_metrics(arr.Z, nodes, SECTOR_EDGE_SHARE_THRESHOLD)
    df.index = pd.MultiIndex.from_tuples(nodes, names=["country", "industry"])
    return df


def network_edges(arr: IcioArrays, top_n: int = 120) -> pd.DataFrame:
    """取流量最大的 top_n 条边,供前端网络图渲染(节点太多画不动)。"""
    F = country_flow_matrix(arr)
    edges = F.stack().rename("flow").reset_index().rename(columns={"level_0": "source", "level_1": "target"})
    edges = edges[edges["source"] != edges["target"]]
    return edges.nlargest(top_n, "flow").reset_index(drop=True)
