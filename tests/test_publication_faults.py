"""Filesystem failures must not turn optional release cleanup into publication failure."""

import os
import signal

import pytest

from gvcsim import publication


@pytest.mark.parametrize("phase", ["cleanup", "cleanup_denied"])
@pytest.mark.skipif(os.geteuid() == 0, reason="root bypasses directory read permissions")
def test_rehearsal_cleanup_hooks_reach_the_injected_fault(tmp_path, monkeypatch, phase):
    from gvcsim import pipeline
    from scripts import dogfood_publication_faults as rehearsal

    current = tmp_path / "processed"
    store = publication.release_store(current)
    store.mkdir()
    previous, active = store / ("a" * 32), store / ("b" * 32)
    for release in (previous, active):
        release.mkdir()
        (release / "data.txt").write_text("complete")
    current.symlink_to(active)
    marker = tmp_path / "checkpoint"
    signals = []
    warnings = []
    monkeypatch.setattr(rehearsal.os, "kill", lambda pid, sig: signals.append((pid, sig)))
    monkeypatch.setattr(pipeline, "run", lambda: warnings.extend(publication.cleanup_old_releases(current)))
    # child installs its hook directly; restore it after this isolated rehearsal.
    monkeypatch.setattr(publication, "cleanup_old_releases", publication.cleanup_old_releases)
    rehearsal.child(phase, marker)
    assert current.resolve() == active
    assert (current / "data.txt").read_text() == "complete"
    if phase == "cleanup":
        assert marker.read_text() == phase
        assert signals == [(os.getpid(), signal.SIGSTOP)]
        assert not warnings
        assert list(store.iterdir()) == [active]
    else:
        assert not marker.exists() and not signals
        assert len(warnings) == 1 and "无法扫描旧发布目录" in warnings[0]
        assert previous.exists()
        assert store.stat().st_mode & 0o777 == 0o700


@pytest.mark.skipif(os.geteuid() == 0, reason="root bypasses directory read permissions")
def test_unreadable_release_listing_is_a_warning_and_keeps_readable_active_data(tmp_path):
    current = tmp_path / "processed"
    store = publication.release_store(current)
    store.mkdir()
    previous, active = store / ("a" * 32), store / ("b" * 32)
    for release in (previous, active):
        release.mkdir()
        (release / "data.txt").write_text("complete")
    current.symlink_to(active)
    store.chmod(0o300)
    try:
        warnings = publication.cleanup_old_releases(current)
        assert len(warnings) == 1 and "无法扫描旧发布目录" in warnings[0]
        assert current.resolve() == active
        assert (current / "data.txt").read_text() == "complete"
        assert (previous / "data.txt").read_text() == "complete"
    finally:
        store.chmod(0o700)
