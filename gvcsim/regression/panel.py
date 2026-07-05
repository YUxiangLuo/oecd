"""面板回归引擎(步骤13-16 共用):双向固定效应 / DID / 事件研究。

教学主引擎仍为纯 numpy 实现,便于单元测试与教学展示;同时提供
linearmodels.PanelOLS 标准库对照。三种方法共用同一个 within-OLS 核心(_within_ols):
  1. 交替去均值(entity / time)做双向 within 变换,直到收敛
     (非平衡面板下一次性去均值不精确,迭代投影可收敛到正确的 within 解)
  2. OLS 估计
  3. 按 cluster 聚类的稳健标准误(sandwich 估计)

区别只在解释变量的构造:
  twoway_fe     连续冲击强度 tariff_shock 直接进方程
  did           treated×post(处理组=曾受冲击的个体,处理期=首个冲击年起)
  event_study   treated×各年份哑变量(基期 k=-1,即冲击前一年),动态效应路径

p 值用正态近似(G 较大时与 t 分布几乎一致)。PanelOLS 对照使用同一份
样本与同一组可估计解释变量,只作为结果校验与界面展示。
"""

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from linearmodels.panel import PanelOLS

from gvcsim.regression.design import PRICE_MODE_REAL


@dataclass
class CoefStat:
    name: str
    coef: float
    se: float
    t: float
    p: float

    @property
    def stars(self) -> str:
        return "***" if self.p < 0.01 else "**" if self.p < 0.05 else "*" if self.p < 0.1 else ""


@dataclass
class RegressionResult:
    depvar: str
    coefs: list[CoefStat]
    n_obs: int
    n_entities: int
    n_times: int
    n_clusters: int
    r2_within: float
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "depvar": self.depvar,
            "coefs": [
                {"name": c.name, "coef": c.coef, "se": c.se, "t": c.t, "p": c.p, "stars": c.stars}
                for c in self.coefs
            ],
            "n_obs": self.n_obs,
            "n_entities": self.n_entities,
            "n_times": self.n_times,
            "n_clusters": self.n_clusters,
            "r2_within": self.r2_within,
            "notes": self.notes,
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


BASE_GVC_COL = "share_trade_gvc_participation"
BASELINE_GVC_COL = "base_gvc_participation"
DEFLATOR_COL = "gdp_deflator"


def _attach_baseline_gvc(data: pd.DataFrame, entity: str, time: str) -> pd.DataFrame:
    """给估计样本加基期 GVC 参与度(每个个体可用样本最早两年均值)。"""
    data = data.sort_values([entity, time]).reset_index(drop=True)
    base = (
        data.groupby(entity, group_keys=False).head(2)
        .groupby(entity)[BASE_GVC_COL]
        .mean()
        .rename(BASELINE_GVC_COL)
    )
    out = data.merge(base, left_on=entity, right_index=True, how="left")
    if out[BASELINE_GVC_COL].isna().any():
        raise ValueError("无法构造基期 GVC 参与度交互项")
    return out


def _real_amount(s: pd.Series, deflator: pd.Series) -> pd.Series:
    return (s.astype(float) / deflator.astype(float).replace(0.0, np.nan)).replace(
        [np.inf, -np.inf], np.nan
    ).fillna(0.0)


def _real_log_from_log(log_s: pd.Series, deflator: pd.Series) -> pd.Series:
    nominal = np.expm1(log_s.astype(float)).clip(lower=0.0)
    return np.log(_real_amount(nominal, deflator) + 1.0)


def _country_year_real_growth(data: pd.DataFrame, amount_col: str, time: str) -> pd.Series:
    base = data[["country", time, amount_col, DEFLATOR_COL]].drop_duplicates(["country", time])
    base = base.sort_values(["country", time]).copy()
    base["_real_amount"] = _real_amount(base[amount_col], base[DEFLATOR_COL])
    prev = base.groupby("country")["_real_amount"].shift(1)
    base["_real_growth"] = ((base["_real_amount"] - prev) / prev.where(prev.abs() > 1e-12)).fillna(0.0)
    return data[["country", time]].merge(
        base[["country", time, "_real_growth"]],
        on=["country", time],
        how="left",
    )["_real_growth"].fillna(0.0)


