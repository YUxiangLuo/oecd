"""四类 outcome 共用的面板回归引擎:双向固定效应 / DID / 事件研究。

教学主引擎仍为纯 numpy 实现,便于单元测试与教学展示;同时提供
linearmodels.PanelOLS 标准库对照。三种方法共用同一个 within-OLS 核心(_within_ols):
  1. 交替去均值(entity / time)做双向 within 变换,直到收敛
     (非平衡面板下一次性去均值不精确,迭代投影可收敛到正确的 within 解)
  2. OLS 估计
  3. 按 cluster 聚类的稳健标准误(sandwich 估计)

区别只在解释变量的构造:
  twoway_fe     连续冲击强度 tariff_shock 直接进方程
  did           treated×post(处理组=曾受冲击的个体,处理期=该个体首次冲击年起)
  event_study   treated×相对首次冲击年的事件时间哑变量(基期 k=-1),动态效应路径

p 值按聚类数做 t(G-1) 小样本校正。PanelOLS 对照使用同一份样本与同一组
可估计解释变量,只作为结果校验与界面展示。
"""

import math
from dataclasses import dataclass, field, replace
from numbers import Real

import numpy as np
import pandas as pd
from linearmodels.panel import PanelOLS
from scipy import stats

from gvcsim.regression.design import (
    METHOD_DID,
    METHOD_EVENT_STUDY,
    METHOD_TWFE_INTENSITY as METHOD_TWFE_INTENSITY,
    PRICE_MODE_REAL,
    SCENARIO_CONFOUNDED as SCENARIO_CONFOUNDED,
    SCENARIO_NOISY as SCENARIO_NOISY,
)
from gvcsim.regression.transforms import (
    BASE_GVC_COL as BASE_GVC_COL,
    BASELINE_GVC_COL as BASELINE_GVC_COL,
    DEFLATOR_COL as DEFLATOR_COL,
    ROW_CODE as ROW_CODE,
    _apply_price_mode as _apply_price_mode,
    _apply_sample_filter as _apply_sample_filter,
    _apply_teaching_scenario as _apply_teaching_scenario,
    _attach_baseline_gvc as _attach_baseline_gvc,
    _country_year_real_growth as _country_year_real_growth,
    _freeze_baseline_gvc as _freeze_baseline_gvc,
    _real_amount as _real_amount,
    _real_log_from_log as _real_log_from_log,
    _stable_noise as _stable_noise,
)
from gvcsim.regression.validity import MIN_TREATED_CLUSTERS, TreatmentSupport, analyze_support


@dataclass
class CoefStat:
    name: str
    coef: float
    se: float
    t: float
    # 推断量:处理支持度不足或设计无效时为 None,表示"不可评估"而非"不显著"。
    p: float | None
    ci_low: float | None
    ci_high: float | None

    @property
    def stars(self) -> str:
        if self.p is None:
            return ""
        return "***" if self.p < 0.01 else "**" if self.p < 0.05 else "*" if self.p < 0.1 else ""

    def without_inference(self) -> "CoefStat":
        """保留点估计与标准误,抹去 p 值、星号与置信区间。"""
        return replace(self, p=None, ci_low=None, ci_high=None)


@dataclass
class RegressionResult:
    depvar: str
    coefs: list[CoefStat]
    n_obs: int
    n_entities: int
    n_times: int
    n_clusters: int
    r2_within: float
    depvar_mean: float
    depvar_std: float
    # 交互模型在低(P25)/均值/高(P75)基期 GVC 水平下的线性组合效应。
    # 空列表表示当前模型没有可配对的政策主效应×base_gvc 交互项。
    marginal_effects: list[dict] = field(default_factory=list)
    diagnostics: dict = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    # 设计有效性:ok / warning / insufficient / invalid_design。
    # 未知处理结构(直接调用底层引擎)时为 None。
    status: str | None = None
    status_reasons: list[str] = field(default_factory=list)
    support: dict | None = None
    # 事件研究逐期支持门禁；None 表示非事件研究。
    event_support: dict | None = None
    # 结构化样本流:说明 treatment timeline 与 outcome-specific estimation sample 的边界。
    sample_flow: dict | None = None

    def to_dict(self) -> dict:
        return {
            "depvar": self.depvar,
            "coefs": [
                {
                    "name": c.name,
                    "coef": c.coef,
                    "se": c.se,
                    "t": c.t,
                    "p": c.p,
                    "stars": c.stars,
                    "ci_low": c.ci_low,
                    "ci_high": c.ci_high,
                }
                for c in self.coefs
            ],
            "n_obs": self.n_obs,
            "n_entities": self.n_entities,
            "n_times": self.n_times,
            "n_clusters": self.n_clusters,
            "r2_within": self.r2_within,
            "depvar_mean": self.depvar_mean,
            "depvar_std": self.depvar_std,
            "marginal_effects": self.marginal_effects,
            "diagnostics": self.diagnostics,
            "notes": self.notes,
            "status": self.status,
            "status_reasons": self.status_reasons,
            "support": self.support,
            "event_support": self.event_support,
            "sample_flow": self.sample_flow,
        }


@dataclass
class PreparedModel:
    data: pd.DataFrame
    depvar: str
    xcols: list[str]
    policy_xcols: list[str]
    control_cols: list[str]
    entity: str
    time: str
    cluster: str
    notes: list[str]
    # 处理支持度;仅在能识别处理列时计算(见 analyze_support)。
    support: TreatmentSupport | None = None
    # outcome/control complete-case 之前冻结的首次处理时点。
    timing: "TreatmentTiming | None" = None
    # 事件研究每个观察期（含省略基期）的课程支持契约。
    event_support: dict | None = None
    sample_flow: dict | None = None


# Imports above intentionally keep existing private/internal names available
# from this module while implementations live in the focused transform module.


def _is_true_finite_number(value: object) -> bool:
    """Accept real numeric scalars only; strings, booleans, and arbitrary objects are not data."""
    return isinstance(value, Real) and not isinstance(value, (bool, np.bool_)) and math.isfinite(float(value))


def _validate_identifier_values(data: pd.DataFrame, columns: list[str]) -> None:
    for column in dict.fromkeys(columns):
        values = data[column]
        blank = values.map(lambda value: bool(isinstance(value, str) and not value.strip())).astype(bool)
        invalid = values.isna() | blank
        if invalid.any():
            raise ValueError(f"回归标识变量 {column} 含缺失或空白值")


def _validate_numeric_values(data: pd.DataFrame, columns: list[str], *, allow_null: bool = True) -> None:
    for column in dict.fromkeys(columns):
        for value in data[column].array:
            try:
                missing = bool(pd.isna(value))
            except (TypeError, ValueError):
                missing = False
            if missing and allow_null:
                continue
            if not _is_true_finite_number(value):
                qualifier = "非缺失值必须是真实数值且有限" if allow_null else "必须是真实数值且有限且不得缺失"
                raise ValueError(f"回归数值变量 {column} {qualifier}；不接受数值字符串、对象或无穷值")


def _validate_time_values(data: pd.DataFrame, time: str) -> None:
    _validate_numeric_values(data, [time], allow_null=False)
    values = data[time].to_numpy(dtype=float)
    if not np.equal(values, np.floor(values)).all():
        raise ValueError(f"回归时间变量 {time} 必须是有限的数学整数")


def _validate_regression_input_boundary(
    data: pd.DataFrame,
    *,
    depvar: str,
    numeric_columns: list[str],
    entity: str,
    time: str,
    cluster: str,
) -> None:
    """Validate source values before pandas/numpy coercion can change their meaning."""
    _validate_identifier_values(data, [entity, cluster])
    _validate_time_values(data, time)
    _validate_numeric_values(data, [depvar, *numeric_columns], allow_null=True)


def _validate_final_estimation_sample(model: "PreparedModel") -> None:
    """Reject structurally unusable complete-case samples before within transformation."""
    data = model.data
    if data.empty:
        raise ValueError("完整案例筛选后回归样本为空")
    _validate_identifier_values(data, [model.entity, model.cluster])
    _validate_time_values(data, model.time)
    _validate_numeric_values(data, [model.depvar, *model.xcols], allow_null=False)
    duplicate = data.duplicated([model.entity, model.time], keep=False)
    if duplicate.any():
        row = data.loc[duplicate, [model.entity, model.time]].iloc[0]
        raise ValueError(f"最终回归样本要求 entity-time 唯一：{row[model.entity]} / {int(row[model.time])}")
    cluster_counts = data.groupby(model.entity, sort=False)[model.cluster].nunique(dropna=False)
    if (cluster_counts > 1).any():
        bad = cluster_counts[cluster_counts > 1].index[0]
        raise ValueError(f"最终回归样本中一个实体只能映射到一个聚类；{bad} 映射到多个 {model.cluster}")

    n_rows = len(data)
    n_entities = int(data[model.entity].nunique())
    n_times = int(data[model.time].nunique())
    n_clusters = int(data[model.cluster].nunique())
    if n_entities < 2:
        raise ValueError("双向固定效应回归至少需要 2 个实体")
    if n_times < 2:
        raise ValueError("双向固定效应回归至少需要 2 个时间期")
    if n_clusters < 2:
        raise ValueError("聚类稳健推断至少需要 2 个聚类")
    if n_rows <= len(model.xcols) + 2:
        raise ValueError("最终回归样本行数不足以估计当前解释变量集合")
    residual_capacity = n_rows - n_entities - n_times + 1 - len(model.xcols)
    if residual_capacity <= 0:
        raise ValueError("最终回归样本在实体、时间固定效应和解释变量之外没有足够自由度")

    outcome = data[model.depvar].to_numpy(dtype=float)
    variance = float(np.var(outcome, ddof=1))
    if not math.isfinite(variance) or variance <= 0:
        raise ValueError(f"最终回归样本因变量 {model.depvar} 必须具有正的有限方差")


