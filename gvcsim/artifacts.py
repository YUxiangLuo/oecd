"""Simple fixed-directory artifact access."""

from __future__ import annotations

import json
import re
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any

import pandas as pd

DATASET_METADATA = "dataset.json"
NETWORK_ALGORITHM = "gephi-compatible-directed-unweighted-positive-v1"
_csv_cache_lock = threading.RLock()


class ArtifactContractError(RuntimeError):
    pass


def dataset_metadata(processed_dir: Path | None = None) -> dict[str, Any]:
    from gvcsim.config import PROCESSED_DIR

    path = (processed_dir or PROCESSED_DIR) / DATASET_METADATA
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ArtifactContractError("缺少可用的 dataset.json，请重新运行 `uv run gvcsim compute`") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("years"), list):
        raise ArtifactContractError("dataset.json 格式无效，请重新运行 compute")
    return payload


def current_artifact_years(processed_dir: Path) -> list[int]:
    candidate_years = {
        int(match.group(1))
        for path in processed_dir.glob("indicators_country_*.csv")
        if (match := re.fullmatch(r"indicators_country_(\d{4})\.csv", path.name))
    }
    return sorted(
        year
        for year in candidate_years
        if all(
            (processed_dir / name).is_file()
            for name in (
                f"qc_{year}.json",
                f"export_exposure_{year}.csv",
                f"indicators_country_{year}.csv",
                f"indicators_industry_{year}.csv",
                f"network_edges_{year}.csv",
            )
        )
    )


def validate_artifact(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(path)


def validate_source(path: Path, processed_dir: Path | None = None) -> None:
    del processed_dir
    if not path.is_file():
        raise FileNotFoundError(path)


def validate_release(processed_dir: Path | None = None, *, validate_sources: bool = False) -> dict[str, int]:
    del validate_sources
    from gvcsim.config import PROCESSED_DIR

    directory = processed_dir or PROCESSED_DIR
    metadata = dataset_metadata(directory)
    years = current_artifact_years(directory)
    declared = sorted({int(year) for year in metadata["years"]})
    if not declared or years != declared:
        raise ArtifactContractError("固定产物目录不完整，请重新运行 compute")
    required = (
        "panel_country.csv",
        "panel_industry.csv",
        "controls_country.csv",
        "demo_trade_war_tariffs.csv",
        "qc_controls.json",
        "qc_shocks.json",
    )
    missing = [name for name in required if not (directory / name).is_file()]
    if missing:
        raise ArtifactContractError("缺少固定产物:" + "、".join(missing))
    return {"files": len(list(directory.glob("*"))), "years": len(years)}


@lru_cache(maxsize=32)
def _cached_csv(path_str: str, mtime_ns: int) -> pd.DataFrame:
    del mtime_ns
    return pd.read_csv(path_str, keep_default_na=False, na_values=[""])


def read_csv_artifact(path: Path, *, require_current: bool = False) -> pd.DataFrame:
    del require_current
    validate_artifact(path)
    resolved = path.resolve()
    with _csv_cache_lock:
        return _cached_csv(str(resolved), resolved.stat().st_mtime_ns)


def write_dataset_metadata(processed_dir: Path, years: list[int], *, metadata: dict[str, Any] | None = None) -> None:
    payload = {"years": sorted(set(years)), "network_algorithm": NETWORK_ALGORITHM, **(metadata or {})}
    (processed_dir / DATASET_METADATA).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