def _apply_price_mode(df: pd.DataFrame, design, time: str = "year") -> pd.DataFrame:
    """实际值模式:用 GDP deflator 平减金额类控制变量。"""
    if getattr(design, "price_mode", None) != PRICE_MODE_REAL:
        return df
    if DEFLATOR_COL not in df.columns:
        raise ValueError("实际值口径需要面板包含 gdp_deflator,请先重新运行 gvcsim compute")
    out = df.copy()
    deflator = out[DEFLATOR_COL].astype(float)

    if "log_gdp_proxy" in out.columns:
        out["log_gdp_proxy"] = _real_log_from_log(out["log_gdp_proxy"], deflator)
    if "log_exports_proxy" in out.columns:
        out["log_exports_proxy"] = _real_log_from_log(out["log_exports_proxy"], deflator)
    if "macro_log_gdp_usd" in out.columns:
        out["macro_log_gdp_usd"] = _real_log_from_log(out["macro_log_gdp_usd"], deflator)
    if {"macro_log_gdp_usd", "macro_log_population"}.issubset(out.columns):
        out["macro_log_gdp_per_capita"] = out["macro_log_gdp_usd"] - out["macro_log_population"]
    if {"country", time, "prod_va_total", DEFLATOR_COL}.issubset(out.columns):
        out["gdp_proxy_growth"] = _country_year_real_growth(out, "prod_va_total", time)
    if {"country", time, "trade_gross_exports", DEFLATOR_COL}.issubset(out.columns):
        out["exports_proxy_growth"] = _country_year_real_growth(out, "trade_gross_exports", time)
    return out


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


def _twoway_demean(values: np.ndarray, ent: np.ndarray, tim: np.ndarray,
                   tol: float = 1e-10, max_iter: int = 200) -> np.ndarray:
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


def _norm_sf(z: float) -> float:
    """标准正态右尾概率(避免引入 scipy)。"""
    return 0.5 * math.erfc(z / math.sqrt(2))


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
    X, xcols, dropped = _drop_collinear_columns(
        demeaned[:, 1:], list(model.xcols), set(model.policy_xcols)
    )
    return y, X, xcols, dropped


def _within_ols(
    model: PreparedModel,
    prepared: tuple[np.ndarray, np.ndarray, list[str], list[str]] | None = None,
) -> RegressionResult:
    """within 变换 + OLS + 聚类稳健标准误的共用核心。data 需已 dropna。

    prepared 可传入 _demean_and_prune 已算好的 (y, X, xcols, dropped),
    避免与 PanelOLS 对照重复做双向去均值。
    """
    data, depvar, entity, time, cluster = (
        model.data, model.depvar, model.entity, model.time, model.cluster
    )
    ent = data[entity].values
    tim = data[time].values
    clu = data[cluster].values

    y, X, xcols, dropped = prepared if prepared is not None else _demean_and_prune(model)

    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta

    # 聚类稳健标准误:V = (X'X)^-1 [Σ_g (X_g'u_g)(X_g'u_g)'] (X'X)^-1,带小样本修正
    XtX_inv = np.linalg.inv(X.T @ X)
    groups = pd.unique(clu)
    meat = np.zeros((X.shape[1], X.shape[1]))
    for g in groups:
        mask = clu == g
        s = X[mask].T @ resid[mask]
        meat += np.outer(s, s)
    n, k, n_g = len(y), X.shape[1], len(groups)
    correction = (n_g / (n_g - 1)) * ((n - 1) / max(n - k, 1)) if n_g > 1 else 1.0
    V = correction * XtX_inv @ meat @ XtX_inv
    se = np.sqrt(np.clip(np.diag(V), 0.0, None))

    ss_res = float(resid @ resid)
    ss_tot = float(y @ y)
    r2_within = 1 - ss_res / ss_tot if ss_tot > 0 else float("nan")

    coefs = []
    for name, b, s in zip(xcols, beta, se):
        t_stat = b / s if s > 0 else float("nan")
        coefs.append(CoefStat(name=name, coef=float(b), se=float(s),
                              t=float(t_stat), p=2 * _norm_sf(abs(t_stat))))

    notes = list(model.notes)
    if dropped:
        notes.append("控制变量被固定效应吸收/完全共线,已剔除:" + "、".join(dropped))
    return RegressionResult(
        depvar=depvar,
        coefs=coefs,
        n_obs=n,
        n_entities=len(pd.unique(ent)),
        n_times=len(pd.unique(tim)),
        n_clusters=n_g,
        r2_within=r2_within,
        notes=[
            *notes,
            f"双向固定效应({entity} + {time}),within 变换后 OLS",
            f"标准误按 {cluster} 聚类(sandwich,{n_g} 组),p 值为正态近似",
        ],
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
) -> PreparedModel:
    cluster = cluster or entity
    interaction_cols: list[str] = []
    xcols = [*regressors, *controls]
    cols = list(dict.fromkeys([depvar, *xcols, entity, time, cluster]))
    if interaction:
        cols.append(BASE_GVC_COL)
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError("面板缺少回归变量:" + "、".join(missing))
    data = df[cols].dropna().reset_index(drop=True)
    if interaction:
        data = _attach_baseline_gvc(data, entity, time)
        for reg in regressors:
            name = f"{reg}×base_gvc"
            data[name] = data[reg] * data[BASELINE_GVC_COL]
            interaction_cols.append(name)
        xcols = [*regressors, *interaction_cols, *controls]
    notes = ["连续冲击强度直接进方程(强度法)"]
    if interaction:
        notes.append("已加入冲击×基期GVC参与度交互项")
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
    )


