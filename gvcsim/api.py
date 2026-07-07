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
from gvcsim.data import crosswalk, icio_browser, quality
from gvcsim.regression.design import (
    CONTROL_MODES,
    GRANULARITIES,
    METHODS,
    PRICE_MODES,
    SCENARIO_LABELS,
    SCENARIOS,
    SHOCK_TYPES,
    STEP_DEPVARS,
    RegressionDesign,
)
from gvcsim.regression.panel import placebo_did_distribution, run_design_with_benchmark
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
    return [{k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in r.items()} for r in records]


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


def _indicator_compat(df: pd.DataFrame) -> pd.DataFrame:
    """旧 processed CSV 的按需兼容层;新 compute 产物会直接包含这些列。"""
    out = df.copy()
    if "trade_dva" in out and "dvaex" not in out:
        out["dvaex"] = out["trade_dva"]
        out["dvart"] = out.get("trade_rdv", 0.0)
        out["ddc"] = out.get("trade_ddc", 0.0)
        out["fva"] = out.get("trade_fva", 0.0)
        out["fdc"] = out.get("trade_fdc", 0.0)
        out["exdva"] = out["dvaex"] + out["dvart"]
        out["taxsub"] = float("nan")
    if "prod_va_total" in out and "sva" not in out:
        out["sva"] = out["prod_va_total"]
        out["va_d"] = out.get("prod_pure_domestic", 0.0)
        out["va_rt"] = out.get("prod_traditional", 0.0)
        out["va_gvc_s"] = out.get("prod_simple_gvc", 0.0)
        out["va_gvc_c"] = out.get("prod_complex_gvc", 0.0)
        out["va_gvc"] = out["va_gvc_s"] + out["va_gvc_c"]
        out["fgy"] = out["prod_va_total"]
        out["fgy_d"] = out["va_d"]
        out["fgy_rt"] = out["va_rt"]
        out["fgy_gvc"] = out["va_gvc"]
        out["fgy_gvc_s"] = out["va_gvc_s"]
        out["fgy_gvc_c"] = out["va_gvc_c"]
    if "upstreamness" in out and "plv" not in out:
        out["plv"] = out["upstreamness"]
        out["plv_d"] = out.get("upstreamness_domestic", 0.0)
        out["plv_rt"] = out["plv_d"]
        out["plv_gvc"] = out["plv"].where(out.get("upstreamness_cross", 0.0) > 1e-12)
        out["ply"] = out["upstreamness"]
        out["ply_d"] = out.get("upstreamness_domestic", 0.0)
        out["ply_rt"] = out["ply_d"]
        out["ply_gvc"] = out["ply"].where(out.get("upstreamness_cross", 0.0) > 1e-12)
        out["pos_tpl"] = 1.0
        out["gvcps"] = 1.0
    return out