def _require_finite_numerical_output(label: str, *values: np.ndarray | float) -> None:
    if any(not np.isfinite(np.asarray(value, dtype=float)).all() for value in values):
        raise ValueError(f"{label}产生非有限数值，已停止返回结果")


def _drop_collinear_columns(
    X: np.ndarray,
    xcols: list[str],
    protected: set[str],
    tol: float = 1e-10,
) -> tuple[np.ndarray, list[str], list[str]]:
    """剔除被固定效应吸收或与已保留变量共线的非核心控制变量。"""
    dropped: list[str] = []
    keep = []
    for i, name in enumerate(xcols):
        if np.linalg.norm(X[:, i]) > tol:
            keep.append(i)
        elif name in protected:
            raise ValueError(f"核心解释变量 {name} 被固定效应完全吸收,无法估计")
        else:
            dropped.append(name)
    X = X[:, keep]
    xcols = [xcols[i] for i in keep]

    while X.shape[1] and np.linalg.matrix_rank(X, tol=tol) < X.shape[1]:
        rank = np.linalg.matrix_rank(X, tol=tol)
        drop_idx = None
        for i in range(X.shape[1] - 1, -1, -1):
            if xcols[i] in protected:
                continue
            cand = np.delete(X, i, axis=1)
            if np.linalg.matrix_rank(cand, tol=tol) == rank:
                drop_idx = i
                break
        if drop_idx is None:
            raise ValueError("核心解释变量之间存在完全共线性,无法估计")
        dropped.append(xcols[drop_idx])
        X = np.delete(X, drop_idx, axis=1)
        del xcols[drop_idx]
    if not X.shape[1]:
        raise ValueError("没有可估计的解释变量")
    return X, xcols, dropped


def _twoway_demean(
    values: np.ndarray, ent: np.ndarray, tim: np.ndarray, tol: float = 1e-10, max_iter: int = 200
) -> np.ndarray:
    """对每一列做 entity/time 交替去均值(Guimarães-Portugal 迭代)。"""
    out = values.astype(float).copy()
    for _ in range(max_iter):
        before = out.copy()
        for groups in (ent, tim):
            df = pd.DataFrame(out)
            out = (df - df.groupby(groups).transform("mean")).values
        if np.abs(out - before).max() < tol:
            break
    return out


def _cluster_t_pvalue(t_stat: float, n_clusters: int) -> float:
    """双侧 p 值:聚类稳健推断使用 t(G-1) 小样本校正。"""
    if not math.isfinite(t_stat):
        return float("nan")
    if n_clusters <= 1:
        return 1.0
    return float(2 * stats.t.sf(abs(t_stat), df=n_clusters - 1))


def _demean_and_prune(
    model: PreparedModel,
) -> tuple[np.ndarray, np.ndarray, list[str], list[str]]:
    """双向 within 变换 + 共线列剔除,返回 (y, X, 保留列, 剔除列)。

    这是每次估计里最贵的一步(3465 个体的迭代去均值)。自写引擎与
    PanelOLS 对照共用这份结果:PanelOLS 只需知道"哪些列共线被剔除",
    不必再单独去均值一次。
    """
    _validate_final_estimation_sample(model)
    demeaned = _twoway_demean(
        model.data[[model.depvar, *model.xcols]].values.astype(float),
        model.data[model.entity].values,
        model.data[model.time].values,
    )
    y = demeaned[:, 0]
    X, xcols, dropped = _drop_collinear_columns(demeaned[:, 1:], list(model.xcols), set(model.policy_xcols))
    return y, X, xcols, dropped


def _event_period_for_term(event_support: dict | None, term: str) -> dict | None:
    if not event_support:
        return None
    main_term = term.replace("×base_gvc", "")
    return next(
        (period for period in event_support.get("periods", []) if period.get("term") == main_term),
        None,
    )


def _unavailable_pretrend(
    scope: str,
    names: list[str],
    n_clusters: int,
    reason: str,
    interpretation: str,
    excluded_terms: list[dict] | None = None,
    support: TreatmentSupport | None = None,
) -> dict:
    diagnostic = {
        "scope": scope,
        "available": False,
        "reason": reason,
        "terms": names,
        "excluded_terms": excluded_terms or [],
        "statistic": None,
        "df_num": len(names),
        "df_denom": max(n_clusters - 1, 0),
        "p": None,
        "interpretation": interpretation,
    }
    if support is not None:
        diagnostic["support_status"] = support.status
        diagnostic["support_reasons"] = list(support.reasons)
    return diagnostic


def _pretrend_scope_label(scope: str) -> str:
    return {
        "main": "主效应",
        "interaction": "处理前 GVC 交互效应",
        "joint": "主效应与处理前 GVC 交互效应联合",
    }[scope]


def _wald_pretrend_scope(
    scope: str,
    candidate_indices: list[int],
    xcols: list[str],
    beta: np.ndarray,
    covariance: np.ndarray,
    n_clusters: int,
    event_support: dict | None,
    support: TreatmentSupport | None,
) -> dict:
    """Assemble one scope-local Wald test without sharing rank/df decisions."""
    label = _pretrend_scope_label(scope)
    # REG-02 is evaluated before any beta/covariance indexing. Every scope therefore
    # remains unavailable even if a stale covariance matrix happens to look usable.
    if support is not None and support.suppress_inference:
        gate_reason = (
            "整体设计与处理路径不相容，统计推断已被抑制。"
            if support.status == "invalid_design"
            else "整体处理支持度不足，统计推断已被抑制。"
        )
        exclusion_reasons = list(dict.fromkeys([gate_reason, *support.reasons]))
        return _unavailable_pretrend(
            scope,
            [],
            n_clusters,
            "global_inference_suppressed",
            f"整体设计或处理支持门禁已抑制统计推断，因此未执行{label}冲击前联合检验；"
            "这不能说明冲击前趋势是否存在，也不能证明没有效应。",
            [{"term": xcols[index], "reasons": exclusion_reasons} for index in candidate_indices],
            support,
        )

    excluded_terms: list[dict] = []
    indices: list[int] = []
    for index in candidate_indices:
        name = xcols[index]
        period = _event_period_for_term(event_support, name)
        if period is not None and period.get("inference_supported") is not True:
            excluded_terms.append({"term": name, "reasons": list(period.get("reasons", []))})
        else:
            indices.append(index)
    names = [xcols[index] for index in indices]
    if not candidate_indices:
        return _unavailable_pretrend(
            scope,
            names,
            n_clusters,
            "no_pre_terms",
            f"没有可联合检验的{label}冲击前系数，无法评估冲击前趋势。",
        )
    if not indices:
        return _unavailable_pretrend(
            scope,
            names,
            n_clusters,
            "no_supported_pre_terms",
            f"所有可估计的{label}冲击前系数都因逐期处理聚类支持不足而被排除；冲击前趋势不可评估。",
            excluded_terms,
        )

    q = len(indices)
    df_denom = n_clusters - 1
    if q > df_denom:
        return _unavailable_pretrend(
            scope,
            names,
            n_clusters,
            "insufficient_cluster_df",
            f"{label}冲击前限制数为 {q}，但仅有 {df_denom} 个聚类自由度，联合检验不可评估。",
            excluded_terms,
        )

    coefficients = beta[indices]
    restriction_covariance = covariance[np.ix_(indices, indices)]
    rank = int(np.linalg.matrix_rank(restriction_covariance, hermitian=True))
    if rank < q:
        return _unavailable_pretrend(
            scope,
            names,
            n_clusters,
            "singular_covariance",
            f"{label}冲击前限制协方差秩不足（{rank}/{q}），联合检验不可评估；不得据此判断没有冲击前差异。",
            excluded_terms,
        )

    statistic = float((coefficients @ np.linalg.inv(restriction_covariance) @ coefficients) / q)
    p_value = float(stats.f.sf(statistic, q, df_denom))
    _require_finite_numerical_output(f"{label}冲击前 Wald 检验", statistic, p_value)
    interpretation = (
        f"{label}未发现明显的冲击前差异；不能据此确认平行趋势假设。"
        if p_value >= 0.05
        else f"{label}检测到明显的冲击前差异，因果解释需谨慎。"
    )
    if excluded_terms:
        interpretation += (
            " 已排除逐期处理聚类支持不足的冲击前系数：" + "、".join(item["term"] for item in excluded_terms) + "。"
        )
    return {
        "scope": scope,
        "available": True,
        "reason": None,
        "terms": names,
        "excluded_terms": excluded_terms,
        "statistic": statistic,
        "df_num": q,
        "df_denom": df_denom,
        "p": p_value,
        "interpretation": interpretation,
    }