def twoway_fe(df: pd.DataFrame, depvar: str, regressors: list[str],
              entity: str = "country", time: str = "year",
              cluster: str | None = None,
              controls: list[str] | tuple[str, ...] = (),
              interaction: bool = False) -> RegressionResult:
    """y_it = β·X_it + α_i + λ_t + ε_it,标准误按 cluster 聚类(默认=entity)。

    行业级面板用 entity=国家×行业 做固定效应、cluster=国家做聚类:
    同一国家各行业受同一政策冲击,残差组内相关,必须在更粗层面聚类。
    """
    return _within_ols(_prepare_fe_model(
        df, depvar, regressors, entity, time, cluster, controls, interaction
    ))


def run_design(df: pd.DataFrame, design) -> RegressionResult:
    """按 RegressionDesign 的方法/粒度分发到对应引擎(步骤12 的对齐结果落地)。"""
    return _within_ols(prepare_design_model(df, design))


def prepare_design_model(df: pd.DataFrame, design) -> PreparedModel:
    """按 RegressionDesign 构造同一份估计样本,供自写引擎与 PanelOLS 共用。"""
    df = _apply_price_mode(df, design)
    kwargs = dict(entity=design.entity, time="year", cluster=design.cluster,
                  controls=list(design.controls), interaction=design.interaction)
    if design.method == "双重差分 (DID)":
        model = _prepare_did_model(df, design.depvar, treated_col=design.treated_col, **kwargs)
    elif design.method == "事件研究":
        model = _prepare_event_model(df, design.depvar, treated_col=design.treated_col, **kwargs)
    else:
        model = _prepare_fe_model(df, design.depvar, list(design.regressors), **kwargs)
    if getattr(design, "price_mode", None) == PRICE_MODE_REAL:
        model.notes.append("实际值口径:金额类控制变量已用 GDP 平减指数调整(基期=1)")
    return model


def _prep_treatment(data: pd.DataFrame, entity: str, time: str,
                    treated_col: str) -> tuple[np.ndarray, int]:
    """处理组指示(个体层面"曾受处理")与处理起始年 T0(首个受处理年份)。"""
    if not (data[treated_col] > 0).any():
        raise ValueError(f"面板中没有受处理个体({treated_col} 全为 0),无法做 DID/事件研究")
    ever = (data.groupby(entity)[treated_col].transform("max") > 0).values.astype(float)
    t0 = int(data.loc[data[treated_col] > 0, time].min())
    return ever, t0


