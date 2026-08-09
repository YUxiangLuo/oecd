"""Fail-closed retention and pruning for content-addressed artifact releases.

A release is deletable only when it is a valid 16-hex content-addressed directory,
is not the current ``data/processed`` target, is outside the newest rollback window,
and is not referenced by any durable classroom record. Unknown, legacy, symlinked,
or malformed entries are always left untouched.
"""

from __future__ import annotations

import fcntl
import os
import re
import shutil
import uuid
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from gvcsim import artifacts

_RELEASE_ID = re.compile(r"[0-9a-f]{16}")
_REFERENCE_TABLES = (
    ("assignments", "manifest_id"),
    ("reports", "manifest_id"),
    ("attempt_sessions", "manifest_id"),
    ("experiment_sessions", "manifest_id"),
    ("learning_evidence_events", "manifest_id"),
)


@dataclass(frozen=True)
class Release:
    manifest_id: str
    path: Path
    size_bytes: int
    modified_ns: int


@dataclass(frozen=True)
class SkippedEntry:
    name: str
    reason: str


@dataclass(frozen=True)
class PrunePlan:
    current_manifest_id: str
    references: dict[str, tuple[str, ...]]
    retained_recent: tuple[str, ...]
    candidates: tuple[Release, ...]
    skipped: tuple[SkippedEntry, ...]

    @property
    def reclaimable_bytes(self) -> int:
        return sum(release.size_bytes for release in self.candidates)


ReferenceProvider = Callable[[], Mapping[str, set[str]]]


@contextmanager
def artifact_store_lock(data_dir: Path) -> Iterator[None]:
    """Serialize the short publish/prune critical section across processes."""
    data_dir.mkdir(parents=True, exist_ok=True)
    lock_path = data_dir / ".artifact-store.lock"
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o660)
    handle: TextIO | None = None
    try:
        handle = os.fdopen(descriptor, "a+")
        descriptor = -1
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        if handle is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()
        elif descriptor >= 0:
            os.close(descriptor)


def classroom_manifest_references() -> dict[str, set[str]]:
    """Read every durable classroom reference; schema/database failures abort pruning."""
    from gvcsim.classroom import db

    db.verify_schema()
    references: dict[str, set[str]] = {}
    with db.conn() as connection:
        connection.execute("SET TRANSACTION READ ONLY")
        for table, column in _REFERENCE_TABLES:
            rows = connection.execute(
                f"SELECT DISTINCT {column} AS manifest_id FROM {table} WHERE {column} <> ''"
            ).fetchall()
            for row in rows:
                references.setdefault(str(row["manifest_id"]), set()).add(table)
    return references


def _directory_size(path: Path) -> int:
    size = 0
    for entry in path.rglob("*"):
        if entry.is_file() and not entry.is_symlink():
            size += entry.stat().st_size
    return size


def _current_release_id(artifacts_dir: Path, current: Path) -> str:
    if not current.is_symlink():
        raise RuntimeError(f"当前产物指针 {current} 不是符号链接；为避免误删，拒绝清理")
    try:
        target = current.resolve(strict=True)
        resolved_artifacts = artifacts_dir.resolve(strict=True)
        target.relative_to(resolved_artifacts)
        if target.parent != resolved_artifacts:
            raise ValueError("current target is nested")
    except (FileNotFoundError, ValueError) as error:
        raise RuntimeError(f"当前产物指针 {current} 未指向版本目录；为避免误删，拒绝清理") from error
    if not _RELEASE_ID.fullmatch(target.name):
        raise RuntimeError(f"当前产物目录 {target.name} 不是受支持的内容 ID；为避免误删，拒绝清理")
    return target.name


