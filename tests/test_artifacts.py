import json
from pathlib import Path

import pandas as pd
import pytest

from gvcsim import artifacts, config


def _year(directory: Path, year: int) -> None:
    pd.DataFrame({"value": [1]}).to_csv(directory / f"indicators_country_{year}.csv", index=False)
    pd.DataFrame({"value": [1]}).to_csv(directory / f"indicators_industry_{year}.csv", index=False)
    pd.DataFrame({"value": [1]}).to_csv(directory / f"network_edges_{year}.csv", index=False)
    pd.DataFrame({"value": [1]}).to_csv(directory / f"export_exposure_{year}.csv", index=False)
    (directory / f"qc_{year}.json").write_text("[]")


def _release_files(directory: Path) -> None:
    _year(directory, 2020)
    for name in ("panel_country.csv", "panel_industry.csv", "controls_country.csv"):
        pd.DataFrame({"value": [1]}).to_csv(directory / name, index=False)
    pd.DataFrame({"value": [1]}).to_csv(directory / "demo_trade_war_tariffs.csv", index=False)
    for name in ("qc_controls.json", "qc_shocks.json"):
        (directory / name).write_text("[]")


def _write_v2_release(directory: Path) -> dict:
    _release_files(directory)
    artifacts.write_dataset_metadata(
        directory,
        [2020],
        metadata={"generated_at": "now", "course_release": config.COURSE_RELEASE},
    )
    return artifacts.dataset_metadata(directory)


def _rewrite_metadata(directory: Path, apply) -> dict:
    path = directory / artifacts.DATASET_METADATA
    payload = json.loads(path.read_text())
    apply(payload)
    path.write_text(json.dumps(payload))
    return payload


def test_fixed_dataset_sentinel_and_v2_manifest(tmp_path: Path):
    metadata = _write_v2_release(tmp_path)

    assert artifacts.validate_release(tmp_path)["years"] == 1
    assert metadata["generated_at"] == "now"
    assert metadata["artifact_contract_version"] == artifacts.ARTIFACT_CONTRACT_VERSION
    assert set(metadata["artifacts"]) == {
        path.name for path in tmp_path.iterdir() if path.name != artifacts.DATASET_METADATA
    }
    panel = metadata["artifacts"]["panel_country.csv"]
    assert panel["kind"] == "csv" and panel["columns"] == ["value"] and panel["rows"] == 1
    qc = metadata["artifacts"]["qc_controls.json"]
    assert qc["kind"] == "json" and qc["top_level"] == "array" and qc["items"] == 0
    assert artifacts.current_artifact_years(tmp_path) == [2020]


def test_v2_rejects_same_size_content_tampering(tmp_path: Path):
    _write_v2_release(tmp_path)
    path = tmp_path / "panel_country.csv"
    original = path.read_text()
    path.write_text(original.replace("1", "2"))
    assert path.stat().st_size == len(original.encode())

    with pytest.raises(artifacts.ArtifactContractError, match="SHA-256"):
        artifacts.validate_release(tmp_path)


def test_v2_rejects_truncated_file(tmp_path: Path):
    _write_v2_release(tmp_path)
    path = tmp_path / "panel_industry.csv"
    path.write_bytes(path.read_bytes()[:-1])

    with pytest.raises(artifacts.ArtifactContractError, match="大小"):
        artifacts.validate_release(tmp_path)


def test_v2_rejects_csv_header_schema_mismatch(tmp_path: Path):
    _write_v2_release(tmp_path)
    _rewrite_metadata(
        tmp_path,
        lambda payload: payload["artifacts"]["controls_country.csv"].update(columns=["other"]),
    )

    with pytest.raises(artifacts.ArtifactContractError, match="CSV 列"):
        artifacts.validate_release(tmp_path)


def test_v2_rejects_csv_row_count_mismatch(tmp_path: Path):
    _write_v2_release(tmp_path)
    _rewrite_metadata(
        tmp_path,
        lambda payload: payload["artifacts"]["controls_country.csv"].update(rows=2),
    )

    with pytest.raises(artifacts.ArtifactContractError, match="CSV 行数"):
        artifacts.validate_release(tmp_path)


def test_json_structure_parsing_is_bounded(tmp_path: Path, monkeypatch):
    _write_v2_release(tmp_path)
    monkeypatch.setattr(artifacts, "_MAX_JSON_BYTES", 1)

    with pytest.raises(artifacts.ArtifactContractError, match="结构检查上限"):
        artifacts.validate_release(tmp_path)


