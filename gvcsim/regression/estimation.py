"""Fixed-effect estimation (any set of absorbed effects) and disconnected-effect accounting."""

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy import stats
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components

from gvcsim.concurrency import check_cancelled
from gvcsim.regression.model import CoefStat, PreparedModel, RegressionResult

CONSTANT = "_constant"
# Above this many levels in total a dense dummy matrix is not built (only two-group sets reach it; they use the
# connected-component count instead).
_DENSE_RANK_MAX_LEVELS = 2000
# A regressor whose demeaned values are this small relative to its raw values is absorbed by the fixed effects.
_ABSORBED_RELATIVE_NORM = 1e-8


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


def fixed_effect_rank(data: pd.DataFrame, columns: Sequence[str]) -> tuple[int, int]:
    """Rank of the dummy matrix of the absorbed effects, and the number of disconnected blocks (1 when connected).

    One group: its level count. Two groups: levels minus connected components of their bipartite graph (exact, no
    dense matrix). More groups only occur with few levels (country + industry + year), where the dense rank is cheap.
    """
    columns = list(columns)
    if not columns:
        return 0, 1
    if len(columns) == 1:
        return int(data[columns[0]].nunique()), 1
    if len(columns) == 2:
        structure = fixed_effect_structure(data, columns[0], columns[1])
        return structure.rank, structure.components
    levels = sum(int(data[column].nunique()) for column in columns)
    if levels > _DENSE_RANK_MAX_LEVELS:
        raise ValueError(f"三组及以上固定效应的水平数过多（{levels}），无法计算秩")
    check_cancelled()
    dummies = np.column_stack([pd.get_dummies(data[column], dtype=float).to_numpy() for column in columns])
    return int(np.linalg.matrix_rank(dummies)), 1


def require_finite(label: str, *values) -> None:
    if any(not np.isfinite(np.asarray(value, dtype=float)).all() for value in values):
        raise ValueError(f"{label}产生非有限数值，已停止返回结果")


def multiway_demean(
    values: np.ndarray,
    groups: Sequence[np.ndarray],
    tol: float = 1e-10,
    max_iter: int = 200,
    label: str = "多组去均值",
) -> np.ndarray:
    """Subtract each group's mean in turn (alternating projections) until every group mean is ~0."""
    if not math.isfinite(tol) or tol <= 0:
        raise ValueError(f"{label}容差必须为正的有限数")
    if max_iter <= 0:
        raise ValueError(f"{label}迭代次数必须为正数")
    out = values.astype(float).copy()
    require_finite(f"{label}输入", out)
    residual = math.inf
    for iteration in range(1, max_iter + 1):
        before = out.copy()
        for group in groups:
            frame = pd.DataFrame(out)
            out = (frame - frame.groupby(group).transform("mean")).values
        require_finite(label, out)
        if np.abs(out - before).max() < tol or iteration == max_iter:
            residual = max(float(pd.DataFrame(out).groupby(g).mean().abs().to_numpy().max()) for g in groups)
            if residual < tol:
                return out
    raise ValueError(f"{label}在 {max_iter} 次迭代后未收敛（最大组均值残差 {residual:.3g}）；无法继续估计")


def twoway_demean(
    values: np.ndarray, ent: np.ndarray, tim: np.ndarray, tol: float = 1e-10, max_iter: int = 200
) -> np.ndarray:
    return multiway_demean(values, (ent, tim), tol, max_iter, label="双向去均值")


def drop_collinear_columns(X, xcols, protected, tol=1e-10):
    keep = [i for i in range(X.shape[1]) if np.linalg.norm(X[:, i]) > tol]
    dropped = [name for i, name in enumerate(xcols) if i not in keep]
    if any(name in protected for name in dropped):
        raise ValueError("核心解释变量被固定效应完全吸收,无法估计")
    X, xcols = X[:, keep], [xcols[i] for i in keep]
    if not xcols or np.linalg.matrix_rank(X, tol=tol) < len(xcols):
        raise ValueError("核心解释变量之间存在完全共线性,无法估计")
    return X, xcols, dropped


