"""Fixed-directory artifact access and versioned release integrity checks."""

from __future__ import annotations

import csv
import hashlib
import json
import re
import stat
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any

import pandas as pd

DATASET_METADATA = "dataset.json"
ARTIFACT_CONTRACT_VERSION = 2
NETWORK_ALGORITHM = "gephi-compatible-directed-unweighted-positive-v1"
_HASH_CHUNK_SIZE = 1024 * 1024
_MAX_JSON_BYTES = 16 * 1024 * 1024
_TRANSIENT_RELEASE_NAMES = {".processed-compute.lock", ".processed-publication.json"}
_csv_cache_lock = threading.RLock()


class ArtifactContractError(RuntimeError):
    pass


def dataset_metadata(processed_dir: Path | None = None) -> dict[str, Any]:
    from gvcsim.config import PROCESSED_DIR

    path = (processed_dir or PROCESSED_DIR) / DATASET_METADATA
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ArtifactContractError("缺少可用的 dataset.json，请重新运行 `uv run gvcsim compute`") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("years"), list):
        raise ArtifactContractError("dataset.json 格式无效，请重新运行 compute")
    return payload


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


def validate_artifact(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(path)


def validate_source(path: Path, processed_dir: Path | None = None) -> None:
    del processed_dir
    if not path.is_file():
        raise FileNotFoundError(path)


def _is_transient_release_name(name: str) -> bool:
    return name in _TRANSIENT_RELEASE_NAMES


def _release_files(directory: Path) -> dict[str, Path]:
    files: dict[str, Path] = {}
    try:
        entries = list(directory.iterdir())
    except OSError as error:
        raise ArtifactContractError("固定产物目录不可读") from error
    for path in entries:
        if path.name == DATASET_METADATA or _is_transient_release_name(path.name):
            continue
        try:
            mode = path.lstat().st_mode
        except OSError as error:
            raise ArtifactContractError(f"固定产物不可读取:{path.name}") from error
        if stat.S_ISLNK(mode):
            raise ArtifactContractError(f"固定产物不能是符号链接:{path.name}")
        if not stat.S_ISREG(mode):
            raise ArtifactContractError(f"固定产物必须是顶层普通文件:{path.name}")
        files[path.name] = path
    return files


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(_HASH_CHUNK_SIZE), b""):
                digest.update(chunk)
    except OSError as error:
        raise ArtifactContractError(f"无法计算固定产物摘要:{path.name}") from error
    return digest.hexdigest()


def release_identity(processed_dir: Path | None = None) -> str:
    """Return an opaque identity that changes with every dataset publication."""
    from gvcsim.config import PROCESSED_DIR

    directory = processed_dir or PROCESSED_DIR
    metadata_path = directory / DATASET_METADATA
    try:
        mode = metadata_path.lstat().st_mode
    except OSError as error:
        raise ArtifactContractError("固定产物入口不可用") from error
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
        raise ArtifactContractError("dataset.json 必须是普通文件")
    return _sha256(metadata_path)


def _csv_shape(path: Path) -> tuple[list[str], int]:
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle)
            try:
                columns = next(reader)
            except StopIteration as error:
                raise ArtifactContractError(f"CSV 固定产物为空:{path.name}") from error
            rows = sum(1 for _row in reader)
    except (OSError, UnicodeError, csv.Error) as error:
        if isinstance(error, ArtifactContractError):
            raise
        raise ArtifactContractError(f"CSV 固定产物无法解析:{path.name}") from error
    return columns, rows


def _json_shape(path: Path) -> tuple[str, int | None]:
    if path.stat().st_size > _MAX_JSON_BYTES:
        raise ArtifactContractError(f"JSON 固定产物超过结构检查上限:{path.name}")
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ArtifactContractError(f"JSON 固定产物无法解析:{path.name}") from error
    if isinstance(payload, list):
        return "array", len(payload)
    if isinstance(payload, dict):
        return "object", len(payload)
    if payload is None:
        return "null", None
    if isinstance(payload, bool):
        return "boolean", None
    if isinstance(payload, (int, float)):
        return "number", None
    if isinstance(payload, str):
        return "string", None
    raise ArtifactContractError(f"JSON 固定产物顶层类型无效:{path.name}")


def _manifest_entry(path: Path) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "sha256": _sha256(path),
        "size_bytes": path.stat().st_size,
    }
    suffix = path.suffix.lower()
    if suffix == ".csv":
        columns, rows = _csv_shape(path)
        entry.update({"kind": "csv", "columns": columns, "rows": rows})
    elif suffix == ".json":
        top_level, items = _json_shape(path)
        entry.update({"kind": "json", "top_level": top_level})
        if items is not None:
            entry["items"] = items
    else:
        entry["kind"] = "binary"
    return entry


