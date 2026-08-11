"""Behavior-preserving sample, price, and teaching-scenario transforms."""

from __future__ import annotations

import numpy as np
import pandas as pd

from gvcsim.regression.design import (
    METHOD_TWFE_INTENSITY,
    PRICE_MODE_REAL,
    SCENARIO_CONFOUNDED,
    SCENARIO_NOISY,
)

BASE_GVC_COL = "3_VA_GVC_share"  # 基期 GVC 生产份额(3_VA_GVC / SVA)
BASELINE_GVC_COL = "base_gvc_participation"
DEFLATOR_COL = "gdp_deflator"
ROW_CODE = "ROW"


def _apply_sample_filter(df: pd.DataFrame, design) -> tuple[pd.DataFrame, list[str]]:
    """回归样本过滤:默认剔除 ROW 这类非真实国家聚合账户。"""
    if not getattr(design, "exclude_row", True) or "country" not in df.columns:
        return df, []
    mask = df["country"].astype(str) != ROW_CODE
    removed = int((~mask).sum())
    if removed == 0:
        return df, []
    return df.loc[mask].copy(), [f"样本过滤:已排除 ROW(世界其他地区聚合账户) {removed} 行"]


def _stable_noise(data: pd.DataFrame, cols: list[str]) -> pd.Series:
    keys = data[cols].astype(str)
    hashed = pd.util.hash_pandas_object(keys, index=False).astype("uint64")
    return ((hashed % 1_000_003).astype(float) / 500_001.5) - 1.0


def _attach_baseline_gvc(
    data: pd.DataFrame,
    entity: str,
    time: str,
    first_by_entity: pd.Series | None = None,
) -> pd.DataFrame:
    """加入真正位于首次处理前、再按个体等权中心化的基期 GVC 生产份额。

    中心化使交互模型的政策主系数表示“基期 GVC 处于样本个体均值时”的效应，
    避免把几乎没有经济含义的 BaseGVC=0 条件效应当作平均变化。

    曾受处理个体使用首次处理前最后至多两期；从未处理个体使用样本最早两期。
    这样不会把处理当年或处理后的结果变量特征反向塞进“基期”交互项。
    """
    data = data.sort_values([entity, time]).reset_index(drop=True)
    first_by_entity = first_by_entity if first_by_entity is not None else pd.Series(dtype=float)
    first_treatment = data[entity].map(first_by_entity)
    treated = first_treatment.notna()
    treated_pre = data.loc[treated & (data[time] < first_treatment)].groupby(entity, group_keys=False).tail(2)
    never_baseline = data.loc[~treated].groupby(entity, group_keys=False).head(2)
    baseline_rows = pd.concat([treated_pre, never_baseline], ignore_index=True)
    base = baseline_rows.groupby(entity)[BASE_GVC_COL].mean()
    missing_treated = sorted(set(first_by_entity.index) - set(base.index))
    if missing_treated:
        preview = "、".join(str(item) for item in missing_treated[:5])
        raise ValueError(f"基期 GVC 交互项要求每个处理个体至少有一期处理前观测；缺少：{preview}")
    centered = (base - float(base.mean())).rename(BASELINE_GVC_COL)
    out = data.merge(centered, left_on=entity, right_index=True, how="left")
    if out[BASELINE_GVC_COL].isna().any():
        raise ValueError("无法构造基期 GVC 生产份额交互项")
    return out


def _real_amount(s: pd.Series, deflator: pd.Series) -> pd.Series:
    return (
        (s.astype(float) / deflator.astype(float).replace(0.0, np.nan)).replace([np.inf, -np.inf], np.nan).fillna(0.0)
    )


def _real_log_from_log(log_s: pd.Series, deflator: pd.Series) -> pd.Series:
    nominal = np.expm1(log_s.astype(float)).clip(lower=0.0)
    return np.log(_real_amount(nominal, deflator) + 1.0)


def _country_year_real_growth(data: pd.DataFrame, amount_col: str, time: str) -> pd.Series:
    base = data[["country", time, amount_col, DEFLATOR_COL]].drop_duplicates(["country", time])
    base = base.sort_values(["country", time]).copy()
    base["_real_amount"] = _real_amount(base[amount_col], base[DEFLATOR_COL])
    prev = base.groupby("country")["_real_amount"].shift(1)
    base["_real_growth"] = ((base["_real_amount"] - prev) / prev.where(prev.abs() > 1e-12)).fillna(0.0)
    return (
        data[["country", time]]
        .merge(
            base[["country", time, "_real_growth"]],
            on=["country", time],
            how="left",
        )["_real_growth"]
        .fillna(0.0)
    )


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
    if {"country", time, "SVA", DEFLATOR_COL}.issubset(out.columns):
        out["gdp_proxy_growth"] = _country_year_real_growth(out, "SVA", time)
    if {"country", time, "gross_exports", DEFLATOR_COL}.issubset(out.columns):
        out["exports_proxy_growth"] = _country_year_real_growth(out, "gross_exports", time)
    return out


def _apply_teaching_scenario(
    df: pd.DataFrame,
    design,
    time: str = "year",
) -> tuple[pd.DataFrame, list[str]]:
    """为教学目的生成 clean/noisy/confounded 三类回归样本。"""
    scenario = getattr(design, "scenario", "clean")
    if scenario not in {SCENARIO_NOISY, SCENARIO_CONFOUNDED}:
        return df, []
    if design.depvar not in df.columns:
        return df, []

    out = df.copy()
    y_scale = float(out[design.depvar].std(skipna=True) or 0.0)
    y_scale = max(y_scale, 0.02)

    if scenario == SCENARIO_NOISY:
        y_noise = _stable_noise(out, [design.entity if design.entity in out.columns else "country", time])
        out[design.depvar] = out[design.depvar].astype(float) + y_noise * y_scale * 0.35
        if design.method == METHOD_TWFE_INTENSITY and design.shock_col in out.columns:
            x_scale = float(out[design.shock_col].std(skipna=True) or 0.0)
            x_noise = _stable_noise(out, ["country", "industry" if "industry" in out.columns else time, time])
            out[design.shock_col] = (out[design.shock_col].astype(float) + x_noise * max(x_scale, 0.01) * 0.55).clip(
                lower=0.0
            )
        return out, ["教学场景:noisy,已加入确定性测量噪声,用于观察显著性下降"]

    if design.treated_col not in out.columns:
        return out, []
    entity = design.entity if design.entity in out.columns else "country"
    ever = (out.groupby(entity)[design.treated_col].transform("max") > 0).astype(float)
    years = out[time].astype(float)
    span = max(float(years.max() - years.min()), 1.0)
    trend = (years - years.min()) / span
    out[design.depvar] = out[design.depvar].astype(float) + ever * trend * y_scale * 0.75
    return out, [
        "教学场景:confounded,处理组被注入冲击前趋势;事件研究应能暴露平行趋势风险",
    ]
