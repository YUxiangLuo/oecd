"""Read-only artifact, ICIO browser, indicator, QC, and shock routes."""

import math
import threading
from dataclasses import dataclass
from functools import lru_cache
from numbers import Real
from pathlib import Path
from types import MappingProxyType
from typing import Annotated, Literal, Mapping, cast

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query, Request

from gvcsim import concurrency, quizzes, shocks
from gvcsim.artifacts import (
    ArtifactContractError,
    dataset_metadata,
    read_csv_artifact,
    read_qc_artifact,
    validate_artifact,
    validate_qc_payload,
)
from gvcsim.config import PROCESSED_DIR, RAW_DATA_DIR, processed_years
from gvcsim.data import crosswalk, icio_browser, quality
from gvcsim.data.raw_icio import validate_raw_source_bindings
from gvcsim.indicator_schema import INDICATOR_SCHEMA
from gvcsim.indicators import tradeflow
from gvcsim.shocks import SHOCK_TARIFF
from gvcsim.steps import STAGE_NAMES, STEPS

router = APIRouter()


def _clean_value(value):
    """JSON 不支持的 NaN/±Infinity 统一转为 ``None``。"""
    if isinstance(value, Real) and not math.isfinite(float(value)):
        return None
    return value


def _clean(records: list[dict]) -> list[dict]:
    """清理 DataFrame 记录中的非有限浮点数，保证响应是严格 JSON。"""
    return [{k: _clean_value(v) for k, v in r.items()} for r in records]


def _read_path(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"缺少预计算产物 {path.name},请先运行 `uv run gvcsim compute`",
        )
    # NOTE: 返回的是共享缓存 DataFrame,派生列/筛选/排序前必须 .copy()(见 gvcsim/artifacts.py)。
    return read_csv_artifact(path)


def _read_csv(name: str) -> pd.DataFrame:
    return _read_path(PROCESSED_DIR / name)


@router.get("/api/meta")
def meta():
    years = processed_years()
    countries: list[str] = []
    sectors: list[str] = []
    if years:
        countries = sorted(_read_csv(f"indicators_country_{years[-1]}.csv")["country"].unique())
        sectors = sorted(_read_csv(f"indicators_industry_{years[-1]}.csv")["industry"].unique())
    return {
        "years": years,
        "countries": countries,
        "sectors": sectors,
        "dataset": dataset_metadata() if years else None,
    }


@router.get("/api/steps")
def steps():
    return {
        "stages": STAGE_NAMES,
        "steps": [
            {
                **step,
                **({"quiz": quiz} if (quiz := quizzes.public_quiz(cast(int, step["n"]))) is not None else {}),
            }
            for step in STEPS
        ],
    }


@router.get("/api/indicators/schema")
def indicators_schema():
    return INDICATOR_SCHEMA


def _validate_active_raw_sources() -> None:
    metadata = dataset_metadata()
    years = metadata.get("years")
    if not isinstance(years, list) or not years:
        raise ArtifactContractError("当前 release 缺少原始数据年份契约")
    try:
        validate_raw_source_bindings(metadata.get("raw_dimensions"), [int(year) for year in years], RAW_DATA_DIR)
    except (OSError, RuntimeError, ValueError) as error:
        raise ArtifactContractError(str(error)) from error


def db_meta():
    _validate_active_raw_sources()
    # The active release was strictly validated when published.  Exact source
    # hashes are checked above, so reparsing five complete wide matrices here
    # would add latency without adding evidence.
    return icio_browser.meta(strict_validate=False)


def db_slice(
    year: int,
    table: str = "z",
    row_country: str | None = None,
    col_country: str | None = None,
    row_sector: str | None = None,
    col_sector: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
):
    try:
        _validate_active_raw_sources()
        payload = icio_browser.slice_table(
            year=year,
            table=table,
            row_country=row_country,
            col_country=col_country,
            row_sector=row_sector,
            col_sector=col_sector,
            page=page,
            page_size=page_size,
            raw_dir=RAW_DATA_DIR,
            strict_validate=False,
        )
        _validate_active_raw_sources()
        return payload
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/api/db/meta")
async def db_meta_http(request: Request):
    return await concurrency.for_request(request, lambda: concurrency.run_raw_io(db_meta))


