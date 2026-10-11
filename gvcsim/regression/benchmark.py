"""Independent library benchmarks for the fixed-effect estimator.

The classic (entity, time) model is checked against linearmodels.PanelOLS; a model with any other set of fixed
effects against linearmodels.AbsorbingLS, and one without fixed effects against IV2SLS with a constant.
"""

import math
from typing import Any

import pandas as pd
from linearmodels.iv import IV2SLS
from linearmodels.iv.absorbing import AbsorbingLS
from linearmodels.panel import PanelOLS
from scipy import stats

from gvcsim.regression.estimation import CONSTANT, fixed_effect_rank, fixed_effect_structure, require_finite
from gvcsim.regression.model import CoefStat, PreparedModel, RegressionResult


def panelols_estimate(model: PreparedModel, keep: list[str], dropped: list[str]) -> RegressionResult:
    data = model.data.set_index([model.entity, model.time])
    y, X = data[model.depvar].astype(float), data[keep].astype(float)
    clusters = pd.Series(model.data[model.cluster].values, index=data.index)
    effects = fixed_effect_structure(model.data, model.entity, model.time)
    absorb_time = effects.components == 1
    if not absorb_time:
        for index, period in enumerate(effects.nonreference_times):
            name = f"__gvcsim_time_effect_{index}"
            while name in X:
                name += "_"
            X[name] = (data.index.get_level_values(model.time) == period).astype(float)
    result = PanelOLS(y, X, entity_effects=True, time_effects=absorb_time, drop_absorbed=True).fit(
        cov_type="clustered", clusters=clusters, group_debias=True, auto_df=False, count_effects=True
    )
    groups = model.data[model.cluster].nunique()
    critical = stats.t.ppf(0.975, groups - 1)
    coefs = []
    for name in keep:
        b, se = float(result.params[name]), float(result.std_errors[name])
        require_finite(f"PanelOLS 系数 {name}", b, se)
        if se <= 0:
            raise ValueError(f"PanelOLS 系数 {name} 的聚类稳健标准误必须为正")
        t = b / se
        coefficient = CoefStat(
            name, b, se, t, float(2 * stats.t.sf(abs(t), groups - 1)), b - critical * se, b + critical * se
        )
        require_finite(
            f"PanelOLS 系数 {name}",
            coefficient.t,
            coefficient.p,
            coefficient.ci_low,
            coefficient.ci_high,
        )
        coefs.append(coefficient)
    panel_r2 = float(result.rsquared_within)
    if not absorb_time:
        original = data[[model.depvar, *keep]].astype(float)
        within = (original - original.groupby(level=model.entity).transform("mean")).to_numpy()
        residual = within[:, 0] - within[:, 1:] @ result.params[keep].to_numpy()
        panel_r2 = 1 - float(residual @ residual) / float(within[:, 0] @ within[:, 0])
    depvar_mean = float(model.data[model.depvar].mean())
    depvar_std = float(model.data[model.depvar].std())
    require_finite("PanelOLS 汇总统计量", panel_r2, depvar_mean, depvar_std)
    return RegressionResult(
        model.depvar,
        coefs,
        int(result.nobs),
        model.data[model.entity].nunique(),
        model.data[model.time].nunique(),
        groups,
        panel_r2,
        depvar_mean,
        depvar_std,
        notes=["标准库对照:linearmodels.PanelOLS", "PanelOLS 仅用于检查实现结果一致性，不验证因果识别假设。"],
        sample_flow=model.sample_flow,
    )


def absorbing_estimate(model: PreparedModel, keep: list[str], dropped: list[str]) -> RegressionResult:
    """The same model through linearmodels: AbsorbingLS with the fixed effects absorbed, or IV2SLS with a constant.

    linearmodels' debiased clustered covariance uses N − k residual degrees of freedom (absorbed effects not
    counted); this course counts the fixed-effect rank r as well, so its SE are the library's times
    √((N − k) / (N − k − r)). The library SE are put on the course's scale before they are compared.
    """
    data = model.data
    names = [name for name in keep if name != CONSTANT]
    y = data[model.depvar].astype(float)
    X = data[names].astype(float)
    clusters = pd.Categorical(data[model.cluster].astype(str))
    effects = model.effect_columns
    result: Any
    if effects:
        absorb = pd.DataFrame(
            {column: pd.Categorical(data[column].astype(str)) for column in effects}, index=data.index
        )
        result = AbsorbingLS(y, X, absorb=absorb, drop_absorbed=True).fit(
            cov_type="clustered", clusters=clusters, debiased=True
        )
        backend, k = "linearmodels.AbsorbingLS", len(names)
    else:
        result = IV2SLS(y, X.assign(**{CONSTANT: 1.0}), None, None).fit(
            cov_type="clustered", clusters=clusters, debiased=True
        )
        backend, k = "linearmodels.IV2SLS", len(names) + 1
    rank, _ = fixed_effect_rank(data, effects)
    n = int(result.nobs)
    scale = math.sqrt((n - k) / (n - k - rank)) if rank else 1.0
    groups = data[model.cluster].nunique()
    critical = stats.t.ppf(0.975, groups - 1)
    coefs = []
    for name in keep:
        if name not in result.params.index:
            continue
        b, se = float(result.params[name]), float(result.std_errors[name]) * scale
        require_finite(f"{backend} 系数 {name}", b, se)
        if se <= 0:
            raise ValueError(f"{backend} 系数 {name} 的聚类稳健标准误必须为正")
        t = b / se
        coefs.append(
            CoefStat(name, b, se, t, float(2 * stats.t.sf(abs(t), groups - 1)), b - critical * se, b + critical * se)
        )
    depvar_mean = float(data[model.depvar].mean())
    depvar_std = float(data[model.depvar].std())
    r2 = float(result.rsquared)
    require_finite(f"{backend} 汇总统计量", r2, depvar_mean, depvar_std)
    reference = RegressionResult(
        model.depvar,
        coefs,
        n,
        data[model.entity].nunique(),
        data[model.time].nunique(),
        groups,
        None,
        depvar_mean,
        depvar_std,
        notes=[f"标准库对照:{backend}", f"{backend.split('.')[-1]} 仅用于检查实现结果一致性，不验证因果识别假设。"],
        sample_flow=model.sample_flow,
        r2=r2,
    )
    reference.diagnostics["backend"] = backend
    return reference


