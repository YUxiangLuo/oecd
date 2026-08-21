"""Versioned release QC for the exact inputs consumed by regression routes.

This v1 contract is intentionally distinct from input QC and output-identity QC.
It certifies a bounded set of supported granularity/outcome slices at the runtime
regression boundary; it does not certify every design variant, an estimator, or a causal claim.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from numbers import Real
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd

from gvcsim.data.controls import CONTROL_COLUMNS, MACRO_CONTROL_COLUMNS
from gvcsim.regression import panel as regression_panel
from gvcsim.regression.design import OUTCOME_DEPVARS, OUTCOME_GRANULARITIES
from gvcsim.regression.transforms import (
    BASELINE_GVC_COL,
    _apply_sample_filter,
    _attach_baseline_gvc,
    _freeze_baseline_gvc,
)
from gvcsim.shocks import (
    EXPOSURE_MODE_FIXED_PRETREATMENT,
    SHOCK_SPECS,
    SHOCK_TARIFF,
    TREATED_THRESHOLD,
)

REGRESSION_INPUT_QC_CONTRACT_VERSION = 1
REGRESSION_INPUT_QC_SEVERITIES = ("ok", "fatal")
REGRESSION_INPUT_QC_FILE = "qc_regression_inputs.json"
BASE_GVC_COLUMN = "3_VA_GVC_share"
CONTEMPORANEOUS_COLUMNS = ("tariff_shock_contemporaneous", "treated_contemporaneous")
REGRESSION_CONTROL_FIELDS = (*CONTROL_COLUMNS, *MACRO_CONTROL_COLUMNS, "gdp_deflator")
DEFAULT_SAMPLE_FILTER = SimpleNamespace(exclude_row=True)
WITHIN_ABSORPTION_TOLERANCE = 1e-10


@dataclass(frozen=True)
class RegressionInputCheckSpec:
    name: str
    kind: str
    description: str


REGRESSION_INPUT_CHECK_SPECS = (
    RegressionInputCheckSpec(
        "panel_keys_years_clusters",
        "structure",
        "Both panel granularities have nonblank identifiers, finite integral declared years, unique entity-year keys, stable entity-cluster mappings, and at least two entities, times, and clusters.",
    ),
    RegressionInputCheckSpec(
        "configured_outcomes",
        "numeric",
        "After the runtime-default ROW exclusion, every supported granularity/outcome is release-certified on its no-control outcome complete-case slice and on the canonical no-control tariff interaction complete case for DID and intensity. Interaction timing and the uncentered moderator are frozen from the full structurally filtered tariff history before outcome/control attrition: treated entities use their last up to two finite raw moderator observations strictly before frozen G_i, never-treated entities use their earliest up to two finite observations, structural nulls are skipped, entities without a finite derived moderator are dropped with all their rows, and retained entities are then centered equally exactly as at runtime. Final slices require finite outcomes, at least two entities, times, and clusters, unique entity-time keys, stable cluster mapping, conservative residual capacity, positive derived entity-level baseline variation, and finite full-rank two-column DID and intensity policy designs after entity/time demeaning. Sanctions, export-control, event-study, control, and other route variants remain runtime-validated optional designs and are not release-fatal.",
    ),
    RegressionInputCheckSpec(
        "shock_control_fields",
        "numeric",
        "All configured shock, treatment, and control fields exist, are nonnull, and are finite; treatment indicators are exact 0/1. The interaction moderator exists and every nonnull value is truly numeric and finite; structural nulls are skipped while freezing entity baselines, and entities with no finite derived baseline are dropped rather than zero-filled. Panel shocks/controls match their source artifacts and country shocks match fixed-weight industry aggregation.",
    ),
    RegressionInputCheckSpec(
        "treatment_timeline_preperiod",
        "design",
        "After the runtime-default ROW exclusion, each observed treatment timeline has a valid first treatment and every treated entity has at least one true earlier panel period.",
    ),
    RegressionInputCheckSpec(
        "fixed_pretreatment_availability",
        "design",
        "The published tariff exposure mode is fixed_pretreatment and any first treatment has at least one strictly earlier release year.",
    ),
)
REGRESSION_INPUT_QC_EXPECTED_CHECKS = tuple(spec.name for spec in REGRESSION_INPUT_CHECK_SPECS)


class RegressionInputQualityError(RuntimeError):
    """A regression-input QC artifact or semantic recomputation is invalid."""


def _panel_contract_metadata() -> dict:
    configured_outcomes: dict[str, list[str]] = {"country": [], "country_industry": []}
    for outcome, (column, _label) in OUTCOME_DEPVARS.items():
        for granularity in OUTCOME_GRANULARITIES[outcome]:
            configured_outcomes[granularity].append(column)
    return {
        "country": {
            "file": "panel_country.csv",
            "entity": "country",
            "cluster": "country",
            "keys": ["country", "year"],
            "outcomes": sorted(set(configured_outcomes["country"])),
        },
        "country_industry": {
            "file": "panel_industry.csv",
            "entity": "entity_id",
            "cluster": "country",
            "keys": ["entity_id", "year"],
            "outcomes": sorted(set(configured_outcomes["country_industry"])),
        },
    }


def regression_input_qc_contract_metadata() -> dict:
    """Return the exact supported regression-input QC v1 contract."""
    shock_fields = sorted({column for pair in SHOCK_SPECS.values() for column in pair} | set(CONTEMPORANEOUS_COLUMNS))
    return {
        "version": REGRESSION_INPUT_QC_CONTRACT_VERSION,
        "artifact": REGRESSION_INPUT_QC_FILE,
        "checks": [
            {
                "name": spec.name,
                "kind": spec.kind,
                "failure_severity": "fatal",
                "description": spec.description,
            }
            for spec in REGRESSION_INPUT_CHECK_SPECS
        ],
        "panels": _panel_contract_metadata(),
        "release_certification_scope": {
            "certified": {
                "baseline_outcomes": {
                    "controls": "none",
                    "interaction": False,
                    "sample": "runtime_default_exclude_country_ROW",
                    "coverage": "each_supported_granularity_outcome",
                },
                "interaction_designs": {
                    "shock_types": [SHOCK_TARIFF],
                    "methods": ["did", "twfe_intensity"],
                    "controls": "none",
                    "interaction": True,
                    "sample": "runtime_default_exclude_country_ROW",
                    "coverage": "each_supported_granularity_outcome",
                },
            },
            "optional_runtime_validated": {
                "shock_types": sorted(set(SHOCK_SPECS) - {SHOCK_TARIFF}),
                "method_variants": ["event_study"],
                "other_variants": ["configured_controls", "other_route_cross_products"],
                "unavailability_release_fatal": False,
            },
            "certifies_every_cross_product": False,
            "certifies_causal_identification": False,
            "certifies_statistical_power": False,
        },
        "sample_scope": {
            "runtime_default": "exclude_row",
            "country_column": "country",
            "excluded_country_values": ["ROW"],
            "applies_before": [
                "configured_outcome_structural_slices",
                "interaction_timing_and_complete_case_slices",
                "treatment_timeline_preperiod",
                "fixed_pretreatment_availability",
            ],
            "full_artifact_scope_retained_for": [
                "persisted_panel_keys_years_clusters",
                "numeric_schema_and_source_reconciliation",
            ],
        },
        "fields": {
            "shock_and_treatment": shock_fields,
            "controls": list(REGRESSION_CONTROL_FIELDS),
            "interaction_baseline": BASE_GVC_COLUMN,
        },
        "requirements": {
            "identifier": "nonnull_nonblank",
            "year": "true_numeric_finite_mathematical_integer_exact_release_set",
            "key": "unique_entity_year",
            "cluster": "stable_entity_mapping_and_at_least_two; at_least_two_declared_times",
            "numeric": (
                "shock_treatment_controls_nonnull_finite; outcomes_allow_null_complete_case; "
                "interaction_moderator_structural_nulls_skipped_when_freezing_entity_baseline; "
                "nonnull_values_must_be_finite_numeric"
            ),
            "outcome_variance": (
                "positive_finite_on_no_control_outcome_complete_case_and_canonical_tariff_interaction_"
                "outcome_plus_shock_treatment_derived_baseline_complete_case"
            ),
            "outcome_structural_slices": {
                "sample": "runtime_default_exclude_country_ROW",
                "baseline": (
                    "no_controls_complete_on_outcome; at_least_two_entities_times_clusters; unique_entity_time; "
                    "stable_entity_cluster; positive_outcome_variance_and_range; "
                    "rows-entities-times+1-one_policy_regressor>0"
                ),
                "interaction": (
                    f"canonical_tariff_only; freeze_first_treatment_from_full_filtered_history; "
                    f"freeze_uncentered_entity_baseline_from_full_filtered_{BASE_GVC_COLUMN}_history_before_"
                    "outcome_control_complete_case; complete_case_on_outcome+tariff_shock+treatment+identifiers_only; "
                    "raw_structural_baseline_nulls_skipped_and_never_zero_filled; "
                    "treated_last_up_to_two_finite_strict_pre_G_i_never_treated_earliest_up_to_two_finite; "
                    "drop_all_rows_for_entities_without_finite_derived_baseline_before_retained_entity_equal_center; "
                    "all_retained_entities_finite; positive_derived_entity_level_baseline_variance_and_range; "
                    "at_least_two_entities_times_clusters; unique_entity_time; stable_entity_cluster; "
                    "positive_outcome_variance_and_range; rows-entities-times+1-two_policy_regressors>0; "
                    "after_entity_time_demeaning_each_did_and_intensity_policy_column_nonzero_and_"
                    "each_two_column_policy_design_finite_with_joint_rank_2_at_runtime_tolerance"
                ),
                "optional_runtime_validated_designs": (
                    "sanctions_and_export_control_interactions; event_study; controls; other_route_variants; "
                    "availability_not_release_fatal"
                ),
            },
            "event_preperiod": "each_treated_entity_has_year_strictly_before_first_treatment",
            "fixed_pretreatment": "release_year_strictly_before_first_treatment; no_treated_year_fallback",
        },
        "certification_limit": (
            "Structural validation only: release certification is bounded to runtime-default non-ROW no-control "
            "baseline outcomes plus canonical no-control tariff DID and intensity interaction prerequisites for each "
            "supported granularity/outcome. Sanctions, export-control, event-study, controls, and other cross-product "
            "variants are optional runtime-validated designs whose unavailability is not release-fatal. This does not "
            "certify every design cross-product, causal identification, statistical power, or estimator validity."
        ),
    }


def validate_regression_input_qc_contract_metadata(value: object) -> None:
    if not isinstance(value, dict) or value != regression_input_qc_contract_metadata():
        raise ValueError(
            "unsupported or incomplete regression input QC contract; "
            f"version {REGRESSION_INPUT_QC_CONTRACT_VERSION} is required"
        )


def _check(name: str, passed: bool, detail: str) -> dict:
    spec = next(item for item in REGRESSION_INPUT_CHECK_SPECS if item.name == name)
    return {
        "name": name,
        "kind": spec.kind,
        "passed": bool(passed),
        "detail": detail,
        "severity": "ok" if passed else "fatal",
    }


def validate_serialized_regression_input_checks(checks: object, *, contract_version: int) -> list[dict]:
    if type(contract_version) is not int or contract_version != REGRESSION_INPUT_QC_CONTRACT_VERSION:
        raise ValueError(f"unsupported regression input QC contract version: {contract_version}")
    if not isinstance(checks, list) or not checks:
        raise ValueError("regression input QC checks must be a nonempty array")
    specs = {spec.name: spec for spec in REGRESSION_INPUT_CHECK_SPECS}
    names: list[str] = []
    for index, raw in enumerate(checks):
        if not isinstance(raw, dict) or set(raw) != {"name", "kind", "passed", "detail", "severity"}:
            raise ValueError(f"regression input QC check {index + 1} has malformed fields")
        if (
            type(raw["name"]) is not str
            or type(raw["kind"]) is not str
            or type(raw["passed"]) is not bool
            or type(raw["detail"]) is not str
            or not raw["detail"]
            or type(raw["severity"]) is not str
        ):
            raise ValueError(f"regression input QC check {index + 1} has invalid field types")
        spec = specs.get(raw["name"])
        if spec is not None and raw["kind"] != spec.kind:
            raise ValueError(f"regression input QC check {raw['name']} has invalid kind")
        expected_severity = "ok" if raw["passed"] else "fatal"
        if raw["severity"] not in REGRESSION_INPUT_QC_SEVERITIES or raw["severity"] != expected_severity:
            raise ValueError(f"regression input QC check {raw['name']} has malformed severity")
        names.append(raw["name"])
    if len(names) != len(set(names)):
        raise ValueError("regression input QC checks contain duplicates")
    missing = sorted(set(REGRESSION_INPUT_QC_EXPECTED_CHECKS) - set(names))
    unknown = sorted(set(names) - set(REGRESSION_INPUT_QC_EXPECTED_CHECKS))
    if missing or unknown or len(names) != len(REGRESSION_INPUT_QC_EXPECTED_CHECKS):
        raise ValueError(f"regression input QC check set mismatch; missing={missing}, unknown={unknown}")
    return checks


def summarize_regression_input_checks(checks: list[dict]) -> dict:
    validate_serialized_regression_input_checks(checks, contract_version=REGRESSION_INPUT_QC_CONTRACT_VERSION)
    fatal = [item["name"] for item in checks if not item["passed"]]
    passed = [item["name"] for item in checks if item["passed"]]
    return {"publishable": not fatal, "fatal": fatal, "passed": passed}


def validate_regression_input_summary(value: object, checks: list[dict]) -> None:
    if not isinstance(value, dict) or set(value) != {"publishable", "fatal", "passed"}:
        raise ValueError("regression input QC summary has malformed fields")
    if type(value.get("publishable")) is not bool:
        raise ValueError("regression input QC summary publishable must be boolean")
    if not isinstance(value.get("fatal"), list) or not isinstance(value.get("passed"), list):
        raise ValueError("regression input QC summary lists are malformed")
    if any(type(item) is not str for key in ("fatal", "passed") for item in value[key]):
        raise ValueError("regression input QC summary names are malformed")
    if value != summarize_regression_input_checks(checks):
        raise ValueError("regression input QC summary does not match its check file")


def _read_csv(root: Path, filename: str) -> pd.DataFrame:
    try:
        return pd.read_csv(root / filename)
    except (OSError, UnicodeError, pd.errors.ParserError, pd.errors.EmptyDataError) as exc:
        raise RegressionInputQualityError(f"cannot recompute regression input QC from {filename}: {exc}") from exc


def _finite_numeric(series: pd.Series, *, allow_null: bool) -> tuple[np.ndarray, int]:
    """Return float values without treating object/string coercion as valid source data."""
    numeric = pd.to_numeric(series, errors="coerce")
    values = numeric.to_numpy(dtype=float)
    invalid = np.zeros(len(series), dtype=bool)
    for index, value in enumerate(series.array):
        try:
            missing = bool(pd.isna(value))
        except (TypeError, ValueError):
            missing = False
        if missing and allow_null:
            continue
        invalid[index] = (
            not isinstance(value, Real) or isinstance(value, (bool, np.bool_)) or not np.isfinite(float(value))
        )
    return values, int(invalid.sum())


def _panel_key_check(frames: dict[str, pd.DataFrame], years: list[int]) -> dict:
    problems: list[str] = []
    contract = _panel_contract_metadata()
    for granularity, spec in contract.items():
        frame = frames[granularity]
        required = {"year", spec["entity"], spec["cluster"], *spec["keys"]}
        missing = sorted(required - set(frame.columns))
        if missing:
            problems.append(f"{granularity}:missing={missing}")
            continue
        for column in {spec["entity"], spec["cluster"]}:
            identifiers = frame[column]
            invalid = identifiers.isna() | identifiers.astype(str).str.strip().eq("")
            if invalid.any():
                problems.append(f"{granularity}:{column}_blank={int(invalid.sum())}")
        year_values, year_invalid = _finite_numeric(frame["year"], allow_null=False)
        integral = np.isfinite(year_values) & (year_values == np.floor(year_values))
        if year_invalid or not integral.all():
            problems.append(f"{granularity}:year_invalid={int((~integral).sum())}")
        else:
            actual_years = {int(value) for value in year_values}
            if actual_years != set(years):
                problems.append(f"{granularity}:years={sorted(actual_years)}")
        if frame.duplicated(spec["keys"]).any():
            problems.append(f"{granularity}:duplicate_entity_year")
        mapping = frame.groupby(spec["entity"], dropna=False)[spec["cluster"]].nunique(dropna=False)
        if (mapping > 1).any():
            problems.append(f"{granularity}:entity_maps_multiple_clusters")
        counts = {
            "entities": int(frame[spec["entity"]].nunique()),
            "times": int(pd.Series(year_values[integral]).nunique()),
            "clusters": int(frame[spec["cluster"]].nunique()),
        }
        if counts["entities"] < 2 or counts["clusters"] < 2 or counts["times"] < 2:
            problems.append(f"{granularity}:inadequate_counts={counts}")
    return _check(
        "panel_keys_years_clusters",
        not problems,
        f"panels={len(frames)}; years={years}; violations={len(problems)}"
        + (f"; {'; '.join(problems)}" if problems else ""),
    )


def _runtime_default_sample_frames(frames: dict[str, pd.DataFrame]) -> tuple[dict[str, pd.DataFrame], dict[str, int]]:
    """Apply the course design's default sample filter before design-level QC."""
    filtered: dict[str, pd.DataFrame] = {}
    excluded: dict[str, int] = {}
    for granularity, frame in frames.items():
        sample, _notes = _apply_sample_filter(frame, DEFAULT_SAMPLE_FILTER)
        filtered[granularity] = sample
        excluded[granularity] = int(len(frame) - len(sample))
    return filtered, excluded


