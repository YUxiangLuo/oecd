import os
from pathlib import Path

import pytest

from gvcsim.artifacts import (
    ARTIFACT_MANIFEST,
    NETWORK_ALGORITHM,
    ArtifactContractError,
    _cached_csv,
    current_artifact_years,
    read_csv_artifact,
    register_artifacts,
    validate_artifact,
)


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


def test_artifact_contract_registers_years_and_rejects_tampering(tmp_path: Path):
    country = tmp_path / "indicators_country_2020.csv"
    industry = tmp_path / "indicators_industry_2020.csv"
    country.write_text("country,value\nAAA,1\n", encoding="utf-8")
    industry.write_text("country,industry,value\nAAA,s1,1\n", encoding="utf-8")
    supporting = [tmp_path / name for name in ["qc_2020.json", "export_exposure_2020.csv", "network_edges_2020.csv"]]
    for path in supporting:
        path.write_text("{}\n", encoding="utf-8")

    register_artifacts(tmp_path, [country.name, industry.name, *(path.name for path in supporting)])

    assert current_artifact_years(tmp_path) == [2020]
    validate_artifact(country)
    assert read_csv_artifact(country, require_current=True).loc[0, "country"] == "AAA"

    country.write_text("country,value\nAAA,999\n", encoding="utf-8")
    with pytest.raises(ArtifactContractError, match="产物清单"):
        validate_artifact(country)


def test_artifact_contract_rejects_missing_and_old_algorithm(tmp_path: Path):
    country = tmp_path / "indicators_country_2020.csv"
    country.write_text("country,value\nAAA,1\n", encoding="utf-8")
    with pytest.raises(ArtifactContractError, match=ARTIFACT_MANIFEST):
        validate_artifact(country)

    register_artifacts(tmp_path, [country.name])
    manifest = tmp_path / ARTIFACT_MANIFEST
    payload = manifest.read_text(encoding="utf-8").replace(NETWORK_ALGORITHM, "legacy-thresholded-v0")
    manifest.write_text(payload, encoding="utf-8")
    with pytest.raises(ArtifactContractError, match="Gephi-compatible"):
        validate_artifact(country)
