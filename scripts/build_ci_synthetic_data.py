#!/usr/bin/env python3
"""Build a small, balanced OECD-ICIO-shaped dataset for CI only.

This is deliberately not a production data fallback.  It requires both an
explicit CI environment and ``GVCSIM_CI_SYNTHETIC=1``, rejects production mode,
and refuses to overwrite any existing raw or published data.  The generated CSV
files use the real OECD wide-table schema, then the normal pymrio parser and
:mod:`gvcsim.pipeline` build every artifact.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "OECD_ICIO"
PROCESSED_DIR = ROOT / "data" / "processed"
MARKER = RAW_DIR / ".ci-only-synthetic.json"

YEARS = tuple(range(2016, 2021))
COUNTRIES = (
    "AUS",  # explicit never-treated tariff control: no exports to USA
    "BRA",
    "CAN",
    "CHN",
    "DEU",
    "JPN",
    "KOR",
    "MEX",
    "NZL",
    "RUS",
    "TUR",
    "USA",
    "VNM",
    "ROW",
)
SECTORS = (
    "A01_02",
    "A03",
    "B05_06",
    "B07_08",
    "B09",
    "C10T12",
    "C13T15",
    "C16",
    "C17_18",
    "C19",
    "C20",
    "C21",
    "C22",
    "C23",
    "C24",
    "C25",
    "C26",
    "C27",
    "C28",
    "C29",
    "C30",
    "C31T33",
    "J62_63",
    "K",
)
FINAL_DEMAND = ("HFCE", "NPISH", "GGFC", "GFCF", "INVNT", "DPABR")


def _require_empty_ci_workspace() -> None:
    if os.environ.get("GVCSIM_CI_SYNTHETIC") != "1":
        raise SystemExit("refusing to build synthetic data without GVCSIM_CI_SYNTHETIC=1")
    if os.environ.get("CI", "").strip().lower() not in {"1", "true", "yes"}:
        raise SystemExit("refusing to build synthetic data outside an explicit CI environment")
    if os.environ.get("GVCSIM_ENV", "").strip().lower() in {"prod", "production"}:
        raise SystemExit("refusing to build synthetic data in production")
    existing_raw = sorted(RAW_DIR.glob("ICIO*_*.csv")) if RAW_DIR.exists() else []
    processed_exists = PROCESSED_DIR.exists() or PROCESSED_DIR.is_symlink()
    if existing_raw or processed_exists:
        paths = [*(str(path) for path in existing_raw)]
        if processed_exists:
            paths.append(str(PROCESSED_DIR))
        raise SystemExit("refusing to overwrite existing data: " + ", ".join(paths))


def _node(country_index: int, sector_index: int) -> int:
    return country_index * len(SECTORS) + sector_index


def _z_matrix(year: int) -> np.ndarray:
    """Sparse directed production graph with deterministic year variation."""
    size = len(COUNTRIES) * len(SECTORS)
    matrix = np.zeros((size, size), dtype=float)
    year_offset = year - YEARS[0]
    usa = COUNTRIES.index("USA")
    chn = COUNTRIES.index("CHN")

    def add(source: int, target: int, base: float) -> None:
        variation = 1.0 + 0.018 * year_offset * (((source * 3 + target * 5) % 7) - 3)
        matrix[source, target] += base * variation

    for country_index, country in enumerate(COUNTRIES):
        for sector_index, _sector in enumerate(SECTORS):
            source = _node(country_index, sector_index)
            # Domestic input chain and self-use keep every sector economically active.
            add(source, source, 3.0 + 0.15 * (sector_index % 5))
            add(source, _node(country_index, (sector_index + 1) % len(SECTORS)), 2.0)
            add(source, _node(country_index, (sector_index + 5) % len(SECTORS)), 0.8)

            # A country ring plus a sector offset creates cross-border supply chains.
            next_country = (country_index + 1) % len(COUNTRIES)
            add(source, _node(next_country, sector_index), 1.5)
            if sector_index % 2 == 0:
                add(source, _node((country_index + 3) % len(COUNTRIES), (sector_index + 2) % len(SECTORS)), 0.9)

            # All economies except AUS export intermediate inputs to the US.  AUS is
            # intentionally the never-treated control in CI's tariff DID fixture.
            if country not in {"AUS", "USA"}:
                add(source, _node(usa, (sector_index + 3) % len(SECTORS)), 1.2)
            elif country == "USA":
                add(source, _node(chn, (sector_index + 4) % len(SECTORS)), 1.1)

            # Changing edges (not just weights) make exact unweighted centrality vary
            # over time, so the network outcome exercises a non-degenerate regression.
            if year >= 2017 and sector_index % 3 == 0:
                add(source, _node(chn, SECTORS.index("C26")), 0.7)
            if year >= 2018 and country_index % 2 == 0 and sector_index % 4 == 1:
                add(source, _node((country_index + 5) % len(COUNTRIES), SECTORS.index("C24")), 0.6)
            if year >= 2019 and country_index % 3 == 1 and sector_index % 5 == 2:
                add(source, _node(usa, SECTORS.index("C28")), 0.5)
            if year == 2020 and country_index % 4 == 2 and sector_index % 3 == 1:
                add(source, _node(chn, SECTORS.index("J62_63")), 0.4)
    return matrix


def _final_demand(z_matrix: np.ndarray, year: int) -> np.ndarray:
    """Positive final demand sized so every industry's value added is positive."""
    size = z_matrix.shape[0]
    demand = np.zeros((size, len(COUNTRIES) * len(FINAL_DEMAND)), dtype=float)
    row_inputs = z_matrix.sum(axis=1)
    column_inputs = z_matrix.sum(axis=0)
    category_shares = np.array([0.62, 0.04, 0.10, 0.18, 0.03, 0.03])
    usa = COUNTRIES.index("USA")

    for row in range(size):
        exporter_index = row // len(SECTORS)
        exporter = COUNTRIES[exporter_index]
        sector_index = row % len(SECTORS)
        # x = row(Z) + Y and x - column(Z) stays comfortably positive.
        total = max(32.0, column_inputs[row] - row_inputs[row] + 32.0)
        total *= 1.0 + 0.012 * (year - YEARS[0]) * (((exporter_index + sector_index) % 5) - 2)

        destination_weights = np.ones(len(COUNTRIES), dtype=float)
        destination_weights[exporter_index] = 8.0
        if exporter == "AUS":
            destination_weights[usa] = 0.0
        else:
            destination_weights[usa] += 4.0
        destination_weights[COUNTRIES.index("CHN")] += 2.0
        destination_weights[COUNTRIES.index("DEU")] += 1.0
        destination_weights /= destination_weights.sum()

        for destination_index, destination_share in enumerate(destination_weights):
            start = destination_index * len(FINAL_DEMAND)
            demand[row, start : start + len(FINAL_DEMAND)] = total * destination_share * category_shares
    return demand


