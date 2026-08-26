"""Strict, source-controlled OECD ICIO raw-file boundary.

The validator deliberately reads CSV tokens itself.  Pandas coercion and null-skipping
are useful for display, but are not evidence that a release input is complete.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import re
import stat
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Mapping, TypeAlias


RawFileIdentity: TypeAlias = tuple[str, int, int, int, int, int, int]
"""Resolved path and immutable stat fields used by every raw-file cache."""

RAW_DIMENSIONS_METADATA_VERSION = 2
_PRODUCTION_CONTRACT_PATH = Path(__file__).with_name("icio2023_dimensions_v1.json")
_YEAR_FILE = re.compile(r"^ICIO.*_(\d{4})\.csv$")
_ACCOUNT_ROWS = ("TLS", "VA", "OUT")
_validation_lock = threading.RLock()


class RawICIOValidationError(ValueError):
    """A raw ICIO file or its persisted dimension evidence is invalid."""


@dataclass(frozen=True)
class DimensionContract:
    contract_id: str
    version: int
    countries: tuple[str, ...]
    industries: tuple[str, ...]
    final_demand_categories: tuple[str, ...]

    def __post_init__(self) -> None:
        groups = (self.countries, self.industries, self.final_demand_categories)
        if not self.contract_id or type(self.version) is not int or self.version < 1:
            raise ValueError("dimension contract id/version is invalid")
        if any(not group or len(group) != len(set(group)) for group in groups):
            raise ValueError("dimension contract code lists must be non-empty and unique")
        if any(not code or "_" in code for code in self.countries):
            raise ValueError("dimension contract country codes are invalid")

    @property
    def industry_labels(self) -> tuple[str, ...]:
        return tuple(f"{country}_{industry}" for country in self.countries for industry in self.industries)

    @property
    def final_demand_labels(self) -> tuple[str, ...]:
        return tuple(f"{country}_{category}" for country in self.countries for category in self.final_demand_categories)


@lru_cache(maxsize=1)
def production_dimension_contract() -> DimensionContract:
    payload = json.loads(_PRODUCTION_CONTRACT_PATH.read_text(encoding="utf-8"))
    return DimensionContract(
        contract_id=payload["contract_id"],
        version=payload["version"],
        countries=tuple(payload["countries"]),
        industries=tuple(payload["industries"]),
        final_demand_categories=tuple(payload["final_demand_categories"]),
    )


# This contract is source-controlled beside the deterministic CI generator.  It is
# selected only behind the same two environment gates and valid marker as provenance.
CI_SYNTHETIC_DIMENSION_CONTRACT = DimensionContract(
    contract_id="gvcsim-ci-synthetic-icio-dimensions",
    version=1,
    countries=(
        "AUS",
        "BRA",
        "CAN",
        "CHN",
        "DEU",
        "JPN",
        "KOR",
        "MEX",
        "NZL",
        "RUS",
        "TUR",
        "USA",
        "VNM",
        "ROW",
    ),
    industries=(
        "A01_02",
        "A03",
        "B05_06",
        "B07_08",
        "B09",
        "C10T12",
        "C13T15",
        "C16",
        "C17_18",
        "C19",
        "C20",
        "C21",
        "C22",
        "C23",
        "C24",
        "C25",
        "C26",
        "C27",
        "C28",
        "C29",
        "C30",
        "C31T33",
        "J62_63",
        "K",
    ),
    final_demand_categories=("HFCE", "NPISH", "GGFC", "GFCF", "INVNT", "DPABR"),
)


def dimension_contract_for(raw_dir: Path) -> DimensionContract:
    """Choose only an explicit source-controlled production or CI contract."""
    from gvcsim.data.citations import CI_SYNTHETIC_KIND, CI_SYNTHETIC_MARKER

    marker = raw_dir / CI_SYNTHETIC_MARKER
    synthetic_enabled = os.environ.get("GVCSIM_CI_SYNTHETIC") == "1"
    ci_enabled = os.environ.get("CI", "").strip().lower() in {"1", "true", "yes"}
    if marker.exists() or synthetic_enabled:
        if not (marker.is_file() and synthetic_enabled and ci_enabled):
            raise RawICIOValidationError(
                "CI synthetic dimensions require CI=true, GVCSIM_CI_SYNTHETIC=1, and a valid marker"
            )
        try:
            payload = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RawICIOValidationError("CI synthetic dimension marker cannot be parsed") from exc
        expected = CI_SYNTHETIC_DIMENSION_CONTRACT
        if (
            payload.get("kind") != CI_SYNTHETIC_KIND
            or payload.get("production_data") is not False
            or payload.get("countries") != list(expected.countries)
            or payload.get("sectors") != list(expected.industries)
        ):
            raise RawICIOValidationError("CI synthetic dimension marker contract is invalid")
        return expected
    return production_dimension_contract()


def resolve_year_source(year: int, raw_dir: Path) -> Path:
    """Resolve exactly one source for a year; missing and duplicate are identical everywhere."""
    matches = sorted(raw_dir.glob(f"ICIO*_{year}.csv"))
    if len(matches) != 1:
        raise FileNotFoundError(f"期望找到 1 个 {year} 年 ICIO CSV，实际找到 {len(matches)} 个: {matches}")
    return matches[0]


def discover_years(raw_dir: Path) -> list[int]:
    years = {int(match.group(1)) for path in raw_dir.glob("ICIO*_*.csv") if (match := _YEAR_FILE.fullmatch(path.name))}
    # Resolve now rather than silently de-duplicating ambiguous candidates.
    for year in sorted(years):
        resolve_year_source(year, raw_dir)
    return sorted(years)


def _digest_codes(values: Iterable[str]) -> str:
    return hashlib.sha256("\n".join(values).encode("utf-8")).hexdigest()


def _fail(path: Path, message: str, *, row_number: int | None = None) -> RawICIOValidationError:
    where = f" line {row_number}" if row_number is not None else ""
    return RawICIOValidationError(f"invalid raw ICIO CSV {path}{where}: {message}")


def _parse_finite(token: str, path: Path, row_number: int, column_number: int) -> None:
    if token.strip() == "":
        raise _fail(path, f"blank numeric token at column {column_number}", row_number=row_number)
    try:
        number = float(token)
    except ValueError as exc:
        raise _fail(path, f"bad numeric token at column {column_number}: {token!r}", row_number=row_number) from exc
    if not math.isfinite(number):
        raise _fail(path, f"non-finite numeric token at column {column_number}: {token!r}", row_number=row_number)


def _contract_key(contract: DimensionContract) -> tuple[Any, ...]:
    return (
        contract.contract_id,
        contract.version,
        contract.countries,
        contract.industries,
        contract.final_demand_categories,
    )


def raw_file_identity(path: Path) -> RawFileIdentity:
    """Return a tamper-sensitive cache identity while rejecting non-regular sources."""
    try:
        source_mode = path.lstat().st_mode
    except FileNotFoundError:
        raise
    if stat.S_ISLNK(source_mode) or not stat.S_ISREG(source_mode):
        raise OSError(f"OECD ICIO 原始文件不是普通文件: {path.name}")

    resolved = path.resolve(strict=True)
    file_stat = resolved.stat()
    if not stat.S_ISREG(file_stat.st_mode):
        raise OSError(f"OECD ICIO 原始文件不是普通文件: {path.name}")
    return (
        str(resolved),
        file_stat.st_dev,
        file_stat.st_ino,
        file_stat.st_mode,
        file_stat.st_size,
        file_stat.st_mtime_ns,
        file_stat.st_ctime_ns,
    )


@lru_cache(maxsize=32)
def _raw_source_evidence_cached(identity: RawFileIdentity) -> dict[str, Any]:
    """Hash one exact regular-file identity and reject changes during the read."""
    path = Path(identity[0])
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if raw_file_identity(path) != identity:
        raise RawICIOValidationError(f"raw ICIO file changed during content hashing: {path}")
    return {
        "source_file": path.name,
        "source_bytes": identity[4],
        "source_sha256": digest.hexdigest(),
    }


@lru_cache(maxsize=32)
def _validate_raw_file_cached(
    identity: RawFileIdentity,
    contract_key: tuple[Any, ...],
) -> dict[str, Any]:
    path = Path(identity[0])
    contract = DimensionContract(
        contract_id=contract_key[0],
        version=contract_key[1],
        countries=contract_key[2],
        industries=contract_key[3],
        final_demand_categories=contract_key[4],
    )
    source_evidence = _raw_source_evidence_cached(identity)
    expected_industry = set(contract.industry_labels)
    expected_demand = set(contract.final_demand_labels)
    expected_rows = expected_industry | set(_ACCOUNT_ROWS)
    expected_width = 2 + len(expected_industry) + len(expected_demand)

    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle, strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise _fail(path, "file is empty") from exc
            if len(header) != expected_width:
                raise _fail(path, f"header width {len(header)} != contract width {expected_width}")
            if len(header) != len(set(header)):
                raise _fail(path, "duplicate header label")
            if header[0] != "V1" or header[-1] != "OUT":
                raise _fail(path, "header must start with V1 and end with OUT")
            value_header = set(header[1:-1])
            expected_header = expected_industry | expected_demand
            if value_header != expected_header:
                missing = sorted(expected_header - value_header)[:3]
                extra = sorted(value_header - expected_header)[:3]
                raise _fail(path, f"header code-set mismatch; missing={missing}, extra={extra}")

            labels: list[str] = []
            seen: set[str] = set()
            for row_number, row in enumerate(reader, start=2):
                if len(row) != expected_width:
                    raise _fail(path, f"row width {len(row)} != header width {expected_width}", row_number=row_number)
                label = row[0]
                if label in seen:
                    raise _fail(path, f"duplicate row label {label!r}", row_number=row_number)
                seen.add(label)
                labels.append(label)
                for column_number, token in enumerate(row[1:], start=2):
                    _parse_finite(token, path, row_number, column_number)
    except (UnicodeError, csv.Error) as exc:
        raise _fail(path, str(exc)) from exc

    actual_rows = set(labels)
    if actual_rows != expected_rows:
        missing = sorted(expected_rows - actual_rows)[:3]
        extra = sorted(actual_rows - expected_rows)[:3]
        raise _fail(path, f"row code-set/account mismatch; missing={missing}, extra={extra}")
    for account in _ACCOUNT_ROWS:
        if labels.count(account) != 1:
            raise _fail(path, f"account row {account} must occur exactly once")

    if raw_file_identity(path) != identity:
        raise RawICIOValidationError(f"raw ICIO file changed during strict validation: {path}")
    layout_digest = _digest_codes([*header, "--ROWS--", *labels])
    return {
        **source_evidence,
        "rows": len(labels),
        "columns": len(header),
        "countries": len(contract.countries),
        "industries": len(contract.industries),
        "final_demand_categories": len(contract.final_demand_categories),
        "country_codes_sha256": _digest_codes(contract.countries),
        "industry_codes_sha256": _digest_codes(contract.industries),
        "final_demand_codes_sha256": _digest_codes(contract.final_demand_categories),
        "layout_sha256": layout_digest,
    }


def validate_raw_file(path: Path, contract: DimensionContract) -> dict[str, Any]:
    identity = raw_file_identity(path)
    if identity[4] <= 0:
        raise OSError(f"OECD ICIO 原始文件为空: {path.name}")
    with _validation_lock:
        return dict(_validate_raw_file_cached(identity, _contract_key(contract)))


@lru_cache(maxsize=16)
def _raw_bilateral_exports_cached(
    identity: RawFileIdentity,
    contract_key: tuple[Any, ...],
    composite_key: tuple[tuple[str, tuple[str, ...]], ...],
) -> tuple[tuple[str, str, str, float, float], ...]:
    """Re-read one strictly validated raw table and aggregate sector export flows.

    This intentionally does not use pymrio, persisted exposure files, shock files,
    or any Leontief/indicator calculation.  The cache key includes every
    tamper-sensitive stat field from :class:`RawFileIdentity`.
    """
    path = Path(identity[0])
    contract = DimensionContract(
        contract_id=contract_key[0],
        version=contract_key[1],
        countries=contract_key[2],
        industries=contract_key[3],
        final_demand_categories=contract_key[4],
    )
    country_set = set(contract.countries)
    industry_owner = {
        f"{country}_{industry}": (country, industry)
        for country in contract.countries
        for industry in contract.industries
    }
    destination_by_label = {
        **{
            label: country
            for country in contract.countries
            for label in (f"{country}_{industry}" for industry in contract.industries)
        },
        **{
            label: country
            for country in contract.countries
            for label in (f"{country}_{category}" for category in contract.final_demand_categories)
        },
    }
    flows = {
        (exporter, sector, destination): 0.0
        for exporter in contract.countries
        for sector in contract.industries
        for destination in contract.countries
    }

    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle, strict=True)
            header = next(reader)
            destinations = [destination_by_label.get(label) for label in header]
            for row in reader:
                owner = industry_owner.get(row[0])
                if owner is None:
                    continue
                exporter, sector = owner
                for column, destination in enumerate(destinations[1:-1], start=1):
                    if destination is not None and destination != exporter:
                        flows[(exporter, sector, destination)] += float(row[column])
    except (UnicodeError, csv.Error, StopIteration, ValueError, IndexError) as exc:
        raise _fail(path, f"raw exposure recomputation failed: {exc}") from exc

    if raw_file_identity(path) != identity:
        raise RawICIOValidationError(f"raw ICIO file changed during exposure recomputation: {path}")

    rows: list[tuple[str, str, str, float, float]] = []
    for exporter in contract.countries:
        for sector in contract.industries:
            positive_flows = {
                destination: max(flows[(exporter, sector, destination)], 0.0) for destination in contract.countries
            }
            total = math.fsum(positive_flows.values())
            for destination in contract.countries:
                rows.append((exporter, sector, destination, positive_flows[destination], total))
            for composite, members in composite_key:
                bilateral = math.fsum(positive_flows[member] for member in members if member in country_set)
                rows.append((exporter, sector, composite, bilateral, total))
    return tuple(rows)


def raw_bilateral_exports(
    year: int,
    raw_dir: Path,
    contract: DimensionContract,
    composite_destinations: Mapping[str, Iterable[str]],
) -> list[dict[str, Any]]:
    """Derive country-sector-to-destination exports from the unique strict raw ICIO CSV."""
    path = resolve_year_source(year, raw_dir)
    identity = raw_file_identity(path)
    if identity[4] <= 0:
        raise OSError(f"OECD ICIO 原始文件为空: {path.name}")
    composite_key = tuple(
        (str(name), tuple(sorted(set(members)))) for name, members in sorted(composite_destinations.items())
    )
    if any(not name or name in contract.countries for name, _members in composite_key):
        raise RawICIOValidationError("composite destination names must be unique non-country codes")
    with _validation_lock:
        # Tie strict validation and the specialized second pass to the exact same
        # tamper-sensitive identity; neither pass can silently validate one inode
        # and read a replacement.
        _validate_raw_file_cached(identity, _contract_key(contract))
        values = _raw_bilateral_exports_cached(identity, _contract_key(contract), composite_key)
    return [
        {
            "country": country,
            "sector": sector,
            "imposer": destination,
            "year": year,
            "bilateral_exports": bilateral,
            "total_exports": total,
            "export_exposure": bilateral / total if total > 0.0 else 0.0,
        }
        for country, sector, destination, bilateral, total in values
    ]


def validate_raw_years(
    years: list[int],
    raw_dir: Path,
    contract: DimensionContract | None = None,
) -> dict[int, dict[str, Any]]:
    selected_contract = contract or dimension_contract_for(raw_dir)
    results: dict[int, dict[str, Any]] = {}
    reference_layout: str | None = None
    for year in years:
        path = resolve_year_source(year, raw_dir)
        result = validate_raw_file(path, selected_contract)
        layout = result["layout_sha256"]
        if reference_layout is None:
            reference_layout = layout
        elif layout != reference_layout:
            raise RawICIOValidationError(f"raw ICIO cross-year dimension/layout drift detected at {year}")
        results[year] = result
    return results


def raw_dimensions_metadata(
    years: list[int],
    raw_dir: Path,
    contract: DimensionContract | None = None,
) -> dict[str, Any]:
    selected_contract = contract or dimension_contract_for(raw_dir)
    results = validate_raw_years(years, raw_dir, selected_contract)
    common = next(iter(results.values()), None)
    if common is None:
        raise RawICIOValidationError("raw dimensions require at least one year")
    return {
        "metadata_version": RAW_DIMENSIONS_METADATA_VERSION,
        "contract_id": selected_contract.contract_id,
        "contract_version": selected_contract.version,
        "countries": common["countries"],
        "industries": common["industries"],
        "final_demand_categories": common["final_demand_categories"],
        "rows": common["rows"],
        "columns": common["columns"],
        "country_codes_sha256": common["country_codes_sha256"],
        "industry_codes_sha256": common["industry_codes_sha256"],
        "final_demand_codes_sha256": common["final_demand_codes_sha256"],
        "layout_sha256": common["layout_sha256"],
        "years": {
            str(year): {
                "source_file": results[year]["source_file"],
                "source_bytes": results[year]["source_bytes"],
                "source_sha256": results[year]["source_sha256"],
            }
            for year in years
        },
    }


def validate_raw_source_bindings(
    payload: object,
    years: list[int],
    raw_dir: Path,
) -> dict[str, dict[str, Any]]:
    """Cheaply bind an active release to exact raw bytes without reparsing its matrix."""
    if not isinstance(payload, dict) or payload.get("metadata_version") != RAW_DIMENSIONS_METADATA_VERSION:
        raise RawICIOValidationError("dataset raw_dimensions source-binding metadata is unsupported")
    persisted_years = payload.get("years")
    expected_year_keys = {str(year) for year in years}
    if not isinstance(persisted_years, dict) or set(persisted_years) != expected_year_keys:
        raise RawICIOValidationError("dataset raw_dimensions years do not match dataset years")

    actual: dict[str, dict[str, Any]] = {}
    for year in years:
        path = resolve_year_source(year, raw_dir)
        identity = raw_file_identity(path)
        with _validation_lock:
            evidence = dict(_raw_source_evidence_cached(identity))
        expected = persisted_years[str(year)]
        if expected != evidence:
            raise RawICIOValidationError(f"dataset raw source binding mismatch for {year}: {path.name}")
        actual[str(year)] = evidence
    return actual


def validate_raw_dimensions_metadata(
    payload: object,
    years: list[int],
    raw_dir: Path,
    contract: DimensionContract | None = None,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RawICIOValidationError("dataset raw_dimensions must be an object")
    expected = raw_dimensions_metadata(years, raw_dir, contract)
    if payload != expected:
        raise RawICIOValidationError("dataset raw_dimensions does not match strict raw files/contract")
    return expected


def clear_raw_validation_cache() -> None:
    _raw_source_evidence_cached.cache_clear()
    _validate_raw_file_cached.cache_clear()
    _raw_bilateral_exports_cached.cache_clear()