def _pretrend_diagnostic(
    xcols: list[str],
    beta: np.ndarray,
    covariance: np.ndarray,
    n_clusters: int,
    event_support: dict | None = None,
    support: TreatmentSupport | None = None,
) -> dict:
    """Build explicit main/interaction/joint pretrend Wald scopes.

    The estimator and covariance are unchanged. Unsupported event leads are removed
    scope-locally, while the whole-run REG-02 gate makes every scope unavailable
    before covariance values are consumed.
    """
    main_indices = [
        index for index, name in enumerate(xcols) if name.startswith("k=-") and not name.endswith("×base_gvc")
    ]
    interaction_indices = [
        index for index, name in enumerate(xcols) if name.startswith("k=-") and name.endswith("×base_gvc")
    ]
    scope_indices = {"main": main_indices}
    if interaction_indices:
        scope_indices.update(
            {
                "interaction": interaction_indices,
                "joint": [index for index in range(len(xcols)) if index in {*main_indices, *interaction_indices}],
            }
        )
    tests = {
        scope: _wald_pretrend_scope(
            scope,
            indices,
            xcols,
            beta,
            covariance,
            n_clusters,
            event_support,
            support,
        )
        for scope, indices in scope_indices.items()
    }
    # Legacy consumers see the overall verdict for interaction models, not merely
    # the conditional main-effect test. Noninteraction behavior remains main.
    legacy = tests["joint"] if "joint" in tests else tests["main"]
    return {"pretrend": legacy, "pretrend_tests": tests}


def _marginal_effects(
    model: PreparedModel,
    xcols: list[str],
    beta: np.ndarray,
    covariance: np.ndarray,
    n_clusters: int,
) -> list[dict]:
    """用完整协方差矩阵计算 β + θ·BaseGVC 的三点线性组合。

    BaseGVC 在建模时已按“个体等权均值”中心化，因此均值点严格为 0；
    P25/P75 也从每个个体唯一的一份基期值计算，不让长面板中的重复年份改变分位点。
    事件研究会为每个可估计事件期分别返回三点效应，由 ``policy_term`` 区分。
    """
    if BASELINE_GVC_COL not in model.data.columns:
        return []
    entity_values = model.data[[model.entity, BASELINE_GVC_COL]].drop_duplicates(model.entity)[BASELINE_GVC_COL]
    if entity_values.empty:
        return []
    levels = (
        ("low", "低（P25）", "p25", float(entity_values.quantile(0.25))),
        ("mean", "均值", "mean", 0.0),
        ("high", "高（P75）", "p75", float(entity_values.quantile(0.75))),
    )
    index = {name: i for i, name in enumerate(xcols)}
    critical = float(stats.t.ppf(0.975, n_clusters - 1))
    suppress_all = bool(model.support and model.support.suppress_inference)
    output: list[dict] = []
    for policy_term in model.policy_xcols:
        if policy_term.endswith("×base_gvc"):
            continue
        interaction_term = f"{policy_term}×base_gvc"
        if policy_term not in index or interaction_term not in index:
            continue
        main_i, interaction_i = index[policy_term], index[interaction_term]
        period = _event_period_for_term(model.event_support, policy_term)
        suppress = suppress_all or bool(period is not None and period.get("inference_supported") is not True)
        for level, label, reference, centered in levels:
            effect = float(beta[main_i] + centered * beta[interaction_i])
            variance = float(
                covariance[main_i, main_i]
                + centered * centered * covariance[interaction_i, interaction_i]
                + 2.0 * centered * covariance[main_i, interaction_i]
            )
            se = math.sqrt(max(variance, 0.0))
            if se <= 0:
                raise ValueError(f"边际效应 {policy_term}/{level} 的标准误非正，无法返回有限诊断")
            t_stat = effect / se
            _require_finite_numerical_output(f"边际效应 {policy_term}/{level}", effect, variance, se, t_stat)
            output.append(
                {
                    "policy_term": policy_term,
                    "interaction_term": interaction_term,
                    "level": level,
                    "label": label,
                    "reference": reference,
                    "baseline_gvc_centered": centered,
                    "effect": effect,
                    "se": se,
                    "t": t_stat,
                    "p": None if suppress else _cluster_t_pvalue(t_stat, n_clusters),
                    "ci_low": None if suppress else effect - critical * se,
                    "ci_high": None if suppress else effect + critical * se,
                }
            )
    return output


def _within_ols(
    model: PreparedModel,
    prepared: tuple[np.ndarray, np.ndarray, list[str], list[str]] | None = None,
) -> RegressionResult:
    """within 变换 + OLS + 聚类稳健标准误的共用核心。data 需已 dropna。

    prepared 可传入 _demean_and_prune 已算好的 (y, X, xcols, dropped),
    避免与 PanelOLS 对照重复做双向去均值。
    """
    data, depvar, entity, time, cluster = (model.data, model.depvar, model.entity, model.time, model.cluster)
    ent = data[entity].values
    tim = data[time].values
    clu = data[cluster].values

    y, X, xcols, dropped = prepared if prepared is not None else _demean_and_prune(model)

    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    _require_finite_numerical_output("回归点估计", y, X, beta, resid)

    # 聚类稳健标准误:V = (X'X)^-1 [Σ_g (X_g'u_g)(X_g'u_g)'] (X'X)^-1,带小样本修正
    XtX_inv = np.linalg.inv(X.T @ X)
    groups = pd.unique(clu)
    n_g = len(groups)
    if n_g <= 1:
        raise ValueError("聚类稳健推断至少需要 2 个聚类；当前样本只有 1 个聚类，无法计算有效的 p 值和置信区间")
    meat = np.zeros((X.shape[1], X.shape[1]))
    for g in groups:
        mask = clu == g
        s = X[mask].T @ resid[mask]
        meat += np.outer(s, s)
    n, k = len(y), X.shape[1]
    correction = (n_g / (n_g - 1)) * ((n - 1) / max(n - k, 1))
    V = correction * XtX_inv @ meat @ XtX_inv
    se = np.sqrt(np.clip(np.diag(V), 0.0, None))
    _require_finite_numerical_output("聚类稳健协方差", XtX_inv, meat, V, se)
    if (se <= 0).any():
        raise ValueError("聚类稳健标准误出现非正值，当前样本无法形成有限统计推断")

    ss_res = float(resid @ resid)
    ss_tot = float(y @ y)
    if not math.isfinite(ss_tot) or ss_tot <= 0:
        raise ValueError("因变量在双向固定效应变换后没有正的有限方差")
    r2_within = 1 - ss_res / ss_tot
    _require_finite_numerical_output("回归拟合统计量", ss_res, ss_tot, r2_within)

    critical = float(stats.t.ppf(0.975, n_g - 1))
    coefs = []
    for name, b, s in zip(xcols, beta, se):
        t_stat = b / s
        _require_finite_numerical_output(f"系数 {name}", b, s, t_stat)
        coefs.append(
            CoefStat(
                name=name,
                coef=float(b),
                se=float(s),
                t=float(t_stat),
                p=_cluster_t_pvalue(float(t_stat), n_g),
                ci_low=float(b - critical * s),
                ci_high=float(b + critical * s),
            )
        )

    notes = list(model.notes)
    if dropped:
        notes.append("控制变量被固定效应吸收/完全共线,已剔除:" + "、".join(dropped))

    support = model.support
    # 处理支持度不足或处理路径与估计量不相容时,点估计与标准误照常返回,
    # 但抑制 p 值、星号与置信区间:能算出数字不等于结果可报告。
    if support is not None and support.suppress_inference:
        coefs = [c.without_inference() for c in coefs]
        notes.append(
            "已抑制 p 值、星号与置信区间:" + ("设计无效" if support.status == "invalid_design" else "处理支持度不足")
        )
    elif model.event_support is not None:
        suppressed_terms = {
            str(period["term"])
            for period in model.event_support.get("periods", [])
            if period.get("estimated") and period.get("inference_supported") is not True
        }
        if suppressed_terms:
            coefs = [c.without_inference() if c.name.replace("×base_gvc", "") in suppressed_terms else c for c in coefs]
            notes.append("逐事件期课程支持门禁已抑制局部 p 值、星号与置信区间：" + "、".join(sorted(suppressed_terms)))
    cluster_note = (
        f"标准误按 {cluster} 聚类(sandwich,{n_g} 组;其中处理聚类 {support.treated_clusters} 个、"
        f"估计样本内完全未暴露聚类 {support.untreated_clusters} 个；未暴露实体 {support.untreated_entities} 个)"
        if support is not None
        else f"标准误按 {cluster} 聚类(sandwich,{n_g} 组)"
    )
    if support is None or not support.suppress_inference:
        cluster_note += f",p 值与 95% 置信区间使用 t({max(n_g - 1, 1)}) 小样本校正"

    return RegressionResult(
        depvar=depvar,
        coefs=coefs,
        n_obs=n,
        n_entities=len(pd.unique(ent)),
        n_times=len(pd.unique(tim)),
        n_clusters=n_g,
        r2_within=r2_within,
        depvar_mean=float(data[depvar].mean()),
        depvar_std=float(data[depvar].std(ddof=1)),
        marginal_effects=_marginal_effects(model, xcols, beta, V, n_g),
        diagnostics=_pretrend_diagnostic(xcols, beta, V, n_g, model.event_support, support)
        if model.event_support is not None
        else {},
        notes=[
            *notes,
            f"双向固定效应({entity} + {time}),within 变换后 OLS",
            cluster_note,
            *(support.reasons if support is not None else []),
            *(
                ["传统 staggered TWFE 在处理效应异质时可能有偏；本教学估计只在识别假设成立时作因果解释。"]
                if model.xcols and (model.xcols[0].startswith("k=") or "×post" in model.xcols[0])
                else []
            ),
        ],
        status=support.status if support is not None else None,
        status_reasons=list(support.reasons) if support is not None else [],
        support=support.to_dict() if support is not None else None,
        event_support=model.event_support,
        sample_flow=model.sample_flow,
    )