def prune_regressors(
    transformed: np.ndarray, raw: np.ndarray, xcols: list[str], protected: set[str], absorbed_by: str
) -> tuple[np.ndarray, list[str], list[dict]]:
    """Keep the regressors that still vary after the fixed effects and add information, in order (X terms first).

    A regressor whose demeaned values vanish is absorbed by the fixed effects; one that a kept regressor already
    spans is collinear. Both are reported in ``omitted``; the model is only refused when no X term is left.
    """
    keep: list[int] = []
    omitted: list[dict] = []
    for index, name in enumerate(xcols):
        column = transformed[:, index]
        raw_norm = float(np.linalg.norm(raw[:, index]))
        if raw_norm == 0:
            omitted.append({"name": name, "reason": "zero", "by": None})
            continue
        if float(np.linalg.norm(column)) <= _ABSORBED_RELATIVE_NORM * max(1.0, raw_norm):
            omitted.append({"name": name, "reason": "absorbed", "by": absorbed_by or None})
            continue
        candidate = transformed[:, [*keep, index]]
        if np.linalg.matrix_rank(candidate) < len(keep) + 1:
            omitted.append({"name": name, "reason": "collinear", "by": None})
            continue
        keep.append(index)
    if not any(xcols[i] in protected for i in keep):
        reasons = {item["reason"] for item in omitted if item["name"] in protected}
        if reasons == {"zero"}:
            raise ValueError("关税暴露 X 在这个设定下无法估计：所选的 X 各项在这个样本里全为 0")
        if "absorbed" in reasons and absorbed_by == "常数项":
            raise ValueError("关税暴露 X 在这个设定下无法估计：X 各项在样本里都不变，与常数项重合")
        if "absorbed" in reasons:
            raise ValueError(f"关税暴露 X 在这个设定下无法估计：X 各项都被{absorbed_by or '所选'}固定效应吸收")
        raise ValueError("关税暴露 X 在这个设定下无法估计：所选的 X 各项彼此完全共线")
    return transformed[:, keep], [xcols[i] for i in keep], omitted


def _attribute_absorbed(omitted: list[dict], raw: np.ndarray, xcols: list[str], data: pd.DataFrame, effects) -> None:
    """Name the single fixed effect that absorbs each absorbed regressor ("国家×年份"); when only the effects taken
    together absorb it, the combined label stays."""
    for item in omitted:
        if item["reason"] != "absorbed":
            continue
        values = raw[:, xcols.index(item["name"])]
        scale = _ABSORBED_RELATIVE_NORM * max(1.0, float(np.linalg.norm(values)))
        for column in effects:
            frame = pd.Series(values)
            within = values - frame.groupby(data[column].to_numpy()).transform("mean").to_numpy()
            if float(np.linalg.norm(within)) <= scale:
                item["by"] = _FE_DIMENSION_LABELS.get(column, column)
                break


_FE_DIMENSION_LABELS = {
    "entity_id": "国家×行业",
    "国家–行业单元": "国家×行业",
    "country": "国家",
    "industry": "行业",
    "year": "年份",
    "_fe_country_year": "国家×年份",
}


def _effects_label(columns: Sequence[str]) -> str:
    return " + ".join(_FE_DIMENSION_LABELS.get(column, column) for column in columns)