def _prepare_did_model(
    df: pd.DataFrame,
    depvar: str,
    entity: str = "country",
    time: str = "year",
    cluster: str | None = None,
    treated_col: str = "treated",
    controls: list[str] | tuple[str, ...] = (),
    interaction: bool = False,
) -> PreparedModel:
    cluster = cluster or entity
    cols = list(dict.fromkeys([depvar, treated_col, entity, time, cluster, *controls]))
    if interaction:
        cols.append(BASE_GVC_COL)
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError("面板缺少回归变量:" + "、".join(missing))
    data = df[cols].dropna().reset_index(drop=True)
    ever, t0 = _prep_treatment(data, entity, time, treated_col)
    did_col = "treated×post" if treated_col == "treated" else f"{treated_col}×post"
    data[did_col] = ever * (data[time] >= t0).values
    policy_xcols = [did_col]
    xcols = [did_col]
    if interaction:
        data = _attach_baseline_gvc(data, entity, time)
        interaction_col = f"{did_col}×base_gvc"
        data[interaction_col] = data[did_col] * data[BASELINE_GVC_COL]
        policy_xcols.append(interaction_col)
        xcols.append(interaction_col)
    n_treated = int(data.loc[ever > 0, entity].nunique())
    notes = [f"DID:处理组={n_treated} 个曾受冲击个体,处理期=T₀({t0})起"]
    if interaction:
        notes.append("已加入处理效应×基期GVC参与度交互项")
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
    )


def did(df: pd.DataFrame, depvar: str,
        entity: str = "country", time: str = "year",
        cluster: str | None = None, treated_col: str = "treated",
        controls: list[str] | tuple[str, ...] = (),
        interaction: bool = False) -> RegressionResult:
    """双重差分:y_it = β·(treated_i × post_t) + α_i + λ_t + ε_it。

    treated_i = 该个体在样本期内是否曾受冲击(时间不变);
    post_t    = 年份 ≥ T0(数据中首个出现冲击的年份);
    β         = 处理组相对对照组在处理后的平均变化(ATT)。
    处理组/对照组主效应分别被个体/时间固定效应吸收。
    """
    return _within_ols(
        _prepare_did_model(df, depvar, entity, time, cluster, treated_col, controls, interaction)
    )


def _prepare_event_model(
    df: pd.DataFrame,
    depvar: str,
    entity: str = "country",
    time: str = "year",
    cluster: str | None = None,
    treated_col: str = "treated",
    controls: list[str] | tuple[str, ...] = (),
    interaction: bool = False,
) -> PreparedModel:
    cluster = cluster or entity
    cols = list(dict.fromkeys([depvar, treated_col, entity, time, cluster, *controls]))
    if interaction:
        cols.append(BASE_GVC_COL)
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError("面板缺少回归变量:" + "、".join(missing))
    data = df[cols].dropna().reset_index(drop=True)
    ever, t0 = _prep_treatment(data, entity, time, treated_col)

    years = sorted(data[time].unique())
    base = t0 - 1 if (t0 - 1) in years else years[0]
    xcols = []
    for y in years:
        if y == base:
            continue
        k = int(y - t0)
        name = f"k={k:+d}" if k != 0 else "k=0"
        data[name] = ever * (data[time] == y).values
        xcols.append(name)
    policy_xcols = list(xcols)
    if interaction:
        data = _attach_baseline_gvc(data, entity, time)
        interaction_cols = []
        for name in xcols:
            interaction_col = f"{name}×base_gvc"
            data[interaction_col] = data[name] * data[BASELINE_GVC_COL]
            interaction_cols.append(interaction_col)
        xcols = [*xcols, *interaction_cols]
        policy_xcols = list(xcols)
    notes = [
        f"事件研究:T₀={t0},基期 k={base - t0:+d}({base} 年);"
        "k<0 的系数≈0 说明平行趋势成立",
    ]
    if interaction:
        notes.append("已加入动态效应×基期GVC参与度交互项")
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
    )