def _prepare_fe_model(
    df: pd.DataFrame,
    depvar: str,
    regressors: list[str],
    entity: str = "country",
    time: str = "year",
    cluster: str | None = None,
    controls: list[str] | tuple[str, ...] = (),
    interaction: bool = False,
    treated_col: str | None = None,
    timing: "TreatmentTiming | None" = None,
    input_rows: int | None = None,
) -> PreparedModel:
    cluster = cluster or entity
    interaction_cols: list[str] = []
    xcols = [*regressors, *controls]
    cols = list(dict.fromkeys([depvar, *xcols, entity, time, cluster]))
    # 处理支持度只是诊断,面板没有处理指示列时照常估计,不因缺诊断而失败。
    has_treated = bool(treated_col) and treated_col in df.columns
    if has_treated:
        cols.append(treated_col)
    required_cols = [*cols, *([BASE_GVC_COL] if interaction else [])]
    missing = [c for c in required_cols if c not in df.columns]
    if missing:
        raise ValueError("面板缺少回归变量:" + "、".join(missing))
    _validate_regression_input_boundary(
        df,
        depvar=depvar,
        numeric_columns=[
            *xcols,
            *([treated_col] if has_treated and treated_col is not None else []),
            *([BASE_GVC_COL] if interaction else []),
        ],
        entity=entity,
        time=time,
        cluster=cluster,
    )
    if has_treated and treated_col is not None and timing is None:
        timing = _freeze_treatment_timing(df, entity, time, cluster, treated_col)
    baseline_first = timing.first_by_entity if timing is not None else pd.Series(dtype=float)
    frozen_baseline = _freeze_baseline_gvc(df, entity, time, baseline_first) if interaction else None
    data, sample_flow = _complete_case_with_flow(
        df, cols, depvar, list(controls), entity, time, cluster, timing, input_rows
    )
    if interaction:
        assert frozen_baseline is not None
        complete_case_data = data
        retained_first = _retained_first_treatment(data, entity, timing) if timing is not None else baseline_first
        data = _attach_baseline_gvc(
            data,
            entity,
            time,
            retained_first,
            frozen_baseline=frozen_baseline,
        )
        _record_baseline_flow(
            sample_flow,
            df,
            complete_case_data,
            data,
            entity,
            time,
            cluster,
            frozen_baseline,
            timing,
        )
        for reg in regressors:
            name = f"{reg}×base_gvc"
            data[name] = data[reg] * data[BASELINE_GVC_COL]
            interaction_cols.append(name)
        xcols = [*regressors, *interaction_cols, *controls]
    notes = ["连续冲击强度直接进方程(强度法)"]
    if interaction:
        notes.append(
            "已加入冲击×处理前GVC生产份额交互项；基期值在结果变量/控制变量完整案例筛选前冻结：处理个体取首次处理前最后至多两期有限原始观测，从未处理个体取最早至多两期有限原始观测，并在保留个体间做个体等权的均值中心化"
        )
        attrition_note = _baseline_attrition_note(sample_flow)
        if attrition_note:
            notes.append(attrition_note)
    if controls:
        notes.append("已加入国家-年份控制变量")
    return PreparedModel(
        data=data,
        depvar=depvar,
        xcols=xcols,
        policy_xcols=[*regressors, *interaction_cols],
        control_cols=list(controls),
        entity=entity,
        time=time,
        cluster=cluster,
        notes=notes,
        # 强度法直接用逐年冲击强度,不做"首次处理后永久处理"的编码,
        # 因此处理可逆不构成设计冲突;但处理聚类支持度仍决定推断是否可用。
        support=(
            analyze_support(
                data,
                entity,
                time,
                cluster,
                treated_col,
                absorbing=False,
                first_by_entity=timing.first_by_entity if timing is not None else None,
                timeline_data=timing.timeline_data if timing is not None else None,
            )
            if has_treated and treated_col is not None
            else None
        ),
        timing=timing,
        sample_flow=sample_flow,
    )


def twoway_fe(
    df: pd.DataFrame,
    depvar: str,
    regressors: list[str],
    entity: str = "country",
    time: str = "year",
    cluster: str | None = None,
    controls: list[str] | tuple[str, ...] = (),
    interaction: bool = False,
) -> RegressionResult:
    """y_it = β·X_it + α_i + λ_t + ε_it,标准误按 cluster 聚类(默认=entity)。

    行业级面板用 entity=国家×行业 做固定效应、cluster=国家做聚类:
    同一国家各行业受同一政策冲击,残差组内相关,必须在更粗层面聚类。
    """
    return _within_ols(_prepare_fe_model(df, depvar, regressors, entity, time, cluster, controls, interaction))


def run_design(df: pd.DataFrame, design) -> RegressionResult:
    """按 RegressionDesign 的方法/粒度分发到共用引擎(步骤12–15)。"""
    return _within_ols(prepare_design_model(df, design))


def placebo_did_distribution(
    df: pd.DataFrame,
    design,
    n_draws: int = 80,
    seed: int = 2026,
) -> dict:
    """DID 实体置换敏感性分析:随机指派伪处理组,重复估计主政策系数。

    保持原始设计的样本、控制变量、交互项、处理组数量与首次处理年份(cohort)
    分布不变;每次随机抽取同等数量的个体并分配原始 cohort。它不保留政策的
    国家定向、行业资格、事件分配机制或聚类结构,因此只返回描述性的尾部占比,
    不能解释为校准 p 值或随机化推断。
    """
    if design.method != METHOD_DID:
        raise ValueError("实体置换敏感性分析当前仅支持双重差分 (DID) 设计")
    n_draws = max(1, min(int(n_draws), 200))
    input_rows = int(len(df))
    base, filter_notes = _apply_sample_filter(df, design)
    base = _apply_price_mode(base, design)
    base, _ = _apply_teaching_scenario(base, design)
    frozen_timing = _freeze_treatment_timing(
        base, design.entity, "year", design.cluster, design.treated_col, design.shock_col
    )
    true_model = _prepare_did_model(
        base,
        design.depvar,
        entity=design.entity,
        time="year",
        cluster=design.cluster,
        treated_col=design.treated_col,
        controls=list(design.controls),
        interaction=design.interaction,
        timing=frozen_timing,
        input_rows=input_rows,
    )
    true_model.notes = [*filter_notes, *true_model.notes]
    true_result = _within_ols(true_model)
    policy_name = true_model.policy_xcols[0]
    true_coef = next(c.coef for c in true_result.coefs if c.name == policy_name)

    data = true_model.data.copy()
    entity_text = data[true_model.entity].astype(str)
    entities = np.array(sorted(pd.unique(entity_text)))
    true_first = entity_text.map(frozen_timing.first_by_entity)
    true_post = true_first.notna() & (data[true_model.time].astype(int) >= true_first)
    effective_treated = sorted(pd.unique(entity_text[true_post]))
    retained_first = frozen_timing.first_by_entity.reindex(effective_treated).dropna().astype(int)
    cohort_counts = retained_first.value_counts().sort_index().astype(int)
    max_year_by_entity = data.assign(__entity_text=entity_text).groupby("__entity_text")[true_model.time].max()
    treated_count = int(cohort_counts.sum())
    if treated_count <= 0 or treated_count >= len(entities):
        raise ValueError("实体置换敏感性分析需要同时存在处理组和对照组")

    rng = np.random.default_rng(seed)
    coefs: list[float] = []
    attempts = 0
    pseudo_col = "__placebo_treated"
    while len(coefs) < n_draws and attempts < n_draws * 4:
        attempts += 1
        assigned_year: dict[str, int] = {}
        remaining = set(str(item) for item in entities)
        assignment_ok = True
        # 先分配最晚 cohort，保证每个伪处理实体在最终估计样本中至少有一个 post 行。
        for cohort, count in reversed(list(cohort_counts.items())):
            eligible = sorted(entity for entity in remaining if int(max_year_by_entity[entity]) >= int(cohort))
            if len(eligible) < int(count):
                assignment_ok = False
                break
            chosen = [str(item) for item in rng.choice(eligible, size=int(count), replace=False)]
            for assigned in chosen:
                assigned_year[assigned] = int(cohort)
                remaining.remove(assigned)
        if not assignment_ok:
            continue
        # Rebuild each placebo from the full structurally filtered panel so its
        # pseudo-G_i moderator is frozen before the same outcome/control attrition.
        pseudo = base.copy()
        pseudo_first = pseudo[true_model.entity].astype(str).map(assigned_year)
        pseudo[pseudo_col] = (pseudo_first.notna() & (pseudo[true_model.time].astype(int) >= pseudo_first)).astype(int)
        try:
            pseudo_timing = _timing_from_assignments(
                pseudo,
                true_model.entity,
                true_model.time,
                true_model.cluster,
                pseudo_col,
                assigned_year,
            )
            placebo_model = _prepare_did_model(
                pseudo,
                design.depvar,
                entity=true_model.entity,
                time=true_model.time,
                cluster=true_model.cluster,
                treated_col=pseudo_col,
                controls=true_model.control_cols,
                interaction=design.interaction,
                timing=pseudo_timing,
                input_rows=input_rows,
            )
            placebo_result = _within_ols(placebo_model)
        except ValueError:
            continue
        placebo_name = placebo_model.policy_xcols[0]
        coefs.append(next(c.coef for c in placebo_result.coefs if c.name == placebo_name))

    if not coefs:
        raise ValueError("无法生成可估计的置换样本")
    extreme_count = sum(abs(c) >= abs(true_coef) for c in coefs)
    # 图表所说的“占比”必须能由展示的抽样系数直接复算。加一修正另存为兼容
    # 统计量；由于置换机制并非真实政策的分配机制，两者都不是校准 p 值。
    tail_share = extreme_count / len(coefs)
    adjusted_tail_share = (extreme_count + 1) / (len(coefs) + 1)
    return {
        "policy_name": policy_name,
        "true_coef": float(true_coef),
        "placebo_coefs": [float(c) for c in coefs],
        "tail_share": float(tail_share),
        "extreme_count": int(extreme_count),
        "adjusted_tail_share": float(adjusted_tail_share),
        # 暂留旧字段以避免破坏既有 API 消费者；教学界面不得把它标成 p 值。
        "empirical_p": float(adjusted_tail_share),
        "n_draws": len(coefs),
        "requested_draws": n_draws,
        "seed": int(seed),
        "treated_entities": treated_count,
        "total_entities": int(len(entities)),
        "cohorts": {str(int(k)): int(v) for k, v in cohort_counts.items()},
        "calibrated_inference": False,
        "assignment_preserved": ["处理实体数量", "首次处理年份(cohort)数量分布"],
        "assignment_not_preserved": ["政策的国家定向", "行业资格", "事件分配机制", "国家聚类结构"],
        "note": "非校准实体置换:仅保留处理实体数量与首次处理年份(cohort)数量分布",
    }


