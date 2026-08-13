from __future__ import annotations

import csv
import hashlib
import hmac
import json
import re
import stat
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any

import pandas as pd


ARTIFACT_CONTRACT_VERSION = 3
ARTIFACT_MANIFEST_ALGORITHM = "sha256"
ARTIFACT_MANIFEST_NAME = "artifact_manifest"
METADATA_DIGEST_NAME = "metadata_sha256"
RELEASE_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
DATASET_METADATA = "dataset.json"
NETWORK_ALGORITHM = "gephi-compatible-directed-unweighted-positive-v1"
_csv_cache_lock = threading.RLock()


class ArtifactContractError(RuntimeError):
    pass


ArtifactValidationError = ArtifactContractError


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


@lru_cache(maxsize=16)
def _dataset_metadata_cached(path_text: str, size: int, mtime_ns: int, ctime_ns: int, inode: int) -> dict[str, Any]:
    del size, mtime_ns, ctime_ns, inode
    path = Path(path_text)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
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
    return _dataset_metadata_cached(
        str(path), file_stat.st_size, file_stat.st_mtime_ns, file_stat.st_ctime_ns, file_stat.st_ino
    )


def _metadata_digest(metadata: dict[str, Any]) -> str:
    payload = {key: value for key, value in metadata.items() if key != METADATA_DIGEST_NAME}
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
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
        if path.name == "dataset.json":
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
        "qc_controls.json",
        "qc_shocks.json",
    ]
    for year in years:
        required.extend(
            [
                f"qc_{year}.json",
                f"export_exposure_{year}.csv",
                f"indicators_country_{year}.csv",
                f"indicators_industry_{year}.csv",
                f"network_edges_{year}.csv",
            ]
        )
    return required


def validate_release(processed_dir: Path | None = None, *, verify_integrity: bool = True) -> dict[str, Any]:
    from gvcsim.config import COURSE_RELEASE, PROCESSED_DIR

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
    for field in ("generated_at", "data_sources", "qc", "network_algorithm"):
        if field not in metadata:
            raise ArtifactValidationError(f"dataset metadata is missing {field}")

    manifest = metadata.get(ARTIFACT_MANIFEST_NAME)
    if not isinstance(manifest, list):
        raise ArtifactValidationError("dataset artifact_manifest must be a non-empty array")
    _validate_manifest(root, manifest, verify_integrity=verify_integrity)
    declared_paths = {entry["path"] for entry in manifest if isinstance(entry, dict) and "path" in entry}
    missing_required = sorted(set(_required_paths(metadata)) - declared_paths)
    if missing_required:
        raise ArtifactValidationError(f"release is missing required artifacts: {missing_required}")
    return {"release_id": metadata["release_id"], "files": len(declared_paths), "years": len(metadata["years"])}


@lru_cache(maxsize=8)
def _validate_release_cached(
    root_text: str, release_id: str, state: tuple[tuple[str, int, int, int, int, int, int], ...]
) -> dict[str, Any]:
    del release_id, state
    return validate_release(Path(root_text), verify_integrity=True)


_VALIDATION_LOCK = threading.Lock()


def validate_release_cached(processed_dir: Path | None = None) -> dict[str, Any]:
    from gvcsim.config import PROCESSED_DIR

    root = (processed_dir or PROCESSED_DIR).resolve()
    identity = release_identity(root)
    state = tuple(
        (
            path.relative_to(root).as_posix(),
            metadata.st_dev,
            metadata.st_ino,
            metadata.st_mode,
            metadata.st_size,
            metadata.st_mtime_ns,
            metadata.st_ctime_ns,
        )
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
def _cached_csv(path_text: str, size: int, mtime_ns: int) -> pd.DataFrame:
    del size, mtime_ns
    return pd.read_csv(path_text, keep_default_na=False, na_values=[""])


def read_csv_artifact(path: Path, *, require_current: bool = False) -> pd.DataFrame:
    del require_current
    validate_artifact(path)
    resolved = path.resolve()
    file_stat = resolved.stat()
    with _csv_cache_lock:
        return _cached_csv(str(resolved), file_stat.st_size, file_stat.st_mtime_ns)


def write_dataset_metadata(processed_dir: Path, metadata: dict[str, Any]) -> Path:
    root = processed_dir.resolve()
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
