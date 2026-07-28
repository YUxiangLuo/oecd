"""在 Uvicorn 多进程父进程启动前验证全部生产依赖。

Uvicorn 的 multiprocess supervisor 不会因为 worker 在导入或 lifespan 中失败
而退出。systemd 因此先运行本模块：只有 ASGI 应用可导入、产物完整、运行目录
可用且 PostgreSQL schema/连接池就绪时，才会启动长期存活的父进程。
"""

from __future__ import annotations

import importlib
from typing import Any

from gvcsim import artifacts, concurrency, config
from gvcsim.classroom import db as classroom_db


def run() -> dict[str, Any]:
    """执行一次无持久连接残留的服务启动预检，失败时直接向调用方抛错。"""
    api_module = importlib.import_module("gvcsim.api")
    if getattr(api_module, "app", None) is None:
        raise RuntimeError("ASGI 应用未导出 app")

    if config.IS_PRODUCTION:
        config.validate_security_config()
    else:
        config.validate_capacity_config()

    release = artifacts.validate_release(config.PROCESSED_DIR, validate_sources=True)
    years = config.processed_years()
    if not years:
        raise artifacts.ArtifactContractError("没有完整的预计算产物年份")
    current_manifest = artifacts.manifest_id()
    concurrency.validate_runtime()
    capacity = concurrency.capacity_snapshot()

    try:
        classroom_db.startup()
        database = classroom_db.readiness()
    finally:
        # ExecStartPre 是短进程；不得把连接池后台线程或连接带到 Uvicorn 父进程。
        classroom_db.close_pool()

    return {
        "status": "ok",
        "manifest_id": current_manifest,
        "years": years,
        "artifacts": release,
        "database": database,
        "capacity": capacity,
    }
