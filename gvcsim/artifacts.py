"""预计算产物契约与只读 CSV 缓存。

算法切换后，只有登记在 ``artifact_manifest.json`` 且摘要匹配的文件才允许
进入 API、报告和回归。这样旧网络 CSV、部分重算形成的混合产物或同步损坏都
会明确失败，不会被静默解释为当前 Gephi-compatible 口径。
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import platform
import re
import subprocess
import sys
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

import pandas as pd

ARTIFACT_MANIFEST = "artifact_manifest.json"
MANIFEST_HISTORY_DIR = "manifest_history"
ARTIFACT_SCHEMA_VERSION = 3
NETWORK_ALGORITHM = "gephi-compatible-directed-unweighted-positive-v1"
_csv_cache_lock = threading.RLock()


class ArtifactContractError(RuntimeError):
    """产物缺少当前契约、版本不符或文件摘要不匹配。"""


def artifact_contract() -> dict[str, str | int]:
    """返回可公开给 API/部署检查的稳定契约标识。"""
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "network_algorithm": NETWORK_ALGORITHM,
    }


def manifest_id(processed_dir: Path | None = None) -> str:
    """当前产物集合的稳定标识:内容变了它就变。

    实验会话绑定该 ID。重新 compute、换算法或任何一个产物文件被改动后,
    ID 随之改变,旧会话里保存的实验结果即可被判定为过期,而不是被静默
    当作仍然对应当前数据。
    """
    from gvcsim.config import PROCESSED_DIR

    payload = _load_manifest(processed_dir or PROCESSED_DIR)
    # 只取影响计算结果的字段;文件顺序归一,避免同一份产物得到不同 ID。
    digest_source = json.dumps(
        {
            "schema_version": payload["schema_version"],
            "network_algorithm": payload["network_algorithm"],
            "files": {name: record.get("sha256") for name, record in sorted(payload["files"].items())},
            "sources": {name: record.get("sha256") for name, record in sorted((payload.get("sources") or {}).items())},
            "qc": payload.get("qc") or {},
            "build": payload.get("build") or {},
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(digest_source.encode("utf-8")).hexdigest()[:16]


def manifest_provenance(processed_dir: Path | None = None) -> dict[str, Any]:
    """返回报告/API 可披露的完整产物来源和 QC 发布状态。"""
    from gvcsim.config import PROCESSED_DIR

    payload = _load_manifest(processed_dir or PROCESSED_DIR)
    return {
        "manifest_id": manifest_id(processed_dir or PROCESSED_DIR),
        "schema_version": payload["schema_version"],
        "network_algorithm": payload["network_algorithm"],
        "qc": payload.get("qc") or {},
        "sources": payload.get("sources") or {},
        "build": payload.get("build") or {},
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


def _deep_merge(base: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in incoming.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _git_head(root: Path) -> str | None:
    """让 Git 自己解析当前 commit，兼容 packed refs、detached HEAD 与 worktree。"""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    commit = result.stdout.strip()
    return commit if re.fullmatch(r"[0-9a-fA-F]{40,64}", commit) else None


def _git_dirty(root: Path) -> bool | None:
    """记录构建是否来自 dirty worktree；git 不可用时明确返回 None。"""
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain=v1", "--untracked-files=all"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return bool(result.stdout.strip())


def _runtime_versions() -> dict[str, Any]:
    packages: dict[str, str] = {}
    for name in ("numpy", "pandas", "pymrio", "networkit", "scipy", "linearmodels"):
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = "not-installed"
    return {
        "python": platform.python_version(),
        "implementation": platform.python_implementation(),
        "platform": sys.platform,
        "packages": packages,
    }


def _source_tree_sha256(sources: dict[str, Any]) -> str:
    source_hashes = {name: record.get("sha256") for name, record in sorted(sources.items()) if isinstance(record, dict)}
    encoded = json.dumps(source_hashes, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def register_artifacts(
    processed_dir: Path,
    filenames: Iterable[str],
    *,
    metadata: dict[str, Any] | None = None,
    source_paths: Iterable[Path] = (),
) -> None:
    """把本次成功写出的文件登记为当前契约，并原子替换 manifest。

    若旧 manifest 缺失或版本不同，不继承任何旧条目；随后构建面板时也只会
    使用已按当前算法重新登记的年度输入。
    """
    processed_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = processed_dir / ARTIFACT_MANIFEST
    files: dict[str, dict[str, str | int]] = {}
    prior: dict[str, Any] = {}
    if manifest_path.exists():
        try:
            prior = dict(_load_manifest(processed_dir))
            files = dict(prior["files"])
        except ArtifactContractError:
            files = {}

    for filename in filenames:
        path = processed_dir / filename
        if not path.is_file():
            raise FileNotFoundError(path)
        files[filename] = _file_record(path)

    from gvcsim.config import ROOT

    sources = dict(prior.get("sources") or {})
    for path in source_paths:
        resolved = path.resolve()
        if not resolved.is_file():
            raise FileNotFoundError(resolved)
        try:
            logical_name = str(resolved.relative_to(ROOT.resolve()))
        except ValueError:
            logical_name = str(resolved)
        sources[logical_name] = {**_file_record(resolved), "path": logical_name}

    carried = {
        key: value for key, value in prior.items() if key not in {"schema_version", "network_algorithm", "files"}
    }
    if metadata:
        carried = _deep_merge(carried, metadata)
    build = dict(carried.get("build") or {})
    build["git_commit"] = _git_head(ROOT)
    build["git_dirty"] = _git_dirty(ROOT)
    build["source_tree_sha256"] = _source_tree_sha256(sources)
    build["source_count"] = len(sources)
    build["runtime"] = _runtime_versions()
    carried["build"] = build
    payload = {
        **artifact_contract(),
        **carried,
        "files": dict(sorted(files.items())),
        "sources": dict(sorted(sources.items())),
    }
    temp_path = processed_dir / f".{ARTIFACT_MANIFEST}.tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    temp_path.replace(manifest_path)
    _cached_manifest.cache_clear()
    _cached_sha256.cache_clear()
    # 当前指针之外保留内容寻址快照；同一 manifest 幂等，不覆盖历史。
    current_id = manifest_id(processed_dir)
    history_dir = processed_dir / MANIFEST_HISTORY_DIR
    history_dir.mkdir(exist_ok=True)
    history_path = history_dir / f"{current_id}.json"
    if not history_path.exists():
        history_path.write_text(manifest_path.read_text(encoding="utf-8"), encoding="utf-8")


def validate_artifact(path: Path) -> None:
    """验证一个 processed 文件已登记且内容摘要未变化。"""
    if not path.is_file():
        raise FileNotFoundError(path)
    payload = _load_manifest(path.parent)
    record = payload["files"].get(path.name)
    if not isinstance(record, dict):
        raise ArtifactContractError(f"{path.name} 未按当前算法登记，请重新运行 `uv run gvcsim compute`")
    resolved = path.resolve()
    stat = resolved.stat()
    if record.get("size_bytes") != stat.st_size:
        raise ArtifactContractError(f"{path.name} 与产物清单大小不一致，请重新计算或重新同步完整产物")
    digest = _cached_sha256(str(resolved), stat.st_mtime_ns, stat.st_size)
    if record.get("sha256") != digest:
        raise ArtifactContractError(f"{path.name} 与产物清单摘要不一致，请重新计算或重新同步完整产物")


def validate_source(path: Path, processed_dir: Path | None = None) -> None:
    """验证 processed 目录外、但会影响展示/回归的输入也属于当前 manifest。"""
    from gvcsim.config import PROCESSED_DIR, ROOT

    resolved = path.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(resolved)
    payload = _load_manifest(processed_dir or PROCESSED_DIR)
    try:
        logical_name = str(resolved.relative_to(ROOT.resolve()))
    except ValueError:
        logical_name = str(resolved)
    record = (payload.get("sources") or {}).get(logical_name)
    if not isinstance(record, dict):
        raise ArtifactContractError(f"来源 {logical_name} 未登记在当前产物清单，请重新运行 `uv run gvcsim compute`")
    stat = resolved.stat()
    digest = _cached_sha256(str(resolved), stat.st_mtime_ns, stat.st_size)
    if record.get("size_bytes") != stat.st_size or record.get("sha256") != digest:
        raise ArtifactContractError(f"来源 {logical_name} 与产物清单不一致，请重新运行 `uv run gvcsim compute`")


def validate_release(processed_dir: Path | None = None, *, validate_sources: bool = False) -> dict[str, int]:
    """验证 manifest 登记的完整 release，而不只检查几个代表性文件。

    文件摘要走 ``path+mtime+size`` 缓存，首次 readiness 会完整扫描，后续探针
    只做廉价 stat。发布前可开启 ``validate_sources``，同时验证所有原始/代码输入。
    """
    from gvcsim.config import PROCESSED_DIR, ROOT

    release_dir = processed_dir or PROCESSED_DIR
    payload = _load_manifest(release_dir)
    for filename in sorted(payload["files"]):
        validate_artifact(release_dir / filename)
    sources = payload.get("sources") or {}
    if validate_sources:
        for record in sources.values():
            if not isinstance(record, dict) or not record.get("path"):
                raise ArtifactContractError("预计算产物清单包含无效来源记录")
            source = Path(str(record["path"]))
            validate_source(source if source.is_absolute() else ROOT / source, release_dir)
    return {"files": len(payload["files"]), "sources": len(sources) if validate_sources else 0}


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
    resolved = path.resolve()
    # lru_cache 本身线程安全，但两个同时发生的首次 miss 仍可能重复执行函数体。
    # 外层锁让同一 worker 的冷启动只解析一次大型 CSV。
    with _csv_cache_lock:
        return _cached_csv(str(resolved), resolved.stat().st_mtime_ns)
