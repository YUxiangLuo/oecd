"""FastAPI 服务:为前端(frontend/)提供 17 步教学系统所需的全部数据接口。

只读 data/processed/ 下的预计算产物,不在请求路径上碰原始大表。
启动:gvcsim serve(或 uv run uvicorn gvcsim.api:app --reload)
"""

import json
import math
from functools import lru_cache
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from gvcsim import report as report_mod
from gvcsim import shocks
from gvcsim.config import PROCESSED_DIR, SHOCKS_DIR, processed_years
from gvcsim.regression.design import (
    GRANULARITIES, METHODS, SHOCK_TYPES, STEP_DEPVARS, RegressionDesign,
)
from gvcsim.regression.panel import twoway_fe
from gvcsim.steps import STAGE_NAMES, STEPS

app = FastAPI(title="供应链仿真系统 API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _clean(records: list[dict]) -> list[dict]:
    """NaN → None,保证 JSON 合法。"""
    return [
        {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in r.items()}
        for r in records
    ]


@lru_cache(maxsize=32)
def _cached_csv(path_str: str, mtime_ns: int) -> pd.DataFrame:
    """按 (路径, mtime) 缓存解析结果:大面板(panel_sector ~6MB)不必每请求重新解析,
    产物被 compute 重写后 mtime 变化会自动失效。调用方不得原地修改返回的 DataFrame。"""
    return pd.read_csv(path_str, keep_default_na=False, na_values=[""])


def _read_path(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"缺少预计算产物 {path.name},请先运行 `uv run gvcsim compute`",
        )
    return _cached_csv(str(path), path.stat().st_mtime_ns)


def _read_csv(name: str) -> pd.DataFrame:
    return _read_path(PROCESSED_DIR / name)


@app.get("/api/meta")
def meta():
    years = processed_years()
    countries: list[str] = []
    sectors: list[str] = []
    if years:
        countries = sorted(
            _read_csv(f"indicators_country_{years[-1]}.csv")["country"].unique()
        )
        sectors = sorted(
            _read_csv(f"indicators_sector_{years[-1]}.csv")["sector"].unique()
        )
    return {"years": years, "countries": countries, "sectors": sectors}


@app.get("/api/steps")
def steps():
    return {
        "stages": STAGE_NAMES,
        "steps": STEPS,
    }


@app.get("/api/qc/{year}")
def qc(year: int):
    path = PROCESSED_DIR / f"qc_{year}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{year} 年尚未质检,请先运行 compute")
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/indicators/country/{year}")
def indicators_country(year: int, country: str | None = None):
    df = _read_csv(f"indicators_country_{year}.csv")
    if country:
        df = df[df["country"] == country]
    return _clean(df.to_dict(orient="records"))


@app.get("/api/indicators/sector/{year}")
def indicators_sector(
    year: int,
    country: str | None = None,
    sector: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
):
    df = _read_csv(f"indicators_sector_{year}.csv")
    if country:
        df = df[df["country"] == country]
    if sector:
        df = df[df["sector"] == sector]
    total = len(df)
    start = (page - 1) * page_size
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "rows": _clean(df.iloc[start : start + page_size].to_dict(orient="records")),
    }


@app.get("/api/viz/network/{year}")
def viz_network(year: int):
    edges = _read_csv(f"network_edges_{year}.csv")
    nodes = _read_csv(f"indicators_country_{year}.csv")[
        ["country", "gvc_participation", "betweenness_centrality"]
    ]
    return {
        "nodes": _clean(nodes.to_dict(orient="records")),
        "edges": _clean(edges.to_dict(orient="records")),
    }


def _read_shocks() -> pd.DataFrame:
    return _read_path(SHOCKS_DIR / shocks.DEMO_FILE)


@app.get("/api/shocks/events")
def shock_events():
    """事件时间线(不依赖预计算产物,直接来自事件表)。"""
    return {
        "events": shocks.events_metadata(),
        "disclaimer": "拟真演示数据:事件与税率量级参考公开资料手工编码,"
        "出口暴露度为风格化数值,不能用于研究结论",
    }


@app.get("/api/shocks/summary")
def shock_summary():
    """按年份的冲击覆盖概览(步骤2 面板头部)。"""
    df = _read_shocks()
    rows = []
    for y, g in df.groupby("year"):
        hit = g[g["treated"] == 1]
        top = g.loc[g["tariff_shock"].idxmax()]
        rows.append({
            "year": int(y),
            "treated_countries": int(hit["country"].nunique()),
            "treated_pairs": int(len(hit)),
            "mean_shock_treated": float(hit["tariff_shock"].mean()) if len(hit) else 0.0,
            "max_shock": float(top["tariff_shock"]),
            "max_shock_target": f"{top['country']}·{top['sector']}" if top["tariff_shock"] > 0 else "",
        })
    return {"years": rows, "n_countries": int(df["country"].nunique()),
            "n_sectors": int(df["sector"].nunique())}


@app.get("/api/shocks/panel")
def shock_panel(
    year: int,
    country: str | None = None,
    sector: str | None = None,
    only_hit: bool = True,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
):
    """冲击面板浏览:按冲击强度降序,支持国家/行业筛选与分页。"""
    df = _read_shocks()
    df = df[df["year"] == year]
    if country:
        df = df[df["country"] == country]
    if sector:
        df = df[df["sector"] == sector]
    if only_hit:
        df = df[df["tariff_shock"] > 0]
    df = df.sort_values("tariff_shock", ascending=False)
    total = len(df)
    start = (page - 1) * page_size
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "rows": _clean(df.iloc[start : start + page_size].to_dict(orient="records")),
    }


class RegressionRequest(BaseModel):
    step: int = 13                      # 13-16
    granularity: str = "国家–行业级"
    shock_type: str = "关税冲击"
    method: str = "双向固定效应"


@app.get("/api/regression/options")
def regression_options():
    return {
        "granularities": GRANULARITIES,
        "shock_types": SHOCK_TYPES,
        "methods": METHODS,
        "steps": {k: v[1] for k, v in STEP_DEPVARS.items()},
    }


@app.post("/api/regression/run")
def regression_run(req: RegressionRequest):
    if req.step not in STEP_DEPVARS:
        raise HTTPException(status_code=400, detail="step 必须是 13-16")
    if req.granularity not in GRANULARITIES:
        raise HTTPException(status_code=400, detail=f"granularity 必须是 {GRANULARITIES}")
    design = RegressionDesign(
        step=req.step, granularity=req.granularity,
        shock_type=req.shock_type, method=req.method,
    )
    panel = _read_csv(design.panel_file)
    result = twoway_fe(
        panel, design.depvar, list(design.regressors),
        entity=design.entity, cluster=design.cluster,
    )
    return {
        "design": {
            "depvar": design.depvar,
            "depvar_label": design.depvar_label,
            "granularity": design.granularity,
            "equation": design.equation(),
        },
        "result": result.to_dict(),
        "disclaimer": "冲击变量为拟真演示面板(全经济体覆盖、行业异质),结果仅用于验证系统链路",
    }


@app.get("/api/report/{year}")
def report(year: int):
    try:
        path = report_mod.generate(year)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    from pathlib import Path

    return {"path": path, "markdown": Path(path).read_text(encoding="utf-8")}
