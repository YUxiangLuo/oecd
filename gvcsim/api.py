"""FastAPI 服务:为前端(frontend/)提供 17 步教学系统所需的全部数据接口。

只读 data/processed/ 下的预计算产物,不在请求路径上碰原始大表。
启动:gvcsim serve(或 uv run uvicorn gvcsim.api:app --reload)
"""

import json
import math
from functools import lru_cache
from numbers import Real
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
from gvcsim.artifacts import read_csv_artifact
from gvcsim.classroom import db as classroom_db
from gvcsim.classroom import routes as classroom_routes
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
    payload = auth.verify_token(authorization.removeprefix("Bearer "))
    if payload is None:
        return JSONResponse(status_code=401, content={"detail": "令牌无效或已过期"})
    request.state.user = payload  # 下游(/api/classroom)按角色鉴权用
    return await call_next(request)


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


INDICATOR_SCHEMA = {
    "groups": [
        {
            "key": "trade",
            "label": "WWZ 总贸易核算分解",
            "fields": [
                "gross_exports",
                "DVAex",
                "DVArt",
                "DDC",
                "FVA",
                "FDC",
                "taxsub",
                "EXDVA",
                "FVA_share",
                "DVAex_share",
            ],
        },
        {
            "key": "production",
            "label": "WWYZ 生产分解",
            "fields": [
                "SVA",
                "1_VA_D",
                "2_VA_RT",
                "3_VA_GVC",
                "3a_VA_GVC_S",
                "3b_VA_GVC_C",
                "FGY",
                "1_FGY_D",
                "2_FGY_RT",
                "3_FGY_GVC",
                "3a_FGY_GVC_S",
                "3b_FGY_GVC_C",
                "3_VA_GVC_share",
                "3b_VA_GVC_C_share",
            ],
        },
        {
            "key": "length",
            "label": "生产长度与位置",
            "fields": [
                "PLv",
                "PLv_D",
                "PLv_RT",
                "PLv_GVC",
                "PLy",
                "PLy_D",
                "PLy_RT",
                "PLy_GVC",
                "Pos_TPL",
                "GVCPs",
            ],
        },
        {
            "key": "network",
            "label": "生产网络中心性(Gephi 口径)",
            "fields": [
                "degree",
                "indegree",
                "outdegree",
                "weighted degree",
                "weighted indegree",
                "weighted outdegree",
                "Eccentricity",
                "closnesscentrality",
                "harmonicclosnesscentrality",
                "betweenesscentrality",
                "eigencentrality",
            ],
        },
    ],
    "fields": {
        "gross_exports": {"label": "毛出口(六项合计)", "format": "amount"},
        "FVA_share": {"label": "FVA 份额(FVA/毛出口)", "format": "pct"},
        "DVAex_share": {"label": "DVAex 份额(DVAex/毛出口)", "format": "pct"},
        "3_VA_GVC_share": {"label": "GVC 生产份额(3_VA_GVC/SVA)", "format": "pct"},
        "3b_VA_GVC_C_share": {"label": "复杂GVC生产份额(3b/SVA)", "format": "pct"},
        "DVAex": {"label": "国内增加值出口(被国外吸收)", "format": "amount"},
        "DVArt": {"label": "出口后返回的国内增加值", "format": "amount"},
        "DDC": {"label": "国内重复计算", "format": "amount"},
        "FVA": {"label": "出口中的外国增加值", "format": "amount"},
        "FDC": {"label": "外国重复计算", "format": "amount"},
        "taxsub": {"label": "出口中的税收减补贴", "format": "amount"},
        "EXDVA": {"label": "出口国内增加值合计", "format": "amount"},
        "SVA": {"label": "总增加值", "format": "amount"},
        "1_VA_D": {"label": "纯国内生产增加值", "format": "amount"},
        "2_VA_RT": {"label": "传统贸易增加值", "format": "amount"},
        "3_VA_GVC": {"label": "GVC 生产增加值", "format": "amount"},
        "3a_VA_GVC_S": {"label": "简单 GVC 增加值", "format": "amount"},
        "3b_VA_GVC_C": {"label": "复杂 GVC 增加值", "format": "amount"},
        "FGY": {"label": "最终品生产(全球增加值)", "format": "amount"},
        "1_FGY_D": {"label": "国内最终品中的国内增加值", "format": "amount"},
        "2_FGY_RT": {"label": "最终品出口中的国内增加值", "format": "amount"},
        "3_FGY_GVC": {"label": "经中间品贸易的增加值", "format": "amount"},
        "3a_FGY_GVC_S": {"label": "简单 GVC(后向)", "format": "amount"},
        "3b_FGY_GVC_C": {"label": "复杂 GVC(后向)", "format": "amount"},
        "PLv": {"label": "前向总生产长度", "format": "number"},
        "PLv_D": {"label": "前向纯国内段长度", "format": "number"},
        "PLv_RT": {"label": "前向传统贸易段长度", "format": "number"},
        "PLv_GVC": {"label": "前向 GVC 段长度", "format": "number"},
        "PLy": {"label": "后向总生产长度", "format": "number"},
        "PLy_D": {"label": "后向纯国内段长度", "format": "number"},
        "PLy_RT": {"label": "后向传统贸易段长度", "format": "number"},
        "PLy_GVC": {"label": "后向 GVC 段长度", "format": "number"},
        "Pos_TPL": {"label": "总生产长度位置指数", "format": "number"},
        "GVCPs": {"label": "GVC 位置指数", "format": "number"},
        "degree": {"label": "度", "format": "number"},
        "indegree": {"label": "入度", "format": "number"},
        "outdegree": {"label": "出度", "format": "number"},
        "weighted degree": {"label": "加权度", "format": "amount"},
        "weighted indegree": {"label": "加权入度", "format": "amount"},
        "weighted outdegree": {"label": "加权出度", "format": "amount"},
        "Eccentricity": {"label": "离心率", "format": "number"},
        "closnesscentrality": {"label": "接近中心性", "format": "number"},
        "harmonicclosnesscentrality": {"label": "调和中心性", "format": "number"},
        "betweenesscentrality": {"label": "介数中心性", "format": "number"},
        "eigencentrality": {"label": "特征向量中心性", "format": "number"},
    },
}

