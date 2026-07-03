"""FastAPI 服务:为前端(frontend/)提供 17 步教学系统所需的全部数据接口。

只读 data/processed/ 下的预计算产物,不在请求路径上碰原始大表。
启动:gvcsim serve(或 uv run uvicorn gvcsim.api:app --reload)
"""

import json
import math

import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from gvcsim import report as report_mod
from gvcsim.config import PROCESSED_DIR, processed_years
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


def _read_csv(name: str) -> pd.DataFrame:
    path = PROCESSED_DIR / name
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"缺少预计算产物 {name},请先运行 `uv run gvcsim compute`",
        )
    return pd.read_csv(path)


@app.get("/api/meta")
def meta():
    years = processed_years()
    countries: list[str] = []
    if years:
        countries = sorted(
            _read_csv(f"indicators_country_{years[-1]}.csv")["country"].unique()
        )
    return {"years": years, "countries": countries}


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


class RegressionRequest(BaseModel):
    step: int = 13                      # 13-16
    granularity: str = "国家级"
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
    design = RegressionDesign(
        step=req.step, granularity=req.granularity,
        shock_type=req.shock_type, method=req.method,
    )
    panel = _read_csv("panel_country.csv")
    result = twoway_fe(panel, design.depvar, list(design.regressors))
    return {
        "design": {
            "depvar": design.depvar,
            "depvar_label": design.depvar_label,
            "equation": design.equation(),
        },
        "result": result.to_dict(),
        "disclaimer": "冲击变量为风格化演示数据,结果仅用于验证系统链路",
    }


@app.get("/api/report/{year}")
def report(year: int):
    try:
        path = report_mod.generate(year)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    from pathlib import Path

    return {"path": path, "markdown": Path(path).read_text(encoding="utf-8")}
