"""Failure-safe publication primitives for the fixed processed-data path.

A compute builds an immutable release below the processed path's parent and
publishes it through one relative symlink replacement.  A small journal bridges
the filesystem pointer switch and the transactional PostgreSQL learning reset.
The deployment contract remains Linux/POSIX and compute remains a maintenance-
window operation.
"""

from __future__ import annotations

import fcntl
import json
import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import TextIO

JOURNAL_VERSION = 1


class PublicationError(RuntimeError):
    """A release cannot be published or recovered safely."""


class ComputeLocked(PublicationError):
    """Another compute/recovery process owns the publication lock."""


class PendingPublication(PublicationError):
    """A publication journal requires explicit recovery."""


@dataclass(frozen=True)
class PublicationJournal:
    version: int
    old_target: str | None
    new_target: str
    phase: str


def release_store(current: Path) -> Path:
    return current.parent / f".{current.name}-releases"


def compute_lock_path(current: Path) -> Path:
    return current.parent / f".{current.name}-compute.lock"


def journal_path(current: Path) -> Path:
    return current.parent / f".{current.name}-publication.json"


def _fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def compute_lock(current: Path) -> Iterator[None]:
    """Own the one non-blocking Linux publication lock for this fixed path."""
    current.parent.mkdir(parents=True, exist_ok=True)
    lock_path = compute_lock_path(current)
    handle: TextIO = lock_path.open("a+", encoding="utf-8")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ComputeLocked("已有 gvcsim compute/recovery 正在运行，请稍后重试") from error
        handle.seek(0)
        handle.truncate()
        handle.write(f"pid={os.getpid()}\n")
        handle.flush()
        os.fsync(handle.fileno())
        yield
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def ensure_no_pending_publication(current: Path) -> None:
    if journal_path(current).exists():
        raise PendingPublication(
            "检测到未完成的数据发布；服务保持不可用，请在维护窗口运行 `uv run gvcsim compute --recover-pending`"
        )


def _atomic_json(path: Path, payload: dict) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def write_journal(current: Path, journal: PublicationJournal) -> None:
    _atomic_json(journal_path(current), asdict(journal))


def read_journal(current: Path) -> PublicationJournal:
    path = journal_path(current)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or not isinstance(payload.get("version"), int):
            raise TypeError("invalid journal object")
        old_target = payload.get("old_target")
        if old_target is not None and not isinstance(old_target, str):
            raise TypeError("invalid old target")
        if not isinstance(payload.get("new_target"), str) or not isinstance(payload.get("phase"), str):
            raise TypeError("invalid journal fields")
        journal = PublicationJournal(
            version=payload["version"],
            old_target=old_target,
            new_target=payload["new_target"],
            phase=payload["phase"],
        )
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, AttributeError) as error:
        raise PublicationError("发布恢复日志损坏，拒绝自动修改固定产物指针") from error
    if journal.version != JOURNAL_VERSION or journal.phase not in {
        "prepared",
        "legacy_migrated",
        "pointer_switched",
        "reset_failed_rolled_back",
    }:
        raise PublicationError("发布恢复日志版本或阶段无效，拒绝自动恢复")
    _resolve_new_release_target(current, journal.new_target)
    if journal.old_target is not None:
        _resolve_old_target(current, journal.old_target)
    return journal


def update_journal_phase(current: Path, journal: PublicationJournal, phase: str) -> PublicationJournal:
    updated = replace(journal, phase=phase)
    write_journal(current, updated)
    return updated


def clear_journal(current: Path) -> None:
    journal_path(current).unlink()
    _fsync_directory(current.parent)


def _lexical_relative_target(current: Path, target: str) -> tuple[Path, Path]:
    """Resolve a relative target without allowing traversal or the fixed path itself."""
    if not target or os.path.isabs(target):
        raise PublicationError("固定产物指针目标必须是非空相对路径")
    parent = Path(os.path.abspath(current.parent))
    candidate = Path(os.path.abspath(current.parent / target))
    try:
        candidate.relative_to(parent)
    except ValueError as error:
        raise PublicationError("固定产物指针目标越出数据目录") from error
    if candidate == Path(os.path.abspath(current)):
        raise PublicationError("固定产物指针不能指向自身")
    return parent, candidate


