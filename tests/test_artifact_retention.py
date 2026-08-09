import json
import os
from pathlib import Path

import pytest

from gvcsim import artifact_retention, artifacts
from gvcsim.classroom import db


def _release(versions: Path, tag: str, modified_ns: int) -> Path:
    staging = versions / f"staging-{tag}"
    staging.mkdir()
    payload = {
        **artifacts.artifact_contract(),
        "files": {},
        "sources": {},
        "qc": {},
        "build": {"test_tag": tag},
    }
    (staging / artifacts.ARTIFACT_MANIFEST).write_text(json.dumps(payload), encoding="utf-8")
    release_id = artifacts.manifest_id(staging)
    release = staging.rename(versions / release_id)
    (release / "payload.bin").write_bytes(tag.encode() * 10)
    os.utime(release, ns=(modified_ns, modified_ns))
    return release


def _store(tmp_path: Path) -> tuple[Path, Path, dict[str, Path]]:
    versions = tmp_path / "artifacts"
    versions.mkdir()
    releases = {
        "current": _release(versions, "current", 50),
        "recent": _release(versions, "recent", 40),
        "assignment": _release(versions, "assignment", 30),
        "candidate": _release(versions, "candidate", 20),
        "report": _release(versions, "report", 10),
    }
    current = tmp_path / "processed"
    current.symlink_to(Path("artifacts") / releases["current"].name, target_is_directory=True)
    return versions, current, releases


def test_classroom_reference_scan_covers_every_durable_manifest_column(monkeypatch):
    verified = False
    queried: list[str] = []

    class Result:
        def __init__(self, table: str):
            self.table = table

        def fetchall(self):
            return [{"manifest_id": f"manifest-{self.table}"}]

    class Connection:
        def execute(self, query: str):
            if query == "SET TRANSACTION READ ONLY":
                return Result("read-only")
            table = query.split(" FROM ", 1)[1].split(" ", 1)[0]
            queried.append(table)
            return Result(table)

    class ConnectionContext:
        def __enter__(self):
            return Connection()

        def __exit__(self, *_args):
            return False

    def verify():
        nonlocal verified
        verified = True
        return {"status": "ok", "schema_version": db.TEACHING_DB_VERSION}

    monkeypatch.setattr(db, "verify_schema", verify)
    monkeypatch.setattr(db, "conn", ConnectionContext)

    references = artifact_retention.classroom_manifest_references()

    expected = {
        "assignments",
        "reports",
        "attempt_sessions",
        "experiment_sessions",
        "learning_evidence_events",
    }
    assert verified is True
    assert set(queried) == expected
    assert references == {f"manifest-{table}": {table} for table in expected}


def test_plan_only_selects_valid_unreferenced_versions_outside_rollback_window(tmp_path):
    versions, current, releases = _store(tmp_path)
    (versions / "legacy-before-content-addressing").mkdir()
    malformed = versions / "0123456789abcdef"
    malformed.mkdir()
    (malformed / artifacts.ARTIFACT_MANIFEST).write_text("not-json", encoding="utf-8")
    corrupt_staging = versions / "corrupt-staging"
    corrupt_staging.mkdir()
    corrupt_payload = {
        **artifacts.artifact_contract(),
        "files": {"missing.csv": {"size_bytes": 1, "sha256": "0" * 64}},
        "sources": {},
        "qc": {},
        "build": {"test_tag": "corrupt"},
    }
    (corrupt_staging / artifacts.ARTIFACT_MANIFEST).write_text(json.dumps(corrupt_payload), encoding="utf-8")
    corrupt = corrupt_staging.rename(versions / artifacts.manifest_id(corrupt_staging))
    (versions / "release-link").symlink_to(releases["candidate"], target_is_directory=True)
    (versions / "operator-note.txt").write_text("keep", encoding="utf-8")

    references = {
        releases["assignment"].name: {"assignments"},
        releases["report"].name: {"reports", "attempt_sessions"},
    }
    plan = artifact_retention.build_prune_plan(
        versions,
        current,
        references,
        keep_latest=1,
    )

    assert plan.current_manifest_id == releases["current"].name
    assert plan.retained_recent == (releases["recent"].name,)
    assert [release.manifest_id for release in plan.candidates] == [releases["candidate"].name]
    assert plan.references[releases["assignment"].name] == ("assignments",)
    assert plan.reclaimable_bytes > 0
    skipped = {entry.name: entry.reason for entry in plan.skipped}
    assert "legacy" in skipped["legacy-before-content-addressing"]
    assert "manifest 无效" in skipped[malformed.name]
    assert "manifest 无效" in skipped[corrupt.name]
    assert skipped["release-link"] == "符号链接"
    assert skipped["operator-note.txt"] == "不是目录"


def test_apply_deletes_only_the_frozen_plan_candidates(tmp_path):
    versions, current, releases = _store(tmp_path)
    references = {
        releases["assignment"].name: {"assignments"},
        releases["report"].name: {"reports"},
    }

    preview = artifact_retention.prune_artifacts(
        versions,
        current,
        keep_latest=1,
        reference_provider=lambda: references,
    )
    assert releases["candidate"].is_dir()
    assert [release.manifest_id for release in preview.candidates] == [releases["candidate"].name]

    applied = artifact_retention.prune_artifacts(
        versions,
        current,
        keep_latest=1,
        apply=True,
        reference_provider=lambda: references,
    )

    assert [release.manifest_id for release in applied.candidates] == [releases["candidate"].name]
    assert not releases["candidate"].exists()
    for name in ("current", "recent", "assignment", "report"):
        assert releases[name].is_dir()
    assert current.resolve() == releases["current"]


def test_reference_lookup_failure_is_fail_closed(tmp_path):
    versions, current, releases = _store(tmp_path)

    def unavailable():
        raise RuntimeError("database unavailable")

    with pytest.raises(RuntimeError, match="database unavailable"):
        artifact_retention.prune_artifacts(
            versions,
            current,
            keep_latest=0,
            apply=True,
            reference_provider=unavailable,
        )

    assert all(release.is_dir() for release in releases.values())


def test_pruning_refuses_a_non_symlink_current_directory(tmp_path):
    versions = tmp_path / "artifacts"
    versions.mkdir()
    _release(versions, "release", 1)
    current = tmp_path / "processed"
    current.mkdir()

    with pytest.raises(RuntimeError, match="不是符号链接"):
        artifact_retention.build_prune_plan(versions, current, {}, keep_latest=0)