@router.get("/api/db/slice")
async def db_slice_http(
    request: Request,
    year: int,
    table: str = "z",
    row_country: str | None = None,
    col_country: str | None = None,
    row_sector: str | None = None,
    col_sector: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
):
    return await concurrency.for_request(
        request,
        lambda: concurrency.run_raw_io(
            db_slice,
            year,
            table,
            row_country,
            col_country,
            row_sector,
            col_sector,
            page,
            page_size,
        ),
    )


def _qc_contract() -> object:
    return dataset_metadata().get("qc_contract")


@router.get("/api/qc/shocks")
def qc_shocks():
    path = PROCESSED_DIR / "qc_shocks.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="冲击面板尚未质检,请先运行 compute")
    return read_qc_artifact(
        path,
        scope=quality.QC_SCOPE_SHOCKS,
        contract=_qc_contract(),
    )


@router.get("/api/qc/controls")
def qc_controls():
    path = PROCESSED_DIR / "qc_controls.json"
    if path.exists():
        return read_qc_artifact(
            path,
            scope=quality.QC_SCOPE_CONTROLS,
            contract=_qc_contract(),
        )
    controls_path = PROCESSED_DIR / "controls_country.csv"
    if not controls_path.exists():
        raise HTTPException(status_code=404, detail="控制变量尚未生成,请先运行 compute")
    payload = [c.to_dict() for c in quality.check_controls_country(_read_path(controls_path))]
    return validate_qc_payload(
        payload,
        scope=quality.QC_SCOPE_CONTROLS,
        contract=_qc_contract(),
    )


@router.get("/api/qc/{year}")
def qc(year: int):
    path = PROCESSED_DIR / f"qc_{year}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{year} 年尚未质检,请先运行 compute")
    return read_qc_artifact(
        path,
        scope=quality.QC_SCOPE_ICIO,
        contract=_qc_contract(),
    )


def _with_derived(df: pd.DataFrame) -> pd.DataFrame:
    """在公开文献指标列之外派生毛出口与教学用份额列（不改变 CSV schema）。"""
    out = df.copy()
    out["gross_exports"] = tradeflow.gross_exports(out)
    gross = out["gross_exports"]
    out["FVA_share"] = (out["FVA"] / gross).where(gross > 0)
    out["DVAex_share"] = (out["DVAex"] / gross).where(gross > 0)
    out["3_VA_GVC_share"] = (out["3_VA_GVC"] / out["SVA"]).where(out["SVA"] > 0)
    out["3b_VA_GVC_C_share"] = (out["3b_VA_GVC_C"] / out["SVA"]).where(out["SVA"] > 0)
    return out


@router.get("/api/indicators/country/{year}")
def indicators_country(year: int, country: str | None = None):
    df = _with_derived(_read_csv(f"indicators_country_{year}.csv"))
    if country:
        df = df[df["country"] == country]
    return _clean(df.to_dict(orient="records"))


def _indicators_industry_page(
    year: int,
    country: str | None = None,
    industry: str | None = None,
    page: int = 1,
    page_size: int = 25,
) -> dict:
    df = _with_derived(_read_csv(f"indicators_industry_{year}.csv"))
    if country:
        df = df[df["country"] == country]
    if industry:
        df = df[df["industry"] == industry]
    total = len(df)
    start = (page - 1) * page_size
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "rows": _clean(df.iloc[start : start + page_size].to_dict(orient="records")),
    }


@router.get("/api/indicators/industry/{year}")
def indicators_industry(
    year: int,
    country: str | None = None,
    industry: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
):
    return _indicators_industry_page(year, country, industry, page, page_size)


@router.get("/api/viz/network/{year}")
def viz_network(year: int):
    edges = _read_csv(f"network_edges_{year}.csv")
    country_df = _read_csv(f"indicators_country_{year}.csv")
    nodes = country_df[["country", "weighted degree", "betweenesscentrality"]].copy()
    nodes["gross_exports"] = tradeflow.gross_exports(country_df)
    nodes["gvc_production_share"] = (country_df["3_VA_GVC"] / country_df["SVA"]).where(country_df["SVA"] > 0)
    return {
        "nodes": _clean(nodes.to_dict(orient="records")),
        "edges": _clean(edges.to_dict(orient="records")),
    }


