"""FastAPI 服务:为前端(frontend/)提供 16 步教学系统所需的全部数据接口。

本文件只负责应用生命周期、中间件、路由装配与全局异常策略；数据浏览和
回归端点分别位于 ``data_routes`` 与 ``regression_routes``。请求路径只读
受控产物，不临时重算原始大表。
启动:gvcsim serve(或 uv run uvicorn gvcsim.api:app --reload)
"""

from contextlib import asynccontextmanager

import anyio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import Request
from fastapi.responses import JSONResponse

from gvcsim import auth, auth_routes, data_routes, publication, regression_routes
from gvcsim import config as app_config
from gvcsim.artifacts import ArtifactContractError, validate_release_cached
from gvcsim.classroom import db as classroom_db
from gvcsim.classroom import routes as classroom_routes
from gvcsim.config import PROCESSED_DIR, processed_years

if app_config.IS_PRODUCTION:
    app_config.validate_security_config()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """每个 worker 显式建立/关闭连接池，并限制同步端点线程数。"""
    app_config.validate_capacity_config()
    anyio.to_thread.current_default_thread_limiter().total_tokens = app_config.THREAD_TOKENS
    await anyio.to_thread.run_sync(classroom_db.startup)
    try:
        yield
    finally:
        await anyio.to_thread.run_sync(classroom_db.shutdown)


app = FastAPI(title="供应链仿真系统 API", version="0.2.0", lifespan=lifespan)

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

    只暴露稳定契约和年份，不泄露数据库连接或文件路径。产物清单缺失、过期或
    摘要契约不合法时返回 503，避免部署脚本把“进程已启动”误当成“数据可用”。
    """
    try:
        publication.ensure_no_pending_publication(PROCESSED_DIR)
        validate_release_cached(PROCESSED_DIR, allow_legacy=not PROCESSED_DIR.is_symlink())
        years = processed_years()
    except (ArtifactContractError, OSError, RuntimeError, ValueError) as error:
        return JSONResponse(status_code=503, content={"status": "unavailable", "detail": str(error)})
    if not years:
        return JSONResponse(status_code=503, content={"status": "unavailable", "detail": "没有完整产物"})
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
        payload = auth.verify_token(authorization.removeprefix("Bearer "))
    except auth.AuthenticationUnavailable as error:
        return JSONResponse(status_code=503, content={"detail": str(error)})
    if payload is None:
        return JSONResponse(status_code=401, content={"detail": "令牌无效或已过期"})
    request.state.user = payload  # 下游(/api/classroom)按角色鉴权用
    return await call_next(request)


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