def test_v2_rejects_json_mutation(tmp_path: Path):
    _write_v2_release(tmp_path)
    path = tmp_path / "qc_controls.json"
    path.write_text("{}")  # same byte length, different digest and top-level shape

    with pytest.raises(artifacts.ArtifactContractError, match="SHA-256"):
        artifacts.validate_release(tmp_path)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"top_level": "object", "items": 0}, "JSON 顶层类型"),
        ({"top_level": "array", "items": 1}, "JSON 条目数"),
    ],
)
def test_v2_rejects_json_shape_and_item_count_mismatch(tmp_path: Path, change, message):
    _write_v2_release(tmp_path)
    _rewrite_metadata(
        tmp_path,
        lambda payload: payload["artifacts"]["qc_controls.json"].update(change),
    )

    with pytest.raises(artifacts.ArtifactContractError, match=message):
        artifacts.validate_release(tmp_path)


def test_v2_rejects_kind_downgrade_for_structured_file(tmp_path: Path):
    _write_v2_release(tmp_path)
    _rewrite_metadata(
        tmp_path,
        lambda payload: payload["artifacts"]["panel_country.csv"].update(kind="binary"),
    )

    with pytest.raises(artifacts.ArtifactContractError, match="扩展名"):
        artifacts.validate_release(tmp_path)


@pytest.mark.parametrize("change", ["missing", "extra"])
def test_v2_rejects_missing_or_extra_files(tmp_path: Path, change: str):
    _write_v2_release(tmp_path)
    if change == "missing":
        (tmp_path / "demo_trade_war_tariffs.csv").unlink()
    else:
        (tmp_path / "unexpected.csv").write_text("value\n1\n")

    with pytest.raises(artifacts.ArtifactContractError, match="缺少固定产物|文件集合"):
        artifacts.validate_release(tmp_path)


def test_v2_rejects_top_level_symlink(tmp_path: Path):
    _write_v2_release(tmp_path)
    (tmp_path / "alias.csv").symlink_to("panel_country.csv")

    with pytest.raises(artifacts.ArtifactContractError, match="符号链接"):
        artifacts.validate_release(tmp_path)


def test_v2_rejects_declared_artifact_replaced_by_symlink(tmp_path: Path):
    _write_v2_release(tmp_path)
    path = tmp_path / "panel_country.csv"
    path.unlink()
    path.symlink_to("panel_industry.csv")

    with pytest.raises(artifacts.ArtifactContractError, match="符号链接"):
        artifacts.validate_release(tmp_path)


def test_v2_rejects_top_level_directory_entry(tmp_path: Path):
    _write_v2_release(tmp_path)
    (tmp_path / "unexpected").mkdir()

    with pytest.raises(artifacts.ArtifactContractError, match="顶层普通文件"):
        artifacts.validate_release(tmp_path)


def test_v2_rejects_symlinked_dataset_metadata(tmp_path: Path):
    _write_v2_release(tmp_path)
    metadata = tmp_path / artifacts.DATASET_METADATA
    retained = tmp_path / ".retained-dataset.json"
    metadata.rename(retained)
    metadata.symlink_to(retained.name)

    with pytest.raises(artifacts.ArtifactContractError, match="dataset.json 必须是普通文件"):
        artifacts.validate_release(tmp_path)


def test_manifest_csv_rows_use_logical_records(tmp_path: Path):
    (tmp_path / "header-only.csv").write_text("value\n")
    (tmp_path / "quoted-multiline.csv").write_text('value\n"line 1\nline 2"\n')

    manifest = artifacts.build_artifact_manifest(tmp_path)

    assert manifest["header-only.csv"]["rows"] == 0
    assert manifest["quoted-multiline.csv"]["rows"] == 1


def test_manifest_records_json_object_and_scalar_shapes(tmp_path: Path):
    (tmp_path / "object.json").write_text('{"a":1,"b":2}')
    (tmp_path / "number.json").write_text("42")
    (tmp_path / "boolean.json").write_text("true")

    manifest = artifacts.build_artifact_manifest(tmp_path)

    assert manifest["object.json"]["top_level"] == "object"
    assert manifest["object.json"]["items"] == 2
    assert manifest["number.json"]["top_level"] == "number"
    assert "items" not in manifest["number.json"]
    assert manifest["boolean.json"]["top_level"] == "boolean"


