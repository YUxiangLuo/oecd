"""Lock, durably stage, and atomically publish processed-data releases."""

from __future__ import annotations

import fcntl
import os
import shutil
import stat
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


class PublicationError(RuntimeError):
    pass


class ComputeLocked(PublicationError):
    pass


def release_store(current: Path) -> Path:
    return current.parent / f".{current.name}-releases"


def compute_lock_path(current: Path) -> Path:
    return current.parent / f".{current.name}-compute.lock"


def _fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def compute_lock(current: Path) -> Iterator[None]:
    current.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    handle = compute_lock_path(current).open("a+", encoding="utf-8")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ComputeLocked("已有 gvcsim compute 正在运行，请稍后重试") from error
        handle.seek(0)
        handle.truncate()
        handle.write(f"{os.getpid()}\n")
        handle.flush()
        os.fsync(handle.fileno())
        yield
    finally:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def create_staging_release(current: Path) -> tuple[Path, Path]:
    store = release_store(current)
    store.mkdir(mode=0o700, parents=True, exist_ok=True)
    _fsync_directory(store.parent)
    release_id = uuid.uuid4().hex
    staging = store / f".build-{release_id}"
    final = store / release_id
    staging.mkdir(mode=0o700)
    _fsync_directory(store)
    return staging, final


def durably_sync_release(directory: Path) -> None:
    """Flush every file and directory before the release becomes discoverable."""
    if directory.is_symlink() or not directory.is_dir():
        raise PublicationError(f"staging release must be a real directory: {directory}")
    directories = [directory]
    for root_text, child_directories, filenames in os.walk(directory, followlinks=False):
        root = Path(root_text)
        for name in child_directories:
            child = root / name
            mode = child.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                raise PublicationError(f"release directories must be real directories: {child}")
            directories.append(child)
        for name in filenames:
            path = root / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
                raise PublicationError(f"release files must be regular files: {path}")
            descriptor = os.open(path, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    for directory_path in reversed(directories):
        _fsync_directory(directory_path)


def promote_staging(staging: Path, final: Path) -> None:
    if final.exists() or final.is_symlink():
        raise PublicationError(f"发布目录已存在:{final.name}")
    if staging.parent.resolve() != final.parent.resolve() or not staging.name.startswith(".build-"):
        raise PublicationError("staging 与正式发布必须位于同一个 release store")
    durably_sync_release(staging)
    staging.rename(final)
    _fsync_directory(final.parent)


def _validated_release(current: Path, candidate: Path) -> Path:
    store = release_store(current).resolve()
    resolved = candidate.resolve(strict=True)
    if resolved.parent != store or resolved.name.startswith(".build-") or not resolved.is_dir():
        raise PublicationError("发布目标必须是 release store 中的正式版本")
    return resolved


def _current_target(current: Path) -> Path | None:
    if not current.exists() and not current.is_symlink():
        return None
    if not current.is_symlink():
        raise PublicationError(f"固定产物入口必须是符号链接:{current}")
    try:
        return _validated_release(current, current)
    except (OSError, RuntimeError) as error:
        raise PublicationError(f"固定产物入口指向无效发布:{current}") from error


def publish_release(current: Path, final: Path) -> None:
    """Atomically expose a completed release. Call only while the API is stopped."""
    _current_target(current)
    _validated_release(current, final)
    relative = os.path.relpath(final, current.parent)
    temporary = current.with_name(f".{current.name}.{uuid.uuid4().hex}.link")
    try:
        temporary.symlink_to(relative, target_is_directory=True)
        os.replace(temporary, current)
        _fsync_directory(current.parent)
    finally:
        temporary.unlink(missing_ok=True)


def cleanup_old_releases(current: Path) -> list[str]:
    """Keep only the active release; no historical release or rollback retention."""
    warnings: list[str] = []
    store = release_store(current)
    retained = {_current_target(current)}
    changed = False
    try:
        candidates = list(store.iterdir())
    except OSError as error:
        return [f"无法扫描旧发布目录 {store}:{error}"]
    for candidate in candidates:
        try:
            if candidate.resolve() in retained:
                continue
            if candidate.is_dir() and not candidate.is_symlink():
                shutil.rmtree(candidate)
            else:
                candidate.unlink(missing_ok=True)
            changed = True
        except OSError as error:
            warnings.append(f"无法清理旧发布 {candidate.name}:{error}")
    if changed:
        try:
            _fsync_directory(store)
        except OSError as error:
            warnings.append(f"无法同步发布目录:{error}")
    return warnings
