"""Filesystem failures must not turn optional release cleanup into publication failure."""

import os

import pytest

from gvcsim import publication


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
        warnings = publication.cleanup_old_releases(current, [previous, active])
        assert len(warnings) == 1 and "无法扫描旧发布目录" in warnings[0]
        assert current.resolve() == active
        assert (current / "data.txt").read_text() == "complete"
        assert (previous / "data.txt").read_text() == "complete"
    finally:
        store.chmod(0o700)
