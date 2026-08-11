"""Read-only artifact, ICIO browser, indicator, QC, and shock routes."""

import json
import math
from numbers import Real
from pathlib import Path

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from fastapi.requests import Request

from gvcsim import artifacts, quizzes, shocks
from gvcsim.artifacts import artifact_contract, manifest_id, read_csv_artifact, validate_artifact
from gvcsim.classroom import db as classroom_db
from gvcsim.config import PROCESSED_DIR, RAW_DATA_DIR, processed_years
from gvcsim.data import crosswalk, icio_browser, quality
from gvcsim.indicator_schema import INDICATOR_SCHEMA
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
    if path.parent == PROCESSED_DIR:
        return read_csv_artifact(path, require_current=True)
    artifacts.validate_source(path)
    return read_csv_artifact(path)


def _read_csv(name: str) -> pd.DataFrame:
    return _read_path(PROCESSED_DIR / name)


@router.get("/api/meta")
def meta(request: Request):
    years = processed_years()
    countries: list[str] = []
    sectors: list[str] = []
    if years:
        countries = sorted(_read_csv(f"indicators_country_{years[-1]}.csv")["country"].unique())
        sectors = sorted(_read_csv(f"indicators_industry_{years[-1]}.csv")["industry"].unique())
    current_manifest = manifest_id() if years else None
    assignment_context = None
    assignment_unavailable = False
    user = getattr(request.state, "user", {})
    if user.get("role") == "student" and current_manifest:
        try:
            scope = classroom_db.assignment_context(user["sub"], current_manifest)
            if scope:
                assignment_context = {
                    "course_run_id": scope.get("course_run_id"),
                    "course_run_code": scope.get("course_run_code"),
                    "course_run_name": scope.get("course_run_name"),
                    "course_run_term": scope.get("course_run_term"),
                    "assignment_id": scope.get("assignment_id"),
                    "assignment_title": scope.get("assignment_title"),
                    "attempt_id": scope.get("attempt_id"),
                    "assignment_scope": scope.get("assignment_scope"),
                    "assignment_manifest_id": scope.get("assignment_manifest_id"),
                    "manifest_mismatch": bool(scope.get("manifest_mismatch")),
                    "assignment_closed": bool(scope.get("assignment_closed")),
                    "assignment_historical": bool(scope.get("assignment_historical")),
                    "due_at": scope.get("due_at"),
                }
        except classroom_db.Unavailable:
            assignment_unavailable = True
    return {
        "years": years,
        "countries": countries,
        "sectors": sectors,
        "artifact_contract": artifact_contract(),
        # 实验会话绑定该 ID:产物换代后旧会话即可被判定为过期。
        "manifest_id": current_manifest,
        "artifact_provenance": artifacts.manifest_provenance() if years else None,
        "assignment_context": assignment_context,
        "assignment_unavailable": assignment_unavailable,
        "course_run_id": (assignment_context or {}).get("course_run_id"),
        "assignment_id": (assignment_context or {}).get("assignment_id"),
        "attempt_id": (assignment_context or {}).get("attempt_id"),
        "assignment_scope": (assignment_context or {}).get("assignment_scope"),
        "manifest_mismatch": bool((assignment_context or {}).get("manifest_mismatch")),
        "assignment_closed": bool((assignment_context or {}).get("assignment_closed")),
        "assignment_historical": bool((assignment_context or {}).get("assignment_historical")),
        "course_run_code": (assignment_context or {}).get("course_run_code"),
        "course_run_name": (assignment_context or {}).get("course_run_name"),
        "course_run_term": (assignment_context or {}).get("course_run_term"),
        "assignment_title": (assignment_context or {}).get("assignment_title"),
        "due_at": (assignment_context or {}).get("due_at"),
    }


@router.get("/api/steps")
def steps():
    return {
        "stages": STAGE_NAMES,
        "steps": [
            {
                **step,
                **({"quiz": quiz} if (quiz := quizzes.public_quiz(int(step["n"]))) is not None else {}),
            }
            for step in STEPS
        ],
    }