def _structural_slice_metrics(
    frame: pd.DataFrame,
    *,
    mask: np.ndarray,
    outcome_values: np.ndarray,
    entity: str,
    cluster: str,
    policy_regressors: int,
    baseline_values: np.ndarray | None = None,
) -> tuple[dict, bool]:
    columns = list(dict.fromkeys([entity, "year", cluster]))
    slice_frame = frame.loc[mask, columns].copy()
    outcome = outcome_values[mask]
    outcome_variance = float(np.var(outcome, ddof=1)) if len(outcome) >= 2 else float("nan")
    outcome_range = float(np.ptp(outcome)) if len(outcome) else float("nan")
    counts = {
        "rows": int(len(slice_frame)),
        "entities": int(slice_frame[entity].nunique()),
        "times": int(slice_frame["year"].nunique()),
        "clusters": int(slice_frame[cluster].nunique()),
    }
    residual_capacity = counts["rows"] - counts["entities"] - counts["times"] + 1 - policy_regressors
    duplicate = bool(slice_frame.duplicated([entity, "year"]).any())
    mapping = slice_frame.groupby(entity, dropna=False)[cluster].nunique(dropna=False)
    unstable = bool((mapping > 1).any())
    metrics = {
        "outcome_variance": outcome_variance,
        "outcome_range": outcome_range,
        "counts": counts,
        "duplicate": duplicate,
        "unstable_cluster": unstable,
        "policy_regressors_reserved": policy_regressors,
        "residual_capacity": residual_capacity,
    }
    valid = (
        np.isfinite(outcome_variance)
        and outcome_variance > 0
        and np.isfinite(outcome_range)
        and outcome_range > 0
        and counts["entities"] >= 2
        and counts["times"] >= 2
        and counts["clusters"] >= 2
        and not duplicate
        and not unstable
        and residual_capacity > 0
    )
    if baseline_values is not None:
        baseline_frame = pd.DataFrame({"entity": frame.loc[mask, entity].to_numpy(), "baseline": baseline_values[mask]})
        inconsistent = bool(baseline_frame.groupby("entity")["baseline"].nunique(dropna=False).gt(1).any())
        entity_baseline = baseline_frame.drop_duplicates("entity")["baseline"].to_numpy(dtype=float)
        all_entities_finite = bool(len(entity_baseline) == counts["entities"] and np.isfinite(entity_baseline).all())
        baseline_variance = float(np.var(entity_baseline, ddof=1)) if len(entity_baseline) >= 2 else float("nan")
        baseline_range = float(np.ptp(entity_baseline)) if len(entity_baseline) else float("nan")
        metrics.update(
            {
                "baseline_scope": "derived_entity_equal_centered",
                "baseline_entities": int(len(entity_baseline)),
                "baseline_all_entities_finite": all_entities_finite,
                "baseline_inconsistent_within_entity": inconsistent,
                "baseline_variance": baseline_variance,
                "baseline_range": baseline_range,
            }
        )
        valid = (
            valid
            and all_entities_finite
            and not inconsistent
            and np.isfinite(baseline_variance)
            and baseline_variance > 0
            and np.isfinite(baseline_range)
            and baseline_range > 0
        )
    return metrics, bool(valid)