def prepare_design_model(df: pd.DataFrame, design) -> PreparedModel:
    """按 RegressionDesign 构造同一份估计样本,供自写引擎与 PanelOLS 共用。"""
    input_rows = int(len(df))
    df, filter_notes = _apply_sample_filter(df, design)
    boundary_numeric = [
        *design.controls,
        *(
            [design.treated_col, *([design.shock_col] if design.shock_col in df.columns else [])]
            if design.method in {METHOD_DID, METHOD_EVENT_STUDY}
            else [*design.regressors, *([design.treated_col] if design.treated_col in df.columns else [])]
        ),
        *([BASE_GVC_COL] if design.interaction else []),
        *([DEFLATOR_COL] if getattr(design, "price_mode", None) == PRICE_MODE_REAL else []),
    ]
    boundary_required = list(dict.fromkeys([design.depvar, *boundary_numeric, design.entity, "year", design.cluster]))
    missing = [column for column in boundary_required if column not in df.columns]
    if missing:
        raise ValueError("面板缺少回归变量:" + "、".join(missing))
    _validate_regression_input_boundary(
        df,
        depvar=design.depvar,
        numeric_columns=boundary_numeric,
        entity=design.entity,
        time="year",
        cluster=design.cluster,
    )
    df = _apply_price_mode(df, design)
    df, scenario_notes = _apply_teaching_scenario(df, design)
    timing = (
        _freeze_treatment_timing(
            df,
            design.entity,
            "year",
            design.cluster,
            design.treated_col,
            design.shock_col,
        )
        if design.treated_col in df.columns
        else None
    )
    kwargs = dict(
        entity=design.entity,
        time="year",
        cluster=design.cluster,
        controls=list(design.controls),
        interaction=design.interaction,
        timing=timing,
        input_rows=input_rows,
    )
    if design.method == METHOD_DID:
        model = _prepare_did_model(
            df, design.depvar, treated_col=design.treated_col, intensity_col=design.shock_col, **kwargs
        )
    elif design.method == METHOD_EVENT_STUDY:
        model = _prepare_event_model(
            df, design.depvar, treated_col=design.treated_col, intensity_col=design.shock_col, **kwargs
        )
    else:
        model = _prepare_fe_model(df, design.depvar, list(design.regressors), treated_col=design.treated_col, **kwargs)
    model.notes = [*filter_notes, *model.notes]
    model.notes.extend(scenario_notes)
    if getattr(design, "price_mode", None) == PRICE_MODE_REAL:
        model.notes.append("实际值口径:金额类控制变量已用 GDP 平减指数调整(基期=1)")
    return model


@dataclass
class TreatmentTiming:
    """Outcome-independent first-treatment timing frozen from the full shock history."""

    first_by_entity: pd.Series  # index is normalized entity text, values are integer G_i
    timeline_data: pd.DataFrame
    entity: str
    time: str
    cluster: str
    treated_col: str
    intensity_col: str | None = None


def _freeze_treatment_timing(
    data: pd.DataFrame,
    entity: str,
    time: str,
    cluster: str,
    treated_col: str,
    intensity_col: str | None = None,
) -> TreatmentTiming:
    """Validate and freeze G_i before any outcome/control complete-case deletion."""
    required = list(dict.fromkeys([entity, time, cluster, treated_col]))
    missing = [column for column in required if column not in data.columns]
    if missing:
        raise ValueError("处理时点面板缺少变量:" + "、".join(missing))
    if data.empty:
        raise ValueError("处理时点面板为空,无法确定首次处理年份")
    _validate_identifier_values(data, [entity, cluster])
    try:
        _validate_time_values(data, time)
    except ValueError as exc:
        raise ValueError(f"处理时点变量 {time} 含缺失、非数值、非有限值或非整数") from exc
    try:
        _validate_numeric_values(data, [treated_col], allow_null=False)
    except ValueError as exc:
        raise ValueError(f"处理状态 {treated_col} 含缺失、非数值或非有限值,不能按 0 处理") from exc
    if intensity_col and intensity_col in data.columns:
        try:
            _validate_numeric_values(data, [intensity_col], allow_null=False)
        except ValueError as exc:
            raise ValueError(f"处理强度 {intensity_col} 含缺失、非数值或非有限值") from exc

    timeline = data[required].copy()
    for column in (entity, cluster):
        invalid = timeline[column].isna() | timeline[column].astype(str).str.strip().eq("")
        if invalid.any():
            raise ValueError(f"处理时点变量 {column} 含缺失或空标识,不能把未知身份解释为未处理")
        timeline[column] = timeline[column].astype(str)

    numeric_time = pd.to_numeric(timeline[time], errors="coerce")
    if numeric_time.isna().any() or not np.isfinite(numeric_time.to_numpy(dtype=float)).all():
        raise ValueError(f"处理时点变量 {time} 含缺失或非数值")
    if not np.equal(numeric_time.to_numpy(dtype=float), np.floor(numeric_time.to_numpy(dtype=float))).all():
        raise ValueError(f"处理时点变量 {time} 必须是整数年份")
    timeline[time] = numeric_time.astype(int)

    treatment = pd.to_numeric(timeline[treated_col], errors="coerce")
    if treatment.isna().any() or not np.isfinite(treatment.to_numpy(dtype=float)).all():
        raise ValueError(f"处理状态 {treated_col} 含缺失或非数值,不能按 0 处理")
    if not treatment.isin([0, 1]).all():
        raise ValueError(f"处理状态 {treated_col} 必须严格为 0/1")
    timeline[treated_col] = treatment.astype(int)

    if timeline.duplicated([entity, time]).any():
        duplicate = timeline.loc[timeline.duplicated([entity, time], keep=False), [entity, time]].iloc[0]
        raise ValueError(f"处理时点面板要求 entity-year 唯一: {duplicate[entity]} / {duplicate[time]}")
    cluster_counts = timeline.groupby(entity, sort=False)[cluster].nunique(dropna=False)
    if (cluster_counts > 1).any():
        bad = str(cluster_counts[cluster_counts > 1].index[0])
        raise ValueError(f"一个实体只能映射到一个聚类；{bad} 映射到多个 {cluster}")

    usable_intensity = intensity_col if intensity_col and intensity_col in data.columns else None
    if usable_intensity:
        intensity = pd.to_numeric(data[usable_intensity], errors="coerce")
        if intensity.isna().any() or not np.isfinite(intensity.to_numpy(dtype=float)).all():
            raise ValueError(f"处理强度 {usable_intensity} 含缺失或非数值")
        timeline[usable_intensity] = intensity.to_numpy(dtype=float)

    treated = timeline[treated_col].eq(1)
    if not treated.any():
        raise ValueError(f"面板中没有受处理个体({treated_col} 全为 0),无法做 DID/事件研究")
    first_by_entity = (
        timeline.loc[treated, [entity, time]].groupby(entity, sort=True)[time].min().astype(int).sort_index()
    )
    return TreatmentTiming(
        first_by_entity=first_by_entity,
        timeline_data=timeline,
        entity=entity,
        time=time,
        cluster=cluster,
        treated_col=treated_col,
        intensity_col=usable_intensity,
    )


def _attach_treatment_timing(data: pd.DataFrame, entity: str, timing: TreatmentTiming) -> tuple[pd.Series, np.ndarray]:
    first_year = data[entity].astype(str).map(timing.first_by_entity)
    return first_year, first_year.notna().to_numpy(dtype=float)


