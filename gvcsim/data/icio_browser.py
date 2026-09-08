"""OECD ICIO 原始宽表浏览器。

原始 ICIO2023_<year>.csv 是约 3,468 行 × 3,929 列的宽表。前端不应
直接拉完整文件;本模块只读取请求需要的结构化切片:
  z        中间投入矩阵:国家-行业 × 国家-行业
  y        最终需求矩阵:国家-行业 × 目的国最终需求类别
  accounts TLS/VA/OUT 账户行转置后的国家-行业表
"""

from collections import OrderedDict
from concurrent.futures import Future
from functools import lru_cache
from pathlib import Path
import threading
from typing import Any

import pandas as pd

from gvcsim.config import RAW_DATA_DIR, available_years
from gvcsim.file_identity import verified_source
from gvcsim.data.raw_icio import (
    DimensionContract,
    RawFileIdentity,
    RawICIOValidationError,
    dimension_contract_for,
    raw_file_identity,
    resolve_year_source,
    validate_raw_file,
    validate_raw_years,
)

FINAL_DEMAND_CATEGORIES = ("HFCE", "NPISH", "GGFC", "GFCF", "INVNT", "DPABR")
ACCOUNT_ROWS = ("TLS", "VA", "OUT")
VALID_TABLES = ("z", "y", "accounts")
_raw_cache_lock = threading.RLock()
_TABLE_CACHE_SIZE = 5
_tables: OrderedDict[RawFileIdentity, pd.DataFrame] = OrderedDict()
_table_reads: dict[RawFileIdentity, Future[pd.DataFrame]] = {}
_cache_generation = 0


def _year_file(year: int, raw_dir: Path = RAW_DATA_DIR) -> Path:
    return resolve_year_source(year, raw_dir)


def validate_raw_files(
    years: list[int],
    raw_dir: Path = RAW_DATA_DIR,
    contract: DimensionContract | None = None,
) -> None:
    """Strictly validate every raw source and reject cross-year dimension drift."""
    validate_raw_years(years, raw_dir, contract)


def _split_label(label: str) -> tuple[str, str] | None:
    if "_" not in label:
        return None
    country, rest = label.split("_", 1)
    if len(country) != 3:
        return None
    return country, rest


def _is_industry_label(label: str) -> bool:
    parts = _split_label(label)
    return bool(parts and parts[1] not in FINAL_DEMAND_CATEGORIES)


def _is_final_demand_label(label: str) -> bool:
    parts = _split_label(label)
    return bool(parts and parts[1] in FINAL_DEMAND_CATEGORIES)


@lru_cache(maxsize=16)
def _metadata(identity: RawFileIdentity) -> dict[str, Any]:
    path = Path(identity[0])
    source = verified_source(path, identity[1:])
    header = pd.read_csv(source, nrows=0).columns.tolist()
    if not isinstance(source, Path):
        source.seek(0)
    first_col = pd.read_csv(source, usecols=[0], keep_default_na=False).iloc[:, 0].astype(str)
    row_labels = first_col.tolist()

    value_columns = header[1:]
    industry_columns = [c for c in value_columns if _is_industry_label(c)]
    final_demand_columns = [c for c in value_columns if _is_final_demand_label(c)]

    industry_parts = [parts for column in industry_columns if (parts := _split_label(column)) is not None]
    demand_parts = [parts for column in final_demand_columns if (parts := _split_label(column)) is not None]
    countries = list(dict.fromkeys(parts[0] for parts in industry_parts))
    sectors = list(dict.fromkeys(parts[1] for parts in industry_parts))
    fd_categories = list(dict.fromkeys(parts[1] for parts in demand_parts))
    account_rows = [r for r in ACCOUNT_ROWS if r in row_labels]
    if raw_file_identity(path) != identity:
        raise RawICIOValidationError(f"raw ICIO file changed during metadata reading: {path}")

    return {
        "header": header,
        "row_labels": row_labels,
        "industry_columns": industry_columns,
        "final_demand_columns": final_demand_columns,
        "countries": countries,
        "sectors": sectors,
        "final_demand_categories": fd_categories,
        "account_rows": account_rows,
        "n_rows": len(row_labels),
        "n_columns": len(header),
    }


def _meta_for_path(path: Path) -> dict[str, Any]:
    with _raw_cache_lock:
        return _metadata(raw_file_identity(path))


