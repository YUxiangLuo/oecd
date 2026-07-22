"""FastAPI 服务:为前端(frontend/)提供 16 步教学系统所需的全部数据接口。

只读 data/processed/ 下的预计算产物,不在请求路径上碰原始大表。
启动:gvcsim serve(或 uv run uvicorn gvcsim.api:app --reload)
"""

import json
import math
from numbers import Real
from pathlib import Path
from typing import Any, cast

import pandas as pd
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from gvcsim import artifacts, auth, config as app_config
from gvcsim import quizzes, shocks, trusted_evidence
from gvcsim.shocks import SHOCK_LABELS, SHOCK_TARIFF
from gvcsim.artifacts import (
    ArtifactContractError,
    artifact_contract,
    manifest_id,
    read_csv_artifact,
    validate_artifact,
    validate_release,
)
from gvcsim.classroom import db as classroom_db
from gvcsim.classroom import routes as classroom_routes
from gvcsim.config import PROCESSED_DIR, RAW_DATA_DIR, processed_years
from gvcsim.data import crosswalk, icio_browser, quality
from gvcsim.regression.design import (
    CONTROL_MODE_LABELS,
    CONTROL_MODE_NONE,
    CONTROL_MODES,
    GRANULARITIES,
    GRANULARITY_COUNTRY_INDUSTRY,
    GRANULARITY_LABELS,
    METHOD_DID,
    METHOD_LABELS,
    METHODS,
    PRICE_MODE_LABELS,
    PRICE_MODE_NOMINAL,
    PRICE_MODES,
    SCENARIO_CLEAN,
    SCENARIO_LABELS,
    SCENARIOS,
    SHOCK_TYPES,
    OUTCOME_DEPVARS,
    OUTCOME_GRANULARITIES,
    OUTCOMES,
    RegressionDesign,
    validate_outcome_granularity,
)
from gvcsim.regression.panel import placebo_did_distribution, run_design_with_benchmark
from gvcsim.steps import STAGE_NAMES, STEPS

if app_config.IS_PRODUCTION:
    app_config.validate_security_config()

app = FastAPI(title="供应链仿真系统 API", version="0.1.0")

_cors_origins = app_config.ALLOWED_ORIGINS
if not _cors_origins and not app_config.IS_PRODUCTION:
    _cors_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", include_in_schema=False)
def health() -> JSONResponse:
    """供 systemd/nginx 使用的无认证只读就绪检查。

    只暴露稳定契约和年份，不泄露数据库连接或文件路径。产物清单缺失、过期或
    摘要契约不合法时返回 503，避免部署脚本把“进程已启动”误当成“数据可用”。
    """
    try:
        validate_release(PROCESSED_DIR, validate_sources=True)
        years = processed_years()
        current_manifest = manifest_id() if years else None
    except (ArtifactContractError, OSError, ValueError) as error:
        return JSONResponse(status_code=503, content={"status": "unavailable", "detail": str(error)})
    if not years or current_manifest is None:
        return JSONResponse(status_code=503, content={"status": "unavailable", "detail": "没有完整产物"})
    try:
        database = classroom_db.readiness()
    except (classroom_db.Unavailable, classroom_db.SchemaVersionMismatch, RuntimeError):
        if app_config.DEMO_MODE:
            # 显式 demo 允许只演示无持久化核心流程；响应必须明确标记降级。
            database = {"status": "unavailable_demo"}
        else:
            return JSONResponse(
                status_code=503,
                content={"status": "unavailable", "detail": "教学数据库未就绪"},
            )
    return JSONResponse(
        content={
            "status": "ok",
            "years": years,
            "manifest_id": current_manifest,
            "artifact_contract": artifact_contract(),
            "database": database,
        }
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
    try:
        payload = auth.verify_token(authorization.removeprefix("Bearer "))
    except auth.AuthenticationUnavailable as error:
        return JSONResponse(status_code=503, content={"detail": str(error)})
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
    if path.parent == PROCESSED_DIR:
        return read_csv_artifact(path, require_current=True)
    artifacts.validate_source(path)
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
    "taxsub": "出口直接及间接所含的产品税减补贴；负值表示沿供应链累计后呈净补贴。",
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
    "weighted degree": "与该节点相连的全部入向和出向网络边流量之和。",
    "weighted indegree": "流入该节点的网络边流量之和。",
    "weighted outdegree": "由该节点流出的网络边流量之和。",
    "Eccentricity": "该节点到所有可达节点的最远最短路径距离。",
    "closnesscentrality": "从该节点沿出边可达的节点数除以最短路径距离之和，越高表示向外可达性越强。",
    "harmonicclosnesscentrality": "从该节点沿出边到可达节点的距离倒数平均值，可处理不完全连通网络。",
    "betweenesscentrality": "经过该节点的有向最短路径原始计数（不归一化），越高表示越可能成为中转枢纽。",
    "eigencentrality": "按入边邻居的重要性迭代计算并以最大值归一的 Gephi 特征向量中心性。",
}
# 国家级贸易图在全部正流量边下是完全图,这些无权中心性因此对所有国家取同一常数
# (度=152、介数=0、接近/离心/调和/特征向量恒定),没有横截面区分度,只在国家–行业级
# 图上才有意义。加权度(=贸易量)不在此列,国家级仍可区分。前端据此在国家级隐藏这些
# 字段,回归也只允许 network outcome 用国家–行业级(见 regression/design.py)。
_COUNTRY_DEGENERATE_NETWORK_FIELDS = frozenset(
    {
        "degree",
        "indegree",
        "outdegree",
        "Eccentricity",
        "closnesscentrality",
        "harmonicclosnesscentrality",
        "betweenesscentrality",
        "eigencentrality",
    }
)
_COUNTRY_DEGENERATE_NOTE = "（国家级贸易图为完全图，该指标对所有国家恒为常数，仅在国家–行业级有区分度）"