def _read_shocks() -> pd.DataFrame:
    return _read_path(PROCESSED_DIR / shocks.DEMO_FILE)


def _shock_source_disclaimer(frame: pd.DataFrame) -> str:
    try:
        exposure = shocks.tariff_exposure_disclaimer(frame)
    except ValueError as exc:
        raise ArtifactContractError(f"冲击面板来源验证失败：{exc}") from exc
    return "拟真政策冲击仅供教学，不能用于研究结论。" + exposure


@dataclass(frozen=True)
class _ExposureIndex:
    """Immutable lookup built once for one exact resolved release/file identity."""

    values: Mapping[tuple[str, str, str, int], float]
    available_years: Mapping[tuple[str, str, str], tuple[int, ...]]
    fixed_base_years: Mapping[tuple[str, str, str], int]


_EXPOSURE_RUNTIME_COLUMNS = shocks.EXPOSURE_LOOKUP_COLUMNS
_exposure_index_lock = threading.RLock()


def _read_runtime_exposure(path: Path) -> pd.DataFrame:
    """Read only lookup columns without retaining the full publication table cache."""
    return pd.read_csv(path, usecols=list(_EXPOSURE_RUNTIME_COLUMNS), keep_default_na=False, na_values=[""])


@lru_cache(maxsize=8)
def _build_exposure_index_cached(
    root_text: str,
    release_id: str,
    release_stat: tuple[int, int, int, int, int],
    years: tuple[int, ...],
    imposers: tuple[str, ...],
    file_state: tuple[tuple[str, int, int, int, int, int], ...],
) -> _ExposureIndex:
    del release_id, release_stat
    root = Path(root_text)
    frames: list[pd.DataFrame] = []
    for relative, *_stat in file_state:
        frame = _read_runtime_exposure(root / relative)
        missing_columns = sorted(set(_EXPOSURE_RUNTIME_COLUMNS) - set(frame.columns))
        if missing_columns:
            raise ValueError(f"OECD ICIO 出口暴露度索引 schema 不完整；missing={missing_columns}")
        # Publication validates the complete bilateral table. Runtime only needs
        # destinations that a catalogue event can actually request.
        frame = frame.loc[frame["imposer"].astype(str).isin(imposers), list(_EXPOSURE_RUNTIME_COLUMNS)].copy()
        if frame.empty:
            raise ValueError(f"OECD ICIO 出口暴露度索引缺少 catalogue 加征方: {relative}")
        frames.append(frame)
    if not frames:
        raise ValueError("OECD ICIO 出口暴露度索引不能从空表建立")
    exposure_data = pd.concat(frames, ignore_index=True)

    key_data = exposure_data.loc[:, list(shocks.EXPOSURE_KEY_COLUMNS)].copy()
    for column in ("country", "sector", "imposer"):
        normalized = key_data[column].fillna("").astype(str).str.strip()
        if normalized.eq("").any():
            raise ValueError(f"OECD ICIO 出口暴露度索引 {column} 含空白标识符")
        key_data[column] = normalized
    if set(key_data["imposer"].unique()) != set(imposers):
        missing = sorted(set(imposers) - set(key_data["imposer"].unique()))
        raise ValueError(f"OECD ICIO 出口暴露度索引缺少 catalogue 加征方；missing={missing}")
    year_values = pd.to_numeric(key_data["year"], errors="coerce").to_numpy(dtype=float)
    if not np.isfinite(year_values).all() or not np.equal(year_values, np.floor(year_values)).all():
        raise ValueError("OECD ICIO 出口暴露度索引 year 必须是有限整数")
    key_data["year"] = year_values.astype(np.int64)
    duplicate = key_data.duplicated(list(shocks.EXPOSURE_KEY_COLUMNS), keep=False)
    if duplicate.any():
        examples = key_data.loc[duplicate, list(shocks.EXPOSURE_KEY_COLUMNS)].head(3).to_dict(orient="records")
        raise ValueError(f"OECD ICIO 出口暴露度索引键重复；examples={examples}")

    exposure_values = pd.to_numeric(exposure_data["export_exposure"], errors="coerce").to_numpy(dtype=float)
    if not np.isfinite(exposure_values).all():
        raise ValueError("OECD ICIO 出口暴露度索引 export_exposure 必须是数值有限值")
    if ((exposure_values < 0.0) | (exposure_values > 1.0)).any():
        raise ValueError("OECD ICIO 出口暴露度索引 export_exposure 必须位于 [0,1]")

    raw_values = {
        (str(country), str(sector), str(imposer), int(year)): float(exposure)
        for country, sector, imposer, year, exposure in zip(
            key_data["country"].to_numpy(),
            key_data["sector"].to_numpy(),
            key_data["imposer"].to_numpy(),
            key_data["year"].to_numpy(),
            exposure_values,
            strict=True,
        )
    }
    available: dict[tuple[str, str, str], list[int]] = {}
    for country, sector, imposer, exposure_year in raw_values:
        available.setdefault((country, sector, imposer), []).append(exposure_year)
    available_sorted = {key: tuple(sorted(set(values))) for key, values in available.items()}
    fixed: dict[tuple[str, str, str], int] = {}
    for (country, sector, imposer), candidate_years in available_sorted.items():
        first = shocks._first_tariff_year(country, sector, imposer, list(years))
        if first is None:
            fixed[(country, sector, imposer)] = max(candidate_years)
            continue
        pre = [candidate for candidate in candidate_years if candidate < first]
        if not pre:
            raise ArtifactContractError(
                f"固定处理前权重要求 {country}/{sector}→{imposer} 在首次处理年 {first} 之前至少有一个发布年份；"
                "不得回退到最早处理年"
            )
        fixed[(country, sector, imposer)] = max(pre)
    return _ExposureIndex(
        values=MappingProxyType(raw_values),
        available_years=MappingProxyType(available_sorted),
        fixed_base_years=MappingProxyType(fixed),
    )