def _read_table(identity: RawFileIdentity) -> pd.DataFrame:
    """Share a year across different countries without serial CSV rescans.

    Retain at most five full tables (about 520 MiB for the current OECD release).
    The short dictionary lock never covers a full-table read or a Future wait.
    """
    with _raw_cache_lock:
        cached = _tables.get(identity)
        if cached is not None:
            _tables.move_to_end(identity)
            return cached
        future = _table_reads.get(identity)
        owns_read = future is None
        generation = _cache_generation
        if future is None:
            future = Future()
            _table_reads[identity] = future
    if not owns_read:
        return future.result()
    try:
        frame = pd.read_csv(verified_source(Path(identity[0]), identity[1:]), keep_default_na=False, na_values=[""])
        if raw_file_identity(Path(identity[0])) != identity:
            raise RawICIOValidationError(f"raw ICIO file changed during table reading: {identity[0]}")
        with _raw_cache_lock:
            if generation == _cache_generation:
                _tables[identity] = frame
                while len(_tables) > _TABLE_CACHE_SIZE:
                    _tables.popitem(last=False)
        future.set_result(frame)
        return frame
    except BaseException as error:
        future.set_exception(error)
        raise
    finally:
        with _raw_cache_lock:
            if _table_reads.get(identity) is future:
                _table_reads.pop(identity)


def _read_columns(path: Path, usecols: tuple[str, ...]) -> pd.DataFrame:
    """Return an isolated column selection from the immutable per-year cache."""
    frame = _read_table(raw_file_identity(path))
    # Preserve file column order, matching pandas.read_csv(usecols=...).
    wanted = set(usecols)
    if missing := wanted.difference(frame.columns):
        raise ValueError(f"Usecols do not match columns: {sorted(missing)}")
    return frame.loc[:, [column for column in frame.columns if column in wanted]].copy()


def clear_raw_browser_caches() -> None:
    """Clear raw metadata and page caches for deterministic tests and maintenance."""
    global _cache_generation
    with _raw_cache_lock:
        _metadata.cache_clear()
        _tables.clear()
        _cache_generation += 1


def meta(
    raw_dir: Path = RAW_DATA_DIR,
    contract: DimensionContract | None = None,
    *,
    strict_validate: bool = True,
) -> dict[str, Any]:
    """Return browser metadata for the available raw ICIO tables.

    ``strict_validate=False`` is reserved for the API adapter, which first
    proves that the files are byte-for-byte identical to the already strictly
    validated active release.  Direct callers retain fail-closed validation.
    """
    years = available_years(raw_dir)
    files = []
    for year in years:
        path = _year_file(year, raw_dir)
        files.append({"year": year, "file": path.name, "size_bytes": path.stat().st_size})

    if not years:
        return {
            "years": [],
            "default_year": None,
            "countries": [],
            "sectors": [],
            "final_demand_categories": list(FINAL_DEMAND_CATEGORIES),
            "account_rows": list(ACCOUNT_ROWS),
            "files": [],
            "n_rows": 0,
            "n_columns": 0,
        }

    if strict_validate:
        selected_contract = contract or dimension_contract_for(raw_dir)
        validate_raw_years(years, raw_dir, selected_contract)
    default_year = max(years)
    latest_meta = _meta_for_path(_year_file(default_year, raw_dir))
    return {
        "years": years,
        "default_year": default_year,
        "countries": latest_meta["countries"],
        "sectors": latest_meta["sectors"],
        "final_demand_categories": latest_meta["final_demand_categories"],
        "account_rows": latest_meta["account_rows"],
        "files": files,
        "n_rows": latest_meta["n_rows"],
        "n_columns": latest_meta["n_columns"],
    }


def _filter_labels(
    labels: list[str],
    country: str | None = None,
    sector: str | None = None,
) -> list[str]:
    out = []
    sector_code = (sector or "").strip()
    for label in labels:
        parts = _split_label(label)
        if not parts:
            continue
        c, s = parts
        if country and c != country:
            continue
        if sector_code and s != sector_code:
            continue
        out.append(label)
    return out


def _page(labels: list[str], page: int, page_size: int) -> list[str]:
    start = (page - 1) * page_size
    return labels[start : start + page_size]


def _records(df: pd.DataFrame) -> list[dict[str, Any]]:
    out = df.where(pd.notna(df), None).to_dict(orient="records")
    return out