_INDICATOR_DESCRIPTIONS = {
    "gross_exports": "WWZ 六个出口核算分项之和，表示按增加值来源完整分解后的毛出口。",
    "FVA_share": "出口中外国增加值占毛出口的比重；越高表示对进口中间投入的后向依赖越强。",
    "DVAex_share": "被国外最终吸收的国内增加值占毛出口的比重；越高表示出口保留的本国增加值越多。",
    "3_VA_GVC_share": "通过中间品跨境参与 GVC 的增加值占总增加值 SVA 的比重。",
    "3b_VA_GVC_C_share": "至少经历两次跨境的复杂 GVC 增加值占总增加值 SVA 的比重。",
    "DVAex": "由本国创造、随出口离境并最终被国外吸收的增加值。",
    "DVArt": "随出口离境后又返回本国并在本国最终吸收的国内增加值。",
    "DDC": "本国增加值在跨境生产链中多次计入毛流量形成的国内重复计算。",
    "FVA": "本国出口中由外国生产者创造的增加值，是后向 GVC 参与的核心量。",
    "FDC": "外国增加值在跨境生产链中多次计入毛流量形成的重复计算。",
    "taxsub": "出口所含产品税减补贴；负值表示补贴大于税收。",
    "EXDVA": "出口中的国内增加值合计，等于 DVAex 与 DVArt 之和。",
    "SVA": "从增加值来源端核算的生产活动总增加值。",
    "1_VA_D": "只在本国生产并满足本国最终需求、未发生跨境的增加值。",
    "2_VA_RT": "随最终品直接出口、只发生一次跨境的传统贸易增加值。",
    "3_VA_GVC": "随中间品贸易跨境并进入全球价值链生产的增加值。",
    "3a_VA_GVC_S": "中间品跨境一次后在国外被最终吸收的简单 GVC 增加值。",
    "3b_VA_GVC_C": "中间品至少两次跨境后才被最终吸收的复杂 GVC 增加值。",
    "FGY": "从最终品生产端核算、为最终需求服务的全球增加值总量。",
    "1_FGY_D": "本国最终品中由本国生产且全程不跨境的增加值。",
    "2_FGY_RT": "最终品直接出口中包含的本国增加值。",
    "3_FGY_GVC": "经由中间品跨境贸易后进入最终品的增加值。",
    "3a_FGY_GVC_S": "从最终品端回溯、只经历一次中间品跨境的简单 GVC 增加值。",
    "3b_FGY_GVC_C": "从最终品端回溯、经历多次中间品跨境的复杂 GVC 增加值。",
    "PLv": "从增加值创造端向最终吸收端追踪的平均总生产阶段数。",
    "PLv_D": "前向生产路径中纯国内活动贡献的加权长度。",
    "PLv_RT": "前向生产路径中传统最终品贸易贡献的加权长度。",
    "PLv_GVC": "前向生产路径中经中间品跨境的 GVC 活动贡献的加权长度。",
    "PLy": "从最终品端向初始增加值来源回溯的平均总生产阶段数。",
    "PLy_D": "后向生产路径中纯国内活动贡献的加权长度。",
    "PLy_RT": "后向生产路径中传统最终品贸易贡献的加权长度。",
    "PLy_GVC": "后向生产路径中经中间品跨境的 GVC 活动贡献的加权长度。",
    "Pos_TPL": "以前向与后向总生产长度的相对关系衡量价值链位置。",
    "GVCPs": "前向与后向 GVC 生产长度之比；大于 1 通常表示更靠近上游。",
    "degree": "与该节点直接相连的入边和出边数量。",
    "indegree": "指向该节点的直接供应链连接数量。",
    "outdegree": "由该节点指向其他节点的直接供应链连接数量。",
    "weighted degree": "与该节点相连的全部入向和出向贸易流量之和。",
    "weighted indegree": "流入该节点的贸易流量之和。",
    "weighted outdegree": "由该节点流出的贸易流量之和。",
    "Eccentricity": "该节点到所有可达节点的最远最短路径距离。",
    "closnesscentrality": "到其他节点最短路径距离之和的倒数，越高表示整体可达性越强。",
    "harmonicclosnesscentrality": "对各节点最短路径倒数求和，可稳健处理不完全连通网络。",
    "betweenesscentrality": "经过该节点的最短路径占比，越高表示越可能成为供应链中转枢纽。",
    "eigencentrality": "同时考虑连接数量与相邻节点重要性的中心性指标。",
}
# 用 .get 而不是下标:漏写描述应表现为测试失败(test_indicator_schema 断言
# desc 全部非空),而不是 import 时 KeyError 拖垮整个服务。
for _field, _meta in INDICATOR_SCHEMA["fields"].items():
    _meta["desc"] = _INDICATOR_DESCRIPTIONS.get(_field, "")


