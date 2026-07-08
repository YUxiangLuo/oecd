"""指标计算的共享底座:把 pymrio IOSystem 拆成 numpy 数组 + 区域块索引。

所有指标模块(tradeflow / production / length / network)都吃 IcioArrays,
这样每年只解析一次数据、只求一次逆,且便于用小型合成矩阵做单元测试。

增加值与产品税:OECD ICIO 原始表把 TLS(产品税减补贴)与 VA(增加值)分开,
pymrio 解析后在 io.factor_inputs.F 中。区分两者后 v(VA 系数)是"纯增加值"
口径,t 是 TLS 系数,满足 (v + t)' B = 1(总产出完全分解)。测试夹具没有
factor_inputs 扩展时回退为残差 VA(此时 t=0、v' B = 1)。
"""

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass
class IcioArrays:
    regions: list[str]  # 国家/地区代码,按矩阵中出现顺序
    sectors: list[str]  # 行业代码
    index: pd.MultiIndex  # (region, sector) 行索引,长度 N
    Z: np.ndarray  # 中间使用矩阵 N×N
    Yd: np.ndarray  # 最终需求按目的国聚合 N×R(列序 = regions)
    x: np.ndarray  # 总产出 N
    v: np.ndarray  # 增加值系数 va/x,产出为0处置0,N
    va: np.ndarray  # 增加值 N
    taxsub: np.ndarray  # 产品税减补贴 TLS,N(无 TLS 数据时为 0)
    t: np.ndarray  # TLS 系数 taxsub/x,产出为0处置0,N
    A: np.ndarray  # 技术系数矩阵 N×N
    B: np.ndarray  # 全球里昂惕夫逆矩阵 (I-A)^-1,N×N
    L_dd: dict[str, np.ndarray]  # 各国国内里昂惕夫逆 (I-A_rr)^-1,S×S
    E: np.ndarray  # 出口向量(中间品+最终品,剔除本国内销),N
    pos: dict[str, np.ndarray]  # 每个国家在 N 维索引中的行位置

    @property
    def n_regions(self) -> int:
        return len(self.regions)

    # ---- 各指标模块共用的小工具 ----

    def home_cols(self) -> np.ndarray:
        """每个节点所属国家在 Yd 列中的位置,N。"""
        region_idx = {r: i for i, r in enumerate(self.regions)}
        return np.array([region_idx[r] for r in self.index.get_level_values(0)])

    def y_domestic(self) -> np.ndarray:
        """本国内销最终品 Y_ss,N。"""
        return self.Yd[np.arange(len(self.x)), self.home_cols()]

    def y_export(self) -> np.ndarray:
        """最终品出口 Σ_{r≠s} Y_sr,N。"""
        return self.Yd.sum(axis=1) - self.y_domestic()

    def apply_L(self, vec: np.ndarray) -> np.ndarray:
        """块对角国内里昂惕夫逆左乘:out[p_r] = L_rr @ vec[p_r]。"""
        out = np.zeros_like(vec, dtype=float)
        for r in self.regions:
            p = self.pos[r]
            out[p] = self.L_dd[r] @ vec[p]
        return out

    def apply_L_T(self, rowvec: np.ndarray) -> np.ndarray:
        """块对角国内里昂惕夫逆右乘(行向量):out[p_r] = rowvec[p_r] @ L_rr。"""
        out = np.zeros_like(rowvec, dtype=float)
        for r in self.regions:
            p = self.pos[r]
            out[p] = rowvec[p] @ self.L_dd[r]
        return out

    def apply_AF(self, vec: np.ndarray) -> np.ndarray:
        """跨境技术系数 A^F(A 去掉国内块)左乘,不显式物化 N×N 副本。"""
        out = self.A @ vec
        for r in self.regions:
            p = self.pos[r]
            out[p] -= self.A[np.ix_(p, p)] @ vec[p]
        return out

    def apply_AF_T(self, rowvec: np.ndarray) -> np.ndarray:
        """跨境技术系数 A^F 右乘(行向量)。"""
        out = rowvec @ self.A
        for r in self.regions:
            p = self.pos[r]
            out[p] -= rowvec[p] @ self.A[np.ix_(p, p)]
        return out


def build_arrays(io) -> IcioArrays:
    """从 pymrio IOSystem(需已 calc_all)构建 IcioArrays。"""
    index = io.Z.index
    regions = list(dict.fromkeys(index.get_level_values(0)))
    sectors = list(dict.fromkeys(index.get_level_values(1)))

    Z = io.Z.values.astype(float)
    x = io.x.iloc[:, 0].values.astype(float)
    B = io.L.values.astype(float)
    A = io.A.values.astype(float)

    # 最终需求列按目的国聚合(去掉需求类别维度)
    Yd_df = io.Y.T.groupby(level=0, sort=False).sum().T
    Yd = Yd_df[regions].values.astype(float)

    # OECD ICIO 原始表把 TLS 与 VA 放在 factor_inputs.F 中;测试夹具没有
    # 这个扩展时才回退到残差 VA,并把 TLS 置零。
    taxsub = np.zeros_like(x)
    factor_inputs = getattr(io, "factor_inputs", None)
    F = getattr(factor_inputs, "F", None)
    if F is not None and {"TLS", "VA"}.issubset(set(F.index.astype(str))):
        F_aligned = F.reindex(columns=index)
        va = F_aligned.loc["VA"].values.astype(float)
        taxsub = F_aligned.loc["TLS"].values.astype(float)
    else:
        # 残差 VA = 总产出 - 中间投入列和(此时含税,t=0)
        va = x - Z.sum(axis=0)
    with np.errstate(divide="ignore", invalid="ignore"):
        v = np.where(x > 0, va / x, 0.0)
        t = np.where(x > 0, taxsub / x, 0.0)

    row_regions = index.get_level_values(0).values
    pos = {r: np.where(row_regions == r)[0] for r in regions}
    col_region_of = {r: regions.index(r) for r in regions}

    # 出口 = 卖给外国的中间品 + 卖给外国的最终品
    E = np.zeros_like(x)
    for r in regions:
        p = pos[r]
        z_row = Z[p, :].sum(axis=1) - Z[np.ix_(p, p)].sum(axis=1)
        y_row = Yd[p, :].sum(axis=1) - Yd[p, col_region_of[r]]
        E[p] = z_row + y_row

    # 国内里昂惕夫逆:每国一个 S×S 小矩阵求逆
    n_sec = len(sectors)
    eye = np.eye(n_sec)
    L_dd = {r: np.linalg.inv(eye - A[np.ix_(pos[r], pos[r])]) for r in regions}

    return IcioArrays(
        regions=regions,
        sectors=sectors,
        index=index,
        Z=Z,
        Yd=Yd,
        x=x,
        v=v,
        va=va,
        taxsub=taxsub,
        t=t,
        A=A,
        B=B,
        L_dd=L_dd,
        E=E,
        pos=pos,
    )