def _within_interaction_metrics(
    frame: pd.DataFrame,
    values: np.ndarray,
    *,
    entity: str,
    time: str,
    method: str,
    shock: str,
    outcome: str,
    policy_columns: tuple[str, str],
) -> tuple[dict, bool]:
    """Validate a joint two-column interaction design exactly after runtime FE demeaning."""
    matrix = np.asarray(values, dtype=float)
    source_finite = bool(matrix.ndim == 2 and matrix.shape == (len(frame), 2) and np.isfinite(matrix).all())
    if frame.empty or not source_finite:
        return {
            "method": method,
            "shock": shock,
            "outcome": outcome,
            "policy_columns": list(policy_columns),
            "finite_matrix": False,
            "within_column_norms": {name: float("nan") for name in policy_columns},
            "nonzero_policy_columns": {name: False for name in policy_columns},
            "within_norm": float("nan"),
            "fully_absorbed": True,
            "joint_rank": 0,
            "required_rank": 2,
            "rank_tolerance": WITHIN_ABSORPTION_TOLERANCE,
            "full_column_rank": False,
        }, False

    within = regression_panel._twoway_demean(  # noqa: SLF001 - exact runtime FE policy
        matrix,
        frame[entity].to_numpy(),
        frame[time].to_numpy(),
    )
    finite_matrix = bool(np.isfinite(within).all())
    if finite_matrix:
        norms = np.linalg.norm(within, axis=0)
        nonzero = norms > WITHIN_ABSORPTION_TOLERANCE
        joint_rank = int(np.linalg.matrix_rank(within, tol=WITHIN_ABSORPTION_TOLERANCE))
    else:
        norms = np.full(2, np.nan)
        nonzero = np.zeros(2, dtype=bool)
        joint_rank = 0
    valid = bool(finite_matrix and nonzero.all() and joint_rank == 2)
    return {
        "method": method,
        "shock": shock,
        "outcome": outcome,
        "policy_columns": list(policy_columns),
        "finite_matrix": finite_matrix,
        "within_column_norms": dict(zip(policy_columns, (float(value) for value in norms), strict=True)),
        "nonzero_policy_columns": dict(zip(policy_columns, (bool(value) for value in nonzero), strict=True)),
        # Keep the prior interaction-specific diagnostics while adding the required joint-design gate.
        "within_norm": float(norms[1]),
        "fully_absorbed": not bool(nonzero[1]),
        "joint_rank": joint_rank,
        "required_rank": 2,
        "rank_tolerance": WITHIN_ABSORPTION_TOLERANCE,
        "full_column_rank": joint_rank == 2,
    }, valid


