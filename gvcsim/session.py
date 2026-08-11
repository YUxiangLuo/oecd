"""Small, server-authoritative experiment session model."""

from __future__ import annotations

import json
from copy import deepcopy
from typing import Any

SESSION_VERSION = "experiment-session-simple-v1"
MAX_SESSION_BYTES = 1_000_000
MAX_STEPS = 16
SHARED_KEYS = {"regression_settings"}


class SessionError(ValueError):
    pass


def empty_session() -> dict[str, Any]:
    return {"version": SESSION_VERSION, "steps": {}, "shared": {}}


def make_record(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise SessionError("步骤数据必须是对象")
    return {"data": deepcopy(data)}


def _json_value(value: Any, path: str = "session") -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [_json_value(item, f"{path}[]") for item in value]
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise SessionError(f"{path} 的键必须是字符串")
        return {key: _json_value(item, f"{path}.{key}") for key, item in value.items()}
    raise SessionError(f"{path} 包含不能保存的值")


def validate_session(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise SessionError("会话必须是对象")
    if payload.get("version") != SESSION_VERSION:
        raise SessionError(f"会话版本不受支持；当前为 {SESSION_VERSION}")
    raw_steps = payload.get("steps", {})
    raw_shared = payload.get("shared", {})
    if not isinstance(raw_steps, dict) or not isinstance(raw_shared, dict):
        raise SessionError("steps/shared 必须是对象")

    steps: dict[str, Any] = {}
    for key, record in raw_steps.items():
        if not isinstance(key, str) or not key.isdigit() or not 1 <= int(key) <= MAX_STEPS:
            raise SessionError(f"步骤编号无效:{key!r}")
        if not isinstance(record, dict) or set(record) != {"data"} or not isinstance(record["data"], dict):
            raise SessionError(f"步骤 {key} 记录格式无效")
        steps[key] = {"data": _json_value(record["data"], f"steps.{key}.data")}

    unknown = set(raw_shared) - SHARED_KEYS
    if unknown:
        raise SessionError(f"shared 包含未知字段:{', '.join(sorted(unknown))}")
    shared = _json_value(raw_shared, "shared")
    normalized = {"version": SESSION_VERSION, "steps": steps, "shared": shared}
    if len(json.dumps(normalized, ensure_ascii=False).encode()) > MAX_SESSION_BYTES:
        raise SessionError("会话过大")
    return normalized