@router.get("/api/indicators/schema")
def indicators_schema():
    return INDICATOR_SCHEMA


@router.get("/api/db/meta")
def db_meta():
    for path in sorted(RAW_DATA_DIR.glob("ICIO*_*.csv")):
        artifacts.validate_source(path)
    return icio_browser.meta()


@router.get("/api/db/slice")
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
        candidates = sorted(RAW_DATA_DIR.glob(f"ICIO*_{year}.csv"))
        if not candidates:
            raise FileNotFoundError(f"没有 {year} 年 OECD ICIO 原始表")
        for path in candidates:
            artifacts.validate_source(path)
        return icio_browser.slice_table(
            year=year,
            table=table,
            row_country=row_country,
            col_country=col_country,
            row_sector=row_sector,
            col_sector=col_sector,
            page=page,
            page_size=page_size,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/api/qc/shocks")
def qc_shocks():
    path = PROCESSED_DIR / "qc_shocks.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="冲击面板尚未质检,请先运行 compute")
    validate_artifact(path)
    return json.loads(path.read_text(encoding="utf-8"))


@router.get("/api/qc/controls")
def qc_controls():
    path = PROCESSED_DIR / "qc_controls.json"
    if path.exists():
        validate_artifact(path)
        return json.loads(path.read_text(encoding="utf-8"))
    controls_path = PROCESSED_DIR / "controls_country.csv"
    if not controls_path.exists():
        raise HTTPException(status_code=404, detail="控制变量尚未生成,请先运行 compute")
    checks = quality.check_controls_country(_read_path(controls_path))
    return [c.to_dict() for c in checks]


@router.get("/api/qc/{year}")
def qc(year: int):
    path = PROCESSED_DIR / f"qc_{year}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{year} 年尚未质检,请先运行 compute")
    validate_artifact(path)
    return json.loads(path.read_text(encoding="utf-8"))


def _with_derived(df: pd.DataFrame) -> pd.DataFrame:
    """在公开文献指标列之外派生毛出口与教学用份额列（不改变 CSV schema）。"""
    out = df.copy()
    out["gross_exports"] = out[["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"]].sum(axis=1)
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
    nodes["gross_exports"] = country_df[["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"]].sum(axis=1)
    nodes["gvc_production_share"] = (country_df["3_VA_GVC"] / country_df["SVA"]).where(country_df["SVA"] > 0)
    return {
        "nodes": _clean(nodes.to_dict(orient="records")),
        "edges": _clean(edges.to_dict(orient="records")),
    }


def _read_shocks() -> pd.DataFrame:
    return _read_path(PROCESSED_DIR / shocks.DEMO_FILE)