INDICATOR_SCHEMA = {
    "groups": [
        {
            "key": "trade",
            "label": "双边总贸易流分解",
            "fields": [
                "exdva",
                "dvaex",
                "dvart",
                "ddc",
                "fva",
                "fdc",
                "taxsub",
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
            "label": "GVC 生产分解",
            "fields": [
                "sva",
                "va_d",
                "va_rt",
                "va_gvc",
                "va_gvc_s",
                "va_gvc_c",
                "fgy",
                "fgy_d",
                "fgy_rt",
                "fgy_gvc",
                "fgy_gvc_s",
                "fgy_gvc_c",
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
            "label": "GVC 长度与位置",
            "fields": [
                "plv",
                "plv_d",
                "plv_rt",
                "plv_gvc",
                "ply",
                "ply_d",
                "ply_rt",
                "ply_gvc",
                "pos_tpl",
                "gvcps",
                "upstreamness",
                "upstreamness_domestic",
                "upstreamness_cross",
            ],
        },
        {
            "key": "network",
            "label": "生产网络中心性",
            "fields": [
                "degree",
                "indegree",
                "outdegree",
                "weighted_degree",
                "weighted_indegree",
                "weighted_outdegree",
                "eccentricity",
                "closeness_centrality",
                "harmonic_closeness_centrality",
                "degree_centrality",
                "betweenness_centrality",
                "eigenvector_centrality",
            ],
        },
    ],
    "fields": {
        "exdva": {"label": "EXDVA 出口国内增加值", "format": "amount", "customer_key": "EXDVA"},
        "dvaex": {"label": "DVAex 被国外吸收的国内增加值", "format": "amount", "customer_key": "DVAex"},
        "dvart": {"label": "DVArt 返回国内增加值", "format": "amount", "customer_key": "DVArt"},
        "ddc": {"label": "DDC 国内重复计算", "format": "amount", "customer_key": "DDC"},
        "fva": {"label": "FVA 国外增加值", "format": "amount", "customer_key": "FVA"},
        "fdc": {"label": "FDC 国外重复计算", "format": "amount", "customer_key": "FDC"},
        "taxsub": {
            "label": "taxsub 税补贴",
            "format": "amount",
            "customer_key": "taxsub",
            "method_note": "当前 2016-2020 指标引擎不单独分解税补贴,该字段保留为空值。",
        },
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
        "sva": {"label": "SVA 总增加值", "format": "amount", "customer_key": "SVA"},
        "va_d": {"label": "1_VA_D 纯国内生产", "format": "amount", "customer_key": "1_VA_D"},
        "va_rt": {"label": "2_VA_RT 传统贸易生产", "format": "amount", "customer_key": "2_VA_RT"},
        "va_gvc": {"label": "3_VA_GVC GVC 生产", "format": "amount", "customer_key": "3_VA_GVC"},
        "va_gvc_s": {"label": "3a_VA_GVC_S 简单 GVC", "format": "amount", "customer_key": "3a_VA_GVC_S"},
        "va_gvc_c": {"label": "3b_VA_GVC_C 复杂 GVC", "format": "amount", "customer_key": "3b_VA_GVC_C"},
        "fgy": {
            "label": "FGY 最终品生产",
            "format": "amount",
            "customer_key": "FGY",
            "method_note": "当前版本按同一四分类聚合口径暴露兼容字段。",
        },
        "fgy_d": {"label": "1_FGY_D 国内最终品", "format": "amount", "customer_key": "1_FGY_D"},
        "fgy_rt": {"label": "2_FGY_RT 最终品出口", "format": "amount", "customer_key": "2_FGY_RT"},
        "fgy_gvc": {"label": "3_FGY_GVC GVC 最终品", "format": "amount", "customer_key": "3_FGY_GVC"},
        "fgy_gvc_s": {"label": "3a_FGY_GVC_S 简单 GVC 最终品", "format": "amount", "customer_key": "3a_FGY_GVC_S"},
        "fgy_gvc_c": {"label": "3b_FGY_GVC_C 复杂 GVC 最终品", "format": "amount", "customer_key": "3b_FGY_GVC_C"},
        "prod_va_total": {"label": "总增加值", "format": "amount", "legacy": True},
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
        "plv": {"label": "PLv 前向总生产长度", "format": "number", "customer_key": "PLv"},
        "plv_d": {"label": "PLv_D 前向纯国内长度", "format": "number", "customer_key": "PLv_D"},
        "plv_rt": {"label": "PLv_RT 前向传统贸易长度", "format": "number", "customer_key": "PLv_RT"},
        "plv_gvc": {"label": "PLv_GVC 前向 GVC 长度", "format": "number", "customer_key": "PLv_GVC"},
        "ply": {"label": "PLy 后向总生产长度", "format": "number", "customer_key": "PLy"},
        "ply_d": {"label": "PLy_D 后向纯国内长度", "format": "number", "customer_key": "PLy_D"},
        "ply_rt": {"label": "PLy_RT 后向传统贸易长度", "format": "number", "customer_key": "PLy_RT"},
        "ply_gvc": {"label": "PLy_GVC 后向 GVC 长度", "format": "number", "customer_key": "PLy_GVC"},
        "pos_tpl": {"label": "Pos_TPL 总生产位置", "format": "number", "customer_key": "Pos_TPL"},
        "gvcps": {"label": "GVCPs GVC 位置指数", "format": "number", "customer_key": "GVCPs"},
        "upstreamness": {"label": "上游度", "format": "number", "legacy": True},
        "upstreamness_domestic": {"label": "国内段长度", "format": "number", "legacy": True},
        "upstreamness_cross": {"label": "跨境段长度", "format": "number", "legacy": True},
        "degree": {"label": "度", "format": "number", "customer_key": "degree"},
        "indegree": {"label": "入度", "format": "number", "customer_key": "indegree"},
        "outdegree": {"label": "出度", "format": "number", "customer_key": "outdegree"},
        "weighted_degree": {"label": "加权度", "format": "amount", "customer_key": "weighted degree"},
        "weighted_indegree": {"label": "加权入度", "format": "amount", "customer_key": "weighted indegree"},
        "weighted_outdegree": {"label": "加权出度", "format": "amount", "customer_key": "weighted outdegree"},
        "eccentricity": {"label": "离心率", "format": "number", "customer_key": "Eccentricity"},
        "closeness_centrality": {"label": "接近中心性", "format": "number", "customer_key": "closnesscentrality"},
        "harmonic_closeness_centrality": {
            "label": "调和中心性",
            "format": "number",
            "customer_key": "harmonicclosnesscentrality",
        },
        "degree_centrality": {"label": "加权度占比", "format": "number", "legacy": True},
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
        countries = sorted(_read_csv(f"indicators_country_{years[-1]}.csv")["country"].unique())
        sectors = sorted(_read_csv(f"indicators_sector_{years[-1]}.csv")["sector"].unique())
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


@app.get("/api/qc/controls")
def qc_controls():
    path = PROCESSED_DIR / "qc_controls.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    controls_path = PROCESSED_DIR / "controls_country.csv"
    if not controls_path.exists():
        raise HTTPException(status_code=404, detail="控制变量尚未生成,请先运行 compute")
    checks = quality.check_controls_country(_read_path(controls_path))
    return [c.to_dict() for c in checks]


@app.get("/api/qc/{year}")
def qc(year: int):
    path = PROCESSED_DIR / f"qc_{year}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{year} 年尚未质检,请先运行 compute")
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/indicators/country/{year}")
def indicators_country(year: int, country: str | None = None):
    df = _indicator_compat(_read_csv(f"indicators_country_{year}.csv"))
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
    df = _indicator_compat(_read_csv(f"indicators_sector_{year}.csv"))
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
    nodes = _indicator_compat(_read_csv(f"indicators_country_{year}.csv"))[
        ["country", "share_trade_gvc_participation", "betweenness_centrality", "trade_gross_exports"]
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
    step: int = 13  # 13-16
    granularity: str = "国家–行业级"
    shock_type: str = "关税冲击"
    method: str = "双重差分 (DID)"
    control_mode: str = "不加控制变量"
    interaction: bool = False
    price_mode: str = "名义值"
    scenario: str = "clean"
    exclude_row: bool = True


class PlaceboRequest(RegressionRequest):
    n_draws: int = 80
    seed: int = 2026


class ReportRequest(BaseModel):
    year: int | None = None
    granularity: str = "国家–行业级"
    shock_type: str = "关税冲击"
    method: str = "双重差分 (DID)"
    control_mode: str = "不加控制变量"
    interaction: bool = False
    price_mode: str = "名义值"
    exclude_row: bool = True


@app.get("/api/regression/options")
def regression_options():
    return {
        "granularities": GRANULARITIES,
        "shock_types": SHOCK_TYPES,
        "methods": METHODS,
        "control_modes": CONTROL_MODES,
        "price_modes": PRICE_MODES,
        "scenarios": SCENARIOS,
        "scenario_labels": SCENARIO_LABELS,
        "steps": {k: v[1] for k, v in STEP_DEPVARS.items()},
    }


def _validate_design(
    step: int,
    granularity: str,
    shock_type: str,
    method: str,
    control_mode: str = "不加控制变量",
    interaction: bool = False,
    price_mode: str = "名义值",
    scenario: str = "clean",
    exclude_row: bool = True,
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
    if price_mode not in PRICE_MODES:
        raise HTTPException(status_code=400, detail=f"price_mode 必须是 {PRICE_MODES}")
    if scenario not in SCENARIOS:
        raise HTTPException(status_code=400, detail=f"scenario 必须是 {SCENARIOS}")
    return RegressionDesign(
        step=step,
        granularity=granularity,
        shock_type=shock_type,
        method=method,
        control_mode=control_mode,
        interaction=interaction,
        price_mode=price_mode,
        scenario=scenario,
        exclude_row=exclude_row,
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
        "price_mode": design.price_mode,
        "scenario": design.scenario,
        "scenario_label": design.scenario_label,
        "sample_filter": design.sample_filter,
        "exclude_row": design.exclude_row,
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
    price_mode: str = "名义值",
    scenario: str = "clean",
    exclude_row: bool = True,
):
    """步骤12 设计确认:不跑回归,只返回方程与面板/个体/聚类等设计信息。"""
    return _design_info(
        _validate_design(
            step,
            granularity,
            shock_type,
            method,
            control_mode,
            interaction,
            price_mode,
            scenario,
            exclude_row,
        )
    )


@app.post("/api/regression/run")
def regression_run(req: RegressionRequest):
    design = _validate_design(
        req.step,
        req.granularity,
        req.shock_type,
        req.method,
        req.control_mode,
        req.interaction,
        req.price_mode,
        req.scenario,
        req.exclude_row,
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


@app.post("/api/regression/placebo")
def regression_placebo(req: PlaceboRequest):
    design = _validate_design(
        req.step,
        req.granularity,
        req.shock_type,
        req.method,
        req.control_mode,
        req.interaction,
        req.price_mode,
        req.scenario,
        req.exclude_row,
    )
    panel = _read_csv(design.panel_file)
    try:
        placebo = placebo_did_distribution(panel, design, n_draws=req.n_draws, seed=req.seed)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "design": _design_info(design),
        "placebo": placebo,
        "disclaimer": "安慰剂检验基于拟真演示冲击数据,用于教学展示随机化反事实分布",
    }


@app.get("/api/report/{year}")
def report(year: int):
    try:
        path = report_mod.generate(year)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    from pathlib import Path

    return {"path": path, "markdown": Path(path).read_text(encoding="utf-8")}


@app.post("/api/report")
def report_custom(req: ReportRequest):
    # 复用步骤13的设计校验;报告生成时会把同一套设定应用到 13-16 四个因变量。
    _validate_design(
        13,
        req.granularity,
        req.shock_type,
        req.method,
        req.control_mode,
        req.interaction,
        req.price_mode,
        exclude_row=req.exclude_row,
    )
    try:
        path = report_mod.generate(
            year=req.year,
            granularity=req.granularity,
            shock_type=req.shock_type,
            method=req.method,
            control_mode=req.control_mode,
            interaction=req.interaction,
            price_mode=req.price_mode,
            exclude_row=req.exclude_row,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    from pathlib import Path

    return {"path": path, "markdown": Path(path).read_text(encoding="utf-8")}
