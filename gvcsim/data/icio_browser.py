"""OECD ICIO 原始宽表浏览器。

原始 ICIO2023_<year>.csv 是约 3,468 行 × 3,929 列的宽表。前端不应
直接拉完整文件;本模块只读取请求需要的结构化切片:
  z        中间投入矩阵:国家-行业 × 国家-行业
  y        最终需求矩阵:国家-行业 × 目的国最终需求类别
  accounts TLS/VA/OUT 账户行转置后的国家-行业表
"""

from functools import lru_cache
from pathlib import Path
from typing import Any

import pandas as pd

from gvcsim.config import RAW_DATA_DIR, available_years

FINAL_DEMAND_CATEGORIES = ("HFCE", "NPISH", "GGFC", "GFCF", "INVNT", "DPABR")
ACCOUNT_ROWS = ("TLS", "VA", "OUT")
VALID_TABLES = ("z", "y", "accounts")


def _year_file(year: int, raw_dir: Path = RAW_DATA_DIR) -> Path:
    matches = sorted(raw_dir.glob(f"ICIO*_{year}.csv"))
    if not matches:
        raise FileNotFoundError(f"未找到 OECD ICIO 原始文件: ICIO*_{year}.csv")
    return matches[-1]


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
def _metadata(path_str: str, mtime_ns: int) -> dict[str, Any]:
    path = Path(path_str)
    header = pd.read_csv(path, nrows=0).columns.tolist()
    first_col = pd.read_csv(path, usecols=[0], keep_default_na=False).iloc[:, 0].astype(str)
    row_labels = first_col.tolist()

    value_columns = header[1:]
    industry_columns = [c for c in value_columns if _is_industry_label(c)]
    final_demand_columns = [c for c in value_columns if _is_final_demand_label(c)]

    countries = list(dict.fromkeys(_split_label(c)[0] for c in industry_columns if _split_label(c)))
    sectors = list(dict.fromkeys(_split_label(c)[1] for c in industry_columns if _split_label(c)))
    fd_categories = list(dict.fromkeys(_split_label(c)[1] for c in final_demand_columns if _split_label(c)))
    account_rows = [r for r in ACCOUNT_ROWS if r in row_labels]

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
    return _metadata(str(path), path.stat().st_mtime_ns)


@lru_cache(maxsize=32)
def _read_columns_cached(path_str: str, mtime_ns: int, usecols: tuple[str, ...]) -> pd.DataFrame:
    return pd.read_csv(path_str, usecols=list(usecols), keep_default_na=False, na_values=[""])


def _read_columns(path: Path, usecols: tuple[str, ...]) -> pd.DataFrame:
    """按列切片读取原始宽表,并按 (路径, mtime, 列集) 缓存。

    翻页只换行不换列,命中缓存后无需重扫 ~66MB 的原始文件。
    缓存的 DataFrame 不得原地修改,调用方只能做产生副本的操作。
    """
    return _read_columns_cached(str(path), path.stat().st_mtime_ns, usecols)


def meta(raw_dir: Path = RAW_DATA_DIR) -> dict[str, Any]:
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
            "industries": [],
            "final_demand_categories": list(FINAL_DEMAND_CATEGORIES),
            "account_rows": list(ACCOUNT_ROWS),
            "files": [],
            "n_rows": 0,
            "n_columns": 0,
        }

    default_year = max(years)
    latest_meta = _meta_for_path(_year_file(default_year, raw_dir))
    return {
        "years": years,
        "default_year": default_year,
        "countries": latest_meta["countries"],
        "industries": latest_meta["sectors"],
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
) -> dict[str, Any]:
    if table not in VALID_TABLES:
        raise ValueError(f"table 必须是 {', '.join(VALID_TABLES)}")
    if page < 1:
        raise ValueError("page 必须大于等于 1")
    if page_size < 1 or page_size > 200:
        raise ValueError("page_size 必须在 1–200 之间")

    path = _year_file(year, raw_dir)
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
        df = _read_columns(path, ("V1", *col_labels))
        df = df[df["V1"].isin(page_rows)]
        df = df.rename(columns={"V1": "row"})
        return {
            "year": year,
            "table": table,
            "total": len(row_labels),
            "page": page,
            "page_size": page_size,
            "columns": df.columns.tolist(),
            "rows": _records(df),
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
        df = _read_columns(path, ("V1", *fd_cols))
        df = df[df["V1"].isin(page_rows)]
        df = df.rename(columns={"V1": "row"})
        return {
            "year": year,
            "table": table,
            "total": len(row_labels),
            "page": page,
            "page_size": page_size,
            "columns": df.columns.tolist(),
            "rows": _records(df),
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
    }