def _with_tariff_exposure(df: pd.DataFrame, year: int, shock_type: str) -> pd.DataFrame:
    """为关税面板行补充主要加征方及 ICIO 出口暴露度。"""
    out = df.copy()
    if shock_type != SHOCK_TARIFF:
        out["main_imposer"] = None
        out["export_exposure"] = None
        return out

    imposer_by_event = {event.name: event.imposer for event in shocks.EVENTS}
    # note 为空或对不上事件表时保持 None,不让 NaN 渗入 JSON 或查找键。
    out["main_imposer"] = [imposer_by_event.get(note) if note else None for note in out["note"].astype(str)]

    years = processed_years()
    exposure_frames = []
    for exposure_year in years:
        path = PROCESSED_DIR / f"{shocks.EXPOSURE_PREFIX}_{exposure_year}.csv"
        validate_artifact(path)
        exposure_frames.append(read_csv_artifact(path))
    exposure_data = pd.concat(exposure_frames, ignore_index=True) if exposure_frames else None
    lookup = shocks._exposure_map(exposure_data)
    fixed_values: list[float | None] = []
    current_values: list[float | None] = []
    base_years: list[int | None] = []
    for country, imposer in zip(out["country"], out["main_imposer"]):
        if imposer is None or lookup is None:
            fixed_values.append(None)
            current_values.append(None)
            base_years.append(None)
            continue
        country_code = str(country)
        base_year = shocks._fixed_exposure_year(country_code, imposer, years, lookup)
        base_years.append(base_year)
        fixed_values.append(lookup.get((country_code, imposer, base_year)) if base_year is not None else None)
        current_values.append(lookup.get((country_code, imposer, year)))
    out["export_exposure"] = fixed_values
    out["export_exposure_fixed"] = fixed_values
    out["export_exposure_contemporaneous"] = current_values
    out["exposure_base_year"] = base_years
    out["exposure_mode"] = shocks.EXPOSURE_MODE_FIXED_PRETREATMENT
    return out


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
    artifacts.validate_source(Path(shocks.__file__))
    frame = _read_shocks()
    available_by_type: dict[str, set[str]] = {}
    for shock_type in shocks.SHOCK_SPECS:
        *_unused, note_col = _shock_view_columns(shock_type)
        available_by_type[shock_type] = (
            {str(value) for value in frame[note_col].dropna().unique() if str(value)}
            if note_col in frame.columns
            else set()
        )
    events = [
        event
        for event in shocks.events_metadata()
        if str(event["name"]) in available_by_type.get(str(event.get("shock_type") or SHOCK_TARIFF), set())
    ]
    return {
        "events": events,
        "disclaimer": "拟真教学数据：事件与税率量级参考公开资料手工编码；"
        "出口暴露度由 OECD ICIO 双边流向计算，不能用于现实政策结论",
    }


@router.get("/api/crosswalk/demo")
def crosswalk_demo(year: int = 2019):
    try:
        artifacts.validate_source(Path(crosswalk.__file__))
        return crosswalk.demo_payload(year)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/api/shocks/summary")
def shock_summary(shock_type: str = SHOCK_TARIFF):
    """按年份的冲击覆盖概览(步骤11 面板头部)。"""
    shock_col, treated_col, *_ = _shock_view_columns(shock_type)
    df = _read_shocks()
    rows = []
    for y, g in df.groupby("year"):
        hit = g[g[treated_col] == 1]
        top = g.loc[g[shock_col].idxmax()]
        rows.append(
            {
                "year": int(y),
                "treated_countries": int(hit["country"].nunique()),
                "treated_pairs": int(len(hit)),
                "mean_shock_treated": float(hit[shock_col].mean()) if len(hit) else 0.0,
                "max_shock": float(top[shock_col]),
                "max_shock_target": f"{top['country']}·{top['sector']}" if top[shock_col] > 0 else "",
            }
        )
    return {"years": rows, "n_countries": int(df["country"].nunique()), "n_sectors": int(df["sector"].nunique())}


@router.get("/api/shocks/panel")
def shock_panel(
    year: int,
    shock_type: str = SHOCK_TARIFF,
    country: str | None = None,
    sector: str | None = None,
    only_hit: bool = True,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
):
    """冲击面板浏览:按冲击强度降序,支持国家/行业筛选与分页。"""
    shock_col, treated_col, announced_col, effective_col, note_col = _shock_view_columns(shock_type)
    df = _read_shocks()
    df = df[df["year"] == year]
    if country:
        df = df[df["country"] == country]
    if sector:
        df = df[df["sector"] == sector]
    if only_hit:
        df = df[df[shock_col] > 0]
    df = df.sort_values(shock_col, ascending=False)
    df = df.assign(
        tariff_shock=df[shock_col],
        treated=df[treated_col],
        announced_date=df[announced_col] if announced_col in df.columns else "",
        effective_date=df[effective_col] if effective_col in df.columns else "",
        note=df[note_col] if note_col in df.columns else "",
        shock_type=shock_type,
    )
    df = _with_tariff_exposure(df, year, shock_type)
    total = len(df)
    start = (page - 1) * page_size
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "rows": _clean(df.iloc[start : start + page_size].to_dict(orient="records")),
    }