def event_study(df: pd.DataFrame, depvar: str,
                entity: str = "country", time: str = "year",
                cluster: str | None = None, treated_col: str = "treated",
                controls: list[str] | tuple[str, ...] = (),
                interaction: bool = False) -> RegressionResult:
    """事件研究:y_it = Σ_{k≠-1} β_k·(treated_i × 1[t = T0+k]) + α_i + λ_t + ε_it。

    以冲击前一年(k=-1)为基期;k<0 的系数应≈0(平行趋势检验),
    k≥0 的系数刻画处理效应的动态路径。
    """
    return _within_ols(
        _prepare_event_model(df, depvar, entity, time, cluster, treated_col, controls, interaction)
    )


def _panelols_estimate(
    model: PreparedModel, keep_xcols: list[str], dropped: list[str],
) -> RegressionResult:
    """用 linearmodels.PanelOLS 估计标准库对照。

    keep_xcols 为共线剔除后保留的解释变量(与自写引擎同一份),
    因此这里不再重复做 within 变换判定,只让 PanelOLS 内部吸收固定效应。
    """
    data = model.data.set_index([model.entity, model.time])
    y = data[model.depvar].astype(float)
    X = data[keep_xcols].astype(float)
    clusters = pd.Series(model.data[model.cluster].values, index=data.index, name=model.cluster)

    res = PanelOLS(
        y, X,
        entity_effects=True,
        time_effects=True,
        drop_absorbed=True,
    ).fit(cov_type="clustered", clusters=clusters)

    coefs = []
    for name, b in res.params.items():
        se = float(res.std_errors[name])
        t_stat = float(res.tstats[name])
        pval = float(res.pvalues[name])
        coefs.append(CoefStat(name=name, coef=float(b), se=se, t=t_stat, p=pval))

    notes = list(model.notes)
    if dropped:
        notes.append("控制变量被固定效应吸收/完全共线,已剔除:" + "、".join(dropped))
    return RegressionResult(
        depvar=model.depvar,
        coefs=coefs,
        n_obs=int(res.nobs),
        n_entities=int(model.data[model.entity].nunique()),
        n_times=int(model.data[model.time].nunique()),
        n_clusters=int(model.data[model.cluster].nunique()),
        r2_within=float(res.rsquared_within),
        notes=[
            *notes,
            f"标准库对照:linearmodels.PanelOLS({model.entity} + {model.time})",
            f"标准误按 {model.cluster} 聚类",
        ],
    )


def linearmodels_panel_ols(df: pd.DataFrame, design) -> RegressionResult:
    """使用 linearmodels.PanelOLS 估计同一设计,作为标准库对照(独立入口)。"""
    model = prepare_design_model(df, design)
    _, _, xcols, dropped = _demean_and_prune(model)
    return _panelols_estimate(model, xcols, dropped)


def _summarize_benchmark(
    model: PreparedModel, own: RegressionResult, lm: RegressionResult,
) -> dict:
    """自写引擎与 PanelOLS 在核心政策系数上的差异摘要。"""
    own_by = {c.name: c for c in own.coefs}
    lm_by = {c.name: c for c in lm.coefs}
    rows = []
    for name in model.policy_xcols:
        if name not in own_by or name not in lm_by:
            continue
        rows.append({
            "name": name,
            "own_coef": own_by[name].coef,
            "panelols_coef": lm_by[name].coef,
            "coef_diff": own_by[name].coef - lm_by[name].coef,
            "own_se": own_by[name].se,
            "panelols_se": lm_by[name].se,
            "se_diff": own_by[name].se - lm_by[name].se,
        })
    max_coef = max((abs(r["coef_diff"]) for r in rows), default=float("nan"))
    max_se = max((abs(r["se_diff"]) for r in rows), default=float("nan"))
    return {
        "backend": "linearmodels.PanelOLS",
        "policy_coefs": rows,
        "max_abs_coef_diff": max_coef,
        "max_abs_se_diff": max_se,
        "passed": bool(rows) and max_coef < 1e-8,
        "notes": lm.notes,
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