def _resolve_old_target(current: Path, target: str) -> Path:
    """Bound a rollback target to one retained directory below the data parent."""
    parent, candidate = _lexical_relative_target(current, target)
    store = Path(os.path.abspath(release_store(current)))
    if candidate.parent not in {parent, store}:
        raise PublicationError("旧固定产物目标不在允许的保留目录中")
    resolved = candidate.resolve()
    try:
        resolved.relative_to(parent.resolve())
    except ValueError as error:
        raise PublicationError("旧固定产物目标越出数据目录") from error
    return resolved


def _resolve_new_release_target(current: Path, target: str) -> Path:
    """Require the new release to be one real direct child of the release store."""
    _parent, candidate = _lexical_relative_target(current, target)
    store = Path(os.path.abspath(release_store(current)))
    if candidate.parent != store or candidate.name.startswith(".build-"):
        raise PublicationError("新固定产物目标必须是发布目录中的正式版本")
    resolved = candidate.resolve()
    expected = store.resolve() / candidate.name
    if resolved != expected or resolved.parent != store.resolve():
        raise PublicationError("新固定产物目标不能通过符号链接别名跳转")
    return resolved


def relative_target(current: Path, target: Path, *, new_release: bool = False) -> str:
    relative = os.path.relpath(target, current.parent)
    if new_release:
        _resolve_new_release_target(current, relative)
    else:
        _resolve_old_target(current, relative)
    return relative


def create_staging_release(current: Path) -> tuple[Path, Path]:
    store = release_store(current)
    store.mkdir(mode=0o700, parents=True, exist_ok=True)
    release_id = uuid.uuid4().hex
    staging = store / f".build-{release_id}"
    final = store / release_id
    staging.mkdir(mode=0o700)
    return staging, final


def durably_sync_release(directory: Path) -> None:
    """Flush every regular release file and directory entry before publication."""
    if directory.is_symlink() or not directory.is_dir():
        raise PublicationError("待发布产物必须是普通目录")
    directories: list[Path] = []
    for root, dirnames, filenames in os.walk(directory, topdown=True, followlinks=False):
        root_path = Path(root)
        directories.append(root_path)
        for dirname in dirnames:
            child = root_path / dirname
            if child.is_symlink():
                raise PublicationError("待发布产物不能包含符号链接")
        for filename in filenames:
            path = root_path / filename
            if path.is_symlink() or not path.is_file():
                raise PublicationError("待发布产物只能包含普通文件")
            descriptor = os.open(path, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    for directory_path in reversed(directories):
        _fsync_directory(directory_path)


def promote_staging(staging: Path, final: Path) -> None:
    if final.exists():
        raise PublicationError(f"发布目录已存在:{final.name}")
    durably_sync_release(staging)
    staging.rename(final)
    _fsync_directory(final.parent)


def current_target(current: Path, *, legacy_target: Path) -> tuple[str | None, bool]:
    """Plan the retained old target and whether a real directory needs migration."""
    if current.is_symlink():
        raw = os.readlink(current)
        resolved = Path(raw) if os.path.isabs(raw) else current.parent / raw
        return relative_target(current, resolved), False
    if current.exists():
        if not current.is_dir():
            raise PublicationError(f"固定产物路径不是目录或符号链接:{current}")
        if legacy_target.exists():
            raise PublicationError(f"旧产物迁移目标已存在:{legacy_target.name}")
        return relative_target(current, legacy_target), True
    return None, False


def migrate_legacy_directory(current: Path, legacy_target: Path, old_target: str) -> None:
    """Move a legacy real directory into the release store during maintenance."""
    current.rename(legacy_target)
    try:
        publish_pointer(current, old_target)
    except BaseException:
        if not current.exists() and not current.is_symlink() and legacy_target.exists():
            legacy_target.rename(current)
        raise


def publish_pointer(current: Path, target: str, *, new_release: bool = False) -> None:
    """Atomically replace the fixed path with one relative symlink."""
    resolved = _resolve_new_release_target(current, target) if new_release else _resolve_old_target(current, target)
    if not resolved.is_dir():
        raise PublicationError(f"固定产物目标不存在或不是目录:{target}")
    temporary = current.with_name(f".{current.name}.{uuid.uuid4().hex}.link")
    try:
        temporary.symlink_to(target, target_is_directory=True)
        os.replace(temporary, current)
        _fsync_directory(current.parent)
    finally:
        temporary.unlink(missing_ok=True)


def rollback_pointer(current: Path, old_target: str | None) -> None:
    if old_target is None:
        if current.is_symlink():
            current.unlink()
            _fsync_directory(current.parent)
        return
    publish_pointer(current, old_target)