def _build_exposure_index(
    root_text: str,
    release_id: str,
    release_stat: tuple[int, int, int, int, int],
    years: tuple[int, ...],
    imposers: tuple[str, ...],
    file_state: tuple[tuple[str, int, int, int, int, int], ...],
) -> _ExposureIndex:
    """Single-flight wrapper: one worker process constructs at most one cold index."""
    with _exposure_index_lock:
        return _build_exposure_index_cached(root_text, release_id, release_stat, years, imposers, file_state)


def clear_exposure_index_cache() -> None:
    with _exposure_index_lock:
        _build_exposure_index_cached.cache_clear()


def _current_exposure_index() -> _ExposureIndex:
    root = PROCESSED_DIR.resolve()
    metadata = dataset_metadata(root)
    release_id = metadata.get("release_id")
    if not isinstance(release_id, str):
        raise ValueError("当前 release 缺少稳定 release_id，不能建立出口暴露度索引")
    years = tuple(int(year) for year in metadata.get("years", processed_years()))
    metadata_stat = (root / "dataset.json").stat()
    release_stat = (
        metadata_stat.st_dev,
        metadata_stat.st_ino,
        metadata_stat.st_size,
        metadata_stat.st_mtime_ns,
        metadata_stat.st_ctime_ns,
    )
    path = root / shocks.EXPOSURE_LOOKUP_FILE
    validate_artifact(path)
    stat_result = path.stat()
    file_state = [
        (
            path.relative_to(root).as_posix(),
            stat_result.st_dev,
            stat_result.st_ino,
            stat_result.st_size,
            stat_result.st_mtime_ns,
            stat_result.st_ctime_ns,
        )
    ]
    imposers = tuple(shocks.catalogue_tariff_imposers())
    if not imposers:
        raise ValueError("关税事件目录没有可索引的加征方")
    return _build_exposure_index(str(root), release_id, release_stat, years, imposers, tuple(file_state))