def _interaction_slice_metrics(
    frame: pd.DataFrame,
    *,
    outcome: str,
    shock: str,
    treated: str,
    entity: str,
    cluster: str,
) -> tuple[dict, bool]:
    required = list(dict.fromkeys([outcome, shock, treated, BASE_GVC_COLUMN, entity, "year", cluster]))
    missing = sorted(set(required) - set(frame.columns))
    if missing:
        return {"missing": missing}, False

    try:
        timing = regression_panel._freeze_treatment_timing(  # noqa: SLF001 - exact runtime timing policy
            frame,
            entity,
            "year",
            cluster,
            treated,
            shock,
        )
    except ValueError as exc:
        return {"timing_error": str(exc)}, False

    numeric: dict[str, np.ndarray] = {}
    invalid: dict[str, int] = {}
    for column in (outcome, shock, treated, BASE_GVC_COLUMN):
        numeric[column], invalid[column] = _finite_numeric(frame[column], allow_null=True)
    if any(invalid.values()):
        return {"invalid_source_values": invalid}, False

    try:
        frozen_baseline = _freeze_baseline_gvc(frame, entity, "year", timing.first_by_entity)
    except ValueError as exc:
        return {"baseline_error": str(exc)}, False

    # The raw moderator is a structural source, not an outcome-row complete-case field.
    mask = np.logical_and.reduce([np.isfinite(numeric[column]) for column in (outcome, shock, treated)])
    for identifier in dict.fromkeys([entity, "year", cluster]):
        mask &= frame[identifier].notna().to_numpy()
    complete = frame.loc[mask, required].copy()
    complete_entities = set(complete[entity].astype(str))
    complete_first = timing.first_by_entity.reindex(sorted(complete_entities)).dropna().astype(int)
    try:
        attached = _attach_baseline_gvc(
            complete,
            entity,
            "year",
            complete_first,
            frozen_baseline=frozen_baseline,
        )
    except ValueError as exc:
        return {
            "complete_case_rows_before_derived_baseline": int(len(complete)),
            "retained_treated_entities": int(len(complete_first)),
            "baseline_source_structural_null_rows": int(frame[BASE_GVC_COLUMN].isna().sum()),
            "baseline_error": str(exc),
        }, False
    retained_entities = set(attached[entity].astype(str))
    missing_entities = sorted(complete_entities - retained_entities)
    baseline_dropped_rows = int(complete[entity].astype(str).isin(missing_entities).sum())
    retained_first = timing.first_by_entity.reindex(sorted(retained_entities)).dropna().astype(int)

    attached_outcome = attached[outcome].to_numpy(dtype=float)
    baseline = attached[BASELINE_GVC_COL].to_numpy(dtype=float)
    structural, structural_valid = _structural_slice_metrics(
        attached,
        mask=np.ones(len(attached), dtype=bool),
        outcome_values=attached_outcome,
        entity=entity,
        cluster=cluster,
        policy_regressors=2,
        baseline_values=baseline,
    )
    first_year = attached[entity].astype(str).map(timing.first_by_entity)
    did = (first_year.notna() & (attached["year"].astype(int) >= first_year)).to_numpy(dtype=float)
    did_metrics, did_valid = _within_interaction_metrics(
        attached,
        np.column_stack((did, did * baseline)),
        entity=entity,
        time="year",
        method="did",
        shock=shock,
        outcome=outcome,
        policy_columns=("treated×post", "treated×post×centered_base"),
    )
    intensity = attached[shock].to_numpy(dtype=float)
    intensity_metrics, intensity_valid = _within_interaction_metrics(
        attached,
        np.column_stack((intensity, intensity * baseline)),
        entity=entity,
        time="year",
        method="intensity",
        shock=shock,
        outcome=outcome,
        policy_columns=("shock", "shock×centered_base"),
    )
    metrics = {
        "timing_policy": "full_filtered_shock_history_before_outcome_attrition",
        "baseline_policy": (
            "full_filtered_structural_history_before_outcome_control_attrition;"
            "treated_last_up_to_2_finite_strict_pre_G_i;never_earliest_up_to_2_finite;"
            "drop_entities_without_finite_derived_baseline;retained_entity_equal_center"
        ),
        "baseline_source_structural_null_rows": int(frame[BASE_GVC_COLUMN].isna().sum()),
        "baseline_entities_available": int(len(frozen_baseline)),
        "baseline_derived_missing_entities": missing_entities,
        "baseline_derived_dropped_entities": len(missing_entities),
        "baseline_derived_dropped_rows": baseline_dropped_rows,
        "complete_case_required": list(dict.fromkeys([outcome, shock, treated, entity, "year", cluster])),
        "complete_case_rows_before_derived_baseline": int(len(complete)),
        "complete_case_rows": int(len(attached)),
        "retained_treated_entities": int(len(retained_first)),
        "structural": structural,
        "did_centered_baseline_interaction": did_metrics,
        "intensity_centered_baseline_interaction": intensity_metrics,
    }
    return metrics, bool(structural_valid and did_valid and intensity_valid)


