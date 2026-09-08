import hashlib
import mmap
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from gvcsim import artifacts, file_identity
from gvcsim.data import raw_icio


@pytest.fixture
def monitor(monkeypatch, tmp_path):
    monkeypatch.setenv("GVCSIM_FILE_CACHE_MODE", "notify")
    instance = file_identity._new_monitor()
    if instance is None:
        pytest.skip("Linux inotify is unavailable")
    if not instance._local(tmp_path):
        instance.close()
        pytest.skip("test directory is not a supported local filesystem")
    monkeypatch.setattr(file_identity, "_monitor", instance)
    yield instance
    instance.close()


def test_repeated_collisions_never_reuse_old_identity(tmp_path, freeze_file_metadata, file_identity_backend):
    path = tmp_path / "sample"
    path.write_bytes(b"a")
    freeze_file_metadata(path)
    previous = file_identity.file_state(path)
    for _ in range(30):
        path.write_bytes(b"b" if path.read_bytes() == b"a" else b"a")
        current = file_identity.file_state(path)
        assert current[:-1] == previous[:-1]
        assert current != previous
        assert file_identity.file_state(path) == current
        previous = current


def test_writes_through_hard_links_invalidate_cache(tmp_path, freeze_file_metadata, file_identity_backend):
    path = tmp_path / "sample"
    alias = tmp_path / "alias"
    path.write_bytes(b"a")
    os.link(path, alias)
    freeze_file_metadata(path)
    previous = file_identity.file_state(path)
    alias.write_bytes(b"b")
    assert file_identity.file_state(path) != previous


def test_atomic_replacement_registers_new_inode_even_if_old_one_is_alive(
    tmp_path, freeze_file_metadata, file_identity_backend
):
    path = tmp_path / "sample"
    path.write_bytes(b"a")
    os.link(path, tmp_path / "old-inode")
    freeze_file_metadata(path)
    previous = file_identity.file_state(path)
    replacement = tmp_path / "replacement"
    replacement.write_bytes(b"b")
    replacement.replace(path)
    current = file_identity.file_state(path)
    assert current[:-1] == previous[:-1]
    assert current != previous
    path.write_bytes(b"c")
    assert file_identity.file_state(path) != current


def test_default_hash_mode_catches_mmap_writes_with_colliding_metadata(tmp_path, monkeypatch, freeze_file_metadata):
    monkeypatch.delenv("GVCSIM_FILE_CACHE_MODE", raising=False)
    assert file_identity._new_monitor() is None
    monkeypatch.setattr(file_identity, "_monitor", None)
    path = tmp_path / "sample.csv"
    path.write_bytes(b"value\n1\n")
    freeze_file_metadata(path)
    with path.open("r+b") as handle, mmap.mmap(handle.fileno(), 0) as mapping:
        assert artifacts.read_csv_artifact(path).iloc[0, 0] == 1
        mapping[6:7] = b"2"
        mapping.flush()
        assert artifacts.read_csv_artifact(path).iloc[0, 0] == 2


def test_csv_changed_during_parse_is_not_cached(tmp_path, monkeypatch, freeze_file_metadata, file_identity_backend):
    path = tmp_path / "sample.csv"
    path.write_bytes(b"value\n1\n")
    freeze_file_metadata(path)
    original = artifacts.pd.read_csv

    def changed(*args, **kwargs):
        frame = original(*args, **kwargs)
        path.write_bytes(b"value\n2\n")
        return frame

    with monkeypatch.context() as patch:
        patch.setattr(artifacts.pd, "read_csv", changed)
        with pytest.raises(artifacts.ArtifactContractError, match="changed during reading"):
            artifacts.read_csv_artifact(path)
    assert artifacts.read_csv_artifact(path).iloc[0, 0] == 2


def test_temporary_change_during_parse_cannot_poison_original_cache_key(
    tmp_path, monkeypatch, freeze_file_metadata, file_identity_backend
):
    path = tmp_path / "sample.csv"
    path.write_bytes(b"value\n1\n")
    freeze_file_metadata(path)
    watched = isinstance(file_identity.file_state(path)[-1], int)
    original = artifacts.pd.read_csv

    def changed_and_restored(*args, **kwargs):
        path.write_bytes(b"value\n2\n")
        frame = original(*args, **kwargs)
        path.write_bytes(b"value\n1\n")
        return frame

    with monkeypatch.context() as patch:
        patch.setattr(artifacts.pd, "read_csv", changed_and_restored)
        if watched:
            with pytest.raises(artifacts.ArtifactContractError, match="changed during reading"):
                artifacts.read_csv_artifact(path)
        else:
            # The parser sees the immutable snapshot, not the temporarily edited file.
            assert artifacts.read_csv_artifact(path).iloc[0, 0] == 1
    assert artifacts.read_csv_artifact(path).iloc[0, 0] == 1


