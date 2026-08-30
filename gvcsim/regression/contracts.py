"""Versioned HTTP shapes for the public regression teaching API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from gvcsim import shocks
from gvcsim.regression.design import (
    CONTROL_MODE_NONE,
    GRANULARITY_COUNTRY_INDUSTRY,
    METHOD_DID,
    PRICE_MODE_NOMINAL,
    SCENARIO_CLEAN,
)
from gvcsim.shocks import SHOCK_TARIFF


class StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RegressionRequest(StrictContract):
    outcome: str
    granularity: str = GRANULARITY_COUNTRY_INDUSTRY
    shock_type: str = SHOCK_TARIFF
    method: str = METHOD_DID
    control_mode: str = CONTROL_MODE_NONE
    interaction: bool = False
    price_mode: str = PRICE_MODE_NOMINAL
    scenario: str = SCENARIO_CLEAN
    exclude_row: bool = True
    weight_mode: str = shocks.EXPOSURE_MODE_FIXED_PRETREATMENT


class PlaceboRequest(RegressionRequest):
    n_draws: int = Field(default=80, ge=10, le=200)
    seed: int = Field(default=2026, ge=0, le=2_147_483_647)


class MethodConstraints(StrictContract):
    cohort_aware_methods: list[str]
    controls_publicly_disabled: bool
    cohort_aware_interaction_supported: bool


class RegressionOptionsResponse(StrictContract):
    granularities: list[str]
    granularity_labels: dict[str, str]
    granularities_by_outcome: dict[str, list[str]]
    shock_types: list[str]
    shock_type_labels: dict[str, str]
    methods: list[str]
    method_labels: dict[str, str]
    control_modes: list[str]
    control_mode_labels: dict[str, str]
    price_modes: list[str]
    price_mode_labels: dict[str, str]
    scenarios: list[str]
    scenario_labels: dict[str, str]
    weight_modes: list[str]
    weight_mode_labels: dict[str, str]
    method_constraints: MethodConstraints
    outcomes: dict[str, str]


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


class PlaceboResponse(StrictContract):
    design: RegressionDesignResponse
    placebo: dict[str, Any]
    disclaimer: str
