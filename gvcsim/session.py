"""Small, server-authoritative experiment session model."""

from __future__ import annotations

import json
from copy import deepcopy
from typing import Any

from gvcsim.numeric import finite_number

SESSION_VERSION = "experiment-session-simple-v4"
MAX_SESSION_BYTES = 300_000
MAX_STEPS = 15
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
    if isinstance(value, (int, float)) and not isinstance(value, bool) and not finite_number(value):
        raise SessionError(f"{path} 包含非有限或超出浮点范围的数值")
    if isinstance(value, str):
        if "\x00" in value:
            raise SessionError("会话不能包含空字符 U+0000")
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise SessionError("会话包含无效的 Unicode 字符") from error
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [_json_value(item, f"{path}[]") for item in value]
    if isinstance(value, dict):
        if not all(isinstance(key, str) for key in value):
            raise SessionError(f"{path} 的键必须是字符串")
        for key in value:
            _json_value(key)
        return {key: _json_value(item, f"{path}.{key}") for key, item in value.items()}
    raise SessionError(f"{path} 包含不能保存的值")


def validate_session(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise SessionError("会话必须是对象")
    if set(payload) != {"version", "steps", "shared"}:
        raise SessionError("会话必须且只能包含 version、steps、shared")
    if payload.get("version") != SESSION_VERSION:
        raise SessionError(f"会话版本不受支持；当前为 {SESSION_VERSION}")
    raw_steps = payload.get("steps", {})
    raw_shared = payload.get("shared", {})
    if not isinstance(raw_steps, dict) or not isinstance(raw_shared, dict):
        raise SessionError("steps/shared 必须是对象")

    steps: dict[str, Any] = {}
    for key, record in raw_steps.items():
        if key not in {str(step) for step in range(1, MAX_STEPS + 1)}:
            raise SessionError(f"步骤编号无效:{key!r}")
        if not isinstance(record, dict) or set(record) != {"data"} or not isinstance(record["data"], dict):
            raise SessionError(f"步骤 {key} 记录格式无效")
        steps[key] = {"data": _json_value(record["data"], f"steps.{key}.data")}

    unknown = set(raw_shared) - SHARED_KEYS
    if unknown:
        raise SessionError(f"shared 包含未知字段:{', '.join(sorted(unknown))!r}")
    shared = _json_value(raw_shared, "shared")
    normalized = {"version": SESSION_VERSION, "steps": steps, "shared": shared}
    if len(json.dumps(normalized, ensure_ascii=False).encode()) > MAX_SESSION_BYTES:
        raise SessionError("会话过大")
    return normalized
