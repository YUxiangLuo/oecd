"""Versioned semantic QC for published indicator, network, and panel outputs.

This contract is intentionally separate from :mod:`gvcsim.data.quality`. The
checks below separate runtime artifact integrity from reproducible identities and
domains; they do not certify independent causal or economic validity.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from numbers import Real
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from gvcsim.indicators.network import NETWORK_COLUMNS
from gvcsim.indicators.core import IcioArrays
from gvcsim.indicators.production import PRODUCTION_COLUMNS
from gvcsim.indicators.tradeflow import TRADE_COLUMNS

OUTPUT_QC_CONTRACT_VERSION = 6
OUTPUT_QC_ABS_TOLERANCE = 1e-8
OUTPUT_QC_REL_TOLERANCE = 1e-8
OUTPUT_QC_DENOMINATOR_FLOOR = 1e-12
OUTPUT_QC_SEVERITIES = ("ok", "warning", "fatal")
OUTPUT_QC_SELF_LOOP_POLICY = "forbidden: country network edge artifacts exclude domestic flows"

TRADE_CLOSURE_COLUMNS = ("DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub")
ADDITIVE_COLUMNS = tuple(TRADE_COLUMNS) + tuple(PRODUCTION_COLUMNS)
LENGTH_DENOMINATORS = {
    "PLv": "SVA",
    "PLv_D": "1_VA_D",
    "PLv_RT": "2_VA_RT",
    "PLv_GVC": "3_VA_GVC",
    "PLy": "FGY",
    "PLy_D": "1_FGY_D",
    "PLy_RT": "2_FGY_RT",
    "PLy_GVC": "3_FGY_GVC",
}
LENGTH_COLUMNS = (*LENGTH_DENOMINATORS, "Pos_TPL", "GVCPs")
PANEL_SHARE_DENOMINATORS = {
    "FVA_share": "gross_exports",
    "3b_VA_GVC_C_share": "SVA",
    "3_VA_GVC_share": "SVA",
}
PANEL_SHARE_NUMERATORS = {
    "FVA_share": "FVA",
    "3b_VA_GVC_C_share": "3b_VA_GVC_C",
    "3_VA_GVC_share": "3_VA_GVC",
}


@dataclass(frozen=True)
class OutputCheckSpec:
    name: str
    kind: str
    description: str


OUTPUT_CHECK_SPECS = (
    OutputCheckSpec(
        "row_keys_and_coverage",
        "structure",
        "Unique year/country/industry/entity keys and exact yearly coverage across indicator, exposure, and panel files.",
    ),
    OutputCheckSpec(
        "required_numeric_fields",
        "integrity",
        "Every numeric field required by indicator and visualization routes exists; nonnull values are true finite numbers, with nulls allowed only for structurally undefined length fields.",
    ),
    OutputCheckSpec(
        "trade_identities",
        "mathematical",
        "Finite signed trade terms; six closure amounts equal gross_exports where persisted; EXDVA=DVAex+DVArt.",
    ),
    OutputCheckSpec(
        "production_identities",
        "mathematical",
        "Finite forward and backward amounts; components 1+2+3 equal totals and 3a+3b equal component 3.",
    ),
    OutputCheckSpec(
        "length_domains_and_identities",
        "mathematical",
        "Lengths are finite exactly on structural denominator support; position ratios and observable segment weighting close.",
    ),
    OutputCheckSpec(
        "country_industry_additivity",
        "mathematical",
        "Country additive trade/production amounts equal grouped country-industry amounts; ratios and shares are not summed.",
    ),
    OutputCheckSpec(
        "network_edges",
        "structure",
        "Country edges use known endpoints, finite positive flow, unique directed keys, and the no-self-loop policy.",
    ),
    OutputCheckSpec(
        "network_indicators",
        "mathematical",
        "Network metrics are finite/in-domain; degree and weighted-degree component identities hold.",
    ),
    OutputCheckSpec(
        "panel_shares",
        "mathematical",
        "Panel share fields are null outside positive denominators and otherwise finite and equal to numerator/denominator, including signed values.",
    ),
    OutputCheckSpec(
        "panel_share_economic_domains",
        "economic",
        "Shares outside [0,1] require economic disclosure (signed VA/TLS or source rounding), independently of the mathematical ratio identity.",
    ),
    OutputCheckSpec(
        "teaching_panel_contract",
        "mathematical",
        "Teaching panel has unique country-industry-year keys, five continuous years, finite teaching fields, bounded outcomes, X=w*tariff with two zero pre-policy years, scheduled lags, tariff waves determined by country goods surplus, country-year exchange noise in its uniform support with first-wave depreciation, and rowwise outcome-family identities.",
    ),
)
OUTPUT_QC_EXPECTED_CHECKS = tuple(spec.name for spec in OUTPUT_CHECK_SPECS)


class OutputQualityError(RuntimeError):
    """An output semantic QC artifact or recomputation is invalid."""


def validate_gvc_structure(arr: IcioArrays, industry: pd.DataFrame, country: pd.DataFrame) -> None:
    """Build-time gate using source paths, independent of computed denominators.

    No foreign edge reachable through domestic production implies exact zero
    GVC activity. The converse is not required (signed flows can cancel, and VA
    or final demand can vanish). This source-dependent gate complements, rather
    than changes, the persisted-only output QC contract.
    """
    homes = arr.index.get_level_values(0)
    for forward, prefix, length_name in ((True, "VA", "PLv_GVC"), (False, "FGY", "PLy_GVC")):
        supported = np.zeros(len(arr.x), dtype=bool)
        for region in arr.regions:
            p = arr.pos[region]
            foreign = np.flatnonzero(homes != region)
            domestic = arr.A[np.ix_(p, p)] != 0
            if forward:
                reachable = (arr.A[np.ix_(p, foreign)] != 0).any(axis=1)
            else:
                reachable = (arr.A[np.ix_(foreign, p)] != 0).any(axis=0)
                domestic = domestic.T
            while True:
                expanded = reachable | (domestic @ reachable)
                if np.array_equal(expanded, reachable):
                    break
                reachable = expanded
            supported[p] = reachable
        support = pd.Series(supported, index=arr.index)
        amounts = [f"3_{prefix}_GVC", f"3a_{prefix}_GVC_S", f"3b_{prefix}_GVC_C"]
        for label, frame, mask in (
            ("industry", industry, support),
            ("country", country, support.groupby(level=0).any()),
        ):
            inactive = frame.loc[~mask.reindex(frame.index)]
            invalid = inactive[amounts].ne(0).any(axis=1) | inactive[[length_name, "GVCPs"]].notna().any(axis=1)
            if invalid.any():
                raise OutputQualityError(f"GVC structural zero violated: {label} {prefix}, {int(invalid.sum())} rows")


def output_qc_contract_metadata() -> dict:
    """Return the exact supported output diagnostic contract and publication policy."""
    return {
        "version": OUTPUT_QC_CONTRACT_VERSION,
        "checks": [
            {
                "name": spec.name,
                "kind": spec.kind,
                "failure_severity": "warning" if spec.kind == "economic" else "fatal",
                "publication_blocking": spec.kind in {"structure", "integrity", "mathematical"},
                "description": spec.description,
            }
            for spec in OUTPUT_CHECK_SPECS
        ],
        "tolerances": {
            "absolute": OUTPUT_QC_ABS_TOLERANCE,
            "relative": OUTPUT_QC_REL_TOLERANCE,
            "denominator_floor": OUTPUT_QC_DENOMINATOR_FLOOR,
            "comparison": "abs(lhs-rhs) <= absolute + relative * max(abs(lhs), abs(rhs), 1)",
        },
        "network_self_loops": OUTPUT_QC_SELF_LOOP_POLICY,
        "certification_limit": (
            "Certifies persisted file semantics and reproducible identities only; "
            "does not certify independent causal validity."
        ),
    }


def validate_output_qc_contract_metadata(value: object) -> None:
    if not isinstance(value, dict) or value != output_qc_contract_metadata():
        raise ValueError(
            f"unsupported or incomplete output QC contract; version {OUTPUT_QC_CONTRACT_VERSION} is required"
        )


def _close(lhs: pd.Series | np.ndarray, rhs: pd.Series | np.ndarray) -> np.ndarray:
    left = np.asarray(lhs, dtype=float)
    right = np.asarray(rhs, dtype=float)
    scale = np.maximum(np.maximum(np.abs(left), np.abs(right)), 1.0)
    return (
        np.isfinite(left)
        & np.isfinite(right)
        & (np.abs(left - right) <= OUTPUT_QC_ABS_TOLERANCE + OUTPUT_QC_REL_TOLERANCE * scale)
    )


def _check(spec_name: str, passed: bool, detail: str) -> dict:
    spec = next(item for item in OUTPUT_CHECK_SPECS if item.name == spec_name)
    return {
        "name": spec.name,
        "kind": spec.kind,
        "passed": bool(passed),
        "detail": detail,
        "severity": "ok" if passed else "warning" if spec.kind == "economic" else "fatal",
    }


def validate_serialized_output_checks(checks: object, *, contract_version: int) -> list[dict]:
    """Validate exact, nonempty output check names, fields, types, and severities."""
    if type(contract_version) is not int or contract_version != OUTPUT_QC_CONTRACT_VERSION:
        raise ValueError(f"unsupported output QC contract version: {contract_version}")
    if not isinstance(checks, list) or not checks:
        raise ValueError("output QC checks must be a nonempty array")
    specs = {spec.name: spec for spec in OUTPUT_CHECK_SPECS}
    names: list[str] = []
    for index, raw in enumerate(checks):
        if not isinstance(raw, dict) or set(raw) != {"name", "kind", "passed", "detail", "severity"}:
            raise ValueError(f"output QC check {index + 1} has malformed fields")
        if (
            type(raw["name"]) is not str
            or type(raw["kind"]) is not str
            or type(raw["passed"]) is not bool
            or type(raw["detail"]) is not str
            or not raw["detail"]
            or type(raw["severity"]) is not str
        ):
            raise ValueError(f"output QC check {index + 1} has invalid field types")
        name = raw["name"]
        spec = specs.get(name)
        if spec is not None and raw["kind"] != spec.kind:
            raise ValueError(f"output QC check {name} has invalid kind")
        expected_severity = "ok" if raw["passed"] else "warning" if spec and spec.kind == "economic" else "fatal"
        if raw["severity"] not in OUTPUT_QC_SEVERITIES or raw["severity"] != expected_severity:
            raise ValueError(f"output QC check {name} has malformed severity")
        names.append(name)
    if len(names) != len(set(names)):
        raise ValueError("output QC checks contain duplicates")
    missing = sorted(set(OUTPUT_QC_EXPECTED_CHECKS) - set(names))
    unknown = sorted(set(names) - set(OUTPUT_QC_EXPECTED_CHECKS))
    if missing or unknown or len(names) != len(OUTPUT_QC_EXPECTED_CHECKS):
        raise ValueError(f"output QC check set mismatch; missing={missing}, unknown={unknown}")
    return checks


def summarize_output_checks(checks: list[dict]) -> dict:
    validate_serialized_output_checks(checks, contract_version=OUTPUT_QC_CONTRACT_VERSION)
    fatal = [item["name"] for item in checks if item["severity"] == "fatal"]
    warnings = [item["name"] for item in checks if item["severity"] == "warning"]
    passed = [item["name"] for item in checks if item["passed"]]
    return {"publishable": not fatal, "fatal": fatal, "warnings": warnings, "passed": passed}


def validate_output_summary(value: object, checks: list[dict]) -> None:
    if not isinstance(value, dict) or set(value) != {"publishable", "fatal", "warnings", "passed"}:
        raise ValueError("output QC summary has malformed fields")
    if type(value.get("publishable")) is not bool:
        raise ValueError("output QC summary publishable must be boolean")
    if any(not isinstance(value.get(key), list) for key in ("fatal", "warnings", "passed")):
        raise ValueError("output QC summary lists are malformed")
    if any(type(item) is not str for key in ("fatal", "warnings", "passed") for item in value[key]):
        raise ValueError("output QC summary names are malformed")
    if value != summarize_output_checks(checks):
        raise ValueError("output QC summary does not match its check file")


def _read_csv(root: Path, filename: str) -> pd.DataFrame:
    path = root / filename
    try:
        return pd.read_csv(path)
    except (OSError, UnicodeError, pd.errors.ParserError, pd.errors.EmptyDataError) as exc:
        raise OutputQualityError(f"cannot recompute output QC from {filename}: {exc}") from exc


def _missing(frame: pd.DataFrame, columns: set[str]) -> list[str]:
    return sorted(columns - set(frame.columns))


def _year_mask(frame: pd.DataFrame, year: int) -> pd.Series:
    numeric = pd.to_numeric(frame["year"], errors="coerce")
    return numeric.eq(year)


def _validate_panel_years(
    frame: pd.DataFrame,
    label: str,
    expected_years: list[int],
) -> tuple[pd.Series | None, list[str]]:
    """Validate panel years without dropping malformed values or truncating fractions."""
    if "year" not in frame:
        return None, []

    numeric = pd.to_numeric(frame["year"], errors="coerce")
    values = numeric.to_numpy(dtype=float)
    finite = np.isfinite(values)
    integral = finite & (values == np.floor(values))
    declared = np.asarray(expected_years, dtype=float)
    in_release = integral & np.isin(values, declared)

    problems: list[str] = []
    nonnumeric = int(numeric.isna().sum())
    nonfinite = int((numeric.notna().to_numpy() & ~finite).sum())
    fractional = int((finite & ~integral).sum())
    outside_release = int((integral & ~in_release).sum())
    if nonnumeric:
        problems.append(f"{label}:year_non_numeric_or_null={nonnumeric}")
    if nonfinite:
        problems.append(f"{label}:year_nonfinite={nonfinite}")
    if fractional:
        problems.append(f"{label}:year_fractional={fractional}")
    if outside_release:
        problems.append(f"{label}:year_outside_release={outside_release}")
    if problems:
        return None, problems

    actual_years = set(numeric.tolist())
    expected = set(expected_years)
    if actual_years != expected:
        problems.append(f"{label}:years={sorted(actual_years)}; missing_years={sorted(expected - actual_years)}")
    memberships = np.zeros(len(frame), dtype=int)
    for declared_year in expected_years:
        memberships += numeric.eq(declared_year).to_numpy(dtype=int)
    if not np.equal(memberships, 1).all():
        problems.append(f"{label}:rows_without_exactly_one_year_slice={int(np.not_equal(memberships, 1).sum())}")
    return numeric, problems


def _keys_and_coverage(
    frames: dict[str, pd.DataFrame],
    year: int,
    panel_year_problems: list[str],
) -> dict:
    required = {
        "country": {"country", "year"},
        "industry": {"country", "industry", "year"},
        "edges": {"source", "target", "year", "flow"},
        "exposure": {"country", "sector", "imposer", "year"},
        "panel_country": {"country", "year"},
        "panel_industry": {"country", "industry", "entity_id", "year"},
        "panel_teaching": {"country", "industry", "entity_id", "year"},
    }
    problems = list(panel_year_problems)
    missing_problems: list[str] = []
    for label, columns in required.items():
        absent = _missing(frames[label], columns)
        if absent:
            missing_problems.append(f"{label}:missing={absent}")
    if missing_problems:
        return _check("row_keys_and_coverage", False, "; ".join([*problems, *missing_problems]))

    country = frames["country"]
    industry = frames["industry"]
    edges = frames["edges"]
    exposure = frames["exposure"]
    panel_country = frames["panel_country"]
    panel_industry = frames["panel_industry"]
    panel_teaching = frames["panel_teaching"]
    for label, frame in (
        ("country", country),
        ("industry", industry),
        ("exposure", exposure),
    ):
        if frame.empty:
            problems.append(f"{label}:empty")
    if panel_country.loc[_year_mask(panel_country, year)].empty:
        problems.append("panel_country:empty_year")
    if panel_industry.loc[_year_mask(panel_industry, year)].empty:
        problems.append("panel_industry:empty_year")
    if panel_teaching.loc[_year_mask(panel_teaching, year)].empty:
        problems.append("panel_teaching:empty_year")

    key_specs = (
        ("country", country, ["country", "year"]),
        ("industry", industry, ["country", "industry", "year"]),
        ("edges", edges, ["source", "target", "year"]),
        ("exposure", exposure, ["country", "sector", "imposer", "year"]),
        ("panel_country", panel_country, ["country", "year"]),
        ("panel_industry", panel_industry, ["country", "industry", "year"]),
        ("panel_industry_entity", panel_industry, ["entity_id", "year"]),
        ("panel_teaching", panel_teaching, ["country", "industry", "year"]),
        ("panel_teaching_entity", panel_teaching, ["entity_id", "year"]),
    )
    for label, frame, keys in key_specs:
        if frame[keys].isna().any(axis=None) or frame.duplicated(keys).any():
            problems.append(f"{label}:null_or_duplicate_keys")

    yearly_files = (country, industry, edges, exposure)
    if any(not _year_mask(frame, year).all() for frame in yearly_files):
        problems.append("yearly_file_year_mismatch")
    country_keys = set(country["country"].astype(str))
    industry_countries = set(industry["country"].astype(str))
    exposure_countries = set(exposure["country"].astype(str))
    panel_country_keys = set(panel_country.loc[_year_mask(panel_country, year), "country"].astype(str))
    panel_industry_keys = set(
        map(
            tuple,
            panel_industry.loc[_year_mask(panel_industry, year), ["country", "industry"]].astype(str).to_numpy(),
        )
    )
    industry_keys = set(map(tuple, industry[["country", "industry"]].astype(str).to_numpy()))
    exposure_industry_keys = set(map(tuple, exposure[["country", "sector"]].astype(str).to_numpy()))
    if not (country_keys == industry_countries == exposure_countries == panel_country_keys):
        problems.append("country_coverage_mismatch")
    if industry_keys != panel_industry_keys or exposure_industry_keys != industry_keys:
        problems.append("industry_coverage_mismatch")
    expected_entities = panel_industry["country"].astype(str) + "_" + panel_industry["industry"].astype(str)
    if not panel_industry["entity_id"].astype(str).eq(expected_entities).all():
        problems.append("entity_id_mismatch")

    rows = sum(len(frame) for frame in frames.values())
    return _check(
        "row_keys_and_coverage",
        not problems,
        f"year={year}; rows={rows}; violations={len(problems)}" + (f"; {'; '.join(problems)}" if problems else ""),
    )


def _invalid_numeric_source(series: pd.Series, *, allow_null: bool) -> int:
    invalid = 0
    for value in series.array:
        try:
            missing = bool(pd.isna(value))
        except (TypeError, ValueError):
            missing = False
        if missing and allow_null:
            continue
        if missing or not isinstance(value, Real) or isinstance(value, (bool, np.bool_)):
            invalid += 1
            continue
        if not np.isfinite(float(value)):
            invalid += 1
    return invalid


def _required_numeric_fields(frames: dict[str, pd.DataFrame], year: int) -> dict:
    annual_required = tuple(dict.fromkeys([*ADDITIVE_COLUMNS, *LENGTH_COLUMNS, *NETWORK_COLUMNS]))
    problems: list[str] = []
    checked = 0
    for label in ("country", "industry"):
        frame = frames[label]
        missing = _missing(frame, set(annual_required))
        if missing:
            problems.append(f"{label}:missing={missing}")
            continue
        for column in annual_required:
            invalid = _invalid_numeric_source(frame[column], allow_null=column in LENGTH_COLUMNS)
            if invalid:
                problems.append(f"{label}:{column}_invalid={invalid}")
        checked += len(frame) * len(annual_required)

    exposure_fields = ("bilateral_exports", "total_exports", "export_exposure")
    exposure = frames["exposure"]
    missing_exposure = _missing(exposure, set(exposure_fields))
    if missing_exposure:
        problems.append(f"exposure:missing={missing_exposure}")
    else:
        for column in exposure_fields:
            invalid = _invalid_numeric_source(exposure[column], allow_null=False)
            if invalid:
                problems.append(f"exposure:{column}_invalid={invalid}")
        checked += len(exposure) * len(exposure_fields)

    return _check(
        "required_numeric_fields",
        not problems,
        f"year={year}; checked_values={checked}; violations={len(problems)}"
        + (f"; {'; '.join(problems)}" if problems else ""),
    )


def _identity_count(frame: pd.DataFrame, lhs: str, rhs_columns: tuple[str, ...]) -> int:
    values = frame[[lhs, *rhs_columns]].apply(pd.to_numeric, errors="coerce")
    rhs = values[list(rhs_columns)].sum(axis=1, min_count=len(rhs_columns))
    return int((~_close(values[lhs], rhs)).sum())


def _trade_identities(frames: dict[str, pd.DataFrame], year: int) -> dict:
    required = set(TRADE_CLOSURE_COLUMNS) | {"EXDVA"}
    violations = 0
    missing: list[str] = []
    checked = 0
    for label in ("country", "industry", "panel_country_year", "panel_industry_year"):
        frame = frames[label]
        absent = _missing(frame, required)
        if absent:
            missing.append(f"{label}:{absent}")
            continue
        numeric = frame[list(required)].apply(pd.to_numeric, errors="coerce")
        violations += int((~np.isfinite(numeric.to_numpy(dtype=float))).sum())
        violations += _identity_count(frame, "EXDVA", ("DVAex", "DVArt"))
        if "gross_exports" in frame:
            violations += _identity_count(frame, "gross_exports", TRADE_CLOSURE_COLUMNS)
        checked += len(frame)
    passed = not missing and violations == 0
    return _check(
        "trade_identities",
        passed,
        f"year={year}; rows={checked}; violations={violations}; abs_tol={OUTPUT_QC_ABS_TOLERANCE}; "
        f"rel_tol={OUTPUT_QC_REL_TOLERANCE}" + (f"; missing={missing}" if missing else ""),
    )


def _production_identities(frames: dict[str, pd.DataFrame], year: int) -> dict:
    required = set(PRODUCTION_COLUMNS)
    violations = 0
    missing: list[str] = []
    checked = 0
    identities = (
        ("SVA", ("1_VA_D", "2_VA_RT", "3_VA_GVC")),
        ("3_VA_GVC", ("3a_VA_GVC_S", "3b_VA_GVC_C")),
        ("FGY", ("1_FGY_D", "2_FGY_RT", "3_FGY_GVC")),
        ("3_FGY_GVC", ("3a_FGY_GVC_S", "3b_FGY_GVC_C")),
    )
    for label in ("country", "industry", "panel_country_year", "panel_industry_year"):
        frame = frames[label]
        absent = _missing(frame, required)
        if absent:
            missing.append(f"{label}:{absent}")
            continue
        numeric = frame[list(required)].apply(pd.to_numeric, errors="coerce")
        violations += int((~np.isfinite(numeric.to_numpy(dtype=float))).sum())
        violations += sum(_identity_count(frame, lhs, rhs) for lhs, rhs in identities)
        checked += len(frame)
    return _check(
        "production_identities",
        not missing and violations == 0,
        f"year={year}; rows={checked}; identities=4; violations={violations}; "
        f"abs_tol={OUTPUT_QC_ABS_TOLERANCE}; rel_tol={OUTPUT_QC_REL_TOLERANCE}"
        + (f"; missing={missing}" if missing else ""),
    )


def _length_frame_violations(frame: pd.DataFrame) -> int:
    violations = 0
    numeric = frame[[*LENGTH_COLUMNS, *set(LENGTH_DENOMINATORS.values())]].apply(pd.to_numeric, errors="coerce")
    for length_name, denominator_name in LENGTH_DENOMINATORS.items():
        values = numeric[length_name].to_numpy(dtype=float)
        denominator = numeric[denominator_name].to_numpy(dtype=float)
        defined = np.isfinite(denominator) & (np.abs(denominator) > OUTPUT_QC_DENOMINATOR_FLOOR)
        violations += int((defined & ~np.isfinite(values)).sum())
        violations += int((~defined & ~np.isnan(values)).sum())

    for ratio_name, numerator_name, denominator_name in (
        ("Pos_TPL", "PLv", "PLy"),
        ("GVCPs", "PLv_GVC", "PLy_GVC"),
    ):
        ratio = numeric[ratio_name].to_numpy(dtype=float)
        numerator = numeric[numerator_name].to_numpy(dtype=float)
        denominator = numeric[denominator_name].to_numpy(dtype=float)
        defined = (
            np.isfinite(numerator) & np.isfinite(denominator) & (np.abs(denominator) > OUTPUT_QC_DENOMINATOR_FLOOR)
        )
        violations += int((defined & ~_close(ratio, numerator / np.where(defined, denominator, 1.0))).sum())
        violations += int((~defined & ~np.isnan(ratio)).sum())

    for total_length, total_amount, segments in (
        ("PLv", "SVA", (("PLv_D", "1_VA_D"), ("PLv_RT", "2_VA_RT"), ("PLv_GVC", "3_VA_GVC"))),
        ("PLy", "FGY", (("PLy_D", "1_FGY_D"), ("PLy_RT", "2_FGY_RT"), ("PLy_GVC", "3_FGY_GVC"))),
    ):
        denominator = numeric[total_amount].to_numpy(dtype=float)
        defined = np.isfinite(denominator) & (np.abs(denominator) > OUTPUT_QC_DENOMINATOR_FLOOR)
        weighted = np.zeros(len(frame), dtype=float)
        observable = defined.copy()
        for length_name, amount_name in segments:
            amount = numeric[amount_name].to_numpy(dtype=float)
            length_value = numeric[length_name].to_numpy(dtype=float)
            active = np.isfinite(amount) & (np.abs(amount) > OUTPUT_QC_DENOMINATOR_FLOOR)
            observable &= ~active | np.isfinite(length_value)
            weighted += np.where(active, length_value * amount, 0.0)
        lhs = numeric[total_length].to_numpy(dtype=float) * denominator
        violations += int((observable & ~_close(lhs, weighted)).sum())
    return violations


def _length_identities(frames: dict[str, pd.DataFrame], year: int) -> dict:
    required = set(LENGTH_COLUMNS) | set(LENGTH_DENOMINATORS.values())
    violations = 0
    missing: list[str] = []
    checked = 0
    for label in ("country", "industry", "panel_country_year", "panel_industry_year"):
        frame = frames[label]
        absent = _missing(frame, required)
        if absent:
            missing.append(f"{label}:{absent}")
            continue
        violations += _length_frame_violations(frame)
        checked += len(frame)
    return _check(
        "length_domains_and_identities",
        not missing and violations == 0,
        f"year={year}; rows={checked}; violations={violations}; denominator_floor={OUTPUT_QC_DENOMINATOR_FLOOR}; "
        f"abs_tol={OUTPUT_QC_ABS_TOLERANCE}; rel_tol={OUTPUT_QC_REL_TOLERANCE}"
        + (f"; missing={missing}" if missing else ""),
    )


def _country_additivity(frames: dict[str, pd.DataFrame], year: int) -> dict:
    country = frames["country"]
    industry = frames["industry"]
    required = {"country", *ADDITIVE_COLUMNS}
    missing_country = _missing(country, required)
    missing_industry = _missing(industry, required)
    if missing_country or missing_industry:
        return _check(
            "country_industry_additivity",
            False,
            f"year={year}; missing_country={missing_country}; missing_industry={missing_industry}",
        )
    grouped = industry.groupby("country", sort=True, as_index=False)[list(ADDITIVE_COLUMNS)].sum(min_count=1)
    merged = country[["country", *ADDITIVE_COLUMNS]].merge(
        grouped,
        on="country",
        how="outer",
        validate="one_to_one",
        suffixes=("_country", "_industry"),
        indicator=True,
    )
    violations = int(merged["_merge"].ne("both").sum())
    for column in ADDITIVE_COLUMNS:
        violations += int((~_close(merged[f"{column}_country"], merged[f"{column}_industry"])).sum())
    return _check(
        "country_industry_additivity",
        violations == 0,
        f"year={year}; countries={len(merged)}; additive_columns={len(ADDITIVE_COLUMNS)}; violations={violations}; "
        f"abs_tol={OUTPUT_QC_ABS_TOLERANCE}; rel_tol={OUTPUT_QC_REL_TOLERANCE}; ratios_aggregated=false",
    )


def _network_edges(frames: dict[str, pd.DataFrame], year: int) -> dict:
    edges = frames["edges"]
    missing = _missing(edges, {"source", "target", "year", "flow"})
    if missing:
        return _check("network_edges", False, f"year={year}; missing={missing}")
    endpoints = set(frames["country"].get("country", pd.Series(dtype=str)).astype(str))
    flow = pd.to_numeric(edges["flow"], errors="coerce").to_numpy(dtype=float)
    violations = int((~np.isfinite(flow) | (flow <= 0)).sum())
    violations += int((~edges["source"].astype(str).isin(endpoints)).sum())
    violations += int((~edges["target"].astype(str).isin(endpoints)).sum())
    violations += int(edges["source"].astype(str).eq(edges["target"].astype(str)).sum())
    violations += int(edges.duplicated(["year", "source", "target"]).sum())
    # Completeness: step 9 sums this table as every bilateral flow, so each source's edges must add up to
    # its country weighted outdegree and number its outdegree (a top-N cut once reversed a ranking).
    country = frames["country"]
    incomplete = 0
    if {"country", "weighted outdegree", "outdegree"} <= set(country.columns):
        by_source = edges.assign(flow=flow).groupby(edges["source"].astype(str))["flow"].agg(["sum", "count"])
        expected = country.set_index(country["country"].astype(str))
        observed = by_source.reindex(expected.index).fillna(0.0)
        incomplete = int(
            (~_close(observed["sum"], expected["weighted outdegree"])).sum()
            + (~_close(observed["count"], expected["outdegree"])).sum()
        )
    else:
        incomplete = 1
    violations += incomplete
    return _check(
        "network_edges",
        violations == 0,
        f"year={year}; edges={len(edges)}; violations={violations}; flow_domain=(0,finite); "
        f"self_loops={OUTPUT_QC_SELF_LOOP_POLICY}; complete_vs_outdegree_violations={incomplete}",
    )


def _network_indicators(frames: dict[str, pd.DataFrame], year: int) -> dict:
    required = set(NETWORK_COLUMNS)
    missing: list[str] = []
    violations = 0
    checked = 0
    bounded = ("closnesscentrality", "harmonicclosnesscentrality", "eigencentrality")
    nonnegative = (
        "degree",
        "indegree",
        "outdegree",
        "weighted degree",
        "weighted indegree",
        "weighted outdegree",
        "Eccentricity",
        "betweenesscentrality",
    )
    for label in ("country", "industry", "panel_country_year", "panel_industry_year"):
        frame = frames[label]
        absent = _missing(frame, required)
        if absent:
            missing.append(f"{label}:{absent}")
            continue
        numeric = frame[list(required)].apply(pd.to_numeric, errors="coerce")
        values = numeric.to_numpy(dtype=float)
        violations += int((~np.isfinite(values)).sum())
        for column in nonnegative:
            violations += int((numeric[column].to_numpy(dtype=float) < -OUTPUT_QC_ABS_TOLERANCE).sum())
        for column in bounded:
            field = numeric[column].to_numpy(dtype=float)
            violations += int(((field < -OUTPUT_QC_ABS_TOLERANCE) | (field > 1 + OUTPUT_QC_ABS_TOLERANCE)).sum())
        for column in ("degree", "indegree", "outdegree"):
            field = numeric[column].to_numpy(dtype=float)
            violations += int((np.isfinite(field) & (np.abs(field - np.rint(field)) > OUTPUT_QC_ABS_TOLERANCE)).sum())
        violations += _identity_count(frame, "degree", ("indegree", "outdegree"))
        violations += _identity_count(frame, "weighted degree", ("weighted indegree", "weighted outdegree"))
        checked += len(frame)
    return _check(
        "network_indicators",
        not missing and violations == 0,
        f"year={year}; rows={checked}; violations={violations}; centrality_domain=[0,1] where bounded; "
        f"nonnegative=true; abs_tol={OUTPUT_QC_ABS_TOLERANCE}; rel_tol={OUTPUT_QC_REL_TOLERANCE}"
        + (f"; missing={missing}" if missing else ""),
    )


def _panel_shares(frames: dict[str, pd.DataFrame], year: int) -> dict:
    required = {
        "gross_exports",
        *PANEL_SHARE_DENOMINATORS,
        *PANEL_SHARE_NUMERATORS.values(),
        *PANEL_SHARE_DENOMINATORS.values(),
    }
    missing: list[str] = []
    violations = 0
    checked = 0
    for label in ("panel_country_year", "panel_industry_year"):
        frame = frames[label]
        absent = _missing(frame, required)
        if absent:
            missing.append(f"{label}:{absent}")
            continue
        numeric = frame[list(required)].apply(pd.to_numeric, errors="coerce")
        gross = numeric["gross_exports"].to_numpy(dtype=float)
        violations += int((~np.isfinite(gross)).sum())
        for share_name, denominator_name in PANEL_SHARE_DENOMINATORS.items():
            share = numeric[share_name].to_numpy(dtype=float)
            numerator = numeric[PANEL_SHARE_NUMERATORS[share_name]].to_numpy(dtype=float)
            denominator = numeric[denominator_name].to_numpy(dtype=float)
            defined = np.isfinite(denominator) & (denominator > 0)
            expected = numerator / np.where(defined, denominator, 1.0)
            violations += int((defined & ~_close(share, expected)).sum())
            violations += int((~defined & ~np.isnan(share)).sum())
        checked += len(frame)
    return _check(
        "panel_shares",
        not missing and violations == 0,
        f"year={year}; rows={checked}; violations={violations}; defined_when=denominator>0; signed_ratio_identity=true; "
        f"abs_tol={OUTPUT_QC_ABS_TOLERANCE}; rel_tol={OUTPUT_QC_REL_TOLERANCE}"
        + (f"; missing={missing}" if missing else ""),
    )


def _panel_share_economic_domains(frames: dict[str, pd.DataFrame], year: int) -> dict:
    violations = 0
    for label in ("panel_country_year", "panel_industry_year"):
        for share_name in PANEL_SHARE_DENOMINATORS:
            if share_name not in frames[label]:
                continue  # Missing columns are handled by the integrity/identity checks.
            values = pd.to_numeric(frames[label][share_name], errors="coerce")
            violations += int(((values < -OUTPUT_QC_ABS_TOLERANCE) | (values > 1 + OUTPUT_QC_ABS_TOLERANCE)).sum())
    return _check(
        "panel_share_economic_domains",
        violations == 0,
        f"year={year}; outside_[0,1]={violations}; signed VA/TLS and source rounding require disclosure, not clipping",
    )


def _teaching_panel_contract(frames: dict[str, pd.DataFrame], year: int) -> dict:
    from gvcsim.regression.teaching import (
        BASELINES,
        EXCHANGE_RATE_COLUMN,
        EXCHANGE_RATE_DEPRECIATION,
        EXCHANGE_RATE_NOISE_SD,
        SURPLUS_COLUMN,
        TARIFF_RATE,
        WAVE_COLUMN,
        X_COLUMN,
        X_LAG_COLUMNS,
        Y_COLUMNS,
        _is_goods_sector,
        tariff_wave,
        wave_start_years,
        y_column,
    )

    frame = frames["panel_teaching"]
    required = {
        "country",
        "industry",
        "entity_id",
        "year",
        "teaching_export_share_w",
        "teaching_tariff_rate_tau",
        "teaching_treated",
        SURPLUS_COLUMN,
        WAVE_COLUMN,
        EXCHANGE_RATE_COLUMN,
        *X_LAG_COLUMNS.values(),
        *Y_COLUMNS.values(),
    }
    missing = _missing(frame, required)
    violations = 0
    details: list[str] = []
    if missing:
        return _check("teaching_panel_contract", False, f"year={year}; missing={missing}")
    years = pd.to_numeric(frame["year"], errors="coerce")
    unique_years = sorted(years.dropna().unique().tolist())
    if len(unique_years) != 5 or unique_years != list(range(int(unique_years[0]), int(unique_years[0]) + 5)):
        violations += 1
        details.append(f"years={unique_years}")
    numeric_columns = [column for column in frame if column.startswith("teaching_")]
    numeric = frame[numeric_columns].apply(pd.to_numeric, errors="coerce")
    violations += int((~np.isfinite(numeric.to_numpy(dtype=float))).sum())
    violations += int(frame.duplicated(["country", "industry", "year"]).sum())
    violations += int(frame.duplicated(["entity_id", "year"]).sum())
    expected_entity = frame["country"].astype(str) + "_" + frame["industry"].astype(str)
    violations += int((~frame["entity_id"].astype(str).eq(expected_entity)).sum())
    w = numeric["teaching_export_share_w"]
    tau = numeric["teaching_tariff_rate_tau"]
    x = numeric[X_COLUMN]
    violations += int((~w.between(0, 1)).sum())
    violations += int((tau < 0).sum())
    violations += int((~_close(x, w * tau)).sum())
    violations += int((~numeric["teaching_treated"].isin([0, 1])).sum())
    violations += int((~numeric[WAVE_COLUMN].isin([0, 1, 2])).sum())
    violations += int((~numeric[WAVE_COLUMN].eq(tariff_wave(numeric[SURPLUS_COLUMN]))).sum())
    # Surplus and wave are country-level, time-invariant; exchange noise is shared by every industry in a
    # country-year. Check its support after removing the prescribed first-wave depreciation, not a fixed seed.
    for column in (SURPLUS_COLUMN, WAVE_COLUMN):
        violations += int((frame.groupby("country")[column].nunique(dropna=False) != 1).sum())
    violations += int((frame.groupby(["country", "year"])[EXCHANGE_RATE_COLUMN].nunique(dropna=False) != 1).sum())
    # τ follows the published schedule: the goods industries (ICIO A–C) of a taxed country from its wave's start year.
    # A lag of X is the unit's w × that schedule k years earlier (0 before the panel), so a unit missing a year inside
    # the panel still has its lags checked, as the generator writes them.
    if unique_years:
        starts = numeric[WAVE_COLUMN].map(wave_start_years(int(unique_years[0])))
        goods = _is_goods_sector(frame["industry"])
        depreciation = EXCHANGE_RATE_DEPRECIATION * (
            numeric[WAVE_COLUMN].eq(1) & years.ge(wave_start_years(int(unique_years[0]))[1])
        )
        noise = numeric[EXCHANGE_RATE_COLUMN] - depreciation
        bound = EXCHANGE_RATE_NOISE_SD * np.sqrt(3)
        violations += int((noise.abs() > bound + OUTPUT_QC_ABS_TOLERANCE).sum())

        def scheduled(at: pd.Series) -> pd.Series:
            return TARIFF_RATE * (goods & starts.notna() & at.ge(starts)).astype(float)

        violations += int((~_close(tau, scheduled(years))).sum())
        for lag, column in X_LAG_COLUMNS.items():
            if lag:
                violations += int((~_close(numeric[column], w * scheduled(years - lag))).sum())
    if len(unique_years) >= 2:
        violations += int((x.loc[years.isin(unique_years[:2])].abs() > OUTPUT_QC_ABS_TOLERANCE).sum())
    violations += int((~numeric[Y_COLUMNS["trade"]].between(0, 1)).sum())
    violations += int((~numeric[Y_COLUMNS["production"]].between(0, 1)).sum())
    violations += int((numeric[Y_COLUMNS["length"]] <= 0).sum())
    violations += int((numeric[Y_COLUMNS["network"]] < 0).sum())
    for outcome, items in BASELINES.items():
        for item in items:
            if item.combine is None:
                continue
            column = y_column(outcome, item.key)
            constant, terms = item.combine
            columns = [y_column(outcome, key) for key, _ in terms]
            # Reduced source fixtures need not carry every optional baseline, but an identity must carry all
            # its parts whenever present. Matching missing masks are required as well as matching values.
            if column not in numeric:
                continue
            if any(part not in numeric for part in columns):
                violations += 1
                details.append(f"incomplete_identity={column}")
                continue
            expected = pd.Series(constant, index=frame.index, dtype=float)
            for (_, coefficient), part in zip(terms, columns, strict=True):
                expected = expected + coefficient * numeric[part]
            valid = numeric[column].isna() & expected.isna() | _close(numeric[column], expected)
            violations += int((~valid).sum())
    return _check(
        "teaching_panel_contract",
        violations == 0,
        f"year={year}; rows={len(frame)}; violations={violations}" + (f"; {'; '.join(details)}" if details else ""),
    )


def recompute_output_checks(root: Path, year: int, *, expected_years: list[int]) -> list[dict]:
    """Recompute all v1 semantic checks from persisted release files for one year."""
    frames = {
        "country": _read_csv(root, f"indicators_country_{year}.csv"),
        "industry": _read_csv(root, f"indicators_industry_{year}.csv"),
        "edges": _read_csv(root, f"network_edges_{year}.csv"),
        "exposure": _read_csv(root, f"export_exposure_{year}.csv"),
        "panel_country": _read_csv(root, "panel_country.csv"),
        "panel_industry": _read_csv(root, "panel_industry.csv"),
        "panel_teaching": _read_csv(root, "panel_teaching.csv"),
    }
    panel_year_problems: list[str] = []
    validated_panel_years: dict[str, pd.Series] = {}
    for panel_name in ("panel_country", "panel_industry", "panel_teaching"):
        numeric_years, problems = _validate_panel_years(frames[panel_name], panel_name, expected_years)
        panel_year_problems.extend(problems)
        if numeric_years is not None:
            validated_panel_years[panel_name] = numeric_years
            # Normalize only after mathematical validation so equivalent numeric tokens
            # cannot bypass the existing entity-year duplicate checks.
            frames[panel_name]["year"] = numeric_years

    panel_years_valid = not panel_year_problems and len(validated_panel_years) == 3
    for panel_name in ("panel_country", "panel_industry", "panel_teaching"):
        panel = frames[panel_name]
        frames[f"{panel_name}_year"] = (
            panel.loc[_year_mask(panel, year)].copy() if panel_years_valid else panel.iloc[0:0].copy()
        )
    runners: tuple[Callable[[dict[str, pd.DataFrame], int], dict], ...] = (
        lambda values, selected_year: _keys_and_coverage(values, selected_year, panel_year_problems),
        _required_numeric_fields,
        _trade_identities,
        _production_identities,
        _length_identities,
        _country_additivity,
        _network_edges,
        _network_indicators,
        _panel_shares,
        _panel_share_economic_domains,
        _teaching_panel_contract,
    )
    checks = [runner(frames, year) for runner in runners]
    validate_serialized_output_checks(checks, contract_version=OUTPUT_QC_CONTRACT_VERSION)
    return checks


def write_output_qc(root: Path, year: int, *, expected_years: list[int]) -> tuple[list[dict], dict]:
    """Persist diagnostics before rejecting integrity or mathematical failures."""
    checks = recompute_output_checks(root, year, expected_years=expected_years)
    summary = summarize_output_checks(checks)
    path = root / f"qc_outputs_{year}.json"
    path.write_text(json.dumps(checks, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    integrity_failures = [
        check["name"]
        for check in checks
        if check["kind"] in {"structure", "integrity", "mathematical"} and not check["passed"]
    ]
    if integrity_failures:
        raise OutputQualityError(f"year {year} output integrity checks failed: {integrity_failures}")
    return checks, summary


def read_output_qc(path: Path, *, contract: object) -> list[dict]:
    """Read one persisted output diagnostic artifact under the current exact contract."""
    validate_output_qc_contract_metadata(contract)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid output QC artifact {path}: {exc}") from exc
    assert isinstance(contract, dict)
    return validate_serialized_output_checks(payload, contract_version=contract["version"])
