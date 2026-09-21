# ruff: noqa: F401
"""Public facade for generating the fixed-model teaching report.

Implementation is split by responsibility; this module exposes only the stable
application API.
"""

from gvcsim.report_build import build
from gvcsim.report_common import (
    GATE_STEPS,
    REFLECTION_TEXT_LIMIT,
    ReportGateError,
    TeachingReport,
    _OUTCOME_INTERPRETATIONS,
    _STUDENT_METRIC_LABELS,
    _natural_effect,
    _observation_reading,
    _signed,
)
from gvcsim.report_gate import check_gate, check_material_gate
from gvcsim.report_observed import _observed_chart, _observed_charts
from gvcsim.report_render import _experiment_sections, _qc_release_summary
from gvcsim.report_saved_run import _gate_qualified_runs, _result_is_qualified, _saved_runs

__all__ = [
    "ReportGateError",
    "GATE_STEPS",
    "REFLECTION_TEXT_LIMIT",
    "TeachingReport",
    "build",
    "check_gate",
    "check_material_gate",
]
