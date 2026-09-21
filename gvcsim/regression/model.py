"""Model preparation and result shapes for the fixed TWFE specification."""

from dataclasses import dataclass, field, replace
import math
from numbers import Real

import numpy as np
import pandas as pd

from gvcsim.regression.validity import TreatmentSupport, analyze_support


@dataclass
class CoefStat:
    name: str
    coef: float
    se: float | None
    t: float | None
    p: float | None
    ci_low: float | None
    ci_high: float | None

    @property
    def stars(self) -> str:
        return (
            "" if self.p is None else "***" if self.p < 0.01 else "**" if self.p < 0.05 else "*" if self.p < 0.1 else ""
        )

    def without_inference(self) -> "CoefStat":
        return replace(self, p=None, ci_low=None, ci_high=None)


@dataclass
class RegressionResult:
    depvar: str
    coefs: list[CoefStat]
    n_obs: int
    n_entities: int
    n_times: int
    n_clusters: int
    r2_within: float | None
    depvar_mean: float | None
    depvar_std: float | None
    diagnostics: dict = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    status: str | None = None
    status_reasons: list[str] = field(default_factory=list)
    support: dict | None = None
    sample_flow: dict | None = None

    def to_dict(self) -> dict:
        return {**self.__dict__, "coefs": [{**c.__dict__, "stars": c.stars} for c in self.coefs]}


@dataclass
class PreparedModel:
    data: pd.DataFrame
    depvar: str
    xcols: list[str]
    policy_xcols: list[str]
    entity: str
    time: str
    cluster: str
    notes: list[str]
    support: TreatmentSupport | None = None
    sample_flow: dict | None = None


@dataclass
class TreatmentTiming:
    first_by_entity: pd.Series
    timeline_data: pd.DataFrame
    entity: str
    time: str


def freeze_treatment_timing(
    data: pd.DataFrame, entity: str, time: str, cluster: str, treated_col: str, intensity_col: str | None = None
) -> TreatmentTiming:
    """Freeze first exposure from the complete policy timeline (QC compatibility)."""
    required = list(dict.fromkeys([entity, time, cluster, treated_col, *([intensity_col] if intensity_col else [])]))
    missing = [column for column in required if column not in data]
    if missing:
        raise ValueError("面板缺少处理时点变量:" + "、".join(missing))
    timeline = data[required].copy()
    active = pd.to_numeric(timeline[treated_col], errors="coerce").fillna(0).gt(0)
    first = timeline.loc[active].groupby(entity, sort=False)[time].min()
    first.index = first.index.astype(str)
    return TreatmentTiming(first.astype(int), timeline, entity, time)


def prepare_design_model(df: pd.DataFrame, design) -> PreparedModel:
    """Validate and prepare the one-regressor nominal clean teaching model."""
    columns = [design.depvar, design.shock_col, design.entity, "year", design.cluster]
    has_treated = design.treated_col in df
    if has_treated:
        columns.append(design.treated_col)
    missing = [column for column in columns if column not in df]
    if missing:
        raise ValueError("面板缺少回归变量:" + "、".join(missing))
    data = df.loc[df["country"].astype(str).ne("ROW")].copy() if "country" in df else df.copy()

    for column in dict.fromkeys([design.entity, design.cluster]):
        invalid = data[column].isna() | data[column].map(lambda value: isinstance(value, str) and not value.strip())
        if invalid.any():
            raise ValueError(f"回归标识变量 {column} 含缺失或空白值")

    for column in [design.depvar, design.shock_col, "year", *([design.treated_col] if has_treated else [])]:
        invalid = data[column].notna() & ~data[column].map(
            lambda value: (
                isinstance(value, Real) and not isinstance(value, (bool, np.bool_)) and math.isfinite(float(value))
            )
        )
        if invalid.any():
            raise ValueError(f"回归数值变量 {column} 非缺失值必须是真实数值且有限")
        data[column] = pd.to_numeric(data[column], errors="coerce")
    if data["year"].isna().any():
        raise ValueError("回归数值变量 year 必须是真实数值且不得缺失")
    if not data["year"].dropna().map(lambda value: float(value).is_integer()).all():
        raise ValueError("回归数值变量 year 必须是数学整数")
    if has_treated and not data[design.treated_col].dropna().isin([0, 1]).all():
        raise ValueError(f"处理状态 {design.treated_col} 必须严格为 0/1")
    timing = (
        freeze_treatment_timing(data, design.entity, "year", design.cluster, design.treated_col)
        if has_treated
        else None
    )
    input_rows = len(df)
    missing_by = {column: int(data[column].isna().sum()) for column in [design.depvar, design.shock_col]}
    data = data.dropna(subset=columns).copy()
    flow = {
        "input_rows": input_rows,
        "estimation_rows": len(data),
        "dropped_rows_total": input_rows - len(data),
        "missing_by_field": missing_by,
        "dropped_by_reason": [],
    }
    duplicate = data.duplicated([design.entity, "year"], keep=False)
    if duplicate.any():
        raise ValueError("最终回归样本要求 entity-time 唯一")
    cluster_counts = data.groupby(design.entity, sort=False)[design.cluster].nunique(dropna=False)
    if (cluster_counts > 1).any():
        raise ValueError("最终回归样本中一个实体只能映射到一个聚类")
    support = None
    if has_treated:
        support = analyze_support(
            data,
            design.entity,
            "year",
            design.cluster,
            design.treated_col,
            absorbing=False,
            first_by_entity=timing.first_by_entity if timing else None,
            timeline_data=timing.timeline_data if timing else None,
        )
    return PreparedModel(
        data=data,
        depvar=design.depvar,
        xcols=[design.shock_col],
        policy_xcols=[design.shock_col],
        entity=design.entity,
        time="year",
        cluster=design.cluster,
        notes=["连续冲击强度直接进方程(强度法)"],
        support=support,
        sample_flow=flow,
    )