def _retained_first_treatment(data: pd.DataFrame, entity: str, timing: TreatmentTiming) -> pd.Series:
    retained = pd.Index(data[entity].astype(str).unique())
    return timing.first_by_entity.reindex(retained).dropna().astype(int)


def _refresh_estimation_flow(
    flow: dict,
    data: pd.DataFrame,
    entity: str,
    time: str,
    cluster: str,
    timing: TreatmentTiming | None,
) -> None:
    """Refresh final-sample counts after each complete-case attrition stage."""
    retained_entities = set(data[entity].astype(str))
    retained_clusters = set(data[cluster].astype(str))
    flow["estimation_rows"] = int(len(data))
    flow["estimation_entities"] = len(retained_entities)
    flow["estimation_clusters"] = len(retained_clusters)
    if timing is None:
        return
    treated_entities = set(timing.first_by_entity.index.astype(str))
    retained_treated = retained_entities & treated_entities
    retained_never = retained_entities - treated_entities
    retained_first = timing.first_by_entity.reindex(sorted(retained_treated)).dropna().astype(int)
    first_year = data[entity].astype(str).map(timing.first_by_entity)
    post = first_year.notna() & (pd.to_numeric(data[time], errors="coerce") >= first_year)
    post_entities = set(data.loc[post, entity].astype(str))
    post_clusters = set(data.loc[post, cluster].astype(str))
    contributing_first = timing.first_by_entity.reindex(sorted(post_entities)).dropna().astype(int)
    flow.update(
        {
            "retained_treated_entities": len(retained_treated),
            "retained_never_treated_entities": len(retained_never),
            "treated_entities_without_post_rows": len(retained_treated - post_entities),
            "contributing_treated_entities": len(post_entities),
            "contributing_treated_clusters": len(post_clusters),
            "retained_cohorts": {
                str(int(year)): int(count) for year, count in retained_first.value_counts().sort_index().items()
            },
            "contributing_cohorts": {
                str(int(year)): int(count)
                for year, count in contributing_first.value_counts().sort_index().items()
            },
        }
    )


def _record_baseline_flow(
    flow: dict,
    source: pd.DataFrame,
    complete_case_data: pd.DataFrame,
    estimation_data: pd.DataFrame,
    entity: str,
    time: str,
    cluster: str,
    frozen_baseline: pd.Series,
    timing: TreatmentTiming | None,
) -> None:
    """Record derived-moderator complete-case attrition and retained centering scope."""
    complete_entities = set(complete_case_data[entity].astype(str))
    retained_entities = set(estimation_data[entity].astype(str))
    missing_entities = sorted(complete_entities - retained_entities)
    dropped_rows = int(complete_case_data[entity].astype(str).isin(missing_entities).sum())
    flow["missing_by_field"][BASELINE_GVC_COL] = dropped_rows
    if dropped_rows:
        flow["dropped_rows_total"] += dropped_rows
        flow["dropped_by_reason"].append(
            {
                "code": "missing_derived_baseline_gvc",
                "field": BASELINE_GVC_COL,
                "rows": dropped_rows,
            }
        )
    flow.update(
        {
            "baseline_policy": (
                "full_structurally_filtered_panel_before_outcome_control_complete_case;"
                "treated_last_up_to_2_finite_pre_G_i;never_treated_earliest_up_to_2_finite;"
                "drop_entities_without_finite_derived_baseline;retained_entity_equal_center"
            ),
            "baseline_source_rows": int(len(source)),
            "baseline_source_entities": int(source[entity].astype(str).nunique()),
            "baseline_source_structural_null_rows": int(source[BASE_GVC_COL].isna().sum()),
            "baseline_entities_available": int(len(frozen_baseline)),
            "baseline_derived_missing_entities": missing_entities,
            "baseline_derived_dropped_entities": len(missing_entities),
            "baseline_derived_dropped_rows": dropped_rows,
            "baseline_retained_entities": len(retained_entities),
        }
    )
    _refresh_estimation_flow(flow, estimation_data, entity, time, cluster, timing)


def _baseline_attrition_note(flow: dict) -> str | None:
    entities = int(flow.get("baseline_derived_dropped_entities", 0))
    rows = int(flow.get("baseline_derived_dropped_rows", 0))
    if not entities:
        return None
    entity_ids = "、".join(str(item) for item in flow.get("baseline_derived_missing_entities", []))
    return (
        f"基期 GVC 完整案例筛选：{entities} 个实体（{entity_ids}）在完整结构历史中无有限派生基期值，"
        f"已在保留实体中心化前删除其全部 {rows} 行；未以 0 填补"
    )


def _timing_from_assignments(
    data: pd.DataFrame,
    entity: str,
    time: str,
    cluster: str,
    treated_col: str,
    assigned_year: dict[str, int],
) -> TreatmentTiming:
    timeline = data[list(dict.fromkeys([entity, time, cluster, treated_col]))].copy()
    timeline[entity] = timeline[entity].astype(str)
    timeline[cluster] = timeline[cluster].astype(str)
    timeline[time] = pd.to_numeric(timeline[time], errors="raise").astype(int)
    timeline[treated_col] = pd.to_numeric(timeline[treated_col], errors="raise").astype(int)
    first = pd.Series(assigned_year, dtype=int).sort_index()
    return TreatmentTiming(first, timeline, entity, time, cluster, treated_col)


def _drop_reason(field_name: str, depvar: str, controls: list[str], entity: str, time: str, cluster: str) -> str:
    if field_name == depvar:
        return "missing_outcome"
    if field_name in controls:
        return "missing_control"
    if field_name == BASE_GVC_COL:
        return "missing_baseline_gvc"
    if field_name in {entity, time, cluster}:
        return "missing_identifier"
    return "missing_regressor"


def _complete_case_with_flow(
    df: pd.DataFrame,
    cols: list[str],
    depvar: str,
    controls: list[str],
    entity: str,
    time: str,
    cluster: str,
    timing: TreatmentTiming | None,
    input_rows: int | None = None,
) -> tuple[pd.DataFrame, dict]:
    """Complete-case once while preserving both overlapping and exclusive attrition counts."""
    eligible_rows = int(len(df))
    input_count = eligible_rows if input_rows is None else int(input_rows)
    frame = df[cols]
    missing_by_field = {column: int(frame[column].isna().sum()) for column in cols}
    any_missing = frame.isna().any(axis=1)
    assigned = pd.Series(False, index=frame.index)
    dropped_by_reason: list[dict[str, str | int]] = []
    priority = [depvar, *controls, *[column for column in cols if column not in {depvar, *controls}]]
    for column in dict.fromkeys(priority):
        mask = frame[column].isna() & ~assigned
        count = int(mask.sum())
        if count:
            dropped_by_reason.append(
                {"code": _drop_reason(column, depvar, controls, entity, time, cluster), "field": column, "rows": count}
            )
            assigned |= mask
    data = frame.loc[~any_missing].reset_index(drop=True)

    flow: dict = {
        "input_rows": input_count,
        "structural_eligible_rows": eligible_rows,
        "structural_excluded_rows": max(input_count - eligible_rows, 0),
        "timing_source_rows": int(len(timing.timeline_data)) if timing is not None else 0,
        "timing_entities": int(timing.timeline_data[timing.entity].nunique()) if timing is not None else 0,
        "timing_clusters": int(timing.timeline_data[timing.cluster].nunique()) if timing is not None else 0,
        "timing_treated_entities": int(len(timing.first_by_entity)) if timing is not None else 0,
        "timing_cohorts": (
            {str(int(year)): int(count) for year, count in timing.first_by_entity.value_counts().sort_index().items()}
            if timing is not None
            else {}
        ),
        "timing_policy": "full_shock_history_before_complete_case" if timing is not None else None,
        "estimation_rows": int(len(data)),
        "dropped_rows_total": int(any_missing.sum()),
        "missing_by_field": missing_by_field,
        "missing_by_field_counts_overlap": True,
        "dropped_by_reason": dropped_by_reason,
    }
    _refresh_estimation_flow(flow, data, entity, time, cluster, timing)
    return data, flow


