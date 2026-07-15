"""预计算产物契约与只读 CSV 缓存。

算法切换后，只有登记在 ``artifact_manifest.json`` 且摘要匹配的文件才允许
进入 API、报告和回归。这样旧网络 CSV、部分重算形成的混合产物或同步损坏都
会明确失败，不会被静默解释为当前 Gephi-compatible 口径。
"""

from __future__ import annotations

import hashlib
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Iterable

import pandas as pd

ARTIFACT_MANIFEST = "artifact_manifest.json"
ARTIFACT_SCHEMA_VERSION = 2
NETWORK_ALGORITHM = "gephi-compatible-directed-unweighted-positive-v1"


class ArtifactContractError(RuntimeError):
    """产物缺少当前契约、版本不符或文件摘要不匹配。"""


def artifact_contract() -> dict[str, str | int]:
    """返回可公开给 API/部署检查的稳定契约标识。"""
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "network_algorithm": NETWORK_ALGORITHM,
    }


@lru_cache(maxsize=16)
def _cached_manifest(path_str: str, mtime_ns: int) -> dict:
    """解析 manifest；``mtime_ns`` 仅用于缓存失效。"""
    del mtime_ns
    try:
        with open(path_str, encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise ArtifactContractError("预计算产物清单无法解析，请重新运行 `uv run gvcsim compute`") from error
    if not isinstance(payload, dict):
        raise ArtifactContractError("预计算产物清单格式无效，请重新运行 `uv run gvcsim compute`")
    return payload


def _load_manifest(processed_dir: Path) -> dict:
    path = processed_dir / ARTIFACT_MANIFEST
    if not path.exists():
        raise ArtifactContractError(
            f"缺少 {ARTIFACT_MANIFEST}，现有 CSV 的算法版本未知；请重新运行 `uv run gvcsim compute`"
        )
    payload = _cached_manifest(str(path), path.stat().st_mtime_ns)
    expected = artifact_contract()
    if payload.get("schema_version") != expected["schema_version"]:
        raise ArtifactContractError("预计算产物 schema 已过期，请重新运行 `uv run gvcsim compute`")
    if payload.get("network_algorithm") != expected["network_algorithm"]:
        raise ArtifactContractError("网络产物不是当前 Gephi-compatible 口径，请重新运行 `uv run gvcsim compute`")
    if not isinstance(payload.get("files"), dict):
        raise ArtifactContractError("预计算产物清单缺少 files 索引，请重新运行 `uv run gvcsim compute`")
    return payload


@lru_cache(maxsize=64)
def _cached_sha256(path_str: str, mtime_ns: int, size_bytes: int) -> str:
    """按路径、mtime 与大小缓存文件摘要，避免 API 热路径重复扫描大面板。"""
    del mtime_ns, size_bytes
    return _sha256(Path(path_str))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_record(path: Path) -> dict[str, str | int]:
    stat = path.stat()
    return {
        "size_bytes": stat.st_size,
        "sha256": _sha256(path),
    }


def register_artifacts(processed_dir: Path, filenames: Iterable[str]) -> None:
    """把本次成功写出的文件登记为当前契约，并原子替换 manifest。

    若旧 manifest 缺失或版本不同，不继承任何旧条目；随后构建面板时也只会
    使用已按当前算法重新登记的年度输入。
    """
    processed_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = processed_dir / ARTIFACT_MANIFEST
    files: dict[str, dict[str, str | int]] = {}
    if manifest_path.exists():
        try:
            files = dict(_load_manifest(processed_dir)["files"])
        except ArtifactContractError:
            files = {}

    for filename in filenames:
        path = processed_dir / filename
        if not path.is_file():
            raise FileNotFoundError(path)
        files[filename] = _file_record(path)

    payload = {**artifact_contract(), "files": dict(sorted(files.items()))}
    temp_path = processed_dir / f".{ARTIFACT_MANIFEST}.tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    temp_path.replace(manifest_path)
    _cached_manifest.cache_clear()
    _cached_sha256.cache_clear()


def validate_artifact(path: Path) -> None:
    """验证一个 processed 文件已登记且内容摘要未变化。"""
    if not path.is_file():
        raise FileNotFoundError(path)
    payload = _load_manifest(path.parent)
    record = payload["files"].get(path.name)
    if not isinstance(record, dict):
        raise ArtifactContractError(f"{path.name} 未按当前算法登记，请重新运行 `uv run gvcsim compute`")
    stat = path.stat()
    if record.get("size_bytes") != stat.st_size:
        raise ArtifactContractError(f"{path.name} 与产物清单大小不一致，请重新计算或重新同步完整产物")
    digest = _cached_sha256(str(path), stat.st_mtime_ns, stat.st_size)
    if record.get("sha256") != digest:
        raise ArtifactContractError(f"{path.name} 与产物清单摘要不一致，请重新计算或重新同步完整产物")


def current_artifact_years(processed_dir: Path) -> list[int]:
    """返回逐年五类产物均已登记并存在的当前算法年份。"""
    payload = _load_manifest(processed_dir)
    files = payload["files"]
    candidate_years = {
        int(match.group(1))
        for name in files
        if (match := re.fullmatch(r"indicators_country_(\d{4})\.csv", name)) and (processed_dir / name).is_file()
    }
    return sorted(
        year
        for year in candidate_years
        if all(
            name in files and (processed_dir / name).is_file()
            for name in (
                f"qc_{year}.json",
                f"export_exposure_{year}.csv",
                f"indicators_country_{year}.csv",
                f"indicators_industry_{year}.csv",
                f"network_edges_{year}.csv",
            )
        )
    )


@lru_cache(maxsize=32)
def _cached_csv(path_str: str, mtime_ns: int) -> pd.DataFrame:
    """解析一份 CSV；``mtime_ns`` 只用于缓存失效。"""
    return pd.read_csv(path_str, keep_default_na=False, na_values=[""])


def read_csv_artifact(path: Path, *, require_current: bool = False) -> pd.DataFrame:
    """读取并缓存 CSV；生产读取可要求其满足当前产物契约。"""
    if not path.exists():
        raise FileNotFoundError(path)
    if require_current:
        validate_artifact(path)
    return _cached_csv(str(path), path.stat().st_mtime_ns)
