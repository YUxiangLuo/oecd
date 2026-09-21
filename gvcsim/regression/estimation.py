"""Two-way fixed-effect estimation and disconnected-effect accounting."""

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy import stats
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components

from gvcsim.concurrency import check_cancelled
from gvcsim.regression.model import CoefStat, PreparedModel, RegressionResult


@dataclass(frozen=True)
class FixedEffectStructure:
    rank: int
    components: int
    nonreference_times: pd.Index


def fixed_effect_structure(data: pd.DataFrame, entity: str, time: str) -> FixedEffectStructure:
    check_cancelled()
    ec, entities = pd.factorize(data[entity], sort=False)
    tc, times = pd.factorize(data[time], sort=True)
    vertices = len(entities) + len(times)
    graph = csr_matrix((np.ones(len(data), dtype=bool), (ec, len(entities) + tc)), shape=(vertices, vertices))
    components, labels = connected_components(graph, directed=False)
    _, references = np.unique(labels[len(entities) :], return_index=True)
    keep = np.ones(len(times), dtype=bool)
    keep[references] = False
    return FixedEffectStructure(vertices - int(components), int(components), times[keep])


def require_finite(label: str, *values) -> None:
    if any(not np.isfinite(np.asarray(value, dtype=float)).all() for value in values):
        raise ValueError(f"{label}产生非有限数值，已停止返回结果")


def twoway_demean(
    values: np.ndarray, ent: np.ndarray, tim: np.ndarray, tol: float = 1e-10, max_iter: int = 200
) -> np.ndarray:
    if not math.isfinite(tol) or tol <= 0:
        raise ValueError("双向去均值容差必须为正的有限数")
    if max_iter <= 0:
        raise ValueError("双向去均值迭代次数必须为正数")
    out = values.astype(float).copy()
    require_finite("双向去均值输入", out)
    residual = math.inf
    for iteration in range(1, max_iter + 1):
        before = out.copy()
        for groups in (ent, tim):
            frame = pd.DataFrame(out)
            out = (frame - frame.groupby(groups).transform("mean")).values
        require_finite("双向去均值", out)
        if np.abs(out - before).max() < tol or iteration == max_iter:
            residual = max(float(pd.DataFrame(out).groupby(g).mean().abs().to_numpy().max()) for g in (ent, tim))
            if residual < tol:
                return out
    raise ValueError(f"双向去均值在 {max_iter} 次迭代后未收敛（最大组均值残差 {residual:.3g}）；无法继续估计")


def drop_collinear_columns(X, xcols, protected, tol=1e-10):
    keep = [i for i in range(X.shape[1]) if np.linalg.norm(X[:, i]) > tol]
    dropped = [name for i, name in enumerate(xcols) if i not in keep]
    if any(name in protected for name in dropped):
        raise ValueError("核心解释变量被固定效应完全吸收,无法估计")
    X, xcols = X[:, keep], [xcols[i] for i in keep]
    if not xcols or np.linalg.matrix_rank(X, tol=tol) < len(xcols):
        raise ValueError("核心解释变量之间存在完全共线性,无法估计")
    return X, xcols, dropped


def demean_and_prune(model: PreparedModel):
    data = model.data
    if data[model.entity].nunique() < 2 or data[model.time].nunique() < 2:
        raise ValueError("双向固定效应回归至少需要 2 个实体和 2 个时间期")
    if data[model.cluster].nunique() < 2:
        raise ValueError("聚类稳健推断至少需要 2 个聚类")
    structure = fixed_effect_structure(data, model.entity, model.time)
    if len(data) - structure.rank - len(model.xcols) <= 0:
        raise ValueError("最终回归样本在实体、时间固定效应和解释变量之外没有足够自由度")
    if data[model.depvar].var() <= 0:
        raise ValueError(f"最终回归样本因变量 {model.depvar} 必须具有正的有限方差")
    transformed = twoway_demean(
        data[[model.depvar, *model.xcols]].to_numpy(float), data[model.entity].values, data[model.time].values
    )
    X, names, dropped = drop_collinear_columns(transformed[:, 1:], list(model.xcols), set(model.policy_xcols))
    return transformed[:, 0], X, names, dropped


def within_ols(model: PreparedModel, prepared=None) -> RegressionResult:
    y, X, names, dropped = prepared or demean_and_prune(model)
    beta = np.linalg.lstsq(X, y, rcond=None)[0]
    residual = y - X @ beta
    bread = np.linalg.inv(X.T @ X)
    groups = pd.unique(model.data[model.cluster])
    meat = np.zeros((len(names), len(names)))
    for group in groups:
        score = X[model.data[model.cluster].values == group].T @ residual[model.data[model.cluster].values == group]
        meat += np.outer(score, score)
    effects = fixed_effect_structure(model.data, model.entity, model.time)
    df = len(y) - len(names) - effects.rank
    correction = len(groups) / (len(groups) - 1) * (len(y) - 1) / df
    covariance = correction * bread @ meat @ bread
    se = np.sqrt(np.clip(np.diag(covariance), 0, None))
    require_finite("回归估计", beta, se)
    if (se <= 0).any():
        raise ValueError("聚类稳健标准误必须为正")
    critical = stats.t.ppf(0.975, len(groups) - 1)
    coefs = [
        CoefStat(
            n,
            float(b),
            float(s),
            float(b / s),
            float(2 * stats.t.sf(abs(b / s), len(groups) - 1)),
            float(b - critical * s),
            float(b + critical * s),
        )
        for n, b, s in zip(names, beta, se)
    ]
    require_finite(
        "回归推断",
        *(
            value
            for coefficient in coefs
            for value in (coefficient.t, coefficient.p, coefficient.ci_low, coefficient.ci_high)
        ),
    )
    if model.support and model.support.suppress_inference:
        coefs = [coef.without_inference() for coef in coefs]
    notes = [*model.notes, f"双向固定效应({model.entity} + {model.time}),within 变换后 OLS"]
    if effects.components > 1:
        notes.append(
            f"实体—年份二部图有 {effects.components} 个连通分量；固定效应秩 {effects.rank}，CR1 残差自由度 {df}；政策系数仍为各分量共同斜率。"
        )
    support = model.support
    total_ss = float(y @ y)
    if not math.isfinite(total_ss) or total_ss <= 0:
        raise ValueError("因变量被双向固定效应完全吸收，无法估计组内关系")
    r2_within = float(1 - residual @ residual / total_ss)
    depvar_mean = float(model.data[model.depvar].mean())
    depvar_std = float(model.data[model.depvar].std())
    require_finite("回归汇总统计量", r2_within, depvar_mean, depvar_std)
    return RegressionResult(
        model.depvar,
        coefs,
        len(y),
        model.data[model.entity].nunique(),
        model.data[model.time].nunique(),
        len(groups),
        r2_within,
        depvar_mean,
        depvar_std,
        notes=notes + (support.reasons if support else []),
        status=support.status if support else None,
        status_reasons=list(support.reasons) if support else [],
        support=support.to_dict() if support else None,
        sample_flow=model.sample_flow,
    )