def _with_tariff_exposure(df: pd.DataFrame, year: int) -> pd.DataFrame:
    """Enrich only an already-paginated tariff page from the release-keyed index."""
    out = df.copy()

    def event_note(value: object) -> str | None:
        if pd.isna(value):
            return None
        text = str(value)
        return text if text.strip() else None

    intensity = pd.to_numeric(out["shock_intensity"], errors="coerce")
    treated = pd.to_numeric(out["treated"], errors="coerce")
    notes = [event_note(value) for value in out["note"]]
    structural_zero = [
        bool(np.isfinite(shock) and shock == 0.0 and np.isfinite(flag) and flag == 0.0 and note is None)
        for shock, flag, note in zip(intensity, treated, notes, strict=True)
    ]

    # Structural zeroes are genuine no-event observations. Do not resolve an
    # event/imposer or open the release exposure index for those rows.
    imposer_by_event = {event.name: event.imposer for event in shocks.EVENTS}
    imposers: list[str | None] = []
    for is_zero, note in zip(structural_zero, notes, strict=True):
        if is_zero:
            imposers.append(None)
            continue
        if note is None:
            raise ArtifactContractError("非零或受处理关税冲击行缺少事件，无法解析加征方")
        imposer = imposer_by_event.get(note)
        if imposer is None:
            raise ArtifactContractError(f"关税冲击事件无法解析加征方: {note!r}")
        imposers.append(imposer)
    out["main_imposer"] = imposers

    needs_oecd = any(
        not is_zero and imposer is not None and source == shocks.EXPOSURE_SOURCE_OECD_ICIO
        for is_zero, imposer, source in zip(
            structural_zero,
            imposers,
            out["tariff_exposure_source"],
            strict=True,
        )
    )
    index = _current_exposure_index() if needs_oecd else None
    fixed_values: list[float | None] = []
    current_values: list[float | None] = []
    base_years: list[int | None] = []
    exposure_modes: list[str | None] = []
    exposure_sources: list[str | None] = []
    for country, sector, imposer, source, note, mode, is_zero in zip(
        out["country"],
        out["sector"],
        out["main_imposer"],
        out["tariff_exposure_source"],
        out["note"],
        out["tariff_exposure_mode"],
        structural_zero,
        strict=True,
    ):
        if is_zero:
            base_years.append(None)
            fixed_values.append(None)
            current_values.append(None)
            exposure_modes.append(None)
            exposure_sources.append(None)
            continue
        key = (str(country), str(sector), str(imposer)) if imposer is not None else None
        if key is not None and source == shocks.EXPOSURE_SOURCE_STYLIZED:
            stylized = shocks._stylized_exposure(key[0], key[2])
            base_years.append(None)
            fixed_values.append(stylized)
            current_values.append(stylized)
            exposure_modes.append(str(mode))
            exposure_sources.append(str(source))
            continue
        if source != shocks.EXPOSURE_SOURCE_OECD_ICIO:
            raise ArtifactContractError(f"关税冲击行含未知出口暴露度来源: {source!r}")
        if key is None:
            raise ArtifactContractError(f"OECD ICIO 关税冲击事件无法解析加征方: {note!r}")
        if index is None:
            raise ArtifactContractError("OECD ICIO 关税冲击行缺少出口暴露度索引")
        if not index.available_years.get(key):
            raise ArtifactContractError(f"OECD ICIO 行业出口暴露度缺少国家/行业/加征方覆盖: {key}")
        try:
            base_year = index.fixed_base_years[key]
        except KeyError as exc:
            raise ArtifactContractError(f"OECD ICIO 出口暴露度缺少固定权重键: {key}") from exc
        fixed_key = (*key, base_year)
        try:
            fixed_value = index.values[fixed_key]
        except KeyError as exc:
            raise ArtifactContractError(f"OECD ICIO 出口暴露度缺少固定年份键: {fixed_key}") from exc
        current_key = (*key, year)
        try:
            current_value = index.values[current_key]
        except KeyError as exc:
            raise ArtifactContractError(f"OECD ICIO 出口暴露度缺少请求年份键: {current_key}") from exc
        base_years.append(base_year)
        fixed_values.append(fixed_value)
        current_values.append(current_value)
        exposure_modes.append(str(mode))
        exposure_sources.append(str(source))
    out["export_exposure"] = fixed_values
    out["export_exposure_fixed"] = fixed_values
    out["export_exposure_contemporaneous"] = current_values
    out["exposure_base_year"] = base_years
    out["exposure_mode"] = exposure_modes
    out["exposure_source"] = exposure_sources
    out["formula"] = "shock_intensity = Σ(事件双边行业平均加征税率 × 该国家–行业对加征方的出口份额)"
    return out


ShockFilter = Literal["treated", "nonzero", "all"]
ShockSort = Literal["intensity_desc", "intensity_asc", "country_asc", "industry_asc"]
SHOCK_SORTS = ("intensity_desc", "intensity_asc", "country_asc", "industry_asc")


