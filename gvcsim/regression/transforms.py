"""Behavior-preserving sample, price, and teaching-scenario transforms."""

from __future__ import annotations

import math
from numbers import Real

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


def _freeze_baseline_gvc(
    data: pd.DataFrame,
    entity: str,
    time: str,
    first_by_entity: pd.Series | None = None,
) -> pd.Series:
    """Freeze uncentered entity moderators from structural rows, before outcome attrition.

    Structural nulls are skipped. Treated entities use their last two finite raw
    observations strictly before frozen ``G_i``; never-treated entities use their
    earliest two finite observations. Non-null malformed and infinite values fail
    closed instead of being coerced or interpreted as zero.
    """
    missing = [column for column in (entity, time, BASE_GVC_COL) if column not in data.columns]
    if missing:
        raise ValueError("面板缺少基期 GVC 变量:" + "、".join(missing))

    raw_values: list[float] = []
    for value in data[BASE_GVC_COL].array:
        try:
            is_null = bool(pd.isna(value))
        except (TypeError, ValueError):
            is_null = False
        if is_null:
            raw_values.append(float("nan"))
        elif isinstance(value, Real) and not isinstance(value, (bool, np.bool_)) and math.isfinite(float(value)):
            raw_values.append(float(value))
        else:
            raise ValueError(
                f"基期 GVC 变量 {BASE_GVC_COL} 的非缺失值必须是真实数值且有限；不接受数值字符串、对象或无穷值"
            )

    numeric_time = pd.to_numeric(data[time], errors="coerce")
    if numeric_time.isna().any() or not np.isfinite(numeric_time.to_numpy(dtype=float)).all():
        raise ValueError(f"基期 GVC 时间变量 {time} 必须是有限数值")

    source = pd.DataFrame(
        {
            "__entity": data[entity].astype(str).to_numpy(),
            "__time": numeric_time.to_numpy(dtype=float),
            BASE_GVC_COL: raw_values,
        }
    ).sort_values(["__entity", "__time"])
    source = source.loc[source[BASE_GVC_COL].notna()].copy()
    first = first_by_entity if first_by_entity is not None else pd.Series(dtype=float)
    first = pd.Series(first.to_numpy(), index=first.index.astype(str), dtype=float)
    first_treatment = source["__entity"].map(first)
    treated = first_treatment.notna()
    treated_pre = (
        source.loc[treated & (source["__time"] < first_treatment)].groupby("__entity", group_keys=False).tail(2)
    )
    never_baseline = source.loc[~treated].groupby("__entity", group_keys=False).head(2)
    baseline_rows = pd.concat([treated_pre, never_baseline], ignore_index=True)
    return baseline_rows.groupby("__entity", sort=True)[BASE_GVC_COL].mean().rename(BASE_GVC_COL)


def _attach_baseline_gvc(
    data: pd.DataFrame,
    entity: str,
    time: str,
    first_by_entity: pd.Series | None = None,
    *,
    frozen_baseline: pd.Series | None = None,
) -> pd.DataFrame:
    """Attach a frozen moderator and center it equally over retained entities.

    ``frozen_baseline`` is constructed from the full structurally filtered panel
    before outcome/control complete-case deletion. The legacy direct-call form
    freezes from ``data`` itself, preserving the helper's standalone behavior.
    """
    data = data.sort_values([entity, time]).reset_index(drop=True)
    first = first_by_entity if first_by_entity is not None else pd.Series(dtype=float)
    base = _freeze_baseline_gvc(data, entity, time, first) if frozen_baseline is None else frozen_baseline.copy()
    base.index = base.index.astype(str)
    retained = pd.Index(data[entity].astype(str).unique())
    available = retained.intersection(base.index, sort=False)
    # A missing frozen moderator is ordinary complete-case attrition at the entity
    # level. Drop every row for that entity before centering; never fabricate zero.
    out = data.loc[data[entity].astype(str).isin(available)].copy()
    retained_base = base.reindex(available).astype(float)
    if not np.isfinite(retained_base.to_numpy()).all():
        raise ValueError("无法构造有限的基期 GVC 生产份额交互项")
    if retained_base.empty:
        out[BASELINE_GVC_COL] = pd.Series(dtype=float)
        return out.reset_index(drop=True)
    centered = retained_base - float(retained_base.mean())
    out[BASELINE_GVC_COL] = out[entity].astype(str).map(centered).to_numpy(dtype=float)
    return out.reset_index(drop=True)