def demean_and_prune(model: PreparedModel):
    """Absorb the model's fixed effects (or, with none, add a constant) and keep the estimable regressors.

    Returns ``(y, X, names, dropped)``; the constant, when present, is the last column named ``CONSTANT``.
    The two-way (entity, time) model keeps its original checks, numerics and messages.
    """
    data = model.data
    effects = model.effect_columns
    if model.fe_columns is None:
        if data[model.entity].nunique() < 2 or data[model.time].nunique() < 2:
            raise ValueError("双向固定效应回归至少需要 2 个实体和 2 个时间期")
    elif len(data) < 2:
        raise ValueError("样本太少，无法估计")
    if data[model.cluster].nunique() < 2:
        raise ValueError("聚类稳健推断至少需要 2 个聚类")
    rank, _ = fixed_effect_rank(data, effects)
    constant = 0 if effects else 1
    if len(data) - rank - constant - len(model.xcols) <= 0:
        raise ValueError("最终回归样本在实体、时间固定效应和解释变量之外没有足够自由度")
    if data[model.depvar].var() <= 0:
        raise ValueError(f"最终回归样本因变量 {model.depvar} 必须具有正的有限方差")
    raw = data[[model.depvar, *model.xcols]].to_numpy(float)
    if model.fe_columns is None:
        transformed = twoway_demean(raw, data[model.entity].values, data[model.time].values)
        X, names, dropped = drop_collinear_columns(transformed[:, 1:], list(model.xcols), set(model.policy_xcols))
        return transformed[:, 0], X, names, dropped
    if effects:
        groups = [data[column].values for column in effects]
        max_iter = 200 if len(groups) <= 2 else 1000
        transformed = multiway_demean(raw, groups, max_iter=max_iter, label="固定效应去均值")
        X, names, omitted = prune_regressors(
            transformed[:, 1:], raw[:, 1:], list(model.xcols), set(model.policy_xcols), _effects_label(effects)
        )
        _attribute_absorbed(omitted, raw[:, 1:], list(model.xcols), data, effects)
        model.omitted = omitted
        return transformed[:, 0], X, names, [item["name"] for item in omitted]
    # No fixed effects: ordinary least squares with a constant column. Which regressors to keep is decided on the
    # mean-centred values, so a regressor that is constant over the sample counts as collinear with the constant.
    regressors = raw[:, 1:]
    centred = regressors - regressors.mean(axis=0)
    _, names, omitted = prune_regressors(centred, regressors, list(model.xcols), set(model.policy_xcols), "常数项")
    model.omitted = omitted
    kept = [list(model.xcols).index(name) for name in names]
    X = np.column_stack([regressors[:, kept], np.ones(len(data))])
    return raw[:, 0], X, [*names, CONSTANT], [item["name"] for item in omitted]


BINSCATTER_BINS = 20


def binned_scatter(x: np.ndarray, y: np.ndarray, slope: float, bins: int = BINSCATTER_BINS) -> dict:
    """Equal-count bins of the within-transformed regressor with the mean response in each bin.

    This is the standard binned scatter plot: the fitted line through the origin with the estimated
    slope is what the regression draws through those means. Ties at the bin edges stay together.
    """
    order = np.argsort(x, kind="stable")
    count = max(1, min(bins, len(order)))
    points = []
    for chunk in np.array_split(order, count):
        if not len(chunk):
            continue
        points.append({"x": float(x[chunk].mean()), "y": float(y[chunk].mean()), "n": int(len(chunk))})
    require_finite("分箱散点", [point["x"] for point in points], [point["y"] for point in points])
    return {"bins": points, "slope": float(slope), "transform": "twoway_demeaned"}


def two_way_note(entity: str, time: str) -> str:
    """The estimator note shown to students (report and page), in course wording rather than column names."""
    return (
        f"双向固定效应（{_FE_DIMENSION_LABELS.get(entity, entity)} + {_FE_DIMENSION_LABELS.get(time, time)}）："
        "先扣掉各自的平均水平，再做普通最小二乘回归（TWFE）"
    )


def effects_note(columns: Sequence[str]) -> str:
    """The estimator note for any set of fixed effects; the classic two-way pair keeps its original wording."""
    columns = list(columns)
    if not columns:
        return "无固定效应：直接做普通最小二乘回归（含常数项）"
    if len(columns) == 2 and columns[1] == "year" and columns[0] in ("entity_id", "country"):
        return two_way_note(columns[0], columns[1])
    return f"固定效应（{_effects_label(columns)}）：先扣掉各自的平均水平，再做普通最小二乘回归"


