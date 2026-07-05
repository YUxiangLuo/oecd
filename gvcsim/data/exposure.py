"""ICIO-derived export exposure by destination country.

The tariff mock uses an exposure term: exporter c's exports to the imposing
market divided by c's total exports. This module computes that term from the
same OECD ICIO flows used by the indicator engine, replacing the hand-written
country table when precomputed files are available.
"""

from __future__ import annotations

import pandas as pd

from gvcsim.config import PROCESSED_DIR
from gvcsim.indicators.core import IcioArrays

# Historical EU retaliation in 2018 used the EU as an aggregate policy actor.
# Include the UK because the encoded 2018 event occurred before Brexit.
EU_IMPOSER_MEMBERS = {
    "AUT", "BEL", "BGR", "CYP", "CZE", "DEU", "DNK", "ESP", "EST", "FIN",
    "FRA", "GBR", "GRC", "HRV", "HUN", "IRL", "ITA", "LTU", "LUX", "LVA",
    "MLT", "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "SWE",
}


def build_export_exposure(arr: IcioArrays, year: int) -> pd.DataFrame:
    """Return country-imposer-year export exposure from ICIO bilateral flows.

    bilateral_exports[c, d] = c's intermediate exports to d + final exports to d.
    export_exposure[c, d] = bilateral_exports[c, d] / c's total exports.
    An additional ``EU`` imposer row aggregates exports to EU member economies.
    """
    col_of = {r: i for i, r in enumerate(arr.regions)}
    rows: list[dict[str, float | int | str]] = []

    for country in arr.regions:
        p = arr.pos[country]
        total_exports = float(arr.E[p].sum())

        for imposer in arr.regions:
            if imposer == country:
                bilateral = 0.0
            else:
                q = arr.pos[imposer]
                bilateral = float(arr.Z[p[:, None], q].sum() + arr.Yd[p, col_of[imposer]].sum())
            rows.append({
                "country": country,
                "imposer": imposer,
                "year": year,
                "bilateral_exports": bilateral,
                "total_exports": total_exports,
                "export_exposure": bilateral / total_exports if total_exports > 0 else 0.0,
            })

        eu_members = [r for r in arr.regions if r in EU_IMPOSER_MEMBERS and r != country]
        eu_bilateral = 0.0
        for member in eu_members:
            q = arr.pos[member]
            eu_bilateral += float(arr.Z[p[:, None], q].sum() + arr.Yd[p, col_of[member]].sum())
        rows.append({
            "country": country,
            "imposer": "EU",
            "year": year,
            "bilateral_exports": eu_bilateral,
            "total_exports": total_exports,
            "export_exposure": eu_bilateral / total_exports if total_exports > 0 else 0.0,
        })

    return pd.DataFrame(rows)


def write_export_exposure(arr: IcioArrays, year: int) -> pd.DataFrame:
    df = build_export_exposure(arr, year)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(PROCESSED_DIR / f"export_exposure_{year}.csv", index=False)
    return df


def read_export_exposures(years: list[int] | None = None) -> pd.DataFrame | None:
    """Read available precomputed exposure files.

    Returns ``None`` when no requested files exist so callers can fall back to
    legacy stylized exposure values.
    """
    paths = []
    if years is None:
        paths = sorted(PROCESSED_DIR.glob("export_exposure_*.csv"))
    else:
        paths = [PROCESSED_DIR / f"export_exposure_{y}.csv" for y in years]
        paths = [p for p in paths if p.exists()]
    if not paths:
        return None
    return pd.concat([pd.read_csv(p) for p in paths], ignore_index=True)