def _prepare_did_model(
    df: pd.DataFrame,
    depvar: str,
    entity: str = "country",
    time: str = "year",
    cluster: str | None = None,
    treated_col: str = "treated",
    controls: list[str] | tuple[str, ...] = (),
    interaction: bool = False,
    intensity_col: str | None = None,
    timing: TreatmentTiming | None = None,
    input_rows: int | None = None,
) -> PreparedModel:
    cluster = cluster or entity
    cols = list(dict.fromkeys([depvar, treated_col, entity, time, cluster, *controls]))
    # 冲击强度列只用于识别真正的政策撤销;缺失时退回按处理指示列判断。
    if intensity_col and intensity_col in df.columns:
        cols.append(intensity_col)
    required_cols = [*cols, *([BASE_GVC_COL] if interaction else [])]
    missing = [c for c in required_cols if c not in df.columns]
    if missing:
        raise ValueError("面板缺少回归变量:" + "、".join(missing))
    _validate_regression_input_boundary(
        df,
        depvar=depvar,
        numeric_columns=[
            treated_col,
            *controls,
            *([intensity_col] if intensity_col and intensity_col in df.columns else []),
            *([BASE_GVC_COL] if interaction else []),
        ],
        entity=entity,
        time=time,
        cluster=cluster,
    )
    if timing is None:
        timing = _freeze_treatment_timing(df, entity, time, cluster, treated_col, intensity_col)
    frozen_baseline = _freeze_baseline_gvc(df, entity, time, timing.first_by_entity) if interaction else None
    data, sample_flow = _complete_case_with_flow(
        df, cols, depvar, list(controls), entity, time, cluster, timing, input_rows
    )
    first_year, _ = _attach_treatment_timing(data, entity, timing)
    did_col = "treated×post" if treated_col == "treated" else f"{treated_col}×post"
    data[did_col] = (first_year.notna() & (data[time].astype(int) >= first_year)).astype(float)
    policy_xcols = [did_col]
    xcols = [did_col]
    if interaction:
        assert frozen_baseline is not None
        complete_case_data = data
        data = _attach_baseline_gvc(
            data,
            entity,
            time,
            _retained_first_treatment(data, entity, timing),
            frozen_baseline=frozen_baseline,
        )
        _record_baseline_flow(
            sample_flow,
            df,
            complete_case_data,
            data,
            entity,
            time,
            cluster,
            frozen_baseline,
            timing,
        )
        interaction_col = f"{did_col}×base_gvc"
        data[interaction_col] = data[did_col] * data[BASELINE_GVC_COL]
        policy_xcols.append(interaction_col)
        xcols.append(interaction_col)
    cohort_summary = "、".join(
        f"{int(y)}:{int(n)}" for y, n in timing.first_by_entity.value_counts().sort_index().items()
    )
    n_treated = int(timing.first_by_entity.size)
    notes = [
        f"DID:处理组={n_treated} 个曾受冲击个体,处理期=各个体首次冲击年 G_i 起",
        f"首次处理年份(cohort):{cohort_summary}",
    ]
    if interaction:
        notes.append(
            "已加入处理效应×处理前GVC生产份额交互项；基期值在结果变量/控制变量完整案例筛选前冻结：处理个体取首次处理前最后至多两期有限原始观测，从未处理个体取最早至多两期有限原始观测，并在保留个体间做个体等权的均值中心化"
        )
        attrition_note = _baseline_attrition_note(sample_flow)
        if attrition_note:
            notes.append(attrition_note)
    if controls:
        notes.append("已加入国家-年份控制变量")
    return PreparedModel(
        data=data,
        depvar=depvar,
        xcols=[*xcols, *controls],
        policy_xcols=policy_xcols,
        control_cols=list(controls),
        entity=entity,
        time=time,
        cluster=cluster,
        notes=notes,
        # DID 用 1[t≥G_i] 编码处理,首次处理后永久为 1 → 吸收型。
        support=analyze_support(
            data,
            entity,
            time,
            cluster,
            treated_col,
            absorbing=True,
            intensity_col=intensity_col,
            first_by_entity=timing.first_by_entity,
            timeline_data=timing.timeline_data,
        ),
        timing=timing,
        sample_flow=sample_flow,
    )


def did(
    df: pd.DataFrame,
    depvar: str,
    entity: str = "country",
    time: str = "year",
    cluster: str | None = None,
    treated_col: str = "treated",
    controls: list[str] | tuple[str, ...] = (),
    interaction: bool = False,
) -> RegressionResult:
    """双重差分:y_it = β·(treated_i × 1[t≥G_i]) + α_i + λ_t + ε_it。

    treated_i = 该个体在样本期内是否曾受冲击(时间不变);
    post_it   = 年份 ≥ G_i,其中 G_i 是该个体首次受冲击年份;
    β         = 处理组相对对照组在处理后的平均变化；因果解释依赖识别假设。
    处理组/对照组主效应分别被个体/时间固定效应吸收。
    """
    return _within_ols(_prepare_did_model(df, depvar, entity, time, cluster, treated_col, controls, interaction))


def _event_term(k: int) -> str:
    return "k=0" if k == 0 else f"k={k:+d}"


def _build_event_support(
    data: pd.DataFrame,
    event_time: pd.Series,
    observed_k: list[int],
    base_k: int,
    entity: str,
    cluster: str,
    first_year: pd.Series,
) -> dict:
    """按最终估计行和冻结 G_i 构造逐事件期课程支持门禁。"""
    reference_mask = event_time == base_k
    reference_clusters = int(data.loc[reference_mask, cluster].nunique())
    reference_supported = reference_clusters >= MIN_TREATED_CLUSTERS
    periods: list[dict] = []
    for k in observed_k:
        mask = event_time == k
        contributing = data.loc[mask]
        # 直接消费已按原始实体行附着的 frozen G_i；不把实体键转成字符串后再 reindex。
        entities = set(contributing[entity].tolist())
        cohort_rows = pd.DataFrame(
            {"entity": contributing[entity], "cohort": first_year.loc[mask]},
            index=contributing.index,
        ).drop_duplicates("entity")
        cohorts = cohort_rows["cohort"].dropna().astype(int).value_counts().sort_index()
        contributing_clusters = int(contributing[cluster].nunique())
        period_supported = contributing_clusters >= MIN_TREATED_CLUSTERS
        reason_codes: list[str] = []
        reasons: list[str] = []
        if not period_supported:
            reason_codes.append("insufficient_period_clusters")
            reasons.append(
                f"{_event_term(k)} 只有 {contributing_clusters} 个贡献处理聚类，低于课程政策下限 "
                f"{MIN_TREATED_CLUSTERS}。"
            )
        if k != base_k and not reference_supported:
            reason_codes.append("insufficient_reference_clusters")
            reasons.append(
                f"省略基期 {_event_term(base_k)} 只有 {reference_clusters} 个贡献处理聚类，低于课程政策下限 "
                f"{MIN_TREATED_CLUSTERS}。"
            )
        inference_supported = period_supported and reference_supported
        if reasons:
            reasons[-1] += "保留点估计与标准误，但抑制 p 值、星号和置信区间。"
        periods.append(
            {
                "term": _event_term(k),
                "event_time": int(k),
                "is_reference": k == base_k,
                "estimated": k != base_k,
                "contributing_rows": int(mask.sum()),
                "contributing_entities": len(entities),
                "contributing_clusters": contributing_clusters,
                "cohorts": {str(int(year)): int(count) for year, count in cohorts.items()},
                "period_supported": period_supported,
                "inference_supported": inference_supported,
                "suppress_inference": not inference_supported,
                "reason_codes": reason_codes,
                "reasons": reasons,
            }
        )
    return {
        "policy": "teaching_min_contributing_clusters_per_event_period",
        "policy_is_statistical_theorem": False,
        "cluster": cluster,
        "base_k": int(base_k),
        "reference_term": _event_term(base_k),
        "min_contributing_clusters": MIN_TREATED_CLUSTERS,
        "periods": periods,
    }


def _prepare_event_model(
    df: pd.DataFrame,
    depvar: str,
    entity: str = "country",
    time: str = "year",
    cluster: str | None = None,
    treated_col: str = "treated",
    controls: list[str] | tuple[str, ...] = (),
    interaction: bool = False,
    intensity_col: str | None = None,
    timing: TreatmentTiming | None = None,
    input_rows: int | None = None,
) -> PreparedModel:
    cluster = cluster or entity
    cols = list(dict.fromkeys([depvar, treated_col, entity, time, cluster, *controls]))
    # 冲击强度列只用于识别真正的政策撤销;缺失时退回按处理指示列判断。
    if intensity_col and intensity_col in df.columns:
        cols.append(intensity_col)
    required_cols = [*cols, *([BASE_GVC_COL] if interaction else [])]
    missing = [c for c in required_cols if c not in df.columns]
    if missing:
        raise ValueError("面板缺少回归变量:" + "、".join(missing))
    _validate_regression_input_boundary(
        df,
        depvar=depvar,
        numeric_columns=[
            treated_col,
            *controls,
            *([intensity_col] if intensity_col and intensity_col in df.columns else []),
            *([BASE_GVC_COL] if interaction else []),
        ],
        entity=entity,
        time=time,
        cluster=cluster,
    )
    if timing is None:
        timing = _freeze_treatment_timing(df, entity, time, cluster, treated_col, intensity_col)
    frozen_baseline = _freeze_baseline_gvc(df, entity, time, timing.first_by_entity) if interaction else None
    data, sample_flow = _complete_case_with_flow(
        df, cols, depvar, list(controls), entity, time, cluster, timing, input_rows
    )
    if interaction:
        assert frozen_baseline is not None
        complete_case_data = data
        data = _attach_baseline_gvc(
            data,
            entity,
            time,
            _retained_first_treatment(data, entity, timing),
            frozen_baseline=frozen_baseline,
        )
        _record_baseline_flow(
            sample_flow,
            df,
            complete_case_data,
            data,
            entity,
            time,
            cluster,
            frozen_baseline,
            timing,
        )
    first_year, _ = _attach_treatment_timing(data, entity, timing)

    event_time = data[time].astype(int) - first_year
    observed_k = sorted(event_time[first_year.notna()].dropna().astype(int).unique())
    if not observed_k:
        raise ValueError("事件研究没有可估计的事件时间")
    negative_k = [k for k in observed_k if k < 0]
    if not negative_k:
        raise ValueError("事件研究至少需要一个真实的处理前事件期(k<0)，当前样本没有处理前观测")
    base_k = -1 if -1 in observed_k else max(negative_k)
    xcols = []
    for k in observed_k:
        if k == base_k:
            continue
        name = _event_term(int(k))
        data[name] = (first_year.notna() & (event_time == k)).astype(float)
        if data[name].sum() > 0:
            xcols.append(name)
    if not xcols:
        raise ValueError("事件研究除基期外没有可估计的事件时间")
    event_support = _build_event_support(
        data, event_time, [int(k) for k in observed_k], int(base_k), entity, cluster, first_year
    )
    policy_xcols = list(xcols)
    if interaction:
        interaction_cols = []
        for name in xcols:
            interaction_col = f"{name}×base_gvc"
            data[interaction_col] = data[name] * data[BASELINE_GVC_COL]
            interaction_cols.append(interaction_col)
        xcols = [*xcols, *interaction_cols]
        policy_xcols = list(xcols)
    cohort_summary = "、".join(
        f"{int(y)}:{int(n)}" for y, n in timing.first_by_entity.value_counts().sort_index().items()
    )
    notes = [
        f"事件研究:事件时间 k=year-G_i(G_i 为个体首次冲击年),基期 k={base_k:+d};k<0 的系数用于检查是否存在明显冲击前差异",
        f"首次处理年份(cohort):{cohort_summary}",
    ]
    if interaction:
        notes.append(
            "已加入动态效应×处理前GVC生产份额交互项；基期值在结果变量/控制变量完整案例筛选前冻结：处理个体取首次处理前最后至多两期有限原始观测，从未处理个体取最早至多两期有限原始观测，并在保留个体间做个体等权的均值中心化"
        )
        attrition_note = _baseline_attrition_note(sample_flow)
        if attrition_note:
            notes.append(attrition_note)
    if controls:
        notes.append("已加入国家-年份控制变量")
    return PreparedModel(
        data=data,
        depvar=depvar,
        xcols=[*xcols, *controls],
        policy_xcols=policy_xcols,
        control_cols=list(controls),
        entity=entity,
        time=time,
        cluster=cluster,
        notes=notes,
        # 事件研究同样围绕首次处理年 G_i 构造 → 吸收型。
        support=analyze_support(
            data,
            entity,
            time,
            cluster,
            treated_col,
            absorbing=True,
            intensity_col=intensity_col,
            first_by_entity=timing.first_by_entity,
            timeline_data=timing.timeline_data,
        ),
        timing=timing,
        event_support=event_support,
        sample_flow=sample_flow,
    )


