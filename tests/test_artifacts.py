import json
from pathlib import Path

import pandas as pd
import pytest

from gvcsim import artifacts


def _year(directory: Path, year: int) -> None:
    pd.DataFrame({"value": [1]}).to_csv(directory / f"indicators_country_{year}.csv", index=False)
    pd.DataFrame({"value": [1]}).to_csv(directory / f"indicators_industry_{year}.csv", index=False)
    pd.DataFrame({"value": [1]}).to_csv(directory / f"network_edges_{year}.csv", index=False)
    pd.DataFrame({"value": [1]}).to_csv(directory / f"export_exposure_{year}.csv", index=False)
    (directory / f"qc_{year}.json").write_text("[]")


def test_fixed_dataset_sentinel_and_files(tmp_path: Path):
    _year(tmp_path, 2020)
    for name in ("panel_country.csv", "panel_industry.csv", "controls_country.csv"):
        pd.DataFrame({"value": [1]}).to_csv(tmp_path / name, index=False)
    pd.DataFrame({"value": [1]}).to_csv(tmp_path / "demo_trade_war_tariffs.csv", index=False)
    for name in ("qc_controls.json", "qc_shocks.json"):
        (tmp_path / name).write_text("[]")
    artifacts.write_dataset_metadata(tmp_path, [2020], metadata={"generated_at": "now"})
    assert artifacts.validate_release(tmp_path)["years"] == 1
    assert artifacts.dataset_metadata(tmp_path)["generated_at"] == "now"
    assert artifacts.current_artifact_years(tmp_path) == [2020]

    (tmp_path / "demo_trade_war_tariffs.csv").unlink()
    with pytest.raises(artifacts.ArtifactContractError, match="demo_trade_war_tariffs"):
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