def test_snapshot_must_match_the_hash_in_its_key(tmp_path, monkeypatch, freeze_file_metadata):
    monkeypatch.setattr(file_identity, "_monitor", None)
    path = tmp_path / "sample"
    path.write_bytes(b"a")
    freeze_file_metadata(path)
    state = file_identity.file_state(path)
    path.write_bytes(b"b")
    with pytest.raises(OSError, match="changed before parsing"):
        file_identity.verified_source(path, state)


@pytest.mark.parametrize("restore", [False, True])
def test_raw_changed_during_hash_is_not_cached(
    tmp_path, monkeypatch, freeze_file_metadata, file_identity_backend, restore
):
    path = tmp_path / "sample"
    path.write_bytes(b"a")
    freeze_file_metadata(path)
    identity = raw_icio.raw_file_identity(path)
    digest = hashlib.sha256()
    if restore:
        path.write_bytes(b"b")

    def update(chunk):
        digest.update(chunk)
        path.write_bytes(b"a" if restore else b"b")

    monkeypatch.setattr(
        raw_icio,
        "hashlib",
        SimpleNamespace(sha256=lambda: SimpleNamespace(update=update, hexdigest=digest.hexdigest)),
    )
    with pytest.raises(raw_icio.RawICIOValidationError, match="changed during content hashing"):
        raw_icio._raw_source_evidence_cached(identity)


def test_warm_notify_identity_and_source_evidence_do_not_rescan_content(tmp_path, monkeypatch, monitor):
    path = tmp_path / "sample"
    path.write_bytes(b"a")
    identity = raw_icio.raw_file_identity(path)
    expected = raw_icio._raw_source_evidence_cached(identity)
    assert isinstance(identity[-1], int)

    def unexpected(*_args, **_kwargs):
        pytest.fail("warm notify lookup must not reopen or rehash the source")

    monkeypatch.setattr(Path, "open", unexpected)
    for _ in range(50):
        assert raw_icio.raw_file_identity(path) == identity
        assert raw_icio._raw_source_evidence_cached(identity) == expected


def test_overflow_invalidates_every_previously_watched_identity(tmp_path, monkeypatch, monitor, freeze_file_metadata):
    paths = [tmp_path / name for name in ("first", "second")]
    for path in paths:
        path.write_bytes(b"a")
        freeze_file_metadata(path)
    previous = [file_identity.file_state(path) for path in paths]
    paths[0].write_bytes(b"b")
    original = os.read
    injected = False

    def overflow(descriptor, size):
        nonlocal injected
        if not injected and descriptor == monitor.fd:
            injected = True
            return file_identity._EVENT.pack(-1, file_identity._IN_Q_OVERFLOW, 0, 0)
        return original(descriptor, size)

    monkeypatch.setattr(os, "read", overflow)
    assert all(file_identity.file_state(path) != old for path, old in zip(paths, previous, strict=True))
    assert injected


def test_watch_lost_between_registration_and_stat_uses_hash(tmp_path, monkeypatch, monitor):
    path = tmp_path / "sample"
    path.write_bytes(b"a")
    drains = 0

    def lose_watch():
        nonlocal drains
        drains += 1
        if drains == 2:
            monitor._reset()

    monkeypatch.setattr(monitor, "_drain", lose_watch)
    assert file_identity.file_state(path)[-1] == hashlib.sha256(b"a").hexdigest()


def test_watch_cap_hashes_excess_files_without_invalidating_other_watches(
    tmp_path, monkeypatch, monitor, freeze_file_metadata
):
    monkeypatch.setattr(file_identity, "_MAX_WATCHES", 1)
    first, second = tmp_path / "first", tmp_path / "second"
    for path in (first, second):
        path.write_bytes(b"a")
        freeze_file_metadata(path)
    retained = file_identity.file_state(first)
    hashed = file_identity.file_state(second)
    assert isinstance(retained[-1], int)
    assert hashed[-1] == hashlib.sha256(b"a").hexdigest()
    for _ in range(3):
        assert file_identity.file_state(first) == retained
        assert file_identity.file_state(second) == hashed
    second.write_bytes(b"b")
    assert file_identity.file_state(second) != hashed
    assert file_identity.file_state(first) == retained
    assert len(monitor.versions) == 1