def _outcome_check(frames: dict[str, pd.DataFrame], *, excluded_rows: dict[str, int] | None = None) -> dict:
    """Mirror non-ROW baseline and exact interaction structural runtime boundaries."""
    problems: list[str] = []
    checked: list[str] = []
    certified_interaction_slices: list[str] = []
    optional_interaction_slices: list[str] = []
    optional_available: list[str] = []
    optional_unavailable: list[str] = []
    certified_baseline_attrition: list[str] = []
    interaction_joint_designs: list[str] = []
    structural_baseline_nulls: list[str] = []
    excluded_rows = excluded_rows or {granularity: 0 for granularity in frames}
    for granularity, spec in _panel_contract_metadata().items():
        frame = frames[granularity]
        entity, cluster = spec["entity"], spec["cluster"]
        for column in spec["outcomes"]:
            label = f"{granularity}:{column}"
            required = {column, BASE_GVC_COLUMN, entity, "year", cluster}
            missing = sorted(required - set(frame.columns))
            if missing:
                problems.append(f"{label}:missing={missing}")
                continue
            outcome_values, outcome_invalid = _finite_numeric(frame[column], allow_null=True)
            _baseline_values, baseline_invalid = _finite_numeric(frame[BASE_GVC_COLUMN], allow_null=True)
            outcome_finite = np.isfinite(outcome_values)

            baseline_metrics, baseline_valid = _structural_slice_metrics(
                frame,
                mask=outcome_finite,
                outcome_values=outcome_values,
                entity=entity,
                cluster=cluster,
                policy_regressors=1,
            )
            if outcome_invalid or not baseline_valid:
                problems.append(f"{label}:baseline:outcome_invalid={outcome_invalid},metrics={baseline_metrics}")
            if baseline_invalid:
                problems.append(f"{label}:baseline_source_invalid={baseline_invalid}")

            structural_nulls = int(frame[BASE_GVC_COLUMN].isna().sum())
            structural_baseline_nulls.append(f"{label}={structural_nulls}")
            for shock_type, (shock, treated) in SHOCK_SPECS.items():
                pair_label = f"{label}:{shock_type}"
                interaction_metrics, interaction_valid = _interaction_slice_metrics(
                    frame,
                    outcome=column,
                    shock=shock,
                    treated=treated,
                    entity=entity,
                    cluster=cluster,
                )
                certified = shock_type == SHOCK_TARIFF
                if certified:
                    certified_interaction_slices.append(pair_label)
                    certified_baseline_attrition.append(
                        f"{pair_label}:dropped_entities="
                        f"{interaction_metrics.get('baseline_derived_dropped_entities', 'unavailable')}:"
                        f"dropped_rows={interaction_metrics.get('baseline_derived_dropped_rows', 'unavailable')}"
                    )
                    if outcome_invalid or baseline_invalid or not interaction_valid:
                        problems.append(
                            f"{pair_label}:interaction:outcome_invalid={outcome_invalid},"
                            f"baseline_invalid={baseline_invalid},baseline_structural_null_rows={structural_nulls},"
                            f"metrics={interaction_metrics}"
                        )
                else:
                    optional_interaction_slices.append(pair_label)
                    (optional_available if interaction_valid else optional_unavailable).append(pair_label)
                for method, metric_key in (
                    ("did", "did_centered_baseline_interaction"),
                    ("intensity", "intensity_centered_baseline_interaction"),
                ):
                    method_metrics = interaction_metrics.get(metric_key, {})
                    interaction_joint_designs.append(
                        f"{pair_label}:scope={'certified' if certified else 'optional_runtime'}:"
                        f"method={method}:shock={shock}:outcome={column}:"
                        f"joint_rank={method_metrics.get('joint_rank', 'unavailable')}/2"
                    )
            checked.append(label)
    excluded_detail = ",".join(f"{key}={excluded_rows.get(key, 0)}" for key in sorted(frames))
    return _check(
        "configured_outcomes",
        not problems,
        f"outcome_fields={len(checked)}; baseline_slices={len(checked)}; "
        f"certified_scope=baseline_no_control+canonical_tariff_no_control_interactions_did_intensity; "
        f"certified_interaction_slices={len(certified_interaction_slices)}; "
        f"optional_runtime_interaction_slices={len(optional_interaction_slices)}; "
        f"optional_runtime_available={len(optional_available)}; "
        f"optional_runtime_unavailable={len(optional_unavailable)}; "
        f"optional_runtime_unavailable_details=[{','.join(optional_unavailable)}]; "
        f"sample_filter=exclude_country_ROW; sample_excluded_rows=[{excluded_detail}]; "
        f"baseline=no_controls_complete_on_outcome; "
        f"interaction=canonical_tariff_runtime_timing_and_baseline_freeze_before_complete_case; "
        f"interaction_baseline_missing_entities_dropped_before_centering=true; "
        f"certified_interaction_baseline_attrition=[{','.join(certified_baseline_attrition)}]; "
        f"interaction_baseline_structural_null_rows=[{','.join(structural_baseline_nulls)}]; "
        f"interaction_joint_designs=[{','.join(interaction_joint_designs)}]; "
        f"optional_design_unavailability_release_fatal=false; "
        f"structural_only_not_causal_or_power=true; every_cross_product_certified=false; violations={len(problems)}"
        + (f"; {'; '.join(problems)}" if problems else ""),
    )