def _scan_releases(artifacts_dir: Path) -> tuple[list[Release], list[SkippedEntry]]:
    releases: list[Release] = []
    skipped: list[SkippedEntry] = []
    for path in sorted(artifacts_dir.iterdir(), key=lambda item: item.name):
        if path.is_symlink():
            skipped.append(SkippedEntry(path.name, "符号链接"))
            continue
        if not path.is_dir():
            skipped.append(SkippedEntry(path.name, "不是目录"))
            continue
        if not _RELEASE_ID.fullmatch(path.name):
            skipped.append(SkippedEntry(path.name, "legacy 或未知目录名"))
            continue
        try:
            declared_id = artifacts.manifest_id(path)
            # Historical source files are expected to change, but every declared output in the
            # release itself must still exist and match its digest before automation may touch it.
            artifacts.validate_release(path, validate_sources=False)
        except (artifacts.ArtifactContractError, OSError, ValueError) as error:
            skipped.append(SkippedEntry(path.name, f"manifest 无效:{type(error).__name__}"))
            continue
        if declared_id != path.name:
            skipped.append(SkippedEntry(path.name, f"目录名与 manifest 内容 ID 不一致:{declared_id}"))
            continue
        stat = path.stat()
        releases.append(
            Release(
                manifest_id=path.name,
                path=path,
                size_bytes=_directory_size(path),
                modified_ns=stat.st_mtime_ns,
            )
        )
    releases.sort(key=lambda release: (release.modified_ns, release.manifest_id), reverse=True)
    return releases, skipped


def build_prune_plan(
    artifacts_dir: Path,
    current: Path,
    references_by_manifest: Mapping[str, set[str]],
    *,
    keep_latest: int = 3,
) -> PrunePlan:
    """Build a deterministic plan without deleting anything."""
    if keep_latest < 0:
        raise ValueError("keep_latest 不能为负数")
    if artifacts_dir.parent.resolve() != current.parent.resolve():
        raise RuntimeError("产物版本目录与当前指针不在同一 data 目录；为避免误删，拒绝清理")
    if not artifacts_dir.is_dir():
        raise RuntimeError(f"产物版本目录不存在:{artifacts_dir}")
    current_id = _current_release_id(artifacts_dir, current)
    releases, skipped = _scan_releases(artifacts_dir)
    release_ids = {release.manifest_id for release in releases}
    if current_id not in release_ids:
        raise RuntimeError(f"当前版本 {current_id} 的 manifest 无效；为避免误删，拒绝清理")

    references = {
        manifest_id: tuple(sorted(sources))
        for manifest_id, sources in sorted(references_by_manifest.items())
        if manifest_id
    }
    retained_recent = tuple(release.manifest_id for release in releases if release.manifest_id != current_id)[
        :keep_latest
    ]
    protected = {current_id, *retained_recent, *references}
    candidates = tuple(release for release in releases if release.manifest_id not in protected)
    return PrunePlan(
        current_manifest_id=current_id,
        references=references,
        retained_recent=retained_recent,
        candidates=candidates,
        skipped=tuple(skipped),
    )


def _delete_release(release: Release, artifacts_dir: Path) -> None:
    """Rename first, then remove; restore the visible name if recursive deletion fails."""
    if release.path.parent.resolve() != artifacts_dir.resolve() or release.path.is_symlink():
        raise RuntimeError(f"拒绝删除版本目录之外或符号链接路径:{release.path}")
    tombstone = artifacts_dir / f".gvcsim-prune-{release.manifest_id}-{uuid.uuid4().hex}"
    os.replace(release.path, tombstone)
    try:
        shutil.rmtree(tombstone)
    except Exception:
        if tombstone.exists() and not release.path.exists():
            os.replace(tombstone, release.path)
        raise


def prune_artifacts(
    artifacts_dir: Path,
    current: Path,
    *,
    keep_latest: int = 3,
    apply: bool = False,
    reference_provider: ReferenceProvider = classroom_manifest_references,
) -> PrunePlan:
    """Plan or apply pruning while holding the same lock as atomic publication."""
    with artifact_store_lock(current.parent):
        # Query inside the lock and fail closed before scanning/deleting if PostgreSQL is unavailable.
        references = reference_provider()
        plan = build_prune_plan(artifacts_dir, current, references, keep_latest=keep_latest)
        if apply:
            for release in plan.candidates:
                # Re-check the pointer before every destructive operation.
                if _current_release_id(artifacts_dir, current) == release.manifest_id:
                    raise RuntimeError(f"版本 {release.manifest_id} 已成为当前版本，终止清理")
                _delete_release(release, artifacts_dir)
        return plan