@pytest.mark.parametrize("failure", ["read", "watch", "unsupported-filesystem"])
def test_notification_failures_use_fresh_content_hashes(tmp_path, monkeypatch, monitor, freeze_file_metadata, failure):
    path = tmp_path / "sample"
    path.write_bytes(b"a")
    freeze_file_metadata(path)
    file_identity.file_state(path)

    def unavailable(*_args):
        raise OSError("unavailable")

    if failure == "unsupported-filesystem":
        monkeypatch.setattr(monitor, "_local", lambda _path: False)
    else:
        monkeypatch.setattr(monitor, "_drain" if failure == "read" else "_watch", unavailable)
    first = file_identity.file_state(path)
    assert first[-1] == hashlib.sha256(b"a").hexdigest()
    path.write_bytes(b"b")
    assert file_identity.file_state(path)[-1] == hashlib.sha256(b"b").hexdigest()
    if failure != "unsupported-filesystem":
        assert file_identity._monitor is None
        assert monitor.fd == -1


@pytest.mark.parametrize("payload", [b"", b"short", file_identity._EVENT.pack(1, 2, 0, 20)])
def test_incomplete_notification_stream_disables_monitor(tmp_path, monkeypatch, monitor, payload):
    path = tmp_path / "sample"
    path.write_bytes(b"a")
    original = os.read
    descriptor = monitor.fd
    monkeypatch.setattr(os, "read", lambda fd, size: payload if fd == descriptor else original(fd, size))
    assert file_identity.file_state(path)[-1] == hashlib.sha256(b"a").hexdigest()
    assert file_identity._monitor is None


def test_busy_notification_stream_has_bounded_drain_work(tmp_path, monkeypatch, monitor):
    path = tmp_path / "sample"
    path.write_bytes(b"a")
    original = os.read
    descriptor = monitor.fd
    reads = 0

    def busy(fd, size):
        nonlocal reads
        if fd == descriptor:
            reads += 1
            return file_identity._EVENT.pack(1, 2, 0, 0)
        return original(fd, size)

    monkeypatch.setattr(os, "read", busy)
    assert file_identity.file_state(path)[-1] == hashlib.sha256(b"a").hexdigest()
    assert reads == 16
    assert file_identity._monitor is None


def test_fork_hook_uses_new_descriptor_state_and_revision_namespace(tmp_path, monitor):
    path = tmp_path / "sample"
    path.write_bytes(b"a")
    previous = file_identity.file_state(path)
    try:
        file_identity._after_fork()
        assert monitor.fd == -1
        assert file_identity.file_state(path) != previous
    finally:
        file_identity._close_monitor()


def test_hash_mode_rejects_metadata_change_during_hash(tmp_path, monkeypatch):
    monkeypatch.setattr(file_identity, "_monitor", None)
    path = tmp_path / "sample"
    path.write_bytes(b"a")
    original = file_identity._sha256

    def changed(target):
        result = original(target)
        path.write_bytes(b"longer")
        return result

    monkeypatch.setattr(file_identity, "_sha256", changed)
    with pytest.raises(OSError, match="changed during content hashing"):
        file_identity.file_state(path)


def test_non_regular_files_are_rejected(tmp_path):
    with pytest.raises(OSError, match="regular file"):
        file_identity.file_state(tmp_path)


def test_unavailable_inotify_initialization_is_safe(monkeypatch):
    monkeypatch.setenv("GVCSIM_FILE_CACHE_MODE", "notify")

    def unavailable(*_args, **_kwargs):
        raise OSError("inotify unavailable")

    monkeypatch.setattr(file_identity.ctypes, "CDLL", unavailable)
    assert file_identity._new_monitor() is None


def test_non_linux_notify_mode_falls_back_to_hash(monkeypatch):
    monkeypatch.setenv("GVCSIM_FILE_CACHE_MODE", "notify")
    monkeypatch.setattr(file_identity.sys, "platform", "darwin")
    assert file_identity._new_monitor() is None


def test_invalid_cache_mode_is_not_silently_accepted(monkeypatch):
    monkeypatch.setenv("GVCSIM_FILE_CACHE_MODE", "typo")
    with pytest.raises(ValueError, match="GVCSIM_FILE_CACHE_MODE"):
        file_identity._new_monitor()