def _columns_match(left: pd.Series, right: pd.Series) -> bool:
    left_values = pd.to_numeric(left, errors="coerce").to_numpy(dtype=float)
    right_values = pd.to_numeric(right, errors="coerce").to_numpy(dtype=float)
    return bool(
        len(left_values) == len(right_values)
        and np.isfinite(left_values).all()
        and np.isfinite(right_values).all()
        and np.isclose(left_values, right_values, rtol=1e-12, atol=1e-12).all()
    )


def _shock_control_check(
    root: Path,
    frames: dict[str, pd.DataFrame],
    *,
    sampled_frames: dict[str, pd.DataFrame] | None = None,
) -> dict:
    contract = regression_input_qc_contract_metadata()["fields"]
    required_numeric_fields = [*contract["shock_and_treatment"], *contract["controls"]]
    interaction_baseline = contract["interaction_baseline"]
    numeric_fields = [*required_numeric_fields, interaction_baseline]
    treatment_fields = {treated for _shock, treated in SHOCK_SPECS.values()} | {"treated_contemporaneous"}
    problems: list[str] = []
    baseline_structural_nulls: list[str] = []
    for granularity, frame in frames.items():
        missing = sorted(set(numeric_fields) - set(frame.columns))
        if missing:
            problems.append(f"{granularity}:missing={missing}")
            continue
        for column in required_numeric_fields:
            values, invalid = _finite_numeric(frame[column], allow_null=False)
            if invalid:
                problems.append(f"{granularity}:{column}_invalid={invalid}")
            if column in treatment_fields and not np.isin(values, [0.0, 1.0]).all():
                problems.append(f"{granularity}:{column}_not_binary")
        _baseline_values, baseline_invalid = _finite_numeric(frame[interaction_baseline], allow_null=True)
        attrition_frame = (sampled_frames or frames)[granularity]
        baseline_nulls = int(attrition_frame[interaction_baseline].isna().sum())
        baseline_structural_nulls.append(f"{granularity}={baseline_nulls}")
        if baseline_invalid:
            problems.append(f"{granularity}:{interaction_baseline}_invalid={baseline_invalid}")

    control_fields = contract["controls"]
    controls = _read_csv(root, "controls_country.csv")
    if not {"country", "year", *control_fields}.issubset(controls.columns):
        problems.append("controls_country:configured_fields_missing")
    elif controls.duplicated(["country", "year"]).any():
        problems.append("controls_country:duplicate_keys")
    else:
        for granularity, frame in frames.items():
            if not {"country", "year", *control_fields}.issubset(frame.columns):
                continue
            compared = frame[["country", "year", *control_fields]].merge(
                controls[["country", "year", *control_fields]],
                on=["country", "year"],
                how="left",
                validate="many_to_one",
                suffixes=("_panel", "_source"),
                indicator=True,
            )
            if compared["_merge"].ne("both").any():
                problems.append(f"{granularity}:control_keys_do_not_match_source")
                continue
            for column in control_fields:
                if not _columns_match(compared[f"{column}_panel"], compared[f"{column}_source"]):
                    problems.append(f"{granularity}:{column}_does_not_match_controls_country")

    shock_fields = contract["shock_and_treatment"]
    shock = _read_csv(root, "demo_trade_war_tariffs.csv").rename(columns={"sector": "industry"})
    industry = frames["country_industry"]
    shock_required = {"country", "industry", "year", *shock_fields}
    if not shock_required.issubset(shock.columns):
        problems.append("shock_artifact:configured_fields_missing")
    elif shock.duplicated(["country", "industry", "year"]).any():
        problems.append("shock_artifact:duplicate_keys")
    elif {"country", "industry", "year", *shock_fields}.issubset(industry.columns):
        compared = industry[["country", "industry", "year", *shock_fields]].merge(
            shock[["country", "industry", "year", *shock_fields]],
            on=["country", "industry", "year"],
            how="left",
            validate="one_to_one",
            suffixes=("_panel", "_source"),
            indicator=True,
        )
        if compared["_merge"].ne("both").any() or len(compared) != len(shock):
            problems.append("country_industry:shock_keys_do_not_match_source")
        else:
            for column in shock_fields:
                if not _columns_match(compared[f"{column}_panel"], compared[f"{column}_source"]):
                    problems.append(f"country_industry:{column}_does_not_match_shock_artifact")

    country = frames["country"]
    aggregation_required = {
        "country",
        "industry",
        "year",
        "gross_exports",
        *shock_fields,
    }
    if aggregation_required.issubset(industry.columns) and {"country", "year", *shock_fields}.issubset(country.columns):
        treatment_columns = [treated for _shock, treated in SHOCK_SPECS.values()]
        any_treated = industry[treatment_columns].max(axis=1) > 0
        treated_years = pd.to_numeric(industry.loc[any_treated, "year"], errors="coerce")
        first_treated = int(treated_years.min()) if not treated_years.empty else None
        available_years = sorted(int(year) for year in pd.to_numeric(industry["year"]).unique())
        pre_years = [year for year in available_years if first_treated is None or year < first_treated]
        if pre_years:
            weight_year = max(pre_years)
            weights = industry.loc[
                pd.to_numeric(industry["year"]).eq(weight_year),
                ["country", "industry", "gross_exports"],
            ].rename(columns={"gross_exports": "__weight"})
            weighted = industry.merge(weights, on=["country", "industry"], how="left")
            weighted["__weight"] = pd.to_numeric(weighted["__weight"], errors="coerce").clip(lower=0).fillna(0)
            expected = weighted.groupby(["country", "year"], as_index=False)["__weight"].sum()
            for shock_column, treated_column in SHOCK_SPECS.values():
                weighted_value = weighted["__weight"] * pd.to_numeric(weighted[shock_column], errors="coerce")
                numerator = (
                    weighted.assign(__numerator=weighted_value)
                    .groupby(["country", "year"], as_index=False)["__numerator"]
                    .sum()
                )
                expected = expected.merge(numerator, on=["country", "year"], how="left")
                expected[shock_column] = (expected["__numerator"] / expected["__weight"]).where(
                    expected["__weight"] > 0, 0.0
                )
                expected[treated_column] = (expected[shock_column] > TREATED_THRESHOLD).astype(int)
                expected = expected.drop(columns="__numerator")
            current_weight = pd.to_numeric(weighted["gross_exports"], errors="coerce").clip(lower=0)
            current_value = current_weight * pd.to_numeric(weighted["tariff_shock_contemporaneous"], errors="coerce")
            current = (
                weighted.assign(__current_weight=current_weight, __current_value=current_value)
                .groupby(["country", "year"], as_index=False)[["__current_weight", "__current_value"]]
                .sum()
            )
            expected = expected.merge(current, on=["country", "year"], how="left")
            expected["tariff_shock_contemporaneous"] = (
                expected["__current_value"] / expected["__current_weight"]
            ).where(expected["__current_weight"] > 0, 0.0)
            expected["treated_contemporaneous"] = (expected["tariff_shock_contemporaneous"] > TREATED_THRESHOLD).astype(
                int
            )
            compared_country = country[["country", "year", *shock_fields]].merge(
                expected[["country", "year", *shock_fields]],
                on=["country", "year"],
                how="left",
                validate="one_to_one",
                suffixes=("_panel", "_expected"),
                indicator=True,
            )
            if compared_country["_merge"].ne("both").any() or len(compared_country) != len(expected):
                problems.append("country:shock_keys_do_not_match_industry_aggregation")
            else:
                for column in shock_fields:
                    if not _columns_match(compared_country[f"{column}_panel"], compared_country[f"{column}_expected"]):
                        problems.append(f"country:{column}_does_not_match_industry_aggregation")

    return _check(
        "shock_control_fields",
        not problems,
        f"fields_per_panel={len(numeric_fields)}; "
        f"interaction_baseline_structural_null_rows=[{','.join(baseline_structural_nulls)}]; "
        f"baseline_source_scope=runtime_default_exclude_country_ROW_before_outcome_control_attrition; "
        f"nonnull_interaction_baseline_must_be_finite_numeric=true; violations={len(problems)}"
        + (f"; {'; '.join(problems)}" if problems else ""),
    )


