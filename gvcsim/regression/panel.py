"""Compatibility facade for the fixed teaching TWFE implementation.

Preparation, estimation, and benchmark responsibilities live in dedicated
modules. Legacy DID, event-study, placebo, controls, interactions, price and
scenario APIs are intentionally not exported.
"""

import pandas as pd

from gvcsim.regression.benchmark import absorbing_estimate as _absorbing_estimate
from gvcsim.regression.benchmark import panelols_estimate as _panelols_estimate
from gvcsim.regression.benchmark import summarize_benchmark as _summarize_benchmark
from gvcsim.regression.estimation import demean_and_prune as _demean_and_prune
from gvcsim.regression.estimation import drop_collinear_columns as _drop_collinear_columns
from gvcsim.regression.estimation import fixed_effect_structure as _fixed_effect_structure
from gvcsim.regression.estimation import twoway_demean as _twoway_demean
from gvcsim.regression.estimation import within_ols as _within_ols
from gvcsim.regression.model import CoefStat, PreparedModel, RegressionResult, TreatmentTiming
from gvcsim.regression.model import freeze_treatment_timing as _freeze_treatment_timing
from gvcsim.regression.model import prepare_design_model

# Private aliases are intentionally retained for QC and focused numerical tests.
_COMPAT_PRIVATE_HELPERS = (
    _drop_collinear_columns,
    _fixed_effect_structure,
    _freeze_treatment_timing,
    _twoway_demean,
)


def run_design_with_benchmark(df: pd.DataFrame, design) -> tuple[RegressionResult, dict]:
    model = prepare_design_model(df, design)
    prepared = _demean_and_prune(model)
    own = _within_ols(model, prepared)
    # The classic (entity, time) pair keeps its PanelOLS benchmark; any other set of fixed effects (or none) is
    # checked against AbsorbingLS / IV2SLS.
    estimate_reference = _panelols_estimate if model.fe_columns is None else _absorbing_estimate
    reference = estimate_reference(model, prepared[2], prepared[3])
    benchmark = _summarize_benchmark(model, own, reference)
    if not benchmark["benchmark_passed"]:
        reason = "标准库实现对照未同时通过系数与标准误门禁；已抑制 p 值和置信区间。"
        # Every inferential number goes, as when the design itself suppresses inference (estimation.within_ols):
        # the X terms' sum (the headline), the constant and the F test's p as well as each coefficient.
        own.coefs = [coefficient.without_inference() for coefficient in own.coefs]
        own.cumulative = own.cumulative.without_inference() if own.cumulative else None
        own.constant = own.constant.without_inference() if own.constant else None
        own.f_p = None
        own.status = "invalid_design"
        own.status_reasons.append(reason)
        own.notes.append(reason)
        if own.support is not None:
            reasons = [*own.support.get("reasons", []), reason]
            own.support = {**own.support, "status": "invalid_design", "suppress_inference": True, "reasons": reasons}
    own.diagnostics["study_contract"] = "economics-v2"
    return own, benchmark


__all__ = [
    "CoefStat",
    "PreparedModel",
    "RegressionResult",
    "TreatmentTiming",
    "prepare_design_model",
    "run_design_with_benchmark",
]
