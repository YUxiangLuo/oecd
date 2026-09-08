from __future__ import annotations

import csv
import hashlib
import hmac
import json
import os
import re
import stat
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any

import pandas as pd


ARTIFACT_CONTRACT_VERSION = 13
ARTIFACT_MANIFEST_ALGORITHM = "sha256"
ARTIFACT_MANIFEST_NAME = "artifact_manifest"
METADATA_DIGEST_NAME = "metadata_sha256"
RELEASE_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
DATASET_METADATA = "dataset.json"
PUBLICATION_POLICY_MODE = "integrity-and-mathematics-v2"
NETWORK_ALGORITHM = "gephi-compatible-directed-unweighted-positive-v1"
_csv_cache_lock = threading.RLock()

FileState = tuple[int, int, int, int, int]


def _file_state(value: os.stat_result) -> FileState:
    """Detect in-place edits and atomic replacements, including preserved mtimes."""
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


class ArtifactContractError(RuntimeError):
    pass


ArtifactValidationError = ArtifactContractError


def publication_policy_metadata() -> dict[str, Any]:
    """Block integrity and mathematical failures; retain economic/design diagnostics."""
    return {
        "mode": PUBLICATION_POLICY_MODE,
        "blocking_kinds": {
            "icio": ["结构", "完整性", "数学"],
            "controls": ["结构", "完整性", "数学"],
            "shocks": ["结构", "完整性", "来源", "数学"],
            "outputs": ["structure", "integrity", "mathematical"],
            "regression_inputs": ["structure", "integrity"],
        },
        "nonblocking_policy": "Economic-range and regression-design diagnostics remain disclosures; failed source-account/inverse/identity checks block publication, while rounding within account tolerances and near-boundary warnings remain visible.",
    }


def integrity_check_summary(checks: object, blocking_kinds: list[str]) -> dict[str, Any]:
    if not isinstance(checks, list) or not checks:
        raise ArtifactValidationError("integrity source checks must be a nonempty array")
    blocking = [check for check in checks if isinstance(check, dict) and check.get("kind") in blocking_kinds]
    if not blocking:
        raise ArtifactValidationError(f"integrity policy matched no checks for kinds {blocking_kinds}")
    malformed = [
        check for check in blocking if not isinstance(check.get("name"), str) or type(check.get("passed")) is not bool
    ]
    if malformed:
        raise ArtifactValidationError("integrity source check fields are malformed")
    failures = [str(check["name"]) for check in blocking if not check["passed"]]
    return {
        "passed": not failures,
        "checked": [str(check["name"]) for check in blocking],
        "failures": failures,
    }


