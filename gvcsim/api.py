"""FastAPI 服务:为前端(frontend/)提供 15 步教学系统所需的全部数据接口。

本文件只负责应用生命周期、中间件、路由装配与全局异常策略；数据浏览和
回归端点分别位于 ``data_routes`` 与 ``regression_routes``。请求路径只读
受控产物，不临时重算原始大表。
启动:gvcsim serve(或 uv run uvicorn gvcsim.api:app --reload)
"""

from contextlib import asynccontextmanager
import json

import anyio
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import Request
from fastapi.responses import JSONResponse, Response

from gvcsim import auth, auth_routes, data_routes, regression_routes
from gvcsim import config as app_config
from gvcsim.artifacts import ArtifactContractError, dataset_metadata, validate_release_cached
from gvcsim.classroom import db as classroom_db
from gvcsim.classroom import routes as classroom_routes
from gvcsim.config import PROCESSED_DIR, RAW_DATA_DIR, processed_years
from gvcsim.data import icio_browser
from gvcsim.data.raw_icio import validate_raw_source_bindings

if app_config.IS_PRODUCTION:
    app_config.validate_security_config()


def validate_startup_data() -> None:
    """Validate and warm the immutable teaching release before accepting traffic.

    The raw-source validator hashes each bound ICIO file on the first call and
    caches the result by exact file identity.  Doing that work in the lifespan
    keeps a student's first ``/api/db/meta`` request from paying the cold hash
    cost while preserving the same fail-closed integrity contract.
    """
    validate_release_cached(PROCESSED_DIR)
    years = processed_years()
    if not years:
        raise ArtifactContractError("没有完整产物")
    metadata = dataset_metadata(PROCESSED_DIR)
    validate_raw_source_bindings(metadata.get("raw_dimensions"), years, RAW_DATA_DIR)
    # Warm the one-file header/index read needed by Step 1.  At this point the
    # raw bytes are proven identical to the strictly validated active release.
    icio_browser.meta(strict_validate=False)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """每个 worker 先验证数据并建立连接池，再开始接单。"""
    app_config.validate_capacity_config()
    anyio.to_thread.current_default_thread_limiter().total_tokens = app_config.THREAD_TOKENS
    await anyio.to_thread.run_sync(classroom_db.startup)
    try:
        await anyio.to_thread.run_sync(validate_startup_data)
        yield
    finally:
        regression_routes.clear_result_cache()
        auth_routes.clear_rate_limits()
        regression_routes.clear_rate_limits()
        await anyio.to_thread.run_sync(classroom_db.shutdown)


app = FastAPI(title="供应链仿真系统 API", version="0.2.0", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def invalid_request(_request: Request, exc: RequestValidationError):
    # Invalid input can itself contain NaN or unpaired Unicode surrogates.
    # Echoing it through JSONResponse turns an intended 422 into a 500, and may
    # also echo a submitted password. Keep diagnostic locations/types/messages.
    details = [{key: error[key] for key in ("loc", "msg", "type") if key in error} for error in exc.errors()]
    return Response(
        content=json.dumps({"detail": details}, ensure_ascii=True, allow_nan=False),
        status_code=422,
        media_type="application/json",
    )


_cors_origins = app_config.ALLOWED_ORIGINS
if not _cors_origins and not app_config.IS_PRODUCTION:
    _cors_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth_routes.router)
app.include_router(data_routes.router)
app.include_router(regression_routes.router)


@app.get("/health", include_in_schema=False)
def health() -> JSONResponse:
    """供 systemd/nginx 使用的无认证只读就绪检查。

    产物、原始年份或教学数据库未就绪时返回 503，避免部署脚本把“进程已启动”
    误当成“数据可用”。detail 给出可操作的失败原因，方便课堂机器排查。
    """
    try:
        validate_release_cached(PROCESSED_DIR)
        years = processed_years()
    except (ArtifactContractError, OSError, RuntimeError, ValueError) as error:
        return JSONResponse(status_code=503, content={"status": "unavailable", "detail": str(error)})
    if not years:
        return JSONResponse(status_code=503, content={"status": "unavailable", "detail": "没有完整产物"})
    try:
        metadata = dataset_metadata(PROCESSED_DIR)
        validate_raw_source_bindings(metadata.get("raw_dimensions"), years, RAW_DATA_DIR)
    except (OSError, RuntimeError, ValueError) as error:
        return JSONResponse(status_code=503, content={"status": "unavailable", "detail": str(error)})
    try:
        database = classroom_db.readiness()
    except (classroom_db.Unavailable, classroom_db.SchemaVersionMismatch, RuntimeError):
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable", "detail": "教学数据库未就绪"},
        )
    return JSONResponse(
        content={
            "status": "ok",
            "years": years,
            "database": database,
        }
    )


@app.get("/health/live", include_in_schema=False)
async def liveness() -> dict[str, str]:
    """只证明 worker 事件循环可接单；不触碰磁盘和 PostgreSQL。"""
    return {"status": "ok"}


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
        payload = await anyio.to_thread.run_sync(
            auth.verify_token,
            authorization.removeprefix("Bearer "),
        )
    except auth.AuthenticationUnavailable as error:
        return JSONResponse(status_code=503, content={"detail": str(error)})
    if payload is None:
        return JSONResponse(status_code=401, content={"detail": "令牌无效或已过期"})
    request.state.user = payload  # 下游(/api/classroom)按角色鉴权用
    return await call_next(request)


# ---------------------------------------------------------------- 教学课堂（学生会话、账号管理、报告评阅）

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


@app.exception_handler(classroom_db.OperationFailed)
async def classroom_db_operation_failed(request: Request, exc: classroom_db.OperationFailed):
    return JSONResponse(
        status_code=503,
        content={
            "detail": "教学数据库操作失败，请稍后重试",
            "code": f"database_{exc.reason}",
        },
    )


@app.exception_handler(classroom_db.SchemaVersionMismatch)
async def classroom_schema_unavailable(request: Request, exc: classroom_db.SchemaVersionMismatch):
    return JSONResponse(status_code=503, content={"detail": "教学数据库 schema 未就绪；请先完成兼容迁移"})
