"""Cache identities independent of filesystem timestamp resolution.

Fresh SHA-256 is the default, including on filesystems with colliding stat fields.
GVCSIM_FILE_CACHE_MODE=notify opts immutable local Linux deployments into synchronous
inotify invalidation (ordinary writes/renames, including hard links). No background
thread or polling interval is needed. Unsupported filesystems/platforms and failed
notifications fall back to hashing. Notify mode cannot observe mmap/raw-device writes;
use the default hash mode when the immutable-source deployment boundary is absent.
"""

from __future__ import annotations

import atexit
import ctypes
import hashlib
import io
import itertools
import os
from pathlib import Path
import stat
import struct
import sys
import threading
from typing import TextIO, TypeAlias

StatFields: TypeAlias = tuple[int, int, int, int, int, int]
FileState: TypeAlias = tuple[int, int, int, int, int, int, int | str]
FileSource: TypeAlias = Path | io.BytesIO
# dev, inode, mode, size, mtime_ns, ctime_ns, observed revision (or content SHA-256)

_MAX_WATCHES = 1024
_EVENT = struct.Struct("iIII")
_IN_IGNORED = 0x00008000
_IN_Q_OVERFLOW = 0x00004000
_WATCH_MASK = (
    0x00000002 | 0x00000004 | 0x00000008 | 0x00000400 | 0x00000800
)  # MODIFY/ATTRIB/CLOSE_WRITE/DELETE/MOVE_SELF
_LOCAL_FILESYSTEMS = {0xEF53, 0x01021994, 0x58465342, 0x9123683E}  # ext*, tmpfs, XFS, Btrfs
_revisions = itertools.count(1)
_lock = threading.RLock()


def _stat_fields(path: Path) -> StatFields:
    value = path.stat()
    if not stat.S_ISREG(value.st_mode):
        raise OSError(f"cache source must be a regular file: {path}")
    return value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class _Inotify:
    """One nonblocking descriptor, bounded inode watches, guarded by _lock."""

    def __init__(self) -> None:
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.inotify_init1.argtypes = [ctypes.c_int]
        self.libc.inotify_init1.restype = ctypes.c_int
        self.libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        self.libc.inotify_add_watch.restype = ctypes.c_int
        self.libc.inotify_rm_watch.argtypes = [ctypes.c_int, ctypes.c_int]
        self.libc.inotify_rm_watch.restype = ctypes.c_int
        self.libc.statfs.argtypes = [ctypes.c_char_p, ctypes.c_void_p]
        self.libc.statfs.restype = ctypes.c_int
        self.fd = -1
        self.versions: dict[int, int] = {}
        self._reset()

    def close(self) -> None:
        descriptor, self.fd = self.fd, -1
        self.versions.clear()
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass  # Also permit fail-safe cleanup after an invalid descriptor.

    def _reset(self) -> None:
        self.close()
        self.fd = self.libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), "cannot initialize file change notifications")

    def _local(self, path: Path) -> bool:
        # Linux statfs starts with a native long f_type. The remaining opaque
        # buffer exceeds struct statfs on supported Linux ABIs. Do not cache by
        # path/device: mounts can change and remote changes may not emit events.
        buffer = ctypes.create_string_buffer(512)
        if self.libc.statfs(os.fsencode(path), buffer) != 0:
            return False
        magic = ctypes.c_long.from_buffer(buffer).value & 0xFFFFFFFF
        return magic in _LOCAL_FILESYSTEMS

    def _drain(self) -> None:
        # An external writer must not keep request threads draining forever.
        for _ in range(16):
            try:
                events = os.read(self.fd, 65536)
            except BlockingIOError:
                return
            if not events:
                raise OSError("file notification stream closed")
            offset = 0
            while offset < len(events):
                if len(events) - offset < _EVENT.size:
                    raise OSError("incomplete file notification")
                watch, mask, _cookie, length = _EVENT.unpack_from(events, offset)
                offset += _EVENT.size + length
                if offset > len(events):
                    raise OSError("incomplete file notification name")
                if mask & _IN_Q_OVERFLOW:
                    # Events were lost: replace the descriptor, never reuse any
                    # old version, and re-register files on subsequent lookups.
                    self._reset()
                    return
                if mask & _IN_IGNORED:
                    self.versions.pop(watch, None)
                elif watch in self.versions:
                    self.versions[watch] = next(_revisions)
        raise OSError("file notification stream is too busy")

    def _watch(self, path: Path) -> int:
        watch = self.libc.inotify_add_watch(self.fd, os.fsencode(path), _WATCH_MASK)
        if watch < 0:
            raise OSError(ctypes.get_errno(), f"cannot watch cache source: {path}")
        if watch not in self.versions:
            self.versions[watch] = next(_revisions)
        return watch

    def state(self, path: Path) -> FileState | None:
        if not self._local(path):
            return None
        self._drain()
        # Always register the current inode, not a path->watch memo: replacement
        # can leave the old inode alive through another hard link/open handle.
        watch = self._watch(path)
        if len(self.versions) > _MAX_WATCHES:
            # Do not rotate all watches: a tree larger than the cap would then
            # never have a stable identity. Excess files always use fresh hashes.
            if self.libc.inotify_rm_watch(self.fd, watch) < 0:
                raise OSError(ctypes.get_errno(), "cannot remove excess file watch")
            self.versions.pop(watch, None)
            return None
        fields = _stat_fields(path)
        self._drain()
        revision = self.versions.get(watch)
        # A deletion/overflow between registration and stat cannot be a hit.
        return (*fields, revision) if revision is not None else None


