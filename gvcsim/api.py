"""FastAPI 服务:为前端(frontend/)提供 17 步教学系统所需的全部数据接口。

只读 data/processed/ 下的预计算产物,不在请求路径上碰原始大表。
启动:gvcsim serve(或 uv run uvicorn gvcsim.api:app --reload)
"""

import json
import math
from functools import lru_cache
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from gvcsim import auth
from gvcsim import report as report_mod
from gvcsim import shocks
from gvcsim.config import PROCESSED_DIR, SHOCKS_DIR, processed_years
from gvcsim.data import crosswalk, icio_browser
from gvcsim.regression.design import (
    CONTROL_MODES, GRANULARITIES, METHODS, SHOCK_TYPES, STEP_DEPVARS, RegressionDesign,
)
from gvcsim.regression.panel import run_design_with_benchmark
from gvcsim.steps import STAGE_NAMES, STEPS

app = FastAPI(title="供应链仿真系统 API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

PUBLIC_API_PATHS = {"/api/auth/login", "/api/auth/me"}


@app.middleware("http")
async def require_api_bearer(request: Request, call_next):
    """除登录/令牌校验外,所有 /api 数据接口都要求 Bearer token。"""
    if request.method == "OPTIONS" or not request.url.path.startswith("/api/"):
        return await call_next(request)
    if request.url.path in PUBLIC_API_PATHS:
        return await call_next(request)

    authorization = request.headers.get("authorization")
    if not authorization or not authorization.startswith("Bearer "):
        return JSONResponse(status_code=401, content={"detail": "缺少 Bearer 令牌"})
    if auth.verify_token(authorization.removeprefix("Bearer ")) is None:
        return JSONResponse(status_code=401, content={"detail": "令牌无效或已过期"})
    return await call_next(request)


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


INDICATOR_SCHEMA = {
    "groups": [
        {
            "key": "trade",
            "label": "KWW 贸易流分解",
            "fields": [
                "trade_gross_exports",
                "trade_dva",
                "trade_dva_final",
                "trade_dva_intermediate_absorbed",
                "trade_dva_intermediate_reexported",
                "trade_rdv",
                "trade_ddc",
                "trade_fva",
                "trade_fdc",
                "trade_pdc",
                "share_trade_dva",
                "share_trade_fva",
                "share_trade_pdc",
                "share_trade_backward_gvc",
                "share_trade_forward_gvc",
                "share_trade_gvc_participation",
            ],
        },
        {
            "key": "production",
            "label": "WWYZ 生产分解",
            "fields": [
                "prod_va_total",
                "prod_pure_domestic",
                "prod_traditional",
                "prod_simple_gvc",
                "prod_complex_gvc",
                "prod_gvc_total",
                "share_prod_pure_domestic",
                "share_prod_traditional",
                "share_prod_simple_gvc",
                "share_prod_complex_gvc",
                "share_prod_gvc_total",
            ],
        },
        {
            "key": "length",
            "label": "价值链长度",
            "fields": ["upstreamness", "upstreamness_domestic", "upstreamness_cross"],
        },
        {
            "key": "network",
            "label": "生产网络中心性",
            "fields": [
                "degree_centrality",
                "betweenness_centrality",
                "eigenvector_centrality",
            ],
        },
    ],
    "fields": {
        "trade_gross_exports": {"label": "毛出口", "format": "amount"},
        "trade_dva": {"label": "国内增加值 DVA", "format": "amount"},
        "trade_dva_final": {"label": "DVA:最终品出口", "format": "amount"},
        "trade_dva_intermediate_absorbed": {"label": "DVA:进口国吸收", "format": "amount"},
        "trade_dva_intermediate_reexported": {"label": "DVA:再出口吸收", "format": "amount"},
        "trade_rdv": {"label": "返回国内增加值 RDV", "format": "amount"},
        "trade_ddc": {"label": "国内重复计算 DDC", "format": "amount"},
        "trade_fva": {"label": "外国增加值 FVA", "format": "amount"},
        "trade_fdc": {"label": "外国重复计算 FDC", "format": "amount"},
        "trade_pdc": {"label": "纯重复计算 PDC", "format": "amount"},
        "share_trade_dva": {"label": "DVA 份额", "format": "pct"},
        "share_trade_fva": {"label": "FVA 份额", "format": "pct"},
        "share_trade_pdc": {"label": "PDC 份额", "format": "pct"},
        "share_trade_backward_gvc": {"label": "后向 GVC 参与度", "format": "pct"},
        "share_trade_forward_gvc": {"label": "前向 GVC 参与度", "format": "pct"},
        "share_trade_gvc_participation": {"label": "总 GVC 参与度", "format": "pct"},
        "prod_va_total": {"label": "总增加值", "format": "amount"},
        "prod_pure_domestic": {"label": "纯国内生产", "format": "amount"},
        "prod_traditional": {"label": "传统贸易生产", "format": "amount"},
        "prod_simple_gvc": {"label": "简单 GVC 生产", "format": "amount"},
        "prod_complex_gvc": {"label": "复杂 GVC 生产", "format": "amount"},
        "prod_gvc_total": {"label": "GVC 生产合计", "format": "amount"},
        "share_prod_pure_domestic": {"label": "纯国内份额", "format": "pct"},
        "share_prod_traditional": {"label": "传统贸易份额", "format": "pct"},
        "share_prod_simple_gvc": {"label": "简单 GVC 份额", "format": "pct"},
        "share_prod_complex_gvc": {"label": "复杂 GVC 份额", "format": "pct"},
        "share_prod_gvc_total": {"label": "GVC 生产份额", "format": "pct"},
        "upstreamness": {"label": "上游度", "format": "number"},
        "upstreamness_domestic": {"label": "国内段长度", "format": "number"},
        "upstreamness_cross": {"label": "跨境段长度", "format": "number"},
        "degree_centrality": {"label": "度中心性", "format": "number"},
        "betweenness_centrality": {"label": "介数中心性", "format": "number"},
        "eigenvector_centrality": {"label": "特征向量中心性", "format": "number"},
    },
}


class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/auth/login")
def login(req: LoginRequest):
    user = auth.authenticate(req.username, req.password)
    if user is None:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    token, exp = auth.issue_token(user)
    return {"token": token, "user": user, "expires_at": exp}


@app.get("/api/auth/me")
def me(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少 Bearer 令牌")
    payload = auth.verify_token(authorization.removeprefix("Bearer "))
    if payload is None:
        raise HTTPException(status_code=401, detail="令牌无效或已过期")
    return {"username": payload["sub"], "name": payload["name"], "role": payload["role"]}


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


@app.get("/api/indicators/schema")
def indicators_schema():
    return INDICATOR_SCHEMA


@app.get("/api/db/meta")
def db_meta():
    return icio_browser.meta()


@app.get("/api/db/slice")
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


@app.get("/api/qc/shocks")
def qc_shocks():
    path = PROCESSED_DIR / "qc_shocks.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="冲击面板尚未质检,请先运行 compute")
    return json.loads(path.read_text(encoding="utf-8"))


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
        ["country", "share_trade_gvc_participation", "betweenness_centrality"]
    ]
    return {
        "nodes": _clean(nodes.to_dict(orient="records")),
        "edges": _clean(edges.to_dict(orient="records")),
    }


def _read_shocks() -> pd.DataFrame:
    return _read_path(SHOCKS_DIR / shocks.DEMO_FILE)


def _shock_view_columns(shock_type: str) -> tuple[str, str, str, str, str]:
    if shock_type not in shocks.SHOCK_SPECS:
        raise HTTPException(status_code=400, detail=f"shock_type 必须是 {list(shocks.SHOCK_SPECS)}")
    shock_col, treated_col = shocks.SHOCK_SPECS[shock_type]
    if shock_type == "关税冲击":
        return shock_col, treated_col, "announced_date", "effective_date", "note"
    prefix = shock_col.removesuffix("_shock")
    return (
        shock_col,
        treated_col,
        f"{prefix}_announced_date",
        f"{prefix}_effective_date",
        f"{prefix}_note",
    )


@app.get("/api/shocks/events")
def shock_events():
    """事件时间线(不依赖预计算产物,直接来自事件表)。"""
    return {
        "events": shocks.events_metadata(),
        "disclaimer": "拟真演示数据:事件与税率量级参考公开资料手工编码,"
        "出口暴露度由 OECD ICIO 双边流向计算,不能用于研究结论",
    }


@app.get("/api/crosswalk/demo")
def crosswalk_demo(year: int = 2019):
    try:
        return crosswalk.demo_payload(year)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get("/api/shocks/summary")
def shock_summary(shock_type: str = "关税冲击"):
    """按年份的冲击覆盖概览(步骤2 面板头部)。"""
    shock_col, treated_col, *_ = _shock_view_columns(shock_type)
    df = _read_shocks()
    rows = []
    for y, g in df.groupby("year"):
        hit = g[g[treated_col] == 1]
        top = g.loc[g[shock_col].idxmax()]
        rows.append({
            "year": int(y),
            "treated_countries": int(hit["country"].nunique()),
            "treated_pairs": int(len(hit)),
            "mean_shock_treated": float(hit[shock_col].mean()) if len(hit) else 0.0,
            "max_shock": float(top[shock_col]),
            "max_shock_target": f"{top['country']}·{top['sector']}" if top[shock_col] > 0 else "",
        })
    return {"years": rows, "n_countries": int(df["country"].nunique()),
            "n_sectors": int(df["sector"].nunique())}


@app.get("/api/shocks/panel")
def shock_panel(
    year: int,
    shock_type: str = "关税冲击",
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
    method: str = "双重差分 (DID)"
    control_mode: str = "不加控制变量"
    interaction: bool = False


@app.get("/api/regression/options")
def regression_options():
    return {
        "granularities": GRANULARITIES,
        "shock_types": SHOCK_TYPES,
        "methods": METHODS,
        "control_modes": CONTROL_MODES,
        "steps": {k: v[1] for k, v in STEP_DEPVARS.items()},
    }


def _validate_design(
    step: int,
    granularity: str,
    shock_type: str,
    method: str,
    control_mode: str = "不加控制变量",
    interaction: bool = False,
) -> RegressionDesign:
    if step not in STEP_DEPVARS:
        raise HTTPException(status_code=400, detail="step 必须是 13-16")
    if granularity not in GRANULARITIES:
        raise HTTPException(status_code=400, detail=f"granularity 必须是 {GRANULARITIES}")
    if shock_type not in SHOCK_TYPES:
        raise HTTPException(status_code=400, detail=f"shock_type 必须是 {SHOCK_TYPES}")
    if method not in METHODS:
        raise HTTPException(status_code=400, detail=f"method 必须是 {METHODS}")
    if control_mode not in CONTROL_MODES:
        raise HTTPException(status_code=400, detail=f"control_mode 必须是 {CONTROL_MODES}")
    return RegressionDesign(
        step=step, granularity=granularity, shock_type=shock_type,
        method=method, control_mode=control_mode, interaction=interaction,
    )


def _design_info(design: RegressionDesign) -> dict:
    return {
        "step": design.step,
        "depvar": design.depvar,
        "depvar_label": design.depvar_label,
        "granularity": design.granularity,
        "shock_type": design.shock_type,
        "shock_col": design.shock_col,
        "treated_col": design.treated_col,
        "method": design.method,
        "control_mode": design.control_mode,
        "interaction": design.interaction,
        "controls": list(design.controls),
        "control_labels": design.control_labels,
        "equation": design.equation(),
        "panel_file": design.panel_file,
        "entity": design.entity,
        "cluster": design.cluster,
    }


@app.get("/api/regression/design")
def regression_design(
    step: int = 13,
    granularity: str = "国家–行业级",
    shock_type: str = "关税冲击",
    method: str = "双重差分 (DID)",
    control_mode: str = "不加控制变量",
    interaction: bool = False,
):
    """步骤12 设计确认:不跑回归,只返回方程与面板/个体/聚类等设计信息。"""
    return _design_info(_validate_design(step, granularity, shock_type, method, control_mode, interaction))


@app.post("/api/regression/run")
def regression_run(req: RegressionRequest):
    design = _validate_design(
        req.step, req.granularity, req.shock_type, req.method, req.control_mode, req.interaction
    )
    panel = _read_csv(design.panel_file)
    try:
        result, benchmark = run_design_with_benchmark(panel, design)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "design": _design_info(design),
        "result": result.to_dict(),
        "benchmark": benchmark,
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
