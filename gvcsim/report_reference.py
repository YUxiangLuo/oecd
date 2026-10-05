"""Global reference for the step 6–8 report charts: every economy's country-level reading in a year.

Mirrors the pages (frontend ``countryDistribution``): ROW excluded, linear-interpolated quartiles, and
ranks from highest to lowest with ties sharing the better rank. Shares are derived exactly as the
indicator API and the pages derive them, from the same processed country CSV.
"""

from __future__ import annotations

import math
from typing import Any

import pandas as pd

from gvcsim import config
from gvcsim.artifacts import read_csv_artifact
from gvcsim.indicators import tradeflow

# Share metrics the pages derive from a numerator and a denominator (trade and production topics).
_SHARES: dict[str, tuple[str, str]] = {
    "FVA_share": ("FVA", "gross_exports"),
    "DVAex_share": ("DVAex", "gross_exports"),
    "3_VA_GVC_share": ("3_VA_GVC", "SVA"),
    "3b_VA_GVC_C_share": ("3b_VA_GVC_C", "SVA"),
    "1_VA_D_share": ("1_VA_D", "SVA"),
    "2_VA_RT_share": ("2_VA_RT", "SVA"),
    "3a_VA_GVC_S_share": ("3a_VA_GVC_S", "SVA"),
}


def _column(df: pd.DataFrame, name: str) -> pd.Series | None:
    if name == "gross_exports":
        # Gross exports are summed from the decomposition columns; an artifact without them has no reference.
        try:
            return tradeflow.gross_exports(df)
        except KeyError:
            return None
    return df[name] if name in df.columns else None


def country_reference(metric: str, year: int, *, share_of: tuple[str, str] | None = None) -> dict[str, Any] | None:
    """Median, quartiles and ranks of ``metric`` across all economies in ``year``; None if unavailable.

    ``share_of=(part, total)`` ranks a composition part as a share of its total instead (step 6–7 构成演变).
    """
    path = config.PROCESSED_DIR / f"indicators_country_{year}.csv"
    if not path.exists():
        return None
    try:
        df = read_csv_artifact(path).copy()
    except (OSError, ValueError):
        return None
    if "country" not in df.columns:
        return None
    df = df[df["country"].astype(str) != "ROW"]
    if share_of is not None or metric in _SHARES:
        numerator, denominator = (_column(df, name) for name in (share_of or _SHARES[metric]))
        if numerator is None or denominator is None:
            return None
        values = (numerator / denominator).where(denominator > 0)
    else:
        column = _column(df, metric)
        if column is None:
            return None
        values = column
    numeric = pd.to_numeric(values, errors="coerce").astype(float)
    readings = {
        str(country): float(value) for country, value in zip(df["country"], numeric) if math.isfinite(float(value))
    }
    if len(readings) < 2:
        return None
    series = pd.Series(readings)
    return {
        "n": len(readings),
        "p25": float(series.quantile(0.25)),
        "median": float(series.quantile(0.5)),
        "p75": float(series.quantile(0.75)),
        "ranks": {country: 1 + int((series > value).sum()) for country, value in readings.items()},
    }