def _shock_type_metadata(shock_type: str) -> dict:
    _shock_view_columns(shock_type)
    return {
        "key": shock_type,
        "label": shocks.SHOCK_LABELS[shock_type],
        "definition": shocks.SHOCK_DEFINITIONS[shock_type],
        "treated_definition": (
            f"权威处理标记来自 {shocks.SHOCK_SPECS[shock_type][1]}==1；"
            f"生成契约使用 shock_intensity>{shocks.TREATED_THRESHOLD:g}，即本面板所编码政策增量的正暴露；低强度不能当作零暴露。"
        ),
        "treated_threshold": shocks.TREATED_THRESHOLD,
        "treated_operator": ">",
    }


def _resolve_shock_filter(filter_value: ShockFilter | None, only_hit: bool | None) -> ShockFilter:
    if filter_value is not None and only_hit is not None:
        raise HTTPException(status_code=400, detail="filter 与旧参数 only_hit 不能同时使用")
    if filter_value is not None:
        return filter_value
    if only_hit is not None:
        # Controlled compatibility adapter: old only_hit meant finite intensity > 0,
        # never the authoritative treated flag.
        return "nonzero" if only_hit else "all"
    return "treated"


def _resolve_shock_sort(sort: str) -> ShockSort:
    if sort not in SHOCK_SORTS:
        raise HTTPException(status_code=400, detail=f"sort 必须是 {list(SHOCK_SORTS)}")
    return cast(ShockSort, sort)


def _shock_view_columns(shock_type: str) -> tuple[str, str, str, str, str]:
    if shock_type not in shocks.SHOCK_SPECS:
        raise HTTPException(status_code=400, detail=f"shock_type 必须是 {list(shocks.SHOCK_SPECS)}")
    shock_col, treated_col = shocks.SHOCK_SPECS[shock_type]
    if shock_type == SHOCK_TARIFF:
        return shock_col, treated_col, "announced_date", "effective_date", "note"
    prefix = shock_col.removesuffix("_shock")
    return (
        shock_col,
        treated_col,
        f"{prefix}_announced_date",
        f"{prefix}_effective_date",
        f"{prefix}_note",
    )


@router.get("/api/shocks/events")
def shock_events():
    """只展示在当前冲击面板中有对应数据行的事件。

    ``events_metadata`` 是事件定义全集，而面板只把每个国家-行业-年份格中
    贡献最大的事件写进对应 ``*_note`` 列。若把定义全集原样交给学生，某些
    被更大贡献覆盖的事件虽然可点击，右侧却找不到与之对应的冲击行。可见列表
    因此从当前 release 的权威面板反向筛选，保证事件列表与面板内容一致。
    """
    frame = _read_shocks()
    disclaimer = _shock_source_disclaimer(frame)
    events = shocks.selectable_events_metadata(frame)
    return {
        "events": events,
        "disclaimer": disclaimer,
        "source_disclosure": shocks.EVENT_SOURCE_DISCLOSURE,
    }


@router.get("/api/crosswalk/demo")
def crosswalk_demo(year: int = 2019):
    try:
        return crosswalk.demo_payload(year)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/api/shocks/summary")
def shock_summary(shock_type: str = SHOCK_TARIFF):
    """Return authoritative-treated and finite-nonzero coverage as distinct counts."""
    shock_col, treated_col, *_ = _shock_view_columns(shock_type)
    df = _read_shocks()
    rows = []
    for y, g in df.groupby("year"):
        intensity = pd.to_numeric(g[shock_col], errors="coerce")
        finite = pd.Series(np.isfinite(intensity.to_numpy(dtype=float)), index=g.index)
        treated = g[g[treated_col] == 1]
        nonzero = g[finite & intensity.gt(0)]
        finite_intensity = intensity.where(finite)
        top_index = finite_intensity.idxmax() if finite_intensity.notna().any() else None
        top = g.loc[top_index] if top_index is not None else None
        max_shock = float(finite_intensity.loc[top_index]) if top_index is not None else 0.0
        treated_intensity = pd.to_numeric(treated[shock_col], errors="coerce")
        treated_intensity = treated_intensity[np.isfinite(treated_intensity.to_numpy(dtype=float))]
        nonzero_intensity = pd.to_numeric(nonzero[shock_col], errors="coerce")
        rows.append(
            {
                "year": int(y),
                "treated_countries": int(treated["country"].nunique()),
                "treated_pairs": int(len(treated)),
                "nonzero_countries": int(nonzero["country"].nunique()),
                "nonzero_pairs": int(len(nonzero)),
                "mean_shock_treated": float(treated_intensity.mean()) if len(treated_intensity) else 0.0,
                "mean_shock_nonzero": float(nonzero_intensity.mean()) if len(nonzero_intensity) else 0.0,
                "max_shock": max_shock,
                "max_shock_target": f"{top['country']}·{top['sector']}" if top is not None and max_shock > 0 else "",
            }
        )
    return {
        "type": _shock_type_metadata(shock_type),
        "years": rows,
        "n_countries": int(df["country"].nunique()),
        "n_sectors": int(df["sector"].nunique()),
    }