def _new_monitor() -> _Inotify | None:
    mode = os.environ.get("GVCSIM_FILE_CACHE_MODE", "hash")
    if mode not in {"hash", "notify"}:
        raise ValueError("GVCSIM_FILE_CACHE_MODE must be hash or notify")
    if mode == "hash" or sys.platform != "linux":
        return None
    try:
        return _Inotify()
    except (AttributeError, OSError):
        return None


_monitor = _new_monitor()

HASH_MODE_WARNING = (
    "GVCSIM_FILE_CACHE_MODE 为 hash：每个已登录请求都会重新计算全部数据产物的 SHA-256（约 80 ms/请求，"
    "15 人同时上课时请求可达 2–5 秒）。课堂或演示请设 GVCSIM_FILE_CACHE_MODE=notify（数据目录须在本地 ext4/XFS/Btrfs）。"
)


def cache_mode_warning() -> str | None:
    """A start-up warning when release files are re-hashed per request (hash mode, or notify unavailable)."""
    mode = os.environ.get("GVCSIM_FILE_CACHE_MODE", "hash")
    if mode == "notify" and _monitor is not None:
        return None
    if mode == "notify":
        return (
            "GVCSIM_FILE_CACHE_MODE=notify 但 inotify 不可用（非 Linux 或已达监视上限），已退回逐请求哈希；"
            + HASH_MODE_WARNING
        )
    return HASH_MODE_WARNING


def file_state(path: Path) -> FileState:
    """Return a metadata + change/content key; never use metadata alone."""
    global _monitor
    with _lock:
        if _monitor is not None:
            try:
                state = _monitor.state(path)
            except OSError:
                _monitor.close()
                _monitor = None
            else:
                if state is not None:
                    return state
    # Fail safe, not stale, if inotify is unavailable, exhausted or unsupported.
    # Keep streaming I/O outside the global notification lock.
    fields = _stat_fields(path)
    digest = _sha256(path)
    if _stat_fields(path) != fields:
        raise OSError(f"cache source changed during content hashing: {path}")
    return (*fields, digest)


def verified_source(path: Path, state: FileState) -> FileSource:
    """Bind a parser to the bytes in its key, including unobservable ABA writes.

    Notify readers retain normal streaming and check their revision afterwards.
    Hash readers parse an immutable byte snapshot matching the measured digest;
    a before/after hash alone could miss a temporary change during parsing.
    """
    if isinstance(state[-1], int):
        return path
    payload = path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != state[-1]:
        raise OSError(f"cache source changed before parsing: {path}")
    return io.BytesIO(payload)


def open_text(path: Path, state: FileState, *, encoding: str) -> TextIO:
    source = verified_source(path, state)
    if isinstance(source, Path):
        return source.open("r", encoding=encoding, newline="")
    return io.TextIOWrapper(source, encoding=encoding, newline="")


def _close_monitor() -> None:
    global _monitor
    with _lock:
        if _monitor is not None:
            _monitor.close()
            _monitor = None


def _after_fork() -> None:
    global _lock, _monitor
    # A child must not consume its parent's event queue or inherit a lock held
    # by another thread. Re-registering yields versions newer than cached keys.
    _lock = threading.RLock()
    _close_monitor()
    _monitor = _new_monitor()


atexit.register(_close_monitor)
if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork)