def _timeline_check(frames: dict[str, pd.DataFrame]) -> dict:
    problems: list[str] = []
    timelines = 0
    contract = _panel_contract_metadata()
    for granularity, frame in frames.items():
        entity = contract[granularity]["entity"]
        if not {entity, "year", *[treated for _shock, treated in SHOCK_SPECS.values()]}.issubset(frame.columns):
            continue
        years = pd.to_numeric(frame["year"], errors="coerce")
        timeline_fields = [
            *[(shock_type, treated_column) for shock_type, (_shock, treated_column) in SHOCK_SPECS.items()],
            ("tariff_contemporaneous", "treated_contemporaneous"),
        ]
        for shock_type, treated_column in timeline_fields:
            treated = pd.to_numeric(frame[treated_column], errors="coerce").eq(1)
            if not treated.any():
                continue
            timelines += 1
            first = frame.loc[treated].assign(__year=years[treated]).groupby(entity)["__year"].min()
            entity_years = frame.assign(__year=years).groupby(entity)["__year"].agg(list)
            missing_pre = [
                str(item)
                for item, first_year in first.items()
                if not any(year < first_year for year in entity_years.get(item, []))
            ]
            if missing_pre:
                problems.append(f"{granularity}:{shock_type}:treated_without_preperiod={len(missing_pre)}")
    return _check(
        "treatment_timeline_preperiod",
        not problems,
        f"observed_timelines={timelines}; violations={len(problems)}"
        + (f"; {'; '.join(problems)}" if problems else ""),
    )


