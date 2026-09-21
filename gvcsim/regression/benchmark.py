"""Independent PanelOLS benchmark for the fixed TWFE estimator."""

import pandas as pd
from linearmodels.panel import PanelOLS
from scipy import stats

from gvcsim.regression.estimation import fixed_effect_structure, require_finite
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


def summarize_benchmark(model: PreparedModel, own: RegressionResult, reference: RegressionResult) -> dict:
    own_by, ref_by = ({c.name: c for c in result.coefs} for result in (own, reference))
    rows: list[dict] = []
    coef_diffs: list[float] = []
    se_diffs: list[float] = []
    se_tolerances: list[float] = []
    for name in model.policy_xcols:
        if name not in own_by or name not in ref_by:
            raise ValueError(f"PanelOLS 对照缺少政策系数: {name}")
        a, b = own_by[name], ref_by[name]
        if a.se is None or b.se is None:
            raise ValueError(f"PanelOLS 对照缺少政策标准误: {name}")
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
        se_diffs.append(abs(se_diff))
        se_tolerances.append(1e-10 + 1e-6 * max(abs(a.se), abs(b.se)))
    max_coef = max(coef_diffs)
    max_se = max(se_diffs)
    require_finite("PanelOLS 对照摘要", max_coef, max_se, coef_diffs, se_diffs, se_tolerances)
    coef_passed = max_coef < 1e-8
    se_passed = all(diff <= tolerance for diff, tolerance in zip(se_diffs, se_tolerances, strict=True))
    return {
        "backend": "linearmodels.PanelOLS",
        "policy_coefs": rows,
        "max_abs_coef_diff": max_coef,
        "max_abs_se_diff": max_se,
        "coef_check_passed": coef_passed,
        "se_check_passed": se_passed,
        "benchmark_passed": coef_passed and se_passed,
        "se_check_mode": "matched_cr1_atol_1e-10_rtol_1e-6",
        "notes": reference.notes,
    }
