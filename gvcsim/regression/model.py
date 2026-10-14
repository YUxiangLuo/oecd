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
    # Binned scatter of the within-transformed Y against X (steps 11–14 result chart); None when not computed.
    binscatter: dict | None = None
    # The SD of Y after removing each entity's level and each year's common change (the variation the two-way
    # model uses): the scale of every "个标准差" conversion. depvar_std stays the pooled SD, a descriptive only.
    depvar_within_std: float | None = None
    # Overall R² (with the fixed effects' explanatory power), adjusted R² (k regressors + fixed-effect rank) and the
    # country-clustered Wald F of every regressor except the constant, with its (q, G − 1) degrees of freedom.
    r2: float | None = None
    r2_adj: float | None = None
    f_stat: float | None = None
    f_df: list[int] | None = None
    f_p: float | None = None
    # Root mean squared error of the residuals over the residual degrees of freedom (Stata's Root MSE).
    root_mse: float | None = None
    # The constant of a model without fixed effects (absent when fixed effects absorb it).
    constant: CoefStat | None = None
    # Sum of the X terms' coefficients (X, L1.X, L2.X): the cumulative relation, with its own clustered SE.
    cumulative: CoefStat | None = None
    # Regressors left out because a fixed effect absorbs them or another regressor duplicates them.
    omitted: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        def coef(c: CoefStat | None) -> dict | None:
            return None if c is None else {**c.__dict__, "stars": c.stars}

        return {
            **self.__dict__,
            "coefs": [coef(c) for c in self.coefs],
            "constant": coef(self.constant),
            "cumulative": coef(self.cumulative),
        }


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
    # Columns whose groups are absorbed as fixed effects; None is the classic (entity, time) pair, () is none at all
    # (the model then carries a constant).
    fe_columns: tuple[str, ...] | None = None
    # Filled by estimation: regressors left out, each {name, reason ("absorbed" / "collinear" / "zero"), by}.
    omitted: list[dict] = field(default_factory=list)

    @property
    def effect_columns(self) -> tuple[str, ...]:
        return (self.entity, self.time) if self.fe_columns is None else self.fe_columns


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
    """Validate and prepare a model: the design's X terms and controls, its fixed effects, the ROW exclusion.

    A teaching design carries a ``ModelSpec`` (X lags read from the panel's lag columns, controls lagged by year key,
    any set of fixed effects); an observed-panel design is the classic one-regressor (entity, year) model.
    """
    spec = getattr(design, "spec", None)
    if spec is not None:
        from gvcsim.regression.spec import FIXED_EFFECT_COLUMNS, control_column

        x_columns = spec.x_columns
        base_controls = [key for key, _ in spec.controls]
        lagged_controls = [(key, lag, control_column(key, lag)) for key, lag in spec.controls if lag]
        regressors = [*x_columns, *spec.control_columns]
        fe_columns: tuple[str, ...] | None = tuple(spec.fixed_effect_columns)
        effect_sources = [
            source
            for key in spec.fixed_effects
            for source in (("country", "year") if key == "country_year" else (FIXED_EFFECT_COLUMNS[key],))
        ]
    else:
        x_columns = [design.shock_col]
        base_controls, lagged_controls, regressors, fe_columns, effect_sources = [], [], [design.shock_col], None, []
    columns = list(dict.fromkeys([design.depvar, *x_columns, *base_controls, design.entity, "year", design.cluster]))
    columns += [column for column in effect_sources if column not in columns]
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

    numeric = [design.depvar, *x_columns, *base_controls, "year", *([design.treated_col] if has_treated else [])]
    for column in dict.fromkeys(numeric):
        values = data[column]
        if values.dtype.kind in "iuf":
            invalid = values.notna() & ~np.isfinite(values)
        else:
            # Object columns still need strict type checks: coercion would accept
            # strings and booleans which the public numeric contract rejects.
            invalid = values.notna() & ~values.map(
                lambda value: (
                    isinstance(value, Real) and not isinstance(value, (bool, np.bool_)) and math.isfinite(float(value))
                )
            )
        if invalid.any():
            raise ValueError(f"回归数值变量 {column} 非缺失值必须是真实数值且有限")
        data[column] = pd.to_numeric(data[column], errors="coerce")
    if data["year"].isna().any():
        raise ValueError("回归数值变量 year 必须是真实数值且不得缺失")
    if not np.equal(data["year"], np.floor(data["year"])).all():
        raise ValueError("回归数值变量 year 必须是数学整数")
    if has_treated and not data[design.treated_col].dropna().isin([0, 1]).all():
        raise ValueError(f"处理状态 {design.treated_col} 必须严格为 0/1")
    omitted = []
    if spec is not None and "country_year" in spec.fixed_effects:
        # Every offered control is national, including its lag. Remove these structural redundancies before
        # complete-case selection: an unused control must not delete observations (or the first lag year).
        for key in base_controls:
            if data.groupby(["country", "year"])[key].nunique().gt(1).any():
                raise ValueError(f"国家层面控制变量 {key} 在同一国家年份必须一致")
        omitted = [{"name": name, "reason": "absorbed", "by": "国家×年份"} for name in spec.control_columns]
        columns = [name for name in columns if name not in base_controls]
        regressors = list(x_columns)
        base_controls, lagged_controls = [], []
    timing = (
        freeze_treatment_timing(data, design.entity, "year", design.cluster, design.treated_col)
        if has_treated
        else None
    )
    # A lagged control is the same unit's value k years earlier, matched on the year (not on row position), so a
    # missing year leaves the lag missing instead of borrowing an older value. The match needs one row per unit and
    # year: a duplicated panel gets the course's message here instead of pandas' MergeError.
    if lagged_controls and data.duplicated([design.entity, "year"]).any():
        raise ValueError("最终回归样本要求 entity-time 唯一")
    for key, lag, column in lagged_controls:
        earlier = data[[design.entity, "year", key]].assign(year=data["year"] + lag).rename(columns={key: column})
        data = data.merge(earlier, on=[design.entity, "year"], how="left", validate="one_to_one")
    if spec is not None and "country_year" in spec.fixed_effects:
        data["_fe_country_year"] = data["country"].astype(str) + "|" + data["year"].astype(int).astype(str)
    input_rows = len(df)
    complete_case_input_rows = len(data)
    row_excluded_rows = input_rows - complete_case_input_rows
    missing_fields = [design.depvar, *regressors, *([design.treated_col] if has_treated else [])]
    missing_by = {column: int(data[column].isna().sum()) for column in missing_fields}
    reasons = [{"code": "excluded_row", "field": "country", "rows": row_excluded_rows}] if row_excluded_rows else []
    lag_columns = {column for _, _, column in lagged_controls}
    # Field counts overlap; reason counts do not. Attribute each incomplete row
    # to its first missing field in Y, X, controls, treated order, after excluding ROW.
    remaining = pd.Series(True, index=data.index)
    for column in missing_fields:
        missing_mask = data[column].isna()
        count = int((remaining & missing_mask).sum())
        if count:
            reasons.append({"code": "lag" if column in lag_columns else "missing", "field": column, "rows": count})
        remaining &= ~missing_mask
    # A control used only at a lag needs its earlier value, not the current one.
    required = [column for column in columns if column not in base_controls or column in regressors]
    data = data.dropna(subset=list(dict.fromkeys([*required, *regressors]))).copy()
    flow = {
        "input_rows": input_rows,
        "row_excluded_rows": row_excluded_rows,
        "complete_case_input_rows": complete_case_input_rows,
        "estimation_rows": len(data),
        "dropped_rows_total": input_rows - len(data),
        "missing_by_field": missing_by,
        "missing_by_field_counts_overlap": True,
        "dropped_by_reason": reasons,
    }
    if spec is not None and len(data):
        # The sample's first and last year (a lagged control drops the first year): the workbench table's 年份 row.
        flow["years"] = [int(data["year"].min()), int(data["year"].max())]
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
        xcols=list(regressors),
        policy_xcols=list(x_columns),
        entity=design.entity,
        time="year",
        cluster=design.cluster,
        notes=["关税暴露 X 以连续强度直接进入方程，不分组、不设阈值"],
        support=support,
        sample_flow=flow,
        fe_columns=fe_columns,
        omitted=omitted,
    )
