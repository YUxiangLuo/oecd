"""Versioned HTTP shapes for the fixed teaching regression API."""

from typing import Any

from pydantic import BaseModel, ConfigDict


class StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RegressionRequest(StrictContract):
    outcome: str


class EquationPart(StrictContract):
    text: str
    term: str | None = None
    description: str | None = None
    meta_key: str | None = None


class RegressionDesignResponse(StrictContract):
    outcome: str
    depvar: str
    depvar_label: str
    granularity: str
    granularity_label: str
    shock_type: str
    shock_type_label: str
    shock_col: str
    treated_col: str
    method: str
    method_label: str
    control_mode: str
    control_mode_label: str
    interaction: bool
    price_mode: str
    price_mode_label: str
    scenario: str
    scenario_label: str
    sample_filter: str
    exclude_row: bool
    controls: list[str]
    control_labels: dict[str, str]
    equation: str
    equation_parts: list[EquationPart]
    panel_file: str
    entity: str
    cluster: str
    weight_mode: str


class RegressionPreflightCheck(StrictContract):
    code: str
    severity: str
    message: str


class RegressionPreflight(StrictContract):
    status: str
    can_infer: bool
    checks: list[RegressionPreflightCheck]


class RegressionRunResponse(StrictContract):
    design: RegressionDesignResponse
    result: dict[str, Any]
    preflight: RegressionPreflight
    benchmark: dict[str, Any]
    disclaimer: str
    variable_catalog: list[dict[str, str]]
    model_snapshot: dict[str, Any]