class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/auth/login")
def login(req: LoginRequest):
    try:
        user = auth.authenticate(req.username, req.password)
    except auth.AuthenticationUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
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
        sectors = sorted(_read_csv(f"indicators_industry_{years[-1]}.csv")["industry"].unique())
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


def _with_derived(df: pd.DataFrame) -> pd.DataFrame:
    """在客户口径原始列之外派生毛出口与教学用份额列(CSV 产物保持客户 schema 不动)。"""
    out = df.copy()
    out["gross_exports"] = out[["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"]].sum(axis=1)
    gross = out["gross_exports"]
    out["FVA_share"] = (out["FVA"] / gross).where(gross > 0)
    out["DVAex_share"] = (out["DVAex"] / gross).where(gross > 0)
    out["3_VA_GVC_share"] = (out["3_VA_GVC"] / out["SVA"]).where(out["SVA"] > 0)
    out["3b_VA_GVC_C_share"] = (out["3b_VA_GVC_C"] / out["SVA"]).where(out["SVA"] > 0)
    return out


@app.get("/api/indicators/country/{year}")
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


@app.get("/api/indicators/industry/{year}")
def indicators_industry(
    year: int,
    country: str | None = None,
    industry: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
):
    return _indicators_industry_page(year, country, industry, page, page_size)


