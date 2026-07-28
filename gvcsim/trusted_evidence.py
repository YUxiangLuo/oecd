"""服务端签发的答题与回归运行收据。

会话仍是便于恢复 UI 的 JSON，但答题完成与报告中的回归只认可本模块签名的
收据。收据绑定账号、步骤、manifest 与规范化 payload 摘要；客户端改动答题
或回归设定后，旧收据立即失效。每次签发前先写入 append-only 事件；HMAC
收据只是该事件的便携引用，验证时还会检查当前账号/assignment/attempt 下的
真实事件。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any

from gvcsim import auth

TOKEN_VERSION = "trusted-receipt-v2"


def _event_time(event: dict[str, Any]) -> str:
    issued_at = event.get("issued_at")
    isoformat = getattr(issued_at, "isoformat", None)
    return str(isoformat()) if callable(isoformat) else str(issued_at)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def issue_claims(claims: dict[str, Any]) -> str:
    body = {"v": TOKEN_VERSION, **claims}
    encoded = _b64(canonical_json(body).encode("utf-8"))
    signature = _b64(hmac.new(auth.evidence_secret(), encoded.encode("ascii"), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def verify_claims(token: Any) -> dict[str, Any] | None:
    if not isinstance(token, str) or not token:
        return None
    try:
        encoded, signature = token.split(".", 1)
        expected = _b64(hmac.new(auth.evidence_secret(), encoded.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            return None
        payload = json.loads(_unb64(encoded))
        return payload if isinstance(payload, dict) and payload.get("v") == TOKEN_VERSION else None
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


def issue_quiz_completion(
    *, subject: str, step: int, manifest_id: str, payload: dict[str, Any], event: dict[str, Any]
) -> str:
    return issue_claims(
        {
            "type": "quiz",
            "sub": subject,
            "step": step,
            "manifest_id": manifest_id,
            "payload_sha256": digest(payload),
            "event_id": str(event["event_id"]),
            "account_id": int(event["account_id"]),
            "assignment_id": int(event["assignment_id"]),
            "attempt_id": int(event["attempt_id"]),
            "issued_at": _event_time(event),
        }
    )


def verify_quiz_completion(
    token: Any,
    *,
    subject: str,
    step: int,
    manifest_id: str,
    payload: dict[str, Any],
    connection: Any | None = None,
) -> bool:
    claims = verify_claims(token)
    valid = bool(
        claims
        and claims.get("type") == "quiz"
        and claims.get("sub") == subject
        and claims.get("step") == step
        and claims.get("manifest_id") == manifest_id
        and claims.get("payload_sha256") == digest(payload)
    )
    if claims is None or not valid:
        return False
    try:
        from gvcsim.classroom import db

        connection_arg = {"connection": connection} if connection is not None else {}
        return db.evidence_event_exists(
            subject,
            str(claims["event_id"]),
            int(claims["assignment_id"]),
            int(claims["attempt_id"]),
            str(claims["payload_sha256"]),
            account_id=int(claims["account_id"]),
            step=step,
            kind="quiz",
            manifest_id=manifest_id,
            **connection_arg,
        )
    except (KeyError, TypeError, ValueError):
        return False


def issue_regression_run(
    *,
    subject: str,
    manifest_id: str,
    design: dict[str, Any],
    result: dict[str, Any],
    event: dict[str, Any],
) -> str:
    """签发引用 append-only 运行事件的 run_id；语义幂等由报告指纹另行归一。"""
    payload_sha256 = digest({"design": design, "result": result})
    return issue_claims(
        {
            "type": "regression",
            "sub": subject,
            "step": int(event["step"]),
            "manifest_id": manifest_id,
            "design": design,
            "result_sha256": digest(result),
            "payload_sha256": payload_sha256,
            "event_id": str(event["event_id"]),
            "account_id": int(event["account_id"]),
            "assignment_id": int(event["assignment_id"]),
            "attempt_id": int(event["attempt_id"]),
            "issued_at": _event_time(event),
        }
    )


def verify_regression_run(
    token: Any,
    *,
    subject: str,
    manifest_id: str,
    outcome: str,
    settings: dict[str, Any],
    step: int | None = None,
) -> dict[str, Any] | None:
    claims = verify_claims(token)
    if not claims or any(
        (
            claims.get("type") != "regression",
            claims.get("sub") != subject,
            claims.get("manifest_id") != manifest_id,
        )
    ):
        return None
    design = claims.get("design")
    if not isinstance(design, dict) or design.get("outcome") != outcome:
        return None
    if step is not None and claims.get("step") != step:
        return None
    # 前端会话用 camelCase；API 设计信息用 snake_case。只比较学生确实保存的字段。
    mapping = {
        "granularity": "granularity",
        "shockType": "shock_type",
        "method": "method",
        "controlMode": "control_mode",
        "interaction": "interaction",
        "priceMode": "price_mode",
        "scenario": "scenario",
        "excludeRow": "exclude_row",
        "weightMode": "weight_mode",
    }
    for session_key, design_key in mapping.items():
        if session_key in settings and settings[session_key] != design.get(design_key):
            return None
    try:
        from gvcsim.classroom import db

        exists = db.evidence_event_exists(
            subject,
            str(claims["event_id"]),
            int(claims["assignment_id"]),
            int(claims["attempt_id"]),
            str(claims["payload_sha256"]),
            account_id=int(claims["account_id"]),
            step=step,
            kind="regression",
            manifest_id=manifest_id,
        )
    except (KeyError, TypeError, ValueError):
        return None
    return claims if exists else None