# 用 .get 而不是下标:漏写描述应表现为测试失败(test_indicator_schema 断言
# desc 全部非空),而不是 import 时 KeyError 拖垮整个服务。
_indicator_fields = cast(dict[str, dict[str, Any]], INDICATOR_SCHEMA["fields"])
for _field, _meta in _indicator_fields.items():
    _degenerate = _field in _COUNTRY_DEGENERATE_NETWORK_FIELDS
    _desc = _INDICATOR_DESCRIPTIONS.get(_field, "")
    _meta["desc"] = _desc + _COUNTRY_DEGENERATE_NOTE if _degenerate else _desc
    # 契约字段:前端在国家级粒度隐藏被标记的字段,避免展示零信息的常数中心性。
    _meta["country_degenerate"] = _degenerate


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)


@app.post("/api/auth/login")
def login(req: LoginRequest, request: Request):
    ip = request.client.host if request.client else None
    rate_key = f"{ip or 'unknown'}|{req.username.casefold()}"
    try:
        auth.check_login_rate(rate_key)
    except auth.TooManyLoginAttempts as error:
        raise HTTPException(
            status_code=429,
            detail="登录尝试过于频繁，请稍后再试",
            headers={"Retry-After": str(error.retry_after)},
        ) from error
    try:
        user = auth.authenticate(req.username, req.password)
    except auth.AuthenticationUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    if user is None:
        auth.record_login_result(rate_key, success=False)
        try:
            classroom_db.record_audit_event(
                "auth.login_failed", target_type="account", target_id=req.username, ip_address=ip
            )
        except classroom_db.Unavailable:
            pass
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    try:
        token, exp = auth.issue_token(user)
        if not user.get("demo"):
            classroom_db.record_audit_event(
                "auth.login_succeeded",
                actor_id=user.get("account_id"),
                actor_name=user["username"],
                target_type="auth_session",
                ip_address=ip,
            )
    except (auth.AuthenticationUnavailable, classroom_db.Unavailable) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    auth.record_login_result(rate_key, success=True)
    public_user = {
        "username": user["username"],
        "name": user["name"],
        "role": user["role"],
        "account_id": user.get("account_id"),
    }
    return {"token": token, "user": public_user, "expires_at": exp}


