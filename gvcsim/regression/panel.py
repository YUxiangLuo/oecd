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
    _real_amount as _real_amount,
    _real_log_from_log as _real_log_from_log,
    _stable_noise as _stable_noise,
)
from gvcsim.regression.validity import TreatmentSupport, analyze_support


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


# Imports above intentionally keep existing private/internal names available
# from this module while implementations live in the focused transform module.


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
    demeaned = _twoway_demean(
        model.data[[model.depvar, *model.xcols]].values.astype(float),
        model.data[model.entity].values,
        model.data[model.time].values,
    )
    y = demeaned[:, 0]
    X, xcols, dropped = _drop_collinear_columns(demeaned[:, 1:], list(model.xcols), set(model.policy_xcols))
    return y, X, xcols, dropped


def _unavailable_pretrend(names: list[str], n_clusters: int, reason: str, interpretation: str) -> dict:
    return {
        "pretrend": {
            "available": False,
            "reason": reason,
            "terms": names,
            "statistic": None,
            "df_num": len(names),
            "df_denom": max(n_clusters - 1, 0),
            "p": None,
            "interpretation": interpretation,
        }
    }


def _pretrend_diagnostic(xcols: list[str], beta: np.ndarray, covariance: np.ndarray, n_clusters: int) -> dict:
    """联合检验事件研究主效应的冲击前系数是否为零。

    该检验只能发现明显的冲击前差异，不能证明平行趋势；传统 staggered
    TWFE 在处理效应异质时仍可能有偏。聚类自由度或限制协方差秩不足时，
    宁可返回不可评估，也不使用广义逆制造一个看似有效的 p 值。
    """
    indices = [i for i, name in enumerate(xcols) if name.startswith("k=-") and "×base_gvc" not in name]
    names = [xcols[i] for i in indices]
    if not indices:
        return _unavailable_pretrend(
            names, n_clusters, "no_pre_terms", "没有可联合检验的冲击前系数，无法评估冲击前趋势。"
        )

    q = len(indices)
    df_denom = n_clusters - 1
    if q > df_denom:
        return _unavailable_pretrend(
            names,
            n_clusters,
            "insufficient_cluster_df",
            f"冲击前限制数为 {q}，但仅有 {df_denom} 个聚类自由度，联合检验不可评估。",
        )

    b = beta[indices]
    cov = covariance[np.ix_(indices, indices)]
    rank = int(np.linalg.matrix_rank(cov, hermitian=True))
    if rank < q:
        return _unavailable_pretrend(
            names,
            n_clusters,
            "singular_covariance",
            f"冲击前限制协方差秩不足（{rank}/{q}），联合检验不可评估；不得据此判断没有冲击前差异。",
        )

    statistic = float((b @ np.linalg.inv(cov) @ b) / q)
    p_value = float(stats.f.sf(statistic, q, df_denom))
    return {
        "pretrend": {
            "available": True,
            "reason": None,
            "terms": names,
            "statistic": statistic,
            "df_num": q,
            "df_denom": df_denom,
            "p": p_value,
            "interpretation": (
                "未发现明显的冲击前差异；不能据此确认平行趋势假设。"
                if p_value >= 0.05
                else "检测到明显的冲击前差异，因果解释需谨慎。"
            ),
        }
    }


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
    suppress = bool(model.support and model.support.suppress_inference)
    output: list[dict] = []
    for policy_term in model.policy_xcols:
        if policy_term.endswith("×base_gvc"):
            continue
        interaction_term = f"{policy_term}×base_gvc"
        if policy_term not in index or interaction_term not in index:
            continue
        main_i, interaction_i = index[policy_term], index[interaction_term]
        for level, label, reference, centered in levels:
            effect = float(beta[main_i] + centered * beta[interaction_i])
            variance = float(
                covariance[main_i, main_i]
                + centered * centered * covariance[interaction_i, interaction_i]
                + 2.0 * centered * covariance[main_i, interaction_i]
            )
            se = math.sqrt(max(variance, 0.0))
            t_stat = effect / se if se > 0 else float("nan")
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

    ss_res = float(resid @ resid)
    ss_tot = float(y @ y)
    r2_within = 1 - ss_res / ss_tot if ss_tot > 0 else float("nan")

    critical = float(stats.t.ppf(0.975, n_g - 1))
    coefs = []
    for name, b, s in zip(xcols, beta, se):
        t_stat = b / s if s > 0 else float("nan")
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
    cluster_note = (
        f"标准误按 {cluster} 聚类(sandwich,{n_g} 组;其中处理聚类 {support.treated_clusters} 个、"
        f"完全未处理聚类 {support.untreated_clusters} 个；从未处理实体 {support.untreated_entities} 个)"
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
        diagnostics=_pretrend_diagnostic(xcols, beta, V, n_g)
        if model.xcols and model.xcols[0].startswith("k=")
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
) -> PreparedModel:
    cluster = cluster or entity
    interaction_cols: list[str] = []
    xcols = [*regressors, *controls]
    cols = list(dict.fromkeys([depvar, *xcols, entity, time, cluster]))
    # 处理支持度只是诊断,面板没有处理指示列时照常估计,不因缺诊断而失败。
    has_treated = bool(treated_col) and treated_col in df.columns
    if has_treated:
        cols.append(treated_col)
    if interaction:
        cols.append(BASE_GVC_COL)
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError("面板缺少回归变量:" + "、".join(missing))
    data = df[cols].dropna().reset_index(drop=True)
    if interaction:
        first_by_entity = pd.Series(dtype=float)
        if has_treated and treated_col is not None:
            treated = pd.to_numeric(data[treated_col], errors="coerce").fillna(0) > 0
            first_by_entity = data.loc[treated, [entity, time]].groupby(entity)[time].min()
        data = _attach_baseline_gvc(data, entity, time, first_by_entity)
        for reg in regressors:
            name = f"{reg}×base_gvc"
            data[name] = data[reg] * data[BASELINE_GVC_COL]
            interaction_cols.append(name)
        xcols = [*regressors, *interaction_cols, *controls]
    notes = ["连续冲击强度直接进方程(强度法)"]
    if interaction:
        notes.append(
            "已加入冲击×处理前GVC生产份额交互项；处理个体取首次处理前最后至多两期，从未处理个体取样本最早两期，并按个体均值中心化"
        )
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
            analyze_support(data, entity, time, cluster, treated_col, absorbing=False)
            if has_treated and treated_col is not None
            else None
        ),
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
    base, filter_notes = _apply_sample_filter(df, design)
    base = _apply_price_mode(base, design)
    base, _ = _apply_teaching_scenario(base, design)
    true_model = _prepare_did_model(
        base,
        design.depvar,
        entity=design.entity,
        time="year",
        cluster=design.cluster,
        treated_col=design.treated_col,
        controls=list(design.controls),
        interaction=design.interaction,
    )
    true_model.notes = [*filter_notes, *true_model.notes]
    true_result = _within_ols(true_model)
    policy_name = true_model.policy_xcols[0]
    true_coef = next(c.coef for c in true_result.coefs if c.name == policy_name)

    data = true_model.data.copy()
    timing = _prep_treatment(data, true_model.entity, true_model.time, design.treated_col)
    entities = np.array(sorted(pd.unique(data[true_model.entity])))
    cohort_counts = timing.first_by_entity.value_counts().sort_index().astype(int)
    treated_count = int(cohort_counts.sum())
    if treated_count <= 0 or treated_count >= len(entities):
        raise ValueError("实体置换敏感性分析需要同时存在处理组和对照组")

    rng = np.random.default_rng(seed)
    coefs: list[float] = []
    attempts = 0
    pseudo_col = "__placebo_treated"
    while len(coefs) < n_draws and attempts < n_draws * 4:
        attempts += 1
        selected = list(rng.choice(entities, size=treated_count, replace=False))
        rng.shuffle(selected)
        assigned_year: dict[str, int] = {}
        cursor = 0
        for cohort, count in cohort_counts.items():
            for ent in selected[cursor : cursor + int(count)]:
                assigned_year[str(ent)] = int(cohort)
            cursor += int(count)
        pseudo = data.copy()
        pseudo_first = pseudo[true_model.entity].astype(str).map(assigned_year)
        pseudo[pseudo_col] = (pseudo_first.notna() & (pseudo[true_model.time].astype(int) >= pseudo_first)).astype(int)
        try:
            placebo_model = _prepare_did_model(
                pseudo,
                design.depvar,
                entity=true_model.entity,
                time=true_model.time,
                cluster=true_model.cluster,
                treated_col=pseudo_col,
                controls=true_model.control_cols,
                interaction=design.interaction,
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
    df, filter_notes = _apply_sample_filter(df, design)
    df = _apply_price_mode(df, design)
    df, scenario_notes = _apply_teaching_scenario(df, design)
    kwargs = dict(
        entity=design.entity,
        time="year",
        cluster=design.cluster,
        controls=list(design.controls),
        interaction=design.interaction,
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
    ever: np.ndarray  # 行级:该个体是否曾受处理
    first_year: pd.Series  # 行级:该个体首次处理年份;never-treated 为 NA
    first_by_entity: pd.Series  # 个体级:首次处理年份(index=entity)


def _prep_treatment(data: pd.DataFrame, entity: str, time: str, treated_col: str) -> TreatmentTiming:
    """处理组指示与个体自身首次处理年份 G_i。"""
    treated = pd.to_numeric(data[treated_col], errors="coerce").fillna(0) > 0
    if not treated.any():
        raise ValueError(f"面板中没有受处理个体({treated_col} 全为 0),无法做 DID/事件研究")
    first_by_entity = data.loc[treated, [entity, time]].groupby(entity)[time].min().astype(int).sort_index()
    first_year = data[entity].map(first_by_entity)
    ever = first_year.notna().to_numpy(dtype=float)
    return TreatmentTiming(ever=ever, first_year=first_year, first_by_entity=first_by_entity)


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
) -> PreparedModel:
    cluster = cluster or entity
    cols = list(dict.fromkeys([depvar, treated_col, entity, time, cluster, *controls]))
    # 冲击强度列只用于识别真正的政策撤销;缺失时退回按处理指示列判断。
    if intensity_col and intensity_col in df.columns:
        cols.append(intensity_col)
    if interaction:
        cols.append(BASE_GVC_COL)
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError("面板缺少回归变量:" + "、".join(missing))
    data = df[cols].dropna().reset_index(drop=True)
    timing = _prep_treatment(data, entity, time, treated_col)
    did_col = "treated×post" if treated_col == "treated" else f"{treated_col}×post"
    data[did_col] = (timing.first_year.notna() & (data[time].astype(int) >= timing.first_year)).astype(float)
    policy_xcols = [did_col]
    xcols = [did_col]
    if interaction:
        data = _attach_baseline_gvc(data, entity, time, timing.first_by_entity)
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
            "已加入处理效应×处理前GVC生产份额交互项；处理个体取首次处理前最后至多两期，从未处理个体取样本最早两期，并按个体均值中心化"
        )
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
        support=analyze_support(data, entity, time, cluster, treated_col, absorbing=True, intensity_col=intensity_col),
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
) -> PreparedModel:
    cluster = cluster or entity
    cols = list(dict.fromkeys([depvar, treated_col, entity, time, cluster, *controls]))
    # 冲击强度列只用于识别真正的政策撤销;缺失时退回按处理指示列判断。
    if intensity_col and intensity_col in df.columns:
        cols.append(intensity_col)
    if interaction:
        cols.append(BASE_GVC_COL)
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError("面板缺少回归变量:" + "、".join(missing))
    data = df[cols].dropna().reset_index(drop=True)
    timing = _prep_treatment(data, entity, time, treated_col)

    event_time = data[time].astype(int) - timing.first_year
    observed_k = sorted(event_time[timing.first_year.notna()].dropna().astype(int).unique())
    if not observed_k:
        raise ValueError("事件研究没有可估计的事件时间")
    negative_k = [k for k in observed_k if k < 0]
    base_k = -1 if -1 in observed_k else (max(negative_k) if negative_k else min(observed_k))
    xcols = []
    for k in observed_k:
        if k == base_k:
            continue
        name = f"k={k:+d}" if k != 0 else "k=0"
        data[name] = (timing.first_year.notna() & (event_time == k)).astype(float)
        if data[name].sum() > 0:
            xcols.append(name)
    if not xcols:
        raise ValueError("事件研究除基期外没有可估计的事件时间")
    policy_xcols = list(xcols)
    if interaction:
        data = _attach_baseline_gvc(data, entity, time, timing.first_by_entity)
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
            "已加入动态效应×处理前GVC生产份额交互项；处理个体取首次处理前最后至多两期，从未处理个体取样本最早两期，并按个体均值中心化"
        )
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
        support=analyze_support(data, entity, time, cluster, treated_col, absorbing=True, intensity_col=intensity_col),
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
    return RegressionResult(
        depvar=model.depvar,
        coefs=coefs,
        n_obs=int(res.nobs),
        n_entities=int(model.data[model.entity].nunique()),
        n_times=int(model.data[model.time].nunique()),
        n_clusters=n_clusters,
        r2_within=float(res.rsquared_within),
        depvar_mean=float(model.data[model.depvar].mean()),
        depvar_std=float(model.data[model.depvar].std(ddof=1)),
        diagnostics={},
        notes=[
            *notes,
            f"标准库对照:linearmodels.PanelOLS({model.entity} + {model.time})",
            f"标准误按 {model.cluster} 聚类；p 值和 95% 置信区间为教学界面统一按 t({n_clusters - 1}) 重算",
            "PanelOLS 仅用于检查实现结果一致性，不验证因果识别假设。",
        ],
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
    max_coef = max((abs(float(r["coef_diff"])) for r in rows), default=float("nan"))
    max_se = max((abs(float(r["se_diff"])) for r in rows), default=float("nan"))
    coef_check_passed = bool(rows) and max_coef < 1e-8
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