def _real_amount(s: pd.Series, deflator: pd.Series) -> pd.Series:
    return (
        (s.astype(float) / deflator.astype(float).replace(0.0, np.nan)).replace([np.inf, -np.inf], np.nan).fillna(0.0)
    )


def _real_log_from_log(log_s: pd.Series, deflator: pd.Series) -> pd.Series:
    nominal = np.expm1(log_s.astype(float)).clip(lower=0.0)
    return np.log(_real_amount(nominal, deflator) + 1.0)


def _country_year_real_growth(
    data: pd.DataFrame,
    amount_col: str,
    time: str,
    *,
    country_totals: pd.DataFrame | None = None,
) -> pd.Series:
    """Country annual growth, preserving national totals on industry slices.

    Use signed raw amounts, never log proxies (their negative values were clipped
    before logging). Input must contain unique country rows or a full industry
    partition. Industry subsets can pass explicit, untrimmed country_totals with
    country/time keys and the raw amount column; these totals are not summed.
    """
    keys = ["country", time]
    grouped = data.groupby(keys, sort=False, dropna=False)
    if grouped[DEFLATOR_COL].nunique(dropna=False).ne(1).any():
        raise ValueError("同一国家年份必须使用唯一的平减指数")
    deflator = data[DEFLATOR_COL].to_numpy(dtype=float)
    if not np.isfinite(deflator).all() or (deflator <= 0).any():
        raise ValueError("平减指数必须为正的有限值")
    if country_totals is not None:
        if not {*keys, amount_col}.issubset(country_totals.columns) or country_totals.duplicated(keys).any():
            raise ValueError("显式国家总额必须包含国家/年份和原始金额列，且国家年份键唯一")
        totals = country_totals.set_index(keys)[[amount_col]]
        needed = grouped.size().index
        if not needed.difference(totals.index).empty:
            raise ValueError("显式国家总额缺少输入面板中的国家年份")
        base = totals.reindex(needed).copy()
    else:
        industry = next((column for column in ("industry", "sector") if column in data), None)
        grain = [*keys, *([industry] if industry else [])]
        if data.duplicated(grain).any():
            raise ValueError("国家增长率输入的金额粒度不唯一；需国家总额或完整且不重复的行业分区")
        base = grouped[amount_col].sum(min_count=1).to_frame()
        # Missing industry amounts must not silently become partial country totals.
        base.loc[grouped[amount_col].count().ne(grouped.size()), amount_col] = np.nan
    base[DEFLATOR_COL] = grouped[DEFLATOR_COL].first()
    base = base.reset_index()
    base = base.sort_values(keys).copy()
    base["_real_amount"] = base[amount_col].astype(float) / base[DEFLATOR_COL].astype(float)
    prev = base.groupby("country")["_real_amount"].shift(1)
    consecutive = base[time] - base.groupby("country")[time].shift(1) == 1
    base["_real_growth"] = (
        ((base["_real_amount"] - prev) / prev.where(prev.abs() > 1e-12))
        .where(consecutive)
        .replace([np.inf, -np.inf], np.nan)
    )
    merged = data[keys].merge(
        base[[*keys, "_real_growth"]],
        on=keys,
        how="left",
        validate="many_to_one",
        sort=False,
    )
    return pd.Series(merged["_real_growth"].to_numpy(), index=data.index)


def _apply_price_mode(
    df: pd.DataFrame,
    design,
    time: str = "year",
    *,
    country_totals: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """平减金额控制；行业子集须显式提供未裁剪的国家总额以计算全国增长率。"""
    if getattr(design, "price_mode", None) != PRICE_MODE_REAL:
        return df
    if DEFLATOR_COL not in df.columns:
        raise ValueError("教学模拟平减口径需要面板包含 gdp_deflator,请先重新运行 gvcsim compute")
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
        out["gdp_proxy_growth"] = _country_year_real_growth(df, "SVA", time, country_totals=country_totals)
    if {"country", time, "gross_exports", DEFLATOR_COL}.issubset(out.columns):
        out["exports_proxy_growth"] = _country_year_real_growth(
            df, "gross_exports", time, country_totals=country_totals
        )
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