@app.get("/api/auth/me")
def me(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少 Bearer 令牌")
    try:
        payload = auth.verify_token(authorization.removeprefix("Bearer "))
    except auth.AuthenticationUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if payload is None:
        raise HTTPException(status_code=401, detail="令牌无效或已过期")
    return {
        "username": payload["sub"],
        "name": payload["name"],
        "role": payload["role"],
        "account_id": payload.get("aid"),
    }


@app.post("/api/auth/logout")
def logout(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少 Bearer 令牌")
    token = authorization.removeprefix("Bearer ")
    try:
        payload = auth.verify_token(token)
    except auth.AuthenticationUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if payload is None:
        raise HTTPException(status_code=401, detail="令牌无效或已过期")
    if not auth.revoke_token(token):
        raise HTTPException(status_code=409, detail="该会话无法撤销")
    classroom_db.record_audit_event(
        "auth.logout", actor_id=payload.get("aid"), actor_name=payload["sub"], target_type="auth_session"
    )
    return {"ok": True}


@app.get("/api/meta")
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


@app.get("/api/steps")
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


@app.get("/api/indicators/schema")
def indicators_schema():
    return INDICATOR_SCHEMA


@app.get("/api/db/meta")
def db_meta():
    for path in sorted(RAW_DATA_DIR.glob("ICIO*_*.csv")):
        artifacts.validate_source(path)
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


@app.get("/api/qc/shocks")
def qc_shocks():
    path = PROCESSED_DIR / "qc_shocks.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="冲击面板尚未质检,请先运行 compute")
    validate_artifact(path)
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/qc/controls")
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


@app.get("/api/qc/{year}")
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


@app.get("/api/shocks/events")
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
        "disclaimer": "拟真演示数据:事件与税率量级参考公开资料手工编码,"
        "出口暴露度由 OECD ICIO 双边流向计算,不能用于研究结论",
    }


@app.get("/api/crosswalk/demo")
def crosswalk_demo(year: int = 2019):
    try:
        artifacts.validate_source(Path(crosswalk.__file__))
        return crosswalk.demo_payload(year)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get("/api/shocks/summary")
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


@app.get("/api/shocks/panel")
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


class RegressionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcome: str
    granularity: str = GRANULARITY_COUNTRY_INDUSTRY
    shock_type: str = SHOCK_TARIFF
    method: str = METHOD_DID
    control_mode: str = CONTROL_MODE_NONE
    interaction: bool = False
    price_mode: str = PRICE_MODE_NOMINAL
    scenario: str = SCENARIO_CLEAN
    exclude_row: bool = True
    weight_mode: str = shocks.EXPOSURE_MODE_FIXED_PRETREATMENT


class PlaceboRequest(RegressionRequest):
    n_draws: int = Field(default=80, ge=10, le=200)
    seed: int = Field(default=2026, ge=0, le=2_147_483_647)


@app.get("/api/regression/options")
def regression_options():
    # 键与文案一起下发:界面渲染 labels,请求回传 keys。
    # 前端不再自备一份中文映射,改文案也不会变成破坏性 API 变更。
    return {
        "granularities": GRANULARITIES,
        "granularity_labels": GRANULARITY_LABELS,
        "granularities_by_outcome": OUTCOME_GRANULARITIES,
        "shock_types": SHOCK_TYPES,
        "shock_type_labels": SHOCK_LABELS,
        "methods": METHODS,
        "method_labels": METHOD_LABELS,
        "control_modes": CONTROL_MODES,
        "control_mode_labels": CONTROL_MODE_LABELS,
        "price_modes": PRICE_MODES,
        "price_mode_labels": PRICE_MODE_LABELS,
        "scenarios": SCENARIOS,
        "scenario_labels": SCENARIO_LABELS,
        "weight_modes": list(shocks.EXPOSURE_MODES),
        "weight_mode_labels": {
            shocks.EXPOSURE_MODE_FIXED_PRETREATMENT: "首次处理前固定权重（主口径）",
            shocks.EXPOSURE_MODE_CONTEMPORANEOUS: "当期贸易权重（稳健性）",
        },
        "outcomes": {key: value[1] for key, value in OUTCOME_DEPVARS.items()},
    }


def _validate_design(
    outcome: str,
    granularity: str,
    shock_type: str,
    method: str,
    control_mode: str = CONTROL_MODE_NONE,
    interaction: bool = False,
    price_mode: str = PRICE_MODE_NOMINAL,
    scenario: str = "clean",
    exclude_row: bool = True,
) -> RegressionDesign:
    if outcome not in OUTCOMES:
        raise HTTPException(status_code=400, detail=f"outcome 必须是 {OUTCOMES}")
    if granularity not in GRANULARITIES:
        raise HTTPException(status_code=400, detail=f"granularity 必须是 {GRANULARITIES}")
    try:
        validate_outcome_granularity(outcome, granularity)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
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
        outcome=outcome,
        granularity=granularity,
        shock_type=shock_type,
        method=method,
        control_mode=control_mode,
        interaction=interaction,
        price_mode=price_mode,
        scenario=scenario,
        exclude_row=exclude_row,
    )