def test_v2_manifest_excludes_transient_publication_files(tmp_path: Path):
    _release_files(tmp_path)
    for name in (".processed-compute.lock", ".processed-publication.json"):
        (tmp_path / name).write_text("transient")
    artifacts.write_dataset_metadata(tmp_path, [2020], metadata={"course_release": config.COURSE_RELEASE})
    metadata = artifacts.dataset_metadata(tmp_path)

    assert not ({".processed-compute.lock", ".processed-publication.json"} & set(metadata["artifacts"]))
    assert artifacts.validate_release(tmp_path)["years"] == 1


def test_legacy_metadata_remains_presence_only_compatible(tmp_path: Path):
    _release_files(tmp_path)
    (tmp_path / artifacts.DATASET_METADATA).write_text(
        json.dumps({"years": [2020], "course_release": config.COURSE_RELEASE})
    )
    # Legacy validation intentionally does not hash contents during rollout.
    (tmp_path / "panel_country.csv").write_text("tampered legacy payload")

    assert artifacts.validate_release(tmp_path, allow_legacy=True)["years"] == 1


def test_immutable_release_cannot_remove_both_v2_markers_and_tamper(tmp_path: Path):
    release = tmp_path / ".processed-releases" / "release"
    release.mkdir(parents=True)
    _write_v2_release(release)
    _rewrite_metadata(
        release,
        lambda payload: (payload.pop("artifact_contract_version"), payload.pop("artifacts")),
    )
    (release / "panel_country.csv").write_text("tampered payload")

    with pytest.raises(artifacts.ArtifactContractError, match="必须使用 v2"):
        artifacts.validate_release(release, allow_legacy=False)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda payload: payload.pop("artifacts"),
        lambda payload: payload.update(artifact_contract_version=1),
        lambda payload: payload.pop("artifact_contract_version"),
        lambda payload: payload.update(artifacts=[]),
        lambda payload: payload["artifacts"]["panel_country.csv"].pop("sha256"),
    ],
)
def test_v2_never_silently_downgrades_or_accepts_malformed_manifest(tmp_path: Path, mutation):
    _write_v2_release(tmp_path)
    _rewrite_metadata(tmp_path, mutation)

    with pytest.raises(artifacts.ArtifactContractError):
        artifacts.validate_release(tmp_path)


@pytest.mark.parametrize("release", [None, "2026-spring"])
def test_release_rejects_missing_or_stale_course_version(tmp_path: Path, release: str | None):
    _release_files(tmp_path)
    metadata = {"years": [2020]}
    if release is not None:
        metadata["course_release"] = release
    (tmp_path / artifacts.DATASET_METADATA).write_text(json.dumps(metadata))

    with pytest.raises(artifacts.ArtifactContractError, match=config.COURSE_RELEASE):
        artifacts.validate_release(tmp_path)


def test_missing_or_partial_dataset_is_unavailable(tmp_path: Path):
    with pytest.raises(artifacts.ArtifactContractError):
        artifacts.validate_release(tmp_path)
    (tmp_path / artifacts.DATASET_METADATA).write_text(json.dumps({"years": [2020]}))
    with pytest.raises(artifacts.ArtifactContractError):
        artifacts.validate_release(tmp_path)


def test_csv_cache_refreshes_on_mtime(tmp_path: Path):
    path = tmp_path / "panel.csv"
    pd.DataFrame({"value": [1]}).to_csv(path, index=False)
    assert artifacts.read_csv_artifact(path).iloc[0]["value"] == 1
    pd.DataFrame({"value": [2]}).to_csv(path, index=False)
    assert artifacts.read_csv_artifact(path).iloc[0]["value"] == 2


def test_release_identity_changes_with_dataset_metadata(tmp_path: Path):
    _write_v2_release(tmp_path)
    first = artifacts.release_identity(tmp_path)
    _rewrite_metadata(tmp_path, lambda payload: payload.update(generated_at="later"))

    assert artifacts.release_identity(tmp_path) != first


def test_cached_validation_rechecks_when_any_artifact_changes(tmp_path: Path):
    _write_v2_release(tmp_path)
    artifacts.clear_release_validation_cache()
    assert artifacts.validate_release_cached(tmp_path)["years"] == 1
    (tmp_path / "panel_country.csv").write_text("corrupted after health check")

    with pytest.raises(artifacts.ArtifactContractError, match="大小|SHA-256"):
        artifacts.validate_release_cached(tmp_path)
    artifacts.clear_release_validation_cache()