def _matrix_page(
    path: Path,
    page_rows: list[str],
    value_columns: list[str],
    has_out: bool,
) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    """读取 Z/Y 当前页，并计算每行当前列切片合计与总产出 OUT。"""
    usecols = tuple(dict.fromkeys(("V1", *value_columns, *(("OUT",) if has_out else ()))))
    raw = _read_columns(path, usecols)
    raw = raw[raw["V1"].isin(page_rows)]

    if value_columns:
        totals = raw[value_columns].apply(pd.to_numeric, errors="coerce").sum(axis=1).astype(float)
    else:
        totals = pd.Series(0.0, index=raw.index)
    out_values = pd.to_numeric(raw["OUT"], errors="coerce") if has_out else pd.Series(float("nan"), index=raw.index)
    summaries = []
    for row_label, slice_total, out_value in zip(raw["V1"], totals, out_values):
        summaries.append(
            {
                "row": str(row_label),
                "slice_total": float(slice_total),
                "out": float(out_value) if pd.notna(out_value) else None,
            }
        )

    visible = raw[["V1", *value_columns]].rename(columns={"V1": "row"})
    return visible, summaries


def slice_table(
    year: int,
    table: str,
    row_country: str | None = None,
    col_country: str | None = None,
    row_sector: str | None = None,
    col_sector: str | None = None,
    page: int = 1,
    page_size: int = 25,
    raw_dir: Path = RAW_DATA_DIR,
    contract: DimensionContract | None = None,
    *,
    strict_validate: bool = True,
) -> dict[str, Any]:
    if table not in VALID_TABLES:
        raise ValueError(f"table 必须是 {', '.join(VALID_TABLES)}")
    if page < 1:
        raise ValueError("page 必须大于等于 1")
    if page_size < 1 or page_size > 200:
        raise ValueError("page_size 必须在 1–200 之间")

    path = _year_file(year, raw_dir)
    if strict_validate:
        validate_raw_file(path, contract or dimension_contract_for(raw_dir))
    info = _meta_for_path(path)
    countries: list[str] = info["countries"]
    if not countries:
        raise ValueError("原始 ICIO 文件中没有可识别的国家-行业列")

    row_country = row_country or ("CHN" if "CHN" in countries else countries[0])
    col_country = col_country or row_country

    if table == "z":
        row_labels = _filter_labels(info["industry_columns"], row_country, row_sector)
        col_labels = _filter_labels(info["industry_columns"], col_country, col_sector)
        page_rows = _page(row_labels, page, page_size)
        df, row_summaries = _matrix_page(path, page_rows, col_labels, "OUT" in info["header"])
        return {
            "year": year,
            "table": table,
            "total": len(row_labels),
            "page": page,
            "page_size": page_size,
            "columns": df.columns.tolist(),
            "rows": _records(df),
            "row_summaries": row_summaries,
        }

    if table == "y":
        row_labels = _filter_labels(info["industry_columns"], row_country, row_sector)
        category = col_sector
        fd_cols = []
        for col in info["final_demand_columns"]:
            parts = _split_label(col)
            if not parts:
                continue
            c, cat = parts
            if c != col_country:
                continue
            if category and cat != category:
                continue
            fd_cols.append(col)
        page_rows = _page(row_labels, page, page_size)
        df, row_summaries = _matrix_page(path, page_rows, fd_cols, "OUT" in info["header"])
        return {
            "year": year,
            "table": table,
            "total": len(row_labels),
            "page": page,
            "page_size": page_size,
            "columns": df.columns.tolist(),
            "rows": _records(df),
            "row_summaries": row_summaries,
        }

    # accounts: transpose TLS/VA/OUT rows into country-sector rows.
    # 读取该行筛选下的全部行业列(≤45 列)并缓存,翻页只在缓存结果上切列。
    industry_cols = _filter_labels(info["industry_columns"], row_country, row_sector)
    page_cols = _page(industry_cols, page, page_size)
    df = _read_columns(path, ("V1", *industry_cols))
    df = df[df["V1"].isin(info["account_rows"])].set_index("V1")
    transposed = df[page_cols].T.reset_index().rename(columns={"index": "row"})
    return {
        "year": year,
        "table": table,
        "total": len(industry_cols),
        "page": page,
        "page_size": page_size,
        "columns": transposed.columns.tolist(),
        "rows": _records(transposed),
        "row_summaries": [],
    }