def _design_info(design: RegressionDesign, weight_mode: str = shocks.EXPOSURE_MODE_FIXED_PRETREATMENT) -> dict:
    return {
        "outcome": design.outcome,
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
        "weight_mode": weight_mode,
    }


def _validate_weight_mode(design: RegressionDesign, weight_mode: str) -> None:
    if weight_mode not in shocks.EXPOSURE_MODES:
        raise HTTPException(status_code=400, detail=f"weight_mode 必须是 {shocks.EXPOSURE_MODES}")
    if weight_mode == shocks.EXPOSURE_MODE_CONTEMPORANEOUS and design.shock_type != SHOCK_TARIFF:
        raise HTTPException(status_code=400, detail="当期贸易权重稳健性只适用于 tariff 冲击")


def _panel_for_weight_mode(panel: pd.DataFrame, design: RegressionDesign, weight_mode: str) -> pd.DataFrame:
    _validate_weight_mode(design, weight_mode)
    if weight_mode == shocks.EXPOSURE_MODE_FIXED_PRETREATMENT:
        return panel
    required = {"tariff_shock_contemporaneous", "treated_contemporaneous"}
    if not required.issubset(panel.columns):
        raise HTTPException(status_code=409, detail="当前产物没有当期权重稳健性列，请重建 schema 3 产物")
    out = panel.copy()
    out[design.shock_col] = out["tariff_shock_contemporaneous"]
    out[design.treated_col] = out["treated_contemporaneous"]
    return out


def _regression_preflight(design: RegressionDesign, result: dict[str, Any], weight_mode: str) -> dict[str, Any]:
    """把识别风险从脚注提升为每次估计都返回的结构化预检。"""
    support_value = result.get("support")
    support: dict[str, Any] = support_value if isinstance(support_value, dict) else {}
    checks: list[dict[str, str]] = []

    def add(code: str, severity: str, message: str) -> None:
        checks.append({"code": code, "severity": severity, "message": message})

    if support.get("untreated_clusters") == 0 and support.get("treated_clusters", 0) > 0:
        add(
            "no_never_treated",
            "warning",
            "没有永不处理聚类；识别仅来自尚未处理者与处理时点差异，异质处理效应下传统 staggered TWFE 可能有偏。",
        )
    if support.get("reversal_entities"):
        add(
            "treatment_reversal",
            "fatal" if result.get("status") == "invalid_design" else "warning",
            f"检测到 {len(support['reversal_entities'])} 个处理撤销实体；吸收型 DID/事件研究可能误编码撤销后的年份。",
        )
    if design.outcome == "network":
        add(
            "network_interference",
            "warning",
            "网络结果存在单位间干扰：一国政策会同时改变其他节点的边与中心性，传统 SUTVA 不成立。",
        )
    add(
        "treatment_weighting",
        "disclosure" if weight_mode == shocks.EXPOSURE_MODE_FIXED_PRETREATMENT else "warning",
        (
            "本次使用首次处理前固定贸易权重，避免处理后贸易结构反向决定 treatment。"
            if weight_mode == shocks.EXPOSURE_MODE_FIXED_PRETREATMENT
            else "本次使用当期贸易权重，仅作稳健性；该权重可能已受政策影响，不能替代固定处理前主口径。"
        ),
    )
    return {
        "status": result.get("status") or "ok",
        "can_infer": not bool(support.get("suppress_inference")),
        "checks": checks,
    }


def _regression_step(outcome: str) -> int:
    return next(cast(int, step["n"]) for step in STEPS if step.get("regression_outcome") == outcome)


def _require_regression_student(request: Request) -> str:
    user = getattr(request.state, "user", None) or {}
    if user.get("role") != "student":
        raise HTTPException(status_code=403, detail="回归学习事件只对当前作业中的学生签发")
    return str(user["sub"])


@app.get("/api/regression/design")
def regression_design(
    request: Request,
    outcome: str,
    granularity: str = GRANULARITY_COUNTRY_INDUSTRY,
    shock_type: str = SHOCK_TARIFF,
    method: str = METHOD_DID,
    control_mode: str = CONTROL_MODE_NONE,
    interaction: bool = False,
    price_mode: str = PRICE_MODE_NOMINAL,
    scenario: str = "clean",
    exclude_row: bool = True,
    weight_mode: str = shocks.EXPOSURE_MODE_FIXED_PRETREATMENT,
):
    """返回指定 outcome 的方程与面板/个体/聚类等设计信息，不执行估计。"""
    if "step" in request.query_params:
        raise HTTPException(status_code=422, detail="旧 step 参数已删除，请使用 outcome")
    design = _validate_design(
        outcome,
        granularity,
        shock_type,
        method,
        control_mode,
        interaction,
        price_mode,
        scenario,
        exclude_row,
    )
    _validate_weight_mode(design, weight_mode)
    return _design_info(design, weight_mode)


