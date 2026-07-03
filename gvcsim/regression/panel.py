"""双向固定效应面板回归(步骤13-16 的共用引擎)。

纯 numpy 实现,零额外依赖,便于单元测试与教学展示:
  1. 交替去均值(entity / time)做双向 within 变换,直到收敛
     (非平衡面板下一次性去均值不精确,迭代投影可收敛到正确的 within 解)
  2. OLS 估计
  3. 按 entity 聚类的稳健标准误(sandwich 估计)

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
    ent = data[entity].values
    tim = data[time].values
    clu = data[cluster].values

    demeaned = _twoway_demean(data[[depvar, *regressors]].values, ent, tim)
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
    for name, b, s in zip(regressors, beta, se):
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
            f"双向固定效应({entity} + {time}),within 变换后 OLS",
            f"标准误按 {cluster} 聚类(sandwich,{n_g} 组),p 值为正态近似",
        ],
    )
