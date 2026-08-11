"""Read-only deployment preflight."""

from __future__ import annotations

import importlib
from typing import Any

from gvcsim import artifacts, config
from gvcsim.classroom import db


def run() -> dict[str, Any]:
    api_module = importlib.import_module("gvcsim.api")
    if getattr(api_module, "app", None) is None:
        raise RuntimeError("ASGI 应用未导出 app")
    if config.IS_PRODUCTION:
        config.validate_security_config()
    release = artifacts.validate_release(config.PROCESSED_DIR)
    years = config.processed_years()
    if not years:
        raise artifacts.ArtifactContractError("没有完整的预计算产物年份")
    try:
        db.startup()
        database = db.readiness()
    finally:
        db.shutdown()
    return {"status": "ok", "years": years, "artifacts": release, "database": database}