def _coef(name: str, b: float, se: float, groups: int, critical: float) -> CoefStat:
    return CoefStat(
        name,
        float(b),
        float(se),
        float(b / se),
        float(2 * stats.t.sf(abs(b / se), groups - 1)),
        float(b - critical * se),
        float(b + critical * se),
    )


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
    effects = model.effect_columns
    rank, components = fixed_effect_rank(model.data, effects)
    df = len(y) - len(names) - rank
    correction = len(groups) / (len(groups) - 1) * (len(y) - 1) / df
    covariance = correction * bread @ meat @ bread
    se = np.sqrt(np.clip(np.diag(covariance), 0, None))
    require_finite("回归估计", beta, se)
    if (se <= 0).any():
        raise ValueError("聚类稳健标准误必须为正")
    critical = stats.t.ppf(0.975, len(groups) - 1)
    all_coefs = [_coef(n, float(b), float(s), len(groups), critical) for n, b, s in zip(names, beta, se)]
    require_finite(
        "回归推断",
        *(
            value
            for coefficient in all_coefs
            for value in (coefficient.t, coefficient.p, coefficient.ci_low, coefficient.ci_high)
        ),
    )
    coefs = [c for c in all_coefs if c.name != CONSTANT]
    constant = next((c for c in all_coefs if c.name == CONSTANT), None)
    # The X terms' sum (one term: the term itself) with SE from the clustered covariance.
    policy_index = [i for i, name in enumerate(names) if name in model.policy_xcols]
    cumulative = None
    if policy_index:
        weights = np.zeros(len(names))
        weights[policy_index] = 1.0
        total = float(weights @ beta)
        total_se = float(math.sqrt(max(float(weights @ covariance @ weights), 0.0)))
        if total_se > 0:
            cumulative = _coef("cumulative", total, total_se, len(groups), critical)
    # Wald F of every regressor except the constant.
    slope_index = [i for i, name in enumerate(names) if name != CONSTANT]
    f_stat = f_p = None
    f_df = None
    if slope_index:
        b = beta[slope_index]
        v = covariance[np.ix_(slope_index, slope_index)]
        try:
            f_value = float(b @ np.linalg.solve(v, b)) / len(slope_index)
        except np.linalg.LinAlgError:
            f_value = math.nan
        if math.isfinite(f_value):
            f_stat = f_value
            f_df = [len(slope_index), len(groups) - 1]
            f_p = float(stats.f.sf(f_value, len(slope_index), len(groups) - 1))
    if model.support and model.support.suppress_inference:
        coefs = [coef.without_inference() for coef in coefs]
        constant = constant.without_inference() if constant else None
        cumulative = cumulative.without_inference() if cumulative else None
        f_p = None
    classic = model.fe_columns is None
    notes = [*model.notes, two_way_note(model.entity, model.time) if classic else effects_note(effects)]
    if components > 1:
        notes.append(
            f"样本分成 {components} 组互不重叠的数据；估计值是这几组共同的斜率"
            f"（技术细节：固定效应秩 {rank}，残差自由度 {df}）。"
        )
    support = model.support
    raw_y = model.data[model.depvar].to_numpy(float)
    total_ss_overall = float(((raw_y - raw_y.mean()) ** 2).sum())
    # With fixed effects y is already demeaned; without, "within" is around the overall mean.
    within_ss = float(y @ y) if effects else total_ss_overall
    if not math.isfinite(within_ss) or within_ss <= 0:
        raise ValueError("因变量被双向固定效应完全吸收，无法估计组内关系")
    rss = float(residual @ residual)
    r2_within = float(1 - rss / within_ss)
    r2 = float(1 - rss / total_ss_overall) if total_ss_overall > 0 else None
    r2_adj = float(1 - (1 - r2) * (len(y) - 1) / df) if r2 is not None else None
    depvar_mean = float(model.data[model.depvar].mean())
    depvar_std = float(model.data[model.depvar].std())
    # y is already demeaned: its SD is the within variation the slope is estimated from.
    depvar_within_std = math.sqrt(within_ss / (len(y) - 1)) if len(y) > 1 else float("nan")
    require_finite("回归汇总统计量", r2_within, depvar_mean, depvar_std, depvar_within_std)
    if classic:
        show_binscatter = bool(names) and names[0] in model.policy_xcols
    else:
        show_binscatter = bool(effects) and len(coefs) == 1 and coefs[0].name in model.policy_xcols
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
        binscatter=binned_scatter(X[:, 0], y, float(beta[0])) if show_binscatter else None,
        depvar_within_std=depvar_within_std,
        r2=r2,
        r2_adj=r2_adj,
        f_stat=f_stat,
        f_df=f_df,
        f_p=f_p,
        constant=constant,
        cumulative=cumulative,
        omitted=list(model.omitted),
    )