def event_study(
    df: pd.DataFrame,
    depvar: str,
    entity: str = "country",
    time: str = "year",
    cluster: str | None = None,
    treated_col: str = "treated",
    controls: list[str] | tuple[str, ...] = (),
    interaction: bool = False,
) -> RegressionResult:
    """事件研究:y_it = Σ_{k≠base} β_k·1[t-G_i = k] + α_i + λ_t + ε_it。

    G_i 是个体 i 的首次受冲击年份;优先以冲击前一年(k=-1)为基期。
    k<0 的系数用于检查是否存在明显冲击前差异；未拒绝联合零假设不能证明平行趋势。
    k≥0 的系数描述相对基期的动态路径。
    """
    return _within_ols(_prepare_event_model(df, depvar, entity, time, cluster, treated_col, controls, interaction))


def _panelols_estimate(
    model: PreparedModel,
    keep_xcols: list[str],
    dropped: list[str],
) -> RegressionResult:
    """用 linearmodels.PanelOLS 估计标准库对照。

    keep_xcols 为共线剔除后保留的解释变量(与自写引擎同一份),
    因此这里不再重复做 within 变换判定,只让 PanelOLS 内部吸收固定效应。
    """
    data = model.data.set_index([model.entity, model.time])
    y = data[model.depvar].astype(float)
    X = data[keep_xcols].astype(float)
    clusters = pd.Series(model.data[model.cluster].values, index=data.index, name=model.cluster)

    n_clusters = int(model.data[model.cluster].nunique())
    if n_clusters <= 1:
        raise ValueError("聚类稳健推断至少需要 2 个聚类；当前样本只有 1 个聚类，无法计算有效的 p 值和置信区间")

    res = PanelOLS(
        y,
        X,
        entity_effects=True,
        time_effects=True,
        drop_absorbed=True,
    ).fit(cov_type="clustered", clusters=clusters)

    critical = float(stats.t.ppf(0.975, n_clusters - 1))
    coefs = []
    for name, b in res.params.items():
        se = float(res.std_errors[name])
        t_stat = float(res.tstats[name])
        pval = _cluster_t_pvalue(t_stat, n_clusters)
        _require_finite_numerical_output(f"PanelOLS 系数 {name}", float(b), se, t_stat, pval)
        if se <= 0:
            raise ValueError(f"PanelOLS 系数 {name} 的聚类稳健标准误非正")
        coefs.append(
            CoefStat(
                name=name,
                coef=float(b),
                se=se,
                t=t_stat,
                p=pval,
                ci_low=float(b - critical * se),
                ci_high=float(b + critical * se),
            )
        )

    notes = list(model.notes)
    if dropped:
        notes.append("控制变量被固定效应吸收/完全共线,已剔除:" + "、".join(dropped))
    panel_r2 = float(res.rsquared_within)
    depvar_mean = float(model.data[model.depvar].mean())
    depvar_std = float(model.data[model.depvar].std(ddof=1))
    _require_finite_numerical_output("PanelOLS 汇总统计量", panel_r2, depvar_mean, depvar_std)
    return RegressionResult(
        depvar=model.depvar,
        coefs=coefs,
        n_obs=int(res.nobs),
        n_entities=int(model.data[model.entity].nunique()),
        n_times=int(model.data[model.time].nunique()),
        n_clusters=n_clusters,
        r2_within=panel_r2,
        depvar_mean=depvar_mean,
        depvar_std=depvar_std,
        diagnostics={},
        notes=[
            *notes,
            f"标准库对照:linearmodels.PanelOLS({model.entity} + {model.time})",
            f"标准误按 {model.cluster} 聚类；p 值和 95% 置信区间为教学界面统一按 t({n_clusters - 1}) 重算",
            "PanelOLS 仅用于检查实现结果一致性，不验证因果识别假设。",
        ],
        sample_flow=model.sample_flow,
    )


def linearmodels_panel_ols(df: pd.DataFrame, design) -> RegressionResult:
    """使用 linearmodels.PanelOLS 估计同一设计,作为标准库对照(独立入口)。"""
    model = prepare_design_model(df, design)
    _, _, xcols, dropped = _demean_and_prune(model)
    return _panelols_estimate(model, xcols, dropped)


def _summarize_benchmark(
    model: PreparedModel,
    own: RegressionResult,
    lm: RegressionResult,
) -> dict:
    """自写引擎与 PanelOLS 在核心政策系数上的差异摘要。"""
    own_by = {c.name: c for c in own.coefs}
    lm_by = {c.name: c for c in lm.coefs}
    rows: list[dict[str, str | float]] = []
    for name in model.policy_xcols:
        if name not in own_by or name not in lm_by:
            continue
        rows.append(
            {
                "name": name,
                "own_coef": own_by[name].coef,
                "panelols_coef": lm_by[name].coef,
                "coef_diff": own_by[name].coef - lm_by[name].coef,
                "own_se": own_by[name].se,
                "panelols_se": lm_by[name].se,
                "se_diff": own_by[name].se - lm_by[name].se,
            }
        )
    if not rows:
        raise ValueError("PanelOLS 对照没有返回可比较的政策系数")
    max_coef = max(abs(float(row["coef_diff"])) for row in rows)
    max_se = max(abs(float(row["se_diff"])) for row in rows)
    _require_finite_numerical_output("PanelOLS 对照摘要", max_coef, max_se)
    coef_check_passed = max_coef < 1e-8
    return {
        "backend": "linearmodels.PanelOLS",
        "policy_coefs": rows,
        "max_abs_coef_diff": max_coef,
        "max_abs_se_diff": max_se,
        "coef_check_passed": coef_check_passed,
        "se_check_mode": "informational",
        "notes": [
            *lm.notes,
            "PanelOLS 对照通过/失败仅针对政策系数;标准误差异受聚类小样本修正与自由度处理影响,仅作参考。",
        ],
    }


def run_design_with_benchmark(df: pd.DataFrame, design) -> tuple[RegressionResult, dict]:
    """一次预处理跑出自写引擎结果 + PanelOLS 对照(接口的热路径)。

    prepare_design_model 与双向去均值都只做一次,自写引擎与 PanelOLS
    共用同一份样本和共线剔除结果——避免此前每个请求重复三次预处理、
    两次全量去均值。
    """
    model = prepare_design_model(df, design)
    prepared = _demean_and_prune(model)
    own = _within_ols(model, prepared)
    lm = _panelols_estimate(model, prepared[2], prepared[3])
    return own, _summarize_benchmark(model, own, lm)


def benchmark_linearmodels(df: pd.DataFrame, design, own: RegressionResult | None = None) -> dict:
    """自写引擎与 PanelOLS 对照的独立入口(报告/测试用)。

    传入已算好的 own 时复用之,只补算 PanelOLS 一遍。
    """
    model = prepare_design_model(df, design)
    prepared = _demean_and_prune(model)
    if own is None:
        own = _within_ols(model, prepared)
    lm = _panelols_estimate(model, prepared[2], prepared[3])
    return _summarize_benchmark(model, own, lm)