def release_integrity_metadata(root: Path, years: list[int]) -> dict[str, Any]:
    """Rebuild the integrity and mathematics decision from persisted diagnostics."""
    policy = publication_policy_metadata()["blocking_kinds"]

    def read(filename: str) -> object:
        try:
            return json.loads((root / filename).read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ArtifactValidationError(f"cannot read integrity source {filename}: {error}") from error

    scopes: dict[str, Any] = {
        "years": {str(year): integrity_check_summary(read(f"qc_{year}.json"), policy["icio"]) for year in years},
        "controls": integrity_check_summary(read("qc_controls.json"), policy["controls"]),
        "shocks": integrity_check_summary(read("qc_shocks.json"), policy["shocks"]),
        "outputs": {
            str(year): integrity_check_summary(read(f"qc_outputs_{year}.json"), policy["outputs"]) for year in years
        },
        "regression_inputs": integrity_check_summary(
            read("qc_regression_inputs.json"),
            policy["regression_inputs"],
        ),
    }
    summaries = [
        *scopes["years"].values(),
        scopes["controls"],
        scopes["shocks"],
        *scopes["outputs"].values(),
        scopes["regression_inputs"],
    ]
    return {
        "status": "passed" if all(summary["passed"] for summary in summaries) else "failed",
        "scopes": scopes,
    }


def _validate_publication_policy_bindings(metadata: dict[str, Any], policy: dict[str, Any]) -> None:
    """Ensure contract-level blocking flags and the release decision use identical kinds."""

    def contract_kinds(items: object, label: str) -> set[str]:
        if not isinstance(items, list):
            raise ArtifactValidationError(f"dataset {label} contract checks are malformed")
        selected = {
            str(item["kind"])
            for item in items
            if isinstance(item, dict) and item.get("publication_blocking") is True and isinstance(item.get("kind"), str)
        }
        if not selected:
            raise ArtifactValidationError(f"dataset {label} contract declares no publication-blocking kinds")
        return selected

    blocking = policy["blocking_kinds"]
    qc_scopes = metadata["qc_contract"]["scopes"]
    expected = {
        "icio": contract_kinds(qc_scopes["icio"], "icio QC"),
        "controls": contract_kinds(qc_scopes["controls"], "controls QC"),
        "shocks": contract_kinds(qc_scopes["shocks"], "shocks QC"),
        "outputs": contract_kinds(metadata["output_qc_contract"]["checks"], "output QC"),
        "regression_inputs": contract_kinds(
            metadata["regression_input_qc_contract"]["checks"],
            "regression input QC",
        ),
    }
    for scope, kinds in expected.items():
        declared = blocking.get(scope)
        if not isinstance(declared, list) or len(declared) != len(set(declared)) or set(declared) != kinds:
            raise ArtifactValidationError(f"dataset publication policy does not match {scope} contract blocking kinds")


def _require_regular_file(path: Path, *, label: str) -> None:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError as exc:
        raise ArtifactValidationError(f"missing {label}: {path}") from exc
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
        raise ArtifactValidationError(f"{label} must be a regular file: {path}")


def validate_artifact(path: Path, *, label: str | None = None) -> None:
    label = label or path.name
    _require_regular_file(path, label=label)
    if path.stat().st_size <= 0:
        raise ArtifactValidationError(f"empty {label}: {path}")


def validate_qc_payload(payload: object, *, scope: str, contract: object) -> list[dict]:
    """Validate an in-memory QC payload through the release artifact error contract."""
    from gvcsim.data import quality

    try:
        quality.validate_qc_contract_metadata(contract)
        assert isinstance(contract, dict)
        return quality.validate_serialized_checks(
            payload,
            scope=scope,
            contract_version=contract["version"],
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ArtifactValidationError(f"invalid {scope} QC payload: {exc}") from exc


def read_qc_artifact(path: Path, *, scope: str, contract: object) -> list[dict]:
    """Read one QC artifact only after validating its versioned exact-set contract."""
    validate_artifact(path, label=f"{scope} QC artifact")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ArtifactValidationError(f"invalid {scope} QC artifact: {path}: {exc}") from exc
    try:
        return validate_qc_payload(payload, scope=scope, contract=contract)
    except ArtifactValidationError as exc:
        raise ArtifactValidationError(f"invalid {scope} QC artifact: {path}: {exc}") from exc


@lru_cache(maxsize=16)
def _dataset_metadata_cached(path_text: str, state: FileState) -> dict[str, Any]:
    del state
    path = Path(path_text)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ArtifactValidationError(f"invalid dataset metadata: {path}") from exc
    if not isinstance(value, dict):
        raise ArtifactValidationError(f"dataset metadata must be an object: {path}")
    return value


def dataset_metadata(processed_dir: Path | None = None) -> dict[str, Any]:
    from gvcsim.config import PROCESSED_DIR

    root = (processed_dir or PROCESSED_DIR).resolve()
    path = root / DATASET_METADATA
    _require_regular_file(path, label="dataset metadata")
    file_stat = path.stat()
    return _dataset_metadata_cached(str(path), _file_state(file_stat))


def _metadata_digest(metadata: dict[str, Any]) -> str:
    payload = {key: value for key, value in metadata.items() if key != METADATA_DIGEST_NAME}
    try:
        canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    except UnicodeError as exc:
        raise ArtifactValidationError("dataset metadata contains invalid Unicode") from exc
    return hashlib.sha256(canonical).hexdigest()


def _validate_metadata_digest(metadata: dict[str, Any]) -> None:
    expected = metadata.get(METADATA_DIGEST_NAME)
    if not isinstance(expected, str) or re.fullmatch(r"[0-9a-f]{64}", expected) is None:
        raise ArtifactValidationError("dataset metadata_sha256 is missing or invalid")
    if not hmac.compare_digest(expected, _metadata_digest(metadata)):
        raise ArtifactValidationError("dataset metadata checksum mismatch")


def release_identity(processed_dir: Path | None = None) -> str:
    metadata = dataset_metadata(processed_dir)
    release_id = metadata.get("release_id")
    if not isinstance(release_id, str) or RELEASE_ID_PATTERN.fullmatch(release_id) is None:
        raise ArtifactValidationError("dataset release_id must be a 32-character lowercase hexadecimal value")
    _validate_metadata_digest(metadata)
    return release_id


def current_artifact_years(processed_dir: Path) -> list[int]:
    candidate_years = {
        int(match.group(1))
        for path in processed_dir.glob("indicators_country_*.csv")
        if (match := re.fullmatch(r"indicators_country_(\d{4})\.csv", path.name))
    }
    return sorted(
        year
        for year in candidate_years
        if all(
            (processed_dir / name).is_file()
            for name in (
                f"qc_{year}.json",
                f"export_exposure_{year}.csv",
                f"indicators_country_{year}.csv",
                f"indicators_industry_{year}.csv",
                f"network_edges_{year}.csv",
            )
        )
    )


def validate_source(path: Path, processed_dir: Path | None = None) -> None:
    del processed_dir
    validate_artifact(path)


def _release_files(processed_dir: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(processed_dir.rglob("*")):
        if path == processed_dir / DATASET_METADATA:
            continue
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError as exc:
            raise ArtifactValidationError(f"artifact disappeared during validation: {path}") from exc
        if stat.S_ISLNK(mode):
            raise ArtifactValidationError(f"artifact tree may not contain symlinks: {path}")
        if stat.S_ISDIR(mode):
            continue
        if not stat.S_ISREG(mode):
            raise ArtifactValidationError(f"artifact must be a regular file: {path}")
        files.append(path)
    return files


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _csv_shape(path: Path) -> tuple[list[str], int]:
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle)
            header = next(reader)
            row_count = sum(1 for _ in reader)
    except (OSError, UnicodeError, csv.Error, StopIteration) as exc:
        raise ArtifactValidationError(f"invalid CSV artifact: {path}") from exc
    if not header or any(not column for column in header):
        raise ArtifactValidationError(f"CSV artifact has an invalid header: {path}")
    return header, row_count


def _json_shape(path: Path) -> str:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ArtifactValidationError(f"invalid JSON artifact: {path}") from exc
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    raise ArtifactValidationError(f"JSON artifact must contain an object or array: {path}")


def _manifest_entry(processed_dir: Path, path: Path) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "path": path.relative_to(processed_dir).as_posix(),
        "bytes": path.stat().st_size,
        ARTIFACT_MANIFEST_ALGORITHM: _sha256(path),
    }
    if path.suffix.lower() == ".csv":
        header, row_count = _csv_shape(path)
        entry.update({"format": "csv", "header": header, "rows": row_count})
    elif path.suffix.lower() == ".json":
        entry.update({"format": "json", "json_type": _json_shape(path)})
    else:
        entry["format"] = "binary"
    return entry


def build_artifact_manifest(processed_dir: Path) -> list[dict[str, Any]]:
    root = processed_dir.resolve()
    return [_manifest_entry(root, path) for path in _release_files(root)]


def _require_manifest_entry(value: Any, index: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ArtifactValidationError(f"artifact manifest entry {index} must be an object")
    path = value.get("path")
    if not isinstance(path, str) or not path or path.startswith("/") or ".." in Path(path).parts:
        raise ArtifactValidationError(f"artifact manifest entry {index} has an invalid path")
    expected_bytes = value.get("bytes")
    if not isinstance(expected_bytes, int) or expected_bytes <= 0:
        raise ArtifactValidationError(f"artifact manifest entry {index} has an invalid byte count")
    digest = value.get(ARTIFACT_MANIFEST_ALGORITHM)
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ArtifactValidationError(f"artifact manifest entry {index} has an invalid SHA-256 digest")
    return value


def _validate_manifest(processed_dir: Path, manifest: Any, *, verify_integrity: bool) -> None:
    if not isinstance(manifest, list) or not manifest:
        raise ArtifactValidationError("dataset artifact_manifest must be a non-empty array")

    entries: dict[str, dict[str, Any]] = {}
    for index, raw_entry in enumerate(manifest):
        entry = _require_manifest_entry(raw_entry, index)
        relative_path = str(entry["path"])
        if relative_path in entries:
            raise ArtifactValidationError(f"duplicate artifact manifest path: {relative_path}")
        entries[relative_path] = entry

    actual_paths = {path.relative_to(processed_dir).as_posix() for path in _release_files(processed_dir)}
    declared_paths = set(entries)
    if actual_paths != declared_paths:
        missing = sorted(declared_paths - actual_paths)
        extra = sorted(actual_paths - declared_paths)
        raise ArtifactValidationError(f"artifact manifest mismatch; missing={missing}, extra={extra}")

    for relative_path, entry in entries.items():
        path = processed_dir / relative_path
        validate_artifact(path, label=f"artifact {relative_path}")
        if path.stat().st_size != entry["bytes"]:
            raise ArtifactValidationError(f"artifact byte count mismatch: {relative_path}")
        if verify_integrity and _sha256(path) != entry[ARTIFACT_MANIFEST_ALGORITHM]:
            raise ArtifactValidationError(f"artifact checksum mismatch: {relative_path}")

        artifact_format = entry.get("format")
        expected_format = (
            "csv" if path.suffix.lower() == ".csv" else "json" if path.suffix.lower() == ".json" else "binary"
        )
        if artifact_format != expected_format:
            raise ArtifactValidationError(f"artifact format does not match its extension: {relative_path}")
        if artifact_format == "csv":
            header, row_count = _csv_shape(path)
            if entry.get("header") != header or entry.get("rows") != row_count:
                raise ArtifactValidationError(f"CSV shape mismatch: {relative_path}")
        elif artifact_format == "json":
            if entry.get("json_type") != _json_shape(path):
                raise ArtifactValidationError(f"JSON shape mismatch: {relative_path}")
        elif artifact_format != "binary":
            raise ArtifactValidationError(f"unsupported artifact format in manifest: {relative_path}")


def _required_paths(metadata: dict[str, Any]) -> list[str]:
    years = metadata.get("years")
    if not isinstance(years, list) or not years or any(not isinstance(year, int) for year in years):
        raise ArtifactValidationError("dataset years must be a non-empty integer array")
    required = [
        "panel_country.csv",
        "panel_industry.csv",
        "controls_country.csv",
        "demo_trade_war_tariffs.csv",
        "tariff_exposure_lookup.csv",
        "qc_controls.json",
        "qc_shocks.json",
        "qc_regression_inputs.json",
    ]
    for year in years:
        required.extend(
            [
                f"qc_{year}.json",
                f"qc_outputs_{year}.json",
                f"export_exposure_{year}.csv",
                f"indicators_country_{year}.csv",
                f"indicators_industry_{year}.csv",
                f"network_edges_{year}.csv",
            ]
        )
    return required


def _validate_release_qc(root: Path, metadata: dict[str, Any]) -> None:
    from gvcsim.data import quality

    contract = metadata.get("qc_contract")
    try:
        quality.validate_qc_contract_metadata(contract)
    except ValueError as exc:
        raise ArtifactValidationError(str(exc)) from exc

    qc_metadata = metadata.get("qc")
    if not isinstance(qc_metadata, dict) or set(qc_metadata) != {"years", "controls", "shocks"}:
        raise ArtifactValidationError("dataset qc metadata must contain years, controls, and shocks")
    years_metadata = qc_metadata.get("years")
    expected_year_keys = {str(year) for year in metadata["years"]}
    if not isinstance(years_metadata, dict) or set(years_metadata) != expected_year_keys:
        raise ArtifactValidationError("dataset qc years do not match dataset years")

    scopes = [
        *[(quality.QC_SCOPE_ICIO, f"qc_{year}.json", years_metadata[str(year)]) for year in metadata["years"]],
        (quality.QC_SCOPE_CONTROLS, "qc_controls.json", qc_metadata["controls"]),
        (quality.QC_SCOPE_SHOCKS, "qc_shocks.json", qc_metadata["shocks"]),
    ]
    for scope, filename, expected_summary in scopes:
        if not isinstance(expected_summary, dict) or type(expected_summary.get("override")) is not bool:
            raise ArtifactValidationError(f"dataset {scope} QC summary is invalid")
        if expected_summary["override"]:
            raise ArtifactValidationError("dataset QC override is forbidden by the publication policy")
        checks = read_qc_artifact(root / filename, scope=scope, contract=contract)
        actual_summary = quality.summarize_serialized_checks(
            checks,
            override=expected_summary["override"],
        )
        if actual_summary != expected_summary:
            raise ArtifactValidationError(f"dataset {scope} QC summary does not match {filename}")


def _validate_persisted_raw_dimensions(payload: object, years: list[int]) -> None:
    """Cheap published-shape check; compute already parsed the raw tables."""
    if not isinstance(payload, dict):
        raise ArtifactValidationError("dataset raw_dimensions must be an object")
    expected_keys = {
        "metadata_version",
        "contract_id",
        "contract_version",
        "countries",
        "industries",
        "final_demand_categories",
        "rows",
        "columns",
        "country_codes_sha256",
        "industry_codes_sha256",
        "final_demand_codes_sha256",
        "layout_sha256",
        "years",
    }
    if set(payload) != expected_keys:
        raise ArtifactValidationError("dataset raw_dimensions is missing required fields")
    if payload.get("metadata_version") != 2:
        raise ArtifactValidationError("dataset raw_dimensions metadata_version is unsupported")
    year_map = payload.get("years")
    if not isinstance(year_map, dict) or set(year_map) != {str(year) for year in years}:
        raise ArtifactValidationError("dataset raw_dimensions years do not match dataset years")
    for year in years:
        entry = year_map[str(year)]
        if not isinstance(entry, dict) or set(entry) != {"source_file", "source_bytes", "source_sha256"}:
            raise ArtifactValidationError(f"dataset raw_dimensions source binding is invalid for {year}")
        source_file = entry.get("source_file")
        if (
            not isinstance(source_file, str)
            or Path(source_file).name != source_file
            or re.fullmatch(rf"ICIO.*_{year}\.csv", source_file) is None
        ):
            raise ArtifactValidationError(f"dataset raw_dimensions source filename is invalid for {year}")
        if type(entry.get("source_bytes")) is not int or entry["source_bytes"] <= 0:
            raise ArtifactValidationError(f"dataset raw_dimensions source byte count is invalid for {year}")
        source_sha256 = entry.get("source_sha256")
        if not isinstance(source_sha256, str) or re.fullmatch(r"[0-9a-f]{64}", source_sha256) is None:
            raise ArtifactValidationError(f"dataset raw_dimensions source SHA-256 is invalid for {year}")


def _validate_release_output_qc(root: Path, metadata: dict[str, Any]) -> None:
    """Require published output QC files and matching summaries; do not recompute."""
    from gvcsim.data import output_quality

    contract = metadata.get("output_qc_contract")
    try:
        output_quality.validate_output_qc_contract_metadata(contract)
    except ValueError as exc:
        raise ArtifactValidationError(str(exc)) from exc

    output_metadata = metadata.get("output_qc")
    expected_year_keys = {str(year) for year in metadata["years"]}
    if not isinstance(output_metadata, dict) or set(output_metadata) != {"years"}:
        raise ArtifactValidationError("dataset output_qc metadata must contain only yearly summaries")
    years_metadata = output_metadata.get("years")
    if not isinstance(years_metadata, dict) or set(years_metadata) != expected_year_keys:
        raise ArtifactValidationError("dataset output QC years do not match dataset years")

    for year in metadata["years"]:
        path = root / f"qc_outputs_{year}.json"
        try:
            persisted = output_quality.read_output_qc(path, contract=contract)
            expected_summary = years_metadata[str(year)]
            output_quality.validate_output_summary(expected_summary, persisted)
        except (KeyError, TypeError, ValueError, output_quality.OutputQualityError) as exc:
            raise ArtifactValidationError(f"invalid output QC for year {year}: {exc}") from exc


def _validate_release_regression_input_qc(root: Path, metadata: dict[str, Any]) -> None:
    """Require the published regression-input QC file; do not recompute."""
    from gvcsim.data import regression_quality

    contract = metadata.get("regression_input_qc_contract")
    try:
        regression_quality.validate_regression_input_qc_contract_metadata(contract)
        persisted = regression_quality.read_regression_input_qc(
            root / regression_quality.REGRESSION_INPUT_QC_FILE,
            contract=contract,
        )
        expected_summary = metadata.get("regression_input_qc")
        regression_quality.validate_regression_input_summary(expected_summary, persisted)
    except (KeyError, TypeError, ValueError, regression_quality.RegressionInputQualityError) as exc:
        raise ArtifactValidationError(f"invalid regression input QC: {exc}") from exc
    if not isinstance(expected_summary, dict):
        raise ArtifactValidationError("regression input QC summary is invalid")


def validate_release(processed_dir: Path | None = None, *, verify_integrity: bool = True) -> dict[str, Any]:
    from gvcsim.config import COURSE_RELEASE, PROCESSED_DIR
    from gvcsim.data.citations import DataSourcesValidationError, validate_data_sources
    from gvcsim.shocks import validate_shock_contract_metadata

    root = (processed_dir or PROCESSED_DIR).resolve()
    metadata = dataset_metadata(root)
    if metadata.get("course_release") != COURSE_RELEASE:
        raise ArtifactValidationError(
            f"dataset course_release mismatch: expected {COURSE_RELEASE}, got {metadata.get('course_release')}"
        )
    if metadata.get("artifact_contract_version") != ARTIFACT_CONTRACT_VERSION:
        raise ArtifactValidationError(
            f"artifact contract mismatch: expected {ARTIFACT_CONTRACT_VERSION}, "
            f"got {metadata.get('artifact_contract_version')}"
        )
    release_identity(root)
    for field in (
        "generated_at",
        "data_sources",
        "raw_dimensions",
        "qc",
        "qc_contract",
        "shock_contract",
        "output_qc",
        "output_qc_contract",
        "regression_input_qc",
        "regression_input_qc_contract",
        "network_algorithm",
        "publication_policy",
        "integrity",
    ):
        if field not in metadata:
            raise ArtifactValidationError(f"dataset metadata is missing {field}")
    try:
        validate_data_sources(metadata["data_sources"])
        _validate_persisted_raw_dimensions(metadata["raw_dimensions"], metadata["years"])
        validate_shock_contract_metadata(metadata["shock_contract"])
    except (DataSourcesValidationError, OSError, TypeError, ValueError) as exc:
        raise ArtifactValidationError(f"dataset provenance/raw dimensions invalid: {exc}") from exc

    manifest = metadata.get(ARTIFACT_MANIFEST_NAME)
    if not isinstance(manifest, list):
        raise ArtifactValidationError("dataset artifact_manifest must be a non-empty array")
    _validate_manifest(root, manifest, verify_integrity=verify_integrity)
    declared_paths = {entry["path"] for entry in manifest if isinstance(entry, dict) and "path" in entry}
    missing_required = sorted(set(_required_paths(metadata)) - declared_paths)
    if missing_required:
        raise ArtifactValidationError(f"release is missing required artifacts: {missing_required}")
    _validate_release_qc(root, metadata)
    _validate_release_output_qc(root, metadata)
    _validate_release_regression_input_qc(root, metadata)
    expected_policy = publication_policy_metadata()
    if metadata["publication_policy"] != expected_policy:
        raise ArtifactValidationError("dataset publication policy is unsupported or incomplete")
    _validate_publication_policy_bindings(metadata, expected_policy)
    actual_integrity = release_integrity_metadata(root, metadata["years"])
    if metadata["integrity"] != actual_integrity:
        raise ArtifactValidationError("dataset integrity decision does not match persisted diagnostics")
    if actual_integrity["status"] != "passed":
        raise ArtifactValidationError("dataset integrity checks failed")
    return {"release_id": metadata["release_id"], "files": len(declared_paths), "years": len(metadata["years"])}


@lru_cache(maxsize=8)
def _validate_release_cached(
    root_text: str, release_id: str, state: tuple[tuple[str, FileState], ...]
) -> dict[str, Any]:
    del release_id, state
    return validate_release(Path(root_text), verify_integrity=True)


_VALIDATION_LOCK = threading.Lock()


def validate_release_cached(processed_dir: Path | None = None) -> dict[str, Any]:
    from gvcsim.config import PROCESSED_DIR

    root = (processed_dir or PROCESSED_DIR).resolve()
    identity = release_identity(root)
    state = tuple(
        (path.relative_to(root).as_posix(), _file_state(metadata))
        for path in [root / DATASET_METADATA, *_release_files(root)]
        for metadata in (path.lstat(),)
    )
    with _VALIDATION_LOCK:
        return _validate_release_cached(str(root), identity, state)


def clear_artifact_caches() -> None:
    _dataset_metadata_cached.cache_clear()
    _validate_release_cached.cache_clear()
    _cached_csv.cache_clear()


def clear_release_validation_cache() -> None:
    clear_artifact_caches()


@lru_cache(maxsize=32)
def _cached_csv(path_text: str, state: FileState) -> pd.DataFrame:
    del state
    return pd.read_csv(path_text, keep_default_na=False, na_values=[""])


def read_csv_artifact(path: Path, *, require_current: bool = False) -> pd.DataFrame:
    del require_current
    validate_artifact(path)
    resolved = path.resolve()
    file_stat = resolved.stat()
    with _csv_cache_lock:
        return _cached_csv(str(resolved), _file_state(file_stat))


def write_dataset_metadata(processed_dir: Path, metadata: dict[str, Any]) -> Path:
    from gvcsim.data.citations import validate_data_sources

    root = processed_dir.resolve()
    validate_data_sources(metadata.get("data_sources"))
    release_id = metadata.get("release_id")
    if not isinstance(release_id, str) or RELEASE_ID_PATTERN.fullmatch(release_id) is None:
        raise ArtifactValidationError("release metadata requires a valid release_id")
    payload = dict(metadata)
    payload["artifact_contract_version"] = ARTIFACT_CONTRACT_VERSION
    payload[ARTIFACT_MANIFEST_NAME] = build_artifact_manifest(root)
    payload[METADATA_DIGEST_NAME] = _metadata_digest(payload)
    path = root / DATASET_METADATA
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path
