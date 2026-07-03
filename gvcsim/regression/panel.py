"""面板回归引擎(步骤13-16 共用):双向固定效应 / DID / 事件研究。

纯 numpy 实现,零额外依赖,便于单元测试与教学展示。三种方法共用同一个
within-OLS 核心(_within_ols):
  1. 交替去均值(entity / time)做双向 within 变换,直到收敛
     (非平衡面板下一次性去均值不精确,迭代投影可收敛到正确的 within 解)
  2. OLS 估计
  3. 按 cluster 聚类的稳健标准误(sandwich 估计)

区别只在解释变量的构造:
  twoway_fe     连续冲击强度 tariff_shock 直接进方程
  did           treated×post(处理组=曾受冲击的个体,处理期=首个冲击年起)
  event_study   treated×各年份哑变量(基期 k=-1,即冲击前一年),动态效应路径

p 值用正态近似(G 较大时与 t 分布几乎一致)。
以后要换 linearmodels.PanelOLS 时,保持 RegressionResult 接口不变即可。
"""

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd


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


def _within_ols(data: pd.DataFrame, depvar: str, xcols: list[str],
                entity: str, time: str, cluster: str,
                extra_notes: list[str]) -> RegressionResult:
    """within 变换 + OLS + 聚类稳健标准误的共用核心。data 需已 dropna。"""
    ent = data[entity].values
    tim = data[time].values
    clu = data[cluster].values

    demeaned = _twoway_demean(data[[depvar, *xcols]].values.astype(float), ent, tim)
    y = demeaned[:, 0]
    X = demeaned[:, 1:]

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
    correction = (n_g / (n_g - 1)) * ((n - 1) / max(n - k, 1))
    V = correction * XtX_inv @ meat @ XtX_inv
    se = np.sqrt(np.diag(V))

    ss_res = float(resid @ resid)
    ss_tot = float(y @ y)
    r2_within = 1 - ss_res / ss_tot if ss_tot > 0 else float("nan")

    coefs = []
    for name, b, s in zip(xcols, beta, se):
        t_stat = b / s if s > 0 else float("nan")
        coefs.append(CoefStat(name=name, coef=float(b), se=float(s),
                              t=float(t_stat), p=2 * _norm_sf(abs(t_stat))))

    return RegressionResult(
        depvar=depvar,
        coefs=coefs,
        n_obs=n,
        n_entities=len(pd.unique(ent)),
        n_times=len(pd.unique(tim)),
        n_clusters=n_g,
        r2_within=r2_within,
        notes=[
            *extra_notes,
            f"双向固定效应({entity} + {time}),within 变换后 OLS",
            f"标准误按 {cluster} 聚类(sandwich,{n_g} 组),p 值为正态近似",
        ],
    )


def twoway_fe(df: pd.DataFrame, depvar: str, regressors: list[str],
              entity: str = "country", time: str = "year",
              cluster: str | None = None) -> RegressionResult:
    """y_it = β·X_it + α_i + λ_t + ε_it,标准误按 cluster 聚类(默认=entity)。

    行业级面板用 entity=国家×行业 做固定效应、cluster=国家做聚类:
    同一国家各行业受同一政策冲击,残差组内相关,必须在更粗层面聚类。
    """
    cluster = cluster or entity
    cols = list(dict.fromkeys([depvar, *regressors, entity, time, cluster]))
    data = df[cols].dropna().reset_index(drop=True)
    return _within_ols(data, depvar, list(regressors), entity, time, cluster,
                       extra_notes=["连续冲击强度直接进方程(强度法)"])


def run_design(df: pd.DataFrame, design) -> RegressionResult:
    """按 RegressionDesign 的方法/粒度分发到对应引擎(步骤12 的对齐结果落地)。"""
    kwargs = dict(entity=design.entity, time="year", cluster=design.cluster)
    if design.method == "双重差分 (DID)":
        return did(df, design.depvar, **kwargs)
    if design.method == "事件研究":
        return event_study(df, design.depvar, **kwargs)
    return twoway_fe(df, design.depvar, list(design.regressors), **kwargs)


def _prep_treatment(data: pd.DataFrame, entity: str, time: str,
                    treated_col: str) -> tuple[np.ndarray, int]:
    """处理组指示(个体层面"曾受处理")与处理起始年 T0(首个受处理年份)。"""
    if not (data[treated_col] > 0).any():
        raise ValueError(f"面板中没有受处理个体({treated_col} 全为 0),无法做 DID/事件研究")
    ever = (data.groupby(entity)[treated_col].transform("max") > 0).values.astype(float)
    t0 = int(data.loc[data[treated_col] > 0, time].min())
    return ever, t0


def did(df: pd.DataFrame, depvar: str,
        entity: str = "country", time: str = "year",
        cluster: str | None = None, treated_col: str = "treated") -> RegressionResult:
    """双重差分:y_it = β·(treated_i × post_t) + α_i + λ_t + ε_it。

    treated_i = 该个体在样本期内是否曾受冲击(时间不变);
    post_t    = 年份 ≥ T0(数据中首个出现冲击的年份);
    β         = 处理组相对对照组在处理后的平均变化(ATT)。
    处理组/对照组主效应分别被个体/时间固定效应吸收。
    """
    cluster = cluster or entity
    cols = list(dict.fromkeys([depvar, treated_col, entity, time, cluster]))
    data = df[cols].dropna().reset_index(drop=True)
    ever, t0 = _prep_treatment(data, entity, time, treated_col)
    data["treated×post"] = ever * (data[time] >= t0).values
    n_treated = int(data.loc[ever > 0, entity].nunique())
    return _within_ols(
        data, depvar, ["treated×post"], entity, time, cluster,
        extra_notes=[
            f"DID:处理组={n_treated} 个曾受冲击个体,处理期=T₀({t0})起",
        ],
    )


def event_study(df: pd.DataFrame, depvar: str,
                entity: str = "country", time: str = "year",
                cluster: str | None = None, treated_col: str = "treated") -> RegressionResult:
    """事件研究:y_it = Σ_{k≠-1} β_k·(treated_i × 1[t = T0+k]) + α_i + λ_t + ε_it。

    以冲击前一年(k=-1)为基期;k<0 的系数应≈0(平行趋势检验),
    k≥0 的系数刻画处理效应的动态路径。
    """
    cluster = cluster or entity
    cols = list(dict.fromkeys([depvar, treated_col, entity, time, cluster]))
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

    return _within_ols(
        data, depvar, xcols, entity, time, cluster,
        extra_notes=[
            f"事件研究:T₀={t0},基期 k={base - t0:+d}({base} 年);"
            "k<0 的系数≈0 说明平行趋势成立",
        ],
    )