@app.post("/api/regression/run")
def regression_run(req: RegressionRequest, request: Request):
    subject = _require_regression_student(request)
    run_manifest = manifest_id()
    design = _validate_design(
        req.outcome,
        req.granularity,
        req.shock_type,
        req.method,
        req.control_mode,
        req.interaction,
        req.price_mode,
        req.scenario,
        req.exclude_row,
    )
    panel = _panel_for_weight_mode(_read_csv(design.panel_file), design, req.weight_mode)
    try:
        result, benchmark = run_design_with_benchmark(panel, design)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    design_info = _design_info(design, req.weight_mode)
    result_info = result.to_dict()
    if manifest_id() != run_manifest:
        raise HTTPException(status_code=409, detail="估计期间数据产物已切换，请重新运行")
    event_payload_sha256 = trusted_evidence.digest({"design": design_info, "result": result_info})
    event = classroom_db.record_evidence_event(
        subject,
        _regression_step(design.outcome),
        "regression",
        run_manifest,
        event_payload_sha256,
        {"design": design_info, "result_sha256": trusted_evidence.digest(result_info)},
    )
    run_id = trusted_evidence.issue_regression_run(
        subject=subject,
        manifest_id=run_manifest,
        design=design_info,
        result=result_info,
        event=event,
    )
    return {
        "run_id": run_id,
        "design": design_info,
        "result": result_info,
        "preflight": _regression_preflight(design, result_info, req.weight_mode),
        "benchmark": benchmark,
        "disclaimer": "冲击变量为拟真演示面板(全经济体覆盖、行业异质),结果仅用于验证系统链路",
    }


@app.post("/api/regression/placebo")
def regression_placebo(req: PlaceboRequest, request: Request):
    subject = _require_regression_student(request)
    run_manifest = manifest_id()
    design = _validate_design(
        req.outcome,
        req.granularity,
        req.shock_type,
        req.method,
        req.control_mode,
        req.interaction,
        req.price_mode,
        req.scenario,
        req.exclude_row,
    )
    panel = _panel_for_weight_mode(_read_csv(design.panel_file), design, req.weight_mode)
    try:
        placebo = placebo_did_distribution(panel, design, n_draws=req.n_draws, seed=req.seed)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    design_info = _design_info(design, req.weight_mode)
    if manifest_id() != run_manifest:
        raise HTTPException(status_code=409, detail="安慰剂期间数据产物已切换，请重新运行")
    event_payload_sha256 = trusted_evidence.digest({"design": design_info, "result": placebo})
    classroom_db.record_evidence_event(
        subject,
        _regression_step(design.outcome),
        "placebo",
        run_manifest,
        event_payload_sha256,
        {"design": design_info, "result_sha256": trusted_evidence.digest(placebo)},
    )
    return {
        "design": design_info,
        "placebo": placebo,
        "disclaimer": "安慰剂检验基于拟真演示冲击数据,用于教学展示随机化反事实分布",
    }


# ---------------------------------------------------------------- 教学面板(班级/学生/评阅/公告)

app.include_router(classroom_routes.router)


@app.exception_handler(ArtifactContractError)
async def artifact_contract_error(request: Request, exc: ArtifactContractError):
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(classroom_db.Unavailable)
async def classroom_db_unavailable(request: Request, exc: classroom_db.Unavailable):
    return JSONResponse(
        status_code=503,
        content={"detail": "教学数据库不可用,请先启动 PostgreSQL 并运行 `uv run gvcsim classroom-init`"},
    )


@app.exception_handler(classroom_db.SchemaVersionMismatch)
async def classroom_schema_unavailable(request: Request, exc: classroom_db.SchemaVersionMismatch):
    return JSONResponse(status_code=503, content={"detail": "教学数据库 schema 未就绪；请先完成兼容迁移"})


@app.exception_handler(classroom_db.AssignmentScopeMismatch)
async def assignment_scope_mismatch(request: Request, exc: classroom_db.AssignmentScopeMismatch):
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(classroom_db.AssignmentClosed)
async def assignment_closed(request: Request, exc: classroom_db.AssignmentClosed):
    return JSONResponse(status_code=409, content={"detail": str(exc)})
