"""步骤6:GVC 生产长度与位置指标（Wang-Wei-Yu-Zhu 2017b 公开文献口径）。

生产长度 = 某段生产活动诱发的累计总产出 ÷ 该段增加值(增加值被计为总产出的
平均次数)。按 WWYZ 2017b 式(10)-(29),各段的分子/分母(v 逐项约去或保留为权重):

前向(增加值来源行业视角,沿行加总):
  PLv      总生产长度            (B B y) / (B y) = (B x) / x
  PLv_D    纯国内段              (L L y_dom) / (L y_dom)
  PLv_RT   传统贸易段            (L L y_exp) / (L y_exp)
  PLv_GVC  GVC 段                (L L A^F x + L A^F B x) / (L A^F x)

后向(最终产品完成地视角,沿列加总):
  PLy      总生产长度            (v'B B) / (v'B)
  PLy_D    纯国内段              (v'L L) / (v'L)
  PLy_RT   传统贸易段            与 PLy_D 相同(最终品去向在比值中约去)
  PLy_GVC  GVC 段                (v'L L A^F B + v'L A^F B B) / (v'L A^F B)

位置指数:
  Pos_TPL  基于总生产长度的位置   PLv / PLy
  GVCPs    全球价值链位置指数     PLv_GVC / PLy_GVC

总长度是各段长度按对应增加值份额的加权平均(WWYZ Figure 1),该恒等式由
单元测试守护。分母趋近于 0(无对应活动)时记 NaN。
"""

import numpy as np
import pandas as pd

from gvcsim.indicators.core import IcioArrays

LENGTH_COLUMNS = [
    "PLv",
    "PLv_D",
    "PLv_RT",
    "PLv_GVC",
    "PLy",
    "PLy_D",
    "PLy_RT",
    "PLy_GVC",
    "Pos_TPL",
    "GVCPs",
]

_DENOM_FLOOR = 1e-12


def _safe_div(num: np.ndarray, den: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.where(np.abs(den) > _DENOM_FLOOR, num / den, np.nan)
    return np.where(np.isfinite(out), out, np.nan)


def _components(arr: IcioArrays) -> dict[str, np.ndarray]:
    """各段的分子(诱发产出)与分母(增加值),前向含 v、后向含 v,便于聚合。

    行业级比值中 v 会逐项约去,但国家级聚合需要 v 加权,所以统一带上。
    """
    ydom = arr.y_domestic()
    yexp = arr.y_export()

    # ---- 前向 ----
    Bx = arr.B @ arr.x  # B B y
    Ly_dom = arr.apply_L(ydom)
    Ly_exp = arr.apply_L(yexp)
    zg = arr.apply_AF(arr.x)  # A^F B y
    Lzg = arr.apply_L(zg)  # V_GVC 的产出核
    fwd = {
        "v_total": arr.v * arr.x,
        "x_total": arr.v * Bx,
        "v_d": arr.v * Ly_dom,
        "x_d": arr.v * arr.apply_L(Ly_dom),
        "v_rt": arr.v * Ly_exp,
        "x_rt": arr.v * arr.apply_L(Ly_exp),
        "v_gvc": arr.v * Lzg,
        "x_gvc": arr.v * (arr.apply_L(Lzg) + arr.apply_L(arr.apply_AF(Bx))),
    }

    # ---- 后向 ----
    ytot = ydom + yexp
    vB = arr.v @ arr.B
    vBB = vB @ arr.B
    vL = arr.apply_L_T(arr.v)
    vLL = arr.apply_L_T(vL)
    vLAF = arr.apply_AF_T(vL)
    vLAFB = vLAF @ arr.B
    num_gvc = arr.apply_AF_T(vLL) @ arr.B + vLAFB @ arr.B
    bwd = {
        "y_total": vB * ytot,
        "xy_total": vBB * ytot,
        "y_d": vL * ydom,
        "xy_d": vLL * ydom,
        "y_rt": vL * yexp,
        "xy_rt": vLL * yexp,
        "y_gvc": vLAFB * ytot,
        "xy_gvc": num_gvc * ytot,
    }
    return {**fwd, **bwd}


def _lengths_from(parts: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    plv = _safe_div(parts["x_total"], parts["v_total"])
    plv_gvc = _safe_div(parts["x_gvc"], parts["v_gvc"])
    ply = _safe_div(parts["xy_total"], parts["y_total"])
    ply_gvc = _safe_div(parts["xy_gvc"], parts["y_gvc"])
    return {
        "PLv": plv,
        "PLv_D": _safe_div(parts["x_d"], parts["v_d"]),
        "PLv_RT": _safe_div(parts["x_rt"], parts["v_rt"]),
        "PLv_GVC": plv_gvc,
        "PLy": ply,
        "PLy_D": _safe_div(parts["xy_d"], parts["y_d"]),
        "PLy_RT": _safe_div(parts["xy_rt"], parts["y_rt"]),
        "PLy_GVC": ply_gvc,
        "Pos_TPL": _safe_div(plv, ply),
        "GVCPs": _safe_div(plv_gvc, ply_gvc),
    }


def sector_length(arr: IcioArrays) -> pd.DataFrame:
    """行业级长度/位置指标，索引 ``(country, industry)``，输出 10 个既有字段。"""
    parts = _components(arr)
    df = pd.DataFrame(_lengths_from(parts), columns=LENGTH_COLUMNS, index=arr.index)
    df.index.names = ["country", "industry"]
    return df


def country_length(arr: IcioArrays, sector_df: pd.DataFrame | None = None) -> pd.DataFrame:
    """国家级长度指标:各段分子/分母分别按国加总后再取比值(即增加值加权平均)。"""
    del sector_df  # 国家级直接从分量聚合,不由行业级表推导
    parts = _components(arr)
    grouped = {k: pd.Series(v, index=arr.index).groupby(level=0).sum().to_numpy() for k, v in parts.items()}
    countries = pd.Series(0.0, index=arr.index).groupby(level=0).sum().index
    df = pd.DataFrame(_lengths_from(grouped), columns=LENGTH_COLUMNS, index=countries)
    df.index.name = "country"
    return df