def summarize_benchmark(model: PreparedModel, own: RegressionResult, reference: RegressionResult) -> dict:
    """Compare every estimated coefficient (X terms, controls and a constant) and its SE with the library's.

    Row keys keep their historical names (``panelols_coef``/``panelols_se``) whatever the library.
    """
    own_by = {c.name: c for c in own.coefs}
    if own.constant is not None:
        own_by[own.constant.name] = own.constant
    ref_by = {c.name: c for c in reference.coefs}
    # Every X term must be compared unless the estimation itself reported it as omitted (absorbed, collinear, zero).
    omitted = {item["name"] for item in model.omitted}
    policy = [name for name in model.policy_xcols if name not in omitted]
    for name in policy:
        if name not in own_by:
            raise ValueError(f"标准库对照缺少政策系数: {name}")
    names = [*policy, *(name for name in own_by if name not in policy)]
    # A regressor the library dropped as absorbed while the course kept it (the two rank tests differ near the
    # threshold) cannot be compared: the check fails, so the run is returned with its inference suppressed
    # (run_design_with_benchmark) rather than refused.
    missing = [name for name in names if name not in ref_by]
    rows: list[dict] = []
    coef_diffs: list[float] = []
    coef_tolerances: list[float] = []
    se_diffs: list[float] = []
    se_tolerances: list[float] = []
    for name in names:
        if name in missing:
            continue
        a, b = own_by[name], ref_by[name]
        if a.se is None or b.se is None:
            raise ValueError(f"标准库对照缺少标准误: {name}")
        coef_diff = a.coef - b.coef
        se_diff = a.se - b.se
        rows.append(
            {
                "name": name,
                "own_coef": a.coef,
                "panelols_coef": b.coef,
                "coef_diff": coef_diff,
                "own_se": a.se,
                "panelols_se": b.se,
                "se_diff": se_diff,
            }
        )
        coef_diffs.append(abs(coef_diff))
        # Absolute 1e-8, plus 1e-9 of the coefficient: a network Y (thousands) without fixed effects is fitted on raw
        # levels with a constant, where the two solvers differ by a few 1e-8 on coefficients in the hundreds.
        coef_tolerances.append(1e-8 + 1e-9 * max(abs(a.coef), abs(b.coef)))
        se_diffs.append(abs(se_diff))
        se_tolerances.append(1e-10 + 1e-6 * max(abs(a.se), abs(b.se)))
    max_coef = max(coef_diffs, default=0.0)
    max_se = max(se_diffs, default=0.0)
    require_finite("标准库对照摘要", max_coef, max_se, coef_diffs, se_diffs, se_tolerances)
    coef_passed = not missing and all(
        diff <= tolerance for diff, tolerance in zip(coef_diffs, coef_tolerances, strict=True)
    )
    se_passed = not missing and all(diff <= tolerance for diff, tolerance in zip(se_diffs, se_tolerances, strict=True))
    notes = list(reference.notes)
    if missing:
        notes.append(f"标准库把这些变量当作已被固定效应吸收而去掉，无法对照：{'、'.join(missing)}")
    return {
        "backend": reference.diagnostics.get("backend", "linearmodels.PanelOLS"),
        "policy_coefs": rows,
        "max_abs_coef_diff": max_coef,
        "max_abs_se_diff": max_se,
        "coef_check_passed": coef_passed,
        "se_check_passed": se_passed,
        "benchmark_passed": coef_passed and se_passed,
        "missing_in_reference": missing,
        "se_check_mode": "matched_cr1_atol_1e-10_rtol_1e-6",
        "notes": notes,
    }
