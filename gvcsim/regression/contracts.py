"""Versioned HTTP shapes for the fixed teaching regression API."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from gvcsim.regression.spec import CONTROLS


class StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SpecControl(StrictContract):
    name: StrictStr
    lag: StrictInt


class ModelSpecPayload(StrictContract):
    """A workbench model (gvcsim.regression.spec.ModelSpec.to_dict()); the whitelist is checked by ModelSpec."""

    x_lags: list[StrictInt] = Field(max_length=3)
    controls: list[SpecControl] = Field(max_length=len(CONTROLS))
    fixed_effects: list[StrictStr] = Field(max_length=5)


class RegressionRequest(StrictContract):
    outcome: str
    # Same-family generation baseline for Y; omitted means the family's fixed default.
    baseline: str | None = None
    # The model a student designs in the workbench (steps 11–14); omitted means the course default model.
    spec: ModelSpecPayload | None = None


class EquationPart(StrictContract):
    text: str
    term: str | None = None
    description: str | None = None
    meta_key: str | None = None


class RegressionDesignResponse(StrictContract):
    outcome: str
    baseline: str
    baseline_label: str
    depvar: str
    depvar_label: str
    depvar_kind: str
    depvar_unit: str
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
    # The model: X lags, controls and fixed effects (gvcsim.regression.spec.ModelSpec.to_dict()).
    spec: dict[str, Any] | None = None


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