def _write_oecd_csv(year: int) -> Path:
    labels = [f"{country}_{sector}" for country in COUNTRIES for sector in SECTORS]
    demand_labels = [f"{country}_{category}" for country in COUNTRIES for category in FINAL_DEMAND]
    z_matrix = _z_matrix(year)
    final_demand = _final_demand(z_matrix, year)
    output = z_matrix.sum(axis=1) + final_demand.sum(axis=1)
    primary_input = output - z_matrix.sum(axis=0)
    if np.any(primary_input <= 0):
        raise RuntimeError(f"{year}: synthetic table has non-positive primary input")

    columns = [*labels, *demand_labels, "OUT"]
    values = np.zeros((len(labels) + 3, len(columns)), dtype=float)
    values[: len(labels), : len(labels)] = z_matrix
    values[: len(labels), len(labels) : -1] = final_demand
    values[: len(labels), -1] = output
    values[len(labels), : len(labels)] = primary_input * 0.08  # TLS
    values[len(labels) + 1, : len(labels)] = primary_input * 0.92  # VA
    values[len(labels) + 2, : len(labels)] = output  # OUT account row
    values[len(labels) + 2, len(labels) : -1] = final_demand.sum(axis=0)
    values[len(labels) + 2, -1] = output.sum()

    frame = pd.DataFrame(values, index=[*labels, "TLS", "VA", "OUT"], columns=columns)
    frame.index.name = "V1"
    path = RAW_DIR / f"ICIO2023_{year}.csv"
    frame.to_csv(path, float_format="%.8f")
    return path


def main() -> None:
    _require_empty_ci_workspace()
    RAW_DIR.mkdir(parents=True, exist_ok=False)
    paths = [_write_oecd_csv(year) for year in YEARS]
    marker = {
        "kind": "gvcsim-ci-only-synthetic-oecd-icio",
        "production_data": False,
        "years": list(YEARS),
        "countries": list(COUNTRIES),
        "sectors": list(SECTORS),
        "n_countries": len(COUNTRIES),
        "n_sectors": len(SECTORS),
        "expected_regression_countries": len(COUNTRIES) - 1,  # ROW is excluded
        "expected_tariff_untreated_clusters": 1,  # AUS
        "raw_files": [path.name for path in paths],
    }
    MARKER.write_text(json.dumps(marker, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # Import only after raw files exist so config's normal path discovery sees them.
    from gvcsim import pipeline

    pipeline.run(list(YEARS))
    print(f"CI-only synthetic release ready: {len(COUNTRIES)} countries × {len(SECTORS)} sectors × {len(YEARS)} years")


if __name__ == "__main__":
    main()
