import json
import os
from pathlib import Path

import pytest

from gvcsim import artifacts, config


RELEASE_ID = "1" * 32


def _release(directory: Path, *, course_release: str | None = None) -> None:
    year = 2020
    for name in (
        f"export_exposure_{year}.csv",
        f"indicators_country_{year}.csv",
        f"indicators_industry_{year}.csv",
        f"network_edges_{year}.csv",
        "panel_country.csv",
        "panel_industry.csv",
        "controls_country.csv",
        "demo_trade_war_tariffs.csv",
    ):
        (directory / name).write_text("value\n1\n", encoding="utf-8")
    for name in (f"qc_{year}.json", "qc_controls.json", "qc_shocks.json"):
        (directory / name).write_text("[]\n", encoding="utf-8")
    artifacts.write_dataset_metadata(
        directory,
        {
            "release_id": RELEASE_ID,
            "years": [year],
            "generated_at": "2026-08-13T00:00:00+00:00",
            "course_release": course_release or config.COURSE_RELEASE,
            "network_algorithm": artifacts.NETWORK_ALGORITHM,
            "data_sources": {},
            "qc": {},
        },
    )


def test_v3_release_requires_complete_manifest_and_explicit_identity(tmp_path):
    _release(tmp_path)

    result = artifacts.validate_release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)

    assert result == {"release_id": RELEASE_ID, "files": 11, "years": 1}
    assert artifacts.release_identity(tmp_path) == RELEASE_ID
    assert metadata["artifact_contract_version"] == 3
    assert len(metadata["artifact_manifest"]) == 11
    assert artifacts.current_artifact_years(tmp_path) == [2020]


def test_missing_or_unregistered_file_fails(tmp_path):
    _release(tmp_path)
    (tmp_path / "demo_trade_war_tariffs.csv").unlink()
    with pytest.raises(artifacts.ArtifactContractError, match="manifest mismatch"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    (tmp_path / "unregistered.csv").write_text("value\n1\n", encoding="utf-8")
    with pytest.raises(artifacts.ArtifactContractError, match="manifest mismatch"):
        artifacts.validate_release(tmp_path)


def test_same_size_tamper_and_truncation_fail_integrity(tmp_path):
    _release(tmp_path)
    target = tmp_path / "panel_country.csv"
    target.write_text("value\n2\n", encoding="utf-8")
    with pytest.raises(artifacts.ArtifactContractError, match="checksum mismatch"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    target.write_text("value\n", encoding="utf-8")
    with pytest.raises(artifacts.ArtifactContractError, match="byte count mismatch"):
        artifacts.validate_release(tmp_path)


def test_manifest_format_must_match_artifact_extension(tmp_path):
    _release(tmp_path)
    metadata_path = tmp_path / artifacts.DATASET_METADATA
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    entry = next(item for item in metadata[artifacts.ARTIFACT_MANIFEST_NAME] if item["path"] == "panel_country.csv")
    entry["format"] = "binary"
    metadata[artifacts.METADATA_DIGEST_NAME] = artifacts._metadata_digest(metadata)
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    artifacts.clear_artifact_caches()

    with pytest.raises(artifacts.ArtifactContractError, match="format does not match"):
        artifacts.validate_release(tmp_path)


def test_wrong_course_missing_manifest_and_invalid_release_id_fail(tmp_path):
    _release(tmp_path, course_release="old")
    with pytest.raises(artifacts.ArtifactContractError, match="course_release mismatch"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata.pop("artifact_manifest")
    (tmp_path / artifacts.DATASET_METADATA).write_text(json.dumps(metadata), encoding="utf-8")
    artifacts.clear_artifact_caches()
    with pytest.raises(artifacts.ArtifactContractError, match="metadata checksum mismatch"):
        artifacts.validate_release(tmp_path, verify_integrity=False)

    metadata["artifact_manifest"] = []
    metadata["release_id"] = "legacy"
    (tmp_path / artifacts.DATASET_METADATA).write_text(json.dumps(metadata), encoding="utf-8")
    artifacts.clear_artifact_caches()
    with pytest.raises(artifacts.ArtifactContractError, match="release_id"):
        artifacts.validate_release(tmp_path)


def test_artifact_tree_rejects_symlinks(tmp_path):
    _release(tmp_path)
    target = tmp_path / "panel_country.csv"
    target.unlink()
    target.symlink_to("panel_industry.csv")
    with pytest.raises(artifacts.ArtifactContractError, match="symlink"):
        artifacts.validate_release(tmp_path)


def test_cached_validation_detects_same_size_tamper_with_restored_mtime(tmp_path):
    _release(tmp_path)
    artifacts.clear_artifact_caches()
    artifacts.validate_release_cached(tmp_path)
    target = tmp_path / "panel_country.csv"
    original = target.stat()
    target.write_text("value\n2\n", encoding="utf-8")
    os.utime(target, ns=(original.st_atime_ns, original.st_mtime_ns))

    with pytest.raises(artifacts.ArtifactContractError, match="checksum mismatch"):
        artifacts.validate_release_cached(tmp_path)
