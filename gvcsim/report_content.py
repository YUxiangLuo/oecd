"""Compatibility import for the report implementation's public boundary."""

from gvcsim.report_build import build
from gvcsim.report_common import ReportGateError, TeachingReport

__all__ = ["ReportGateError", "TeachingReport", "build"]