@app.get("/api/viz/network/{year}")
def viz_network(year: int):
    edges = _read_csv(f"network_edges_{year}.csv")
    country_df = _read_csv(f"indicators_country_{year}.csv")
    nodes = country_df[["country", "betweenesscentrality"]].copy()
    nodes["gross_exports"] = country_df[["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"]].sum(axis=1)
    nodes["gvc_production_share"] = (country_df["3_VA_GVC"] / country_df["SVA"]).where(country_df["SVA"] > 0)
    return {
        "nodes": _clean(nodes.to_dict(orient="records")),
        "edges": _clean(edges.to_dict(orient="records")),
    }


def _read_shocks() -> pd.DataFrame:
    return _read_path(SHOCKS_DIR / shocks.DEMO_FILE)


@lru_cache(maxsize=8)
def _exposure_lookup(path_str: str, mtime_ns: int) -> dict[tuple[str, str], float]:
    """(国家, 加征方) → 出口暴露度。与 CSV 缓存同样按 mtime 失效,
    避免分页热路径上每个请求都重建整张查找表。"""
    exposure = read_csv_artifact(Path(path_str))
    return {
        (str(row.country), str(row.imposer)): float(row.export_exposure) for row in exposure.itertuples(index=False)
    }


def _with_tariff_exposure(df: pd.DataFrame, year: int, shock_type: str) -> pd.DataFrame:
    """为关税面板行补充主要加征方及 ICIO 出口暴露度。"""
    out = df.copy()
    if shock_type != "关税冲击":
        out["main_imposer"] = None
        out["export_exposure"] = None
        return out

    imposer_by_event = {event.name: event.imposer for event in shocks.EVENTS}
    # note 为空或对不上事件表时保持 None,不让 NaN 渗入 JSON 或查找键。
    out["main_imposer"] = [imposer_by_event.get(note) if note else None for note in out["note"].astype(str)]

    exposure_path = PROCESSED_DIR / f"{shocks.EXPOSURE_PREFIX}_{year}.csv"
    exposure_lookup: dict[tuple[str, str], float] = {}
    if exposure_path.exists():
        exposure_lookup = _exposure_lookup(str(exposure_path), exposure_path.stat().st_mtime_ns)
    out["export_exposure"] = [
        exposure_lookup.get((str(country), imposer)) if imposer is not None else None
        for country, imposer in zip(out["country"], out["main_imposer"])
    ]
    return out


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
    df = _with_tariff_exposure(df, year, shock_type)
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
        "equation_parts": design.equation_parts(),
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
        raise HTTPException(status_code=400, detail=str(e)) from e
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
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {
        "design": _design_info(design),
        "placebo": placebo,
        "disclaimer": "安慰剂检验基于拟真演示冲击数据,用于教学展示随机化反事实分布",
    }


@app.get("/api/report/{year}")
def report(year: int):
    try:
        document = report_mod.build(year)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return document.to_dict()


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
        document = report_mod.build(
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
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return document.to_dict()


# ---------------------------------------------------------------- 教学面板(班级/学生/评阅/公告)

app.include_router(classroom_routes.router)


@app.exception_handler(classroom_db.Unavailable)
async def classroom_db_unavailable(request: Request, exc: classroom_db.Unavailable):
    return JSONResponse(
        status_code=503,
        content={"detail": "教学数据库不可用,请先启动 PostgreSQL 并运行 `uv run gvcsim classroom-init`"},
    )