@router.get("/api/shocks/panel")
def shock_panel(
    year: int,
    shock_type: str = SHOCK_TARIFF,
    country: str | None = None,
    sector: str | None = None,
    filter: Annotated[ShockFilter | None, Query()] = None,
    only_hit: Annotated[bool | None, Query(deprecated=True)] = None,
    sort: Annotated[ShockSort, Query()] = "intensity_desc",
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 25,
):
    """Filter/sort/count first, paginate, then enrich no more than one page."""
    shock_filter = _resolve_shock_filter(filter, only_hit)
    shock_sort = _resolve_shock_sort(sort)
    shock_col, treated_col, announced_col, effective_col, note_col = _shock_view_columns(shock_type)
    df = _read_shocks()
    disclaimer = _shock_source_disclaimer(df)
    df = df[df["year"] == year]
    if country:
        df = df[df["country"] == country]
    if sector:
        df = df[df["sector"] == sector]
    intensity = pd.to_numeric(df[shock_col], errors="coerce")
    finite = pd.Series(np.isfinite(intensity.to_numpy(dtype=float)), index=df.index)
    if shock_filter == "treated":
        df = df[df[treated_col] == 1]
    elif shock_filter == "nonzero":
        df = df[finite & intensity.gt(0)]
    # Rebind the sort vector after filtering. Assigning the pre-filter Series to
    # an empty frame would align its old index back into a synthetic all-null row.
    intensity = pd.to_numeric(df[shock_col], errors="coerce")
    df = df.assign(_shock_sort=intensity)
    if shock_sort == "intensity_desc":
        by, ascending = ["_shock_sort", "country", "sector"], [False, True, True]
    elif shock_sort == "intensity_asc":
        by, ascending = ["_shock_sort", "country", "sector"], [True, True, True]
    elif shock_sort == "country_asc":
        by, ascending = ["country", "sector", "_shock_sort"], [True, True, False]
    else:
        by, ascending = ["sector", "country", "_shock_sort"], [True, True, False]
    df = df.sort_values(by, ascending=ascending, na_position="last", kind="mergesort")
    total = len(df)
    start = (page - 1) * page_size
    page_frame = df.iloc[start : start + page_size]
    rows = page_frame[["country", "sector", "year"]].copy()
    rows["shock_intensity"] = pd.to_numeric(page_frame[shock_col], errors="coerce")
    rows["treated"] = pd.to_numeric(page_frame[treated_col], errors="coerce")
    rows["announced_date"] = page_frame[announced_col]
    rows["effective_date"] = page_frame[effective_col]
    rows["note"] = page_frame[note_col]
    rows["shock_type"] = shock_type
    if shock_type == SHOCK_TARIFF:
        rows["tariff_exposure_source"] = page_frame["tariff_exposure_source"]
        rows["tariff_exposure_mode"] = page_frame["tariff_exposure_mode"]
        rows["tariff_exposure_disclosure"] = page_frame["tariff_exposure_disclosure"]
        rows = _with_tariff_exposure(rows, year)
    return {
        "type": _shock_type_metadata(shock_type),
        "filter": shock_filter,
        "sort": shock_sort,
        "total": total,
        "page": page,
        "page_size": page_size,
        "rows": _clean(rows.to_dict(orient="records")),
        "disclaimer": disclaimer,
    }