def _fixed_pretreatment_check(root: Path, frames: dict[str, pd.DataFrame], years: list[int]) -> dict:
    problems: list[str] = []
    shock_frame = _read_csv(root, "demo_trade_war_tariffs.csv")
    if "tariff_exposure_mode" not in shock_frame:
        problems.append("shock_artifact:missing_tariff_exposure_mode")
    else:
        modes = set(shock_frame["tariff_exposure_mode"].fillna("").astype(str))
        if modes != {EXPOSURE_MODE_FIXED_PRETREATMENT}:
            problems.append(f"shock_artifact:exposure_modes={sorted(modes)}")

    first_years: list[int] = []
    treatment_columns = [treated for _shock, treated in SHOCK_SPECS.values()]
    for granularity, frame in frames.items():
        if "year" not in frame.columns:
            continue
        for treated_column in treatment_columns:
            if treated_column not in frame.columns:
                continue
            treated = pd.to_numeric(frame[treated_column], errors="coerce").eq(1)
            if treated.any():
                first_years.append(int(pd.to_numeric(frame.loc[treated, "year"], errors="coerce").min()))
        if "tariff_exposure_mode" in frame.columns:
            panel_modes = set(frame["tariff_exposure_mode"].fillna("").astype(str))
            if panel_modes != {EXPOSURE_MODE_FIXED_PRETREATMENT}:
                problems.append(f"{granularity}:exposure_modes={sorted(panel_modes)}")
    if first_years:
        first = min(first_years)
        if not any(year < first for year in years):
            problems.append(f"no_release_year_before_first_treatment={first}")
    detail_first = min(first_years) if first_years else "none"
    return _check(
        "fixed_pretreatment_availability",
        not problems,
        f"first_treatment={detail_first}; release_years={years}; violations={len(problems)}"
        + (f"; {'; '.join(problems)}" if problems else ""),
    )


def recompute_regression_input_checks(root: Path, *, expected_years: list[int]) -> list[dict]:
    """Recompute all regression-input QC v1 checks from persisted release files."""
    years = sorted(expected_years)
    if not years or any(type(year) is not int for year in years):
        raise ValueError("regression input QC expected_years must be a nonempty integer array")
    contract = _panel_contract_metadata()
    frames = {granularity: _read_csv(root, spec["file"]) for granularity, spec in contract.items()}
    sampled_frames, excluded_rows = _runtime_default_sample_frames(frames)
    checks = [
        # Persisted schema/key integrity remains a full-artifact claim. Every design-level
        # estimability claim below consumes the exact runtime-default filtered sample.
        _panel_key_check(frames, years),
        _outcome_check(sampled_frames, excluded_rows=excluded_rows),
        _shock_control_check(root, frames, sampled_frames=sampled_frames),
        _timeline_check(sampled_frames),
        _fixed_pretreatment_check(root, sampled_frames, years),
    ]
    validate_serialized_regression_input_checks(checks, contract_version=REGRESSION_INPUT_QC_CONTRACT_VERSION)
    return checks


def write_regression_input_qc(root: Path, *, expected_years: list[int]) -> tuple[list[dict], dict]:
    checks = recompute_regression_input_checks(root, expected_years=expected_years)
    summary = summarize_regression_input_checks(checks)
    (root / REGRESSION_INPUT_QC_FILE).write_text(
        json.dumps(checks, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    if not summary["publishable"]:
        raise RegressionInputQualityError(f"regression input semantic QC failed: {summary['fatal']}")
    return checks, summary


def read_regression_input_qc(path: Path, *, contract: object) -> list[dict]:
    validate_regression_input_qc_contract_metadata(contract)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid regression input QC artifact {path}: {exc}") from exc
    assert isinstance(contract, dict)
    return validate_serialized_regression_input_checks(payload, contract_version=contract["version"])
