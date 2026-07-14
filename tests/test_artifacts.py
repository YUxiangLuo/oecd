import os
from pathlib import Path

from gvcsim.artifacts import _cached_csv, read_csv_artifact


def test_csv_artifact_cache_uses_path_and_mtime(tmp_path: Path):
    path = tmp_path / "panel.csv"
    path.write_text("value\n1\n", encoding="utf-8")
    _cached_csv.cache_clear()

    first = read_csv_artifact(path)
    again = read_csv_artifact(path)
    assert again is first
    assert first.loc[0, "value"] == 1

    old_mtime = path.stat().st_mtime_ns
    path.write_text("value\n2\n", encoding="utf-8")
    os.utime(path, ns=(path.stat().st_atime_ns, max(path.stat().st_mtime_ns, old_mtime + 1)))

    refreshed = read_csv_artifact(path)
    assert refreshed is not first
    assert refreshed.loc[0, "value"] == 2