def build_artifact_manifest(processed_dir: Path) -> dict[str, dict[str, Any]]:
    """Describe every top-level release file without materializing large CSVs."""
    return {name: _manifest_entry(path) for name, path in sorted(_release_files(processed_dir).items())}


def _require_manifest_entry(name: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ArtifactContractError(f"产物清单条目格式无效:{name}")
    required = {"sha256", "size_bytes", "kind"}
    if not required.issubset(value):
        raise ArtifactContractError(f"产物清单条目缺少字段:{name}")
    digest = value.get("sha256")
    size = value.get("size_bytes")
    kind = value.get("kind")
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ArtifactContractError(f"产物清单 SHA-256 无效:{name}")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise ArtifactContractError(f"产物清单文件大小无效:{name}")
    if kind not in {"csv", "json", "binary"}:
        raise ArtifactContractError(f"产物清单类型无效:{name}")
    if kind == "csv":
        columns = value.get("columns")
        rows = value.get("rows")
        if not isinstance(columns, list) or any(not isinstance(column, str) for column in columns):
            raise ArtifactContractError(f"产物清单 CSV 列无效:{name}")
        if isinstance(rows, bool) or not isinstance(rows, int) or rows < 0:
            raise ArtifactContractError(f"产物清单 CSV 行数无效:{name}")
    if kind == "json":
        if value.get("top_level") not in {"array", "object", "null", "boolean", "number", "string"}:
            raise ArtifactContractError(f"产物清单 JSON 顶层类型无效:{name}")
        items = value.get("items")
        if items is not None and (isinstance(items, bool) or not isinstance(items, int) or items < 0):
            raise ArtifactContractError(f"产物清单 JSON 条目数无效:{name}")
        if value.get("top_level") in {"array", "object"} and items is None:
            raise ArtifactContractError(f"产物清单 JSON 缺少条目数:{name}")
        if value.get("top_level") not in {"array", "object"} and "items" in value:
            raise ArtifactContractError(f"产物清单 JSON 条目数不适用于当前类型:{name}")
    return value


def _validate_v2_manifest(directory: Path, metadata: dict[str, Any]) -> None:
    manifest = metadata.get("artifacts")
    if not isinstance(manifest, dict) or any(not isinstance(name, str) or not name for name in manifest):
        raise ArtifactContractError("dataset.json 的 v2 产物清单格式无效")
    actual = _release_files(directory)
    declared_names = set(manifest)
    actual_names = set(actual)
    if declared_names != actual_names:
        missing = sorted(declared_names - actual_names)
        extra = sorted(actual_names - declared_names)
        detail = []
        if missing:
            detail.append("缺失:" + "、".join(missing))
        if extra:
            detail.append("未登记:" + "、".join(extra))
        raise ArtifactContractError("v2 固定产物文件集合不一致(" + ";".join(detail) + ")")
    for name in sorted(actual):
        expected = _require_manifest_entry(name, manifest[name])
        path = actual[name]
        expected_kind = (
            "csv" if path.suffix.lower() == ".csv" else "json" if path.suffix.lower() == ".json" else "binary"
        )
        if expected["kind"] != expected_kind:
            raise ArtifactContractError(f"固定产物类型与扩展名不匹配:{name}")
        if path.stat().st_size != expected["size_bytes"]:
            raise ArtifactContractError(f"固定产物文件大小不匹配:{name}")
        if _sha256(path) != expected["sha256"]:
            raise ArtifactContractError(f"固定产物 SHA-256 不匹配:{name}")
        if expected["kind"] == "csv":
            columns, rows = _csv_shape(path)
            if columns != expected["columns"]:
                raise ArtifactContractError(f"固定产物 CSV 列不匹配:{name}")
            if rows != expected["rows"]:
                raise ArtifactContractError(f"固定产物 CSV 行数不匹配:{name}")
        elif expected["kind"] == "json":
            top_level, items = _json_shape(path)
            if top_level != expected["top_level"]:
                raise ArtifactContractError(f"固定产物 JSON 顶层类型不匹配:{name}")
            if items != expected.get("items"):
                raise ArtifactContractError(f"固定产物 JSON 条目数不匹配:{name}")


def validate_release(
    processed_dir: Path | None = None,
    *,
    validate_sources: bool = False,
    verify_integrity: bool = True,
    allow_legacy: bool = False,
) -> dict[str, int]:
    del validate_sources
    from gvcsim.config import COURSE_RELEASE, PROCESSED_DIR

    directory = processed_dir or PROCESSED_DIR
    metadata_path = directory / DATASET_METADATA
    try:
        metadata_mode = metadata_path.lstat().st_mode
    except OSError as error:
        raise ArtifactContractError("缺少可用的 dataset.json，请重新运行 `uv run gvcsim compute`") from error
    if stat.S_ISLNK(metadata_mode) or not stat.S_ISREG(metadata_mode):
        raise ArtifactContractError("dataset.json 必须是普通文件")
    metadata = dataset_metadata(directory)
    if metadata.get("course_release") != COURSE_RELEASE:
        raise ArtifactContractError(f"固定产物属于其他课程发布，当前需要 {COURSE_RELEASE}；请重新运行 compute")
    years = current_artifact_years(directory)
    try:
        declared = sorted({int(year) for year in metadata["years"]})
    except (TypeError, ValueError) as error:
        raise ArtifactContractError("dataset.json 年份格式无效，请重新运行 compute") from error
    if not declared or years != declared:
        raise ArtifactContractError("固定产物目录不完整，请重新运行 compute")
    required = (
        "panel_country.csv",
        "panel_industry.csv",
        "controls_country.csv",
        "demo_trade_war_tariffs.csv",
        "qc_controls.json",
        "qc_shocks.json",
    )
    missing = [name for name in required if not (directory / name).is_file()]
    if missing:
        raise ArtifactContractError("缺少固定产物:" + "、".join(missing))

    version = metadata.get("artifact_contract_version")
    if version is None:
        if "artifacts" in metadata:
            raise ArtifactContractError("dataset.json 含产物清单但缺少 artifact_contract_version")
        if not allow_legacy:
            raise ArtifactContractError("不可变发布必须使用 v2 产物契约，请重新运行 compute")
    elif isinstance(version, bool) or version != ARTIFACT_CONTRACT_VERSION:
        raise ArtifactContractError(f"不支持的产物契约版本:{version}")
    elif verify_integrity:
        _validate_v2_manifest(directory, metadata)
    elif not isinstance(metadata.get("artifacts"), dict):
        # Even a shallow v2 read must not silently accept a missing manifest.
        raise ArtifactContractError("dataset.json 的 v2 产物清单格式无效")

    return {"files": len(list(directory.glob("*"))), "years": len(years)}


@lru_cache(maxsize=16)
def _cached_release_validation(
    resolved_directory: str,
    release_state: tuple[tuple[str, int, int, int, int, int, int], ...],
    allow_legacy: bool,
) -> dict[str, int]:
    del release_state
    return validate_release(Path(resolved_directory), verify_integrity=True, allow_legacy=allow_legacy)


def _release_cache_state(directory: Path) -> tuple[tuple[str, int, int, int, int, int, int], ...]:
    """Cheaply notice any top-level release mutation before reusing a deep check."""
    try:
        paths = sorted(directory.iterdir(), key=lambda path: path.name)
        return tuple(
            (
                path.name,
                metadata.st_dev,
                metadata.st_ino,
                metadata.st_mode,
                metadata.st_size,
                metadata.st_mtime_ns,
                metadata.st_ctime_ns,
            )
            for path in paths
            for metadata in (path.lstat(),)
        )
    except OSError as error:
        raise ArtifactContractError("固定产物入口不可用") from error


def validate_release_cached(
    processed_dir: Path | None = None,
    *,
    allow_legacy: bool = False,
) -> dict[str, int]:
    """Deep-check once per release identity and explicit rollout policy."""
    from gvcsim.config import PROCESSED_DIR

    directory = processed_dir or PROCESSED_DIR
    try:
        resolved = directory.resolve(strict=True)
    except OSError as error:
        raise ArtifactContractError("固定产物入口不可用") from error
    result = _cached_release_validation(
        str(resolved),
        _release_cache_state(resolved),
        allow_legacy,
    )
    return dict(result)


def clear_release_validation_cache() -> None:
    _cached_release_validation.cache_clear()


@lru_cache(maxsize=32)
def _cached_csv(path_str: str, mtime_ns: int) -> pd.DataFrame:
    del mtime_ns
    return pd.read_csv(path_str, keep_default_na=False, na_values=[""])


def read_csv_artifact(path: Path, *, require_current: bool = False) -> pd.DataFrame:
    del require_current
    validate_artifact(path)
    resolved = path.resolve()
    with _csv_cache_lock:
        return _cached_csv(str(resolved), resolved.stat().st_mtime_ns)


def write_dataset_metadata(processed_dir: Path, years: list[int], *, metadata: dict[str, Any] | None = None) -> None:
    supplied = metadata or {}
    payload = {
        "years": sorted(set(years)),
        "network_algorithm": NETWORK_ALGORITHM,
        **supplied,
        "artifact_contract_version": ARTIFACT_CONTRACT_VERSION,
        "artifacts": build_artifact_manifest(processed_dir),
    }
    (processed_dir / DATASET_METADATA).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
