"""Sample and baseline transforms used by release quality checks."""

from __future__ import annotations

import math
from numbers import Real

import numpy as np
import pandas as pd

BASE_GVC_COL = "3_VA_GVC_share"  # 基期 GVC 生产份额(3_VA_GVC / SVA)
BASELINE_GVC_COL = "base_gvc_participation"
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
