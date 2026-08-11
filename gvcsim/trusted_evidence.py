"""服务端签发的答题、主回归与安慰剂运行收据。

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


def _verified_quiz_claims(
    token: Any,
    *,
    subject: str,
    step: int,
    manifest_id: str,
    payload: dict[str, Any],
) -> dict[str, Any] | None:
    """先在内存中核对签名和教学语义；数据库事件边界由调用方随后确认。"""
    claims = verify_claims(token)
    if not claims or any(
        (
            claims.get("type") != "quiz",
            claims.get("sub") != subject,
            claims.get("step") != step,
            claims.get("manifest_id") != manifest_id,
            claims.get("payload_sha256") != digest(payload),
        )
    ):
        return None
    return claims


def verify_quiz_completion(
    token: Any,
    *,
    subject: str,
    step: int,
    manifest_id: str,
    payload: dict[str, Any],
    connection: Any | None = None,
) -> bool:
    claims = _verified_quiz_claims(
        token,
        subject=subject,
        step=step,
        manifest_id=manifest_id,
        payload=payload,
    )
    if claims is None:
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


def verify_quiz_completions(
    receipts: dict[int, tuple[Any, dict[str, Any]]],
    *,
    subject: str,
    manifest_id: str,
    connection: Any | None = None,
    scope: dict[str, Any] | None = None,
) -> set[int]:
    """批量核对一份会话里的答题收据，避免逐步重复解析课堂作用域。"""
    checks: list[dict[str, Any]] = []
    event_steps: dict[str, int] = {}
    for step, (token, payload) in receipts.items():
        claims = _verified_quiz_claims(
            token,
            subject=subject,
            step=step,
            manifest_id=manifest_id,
            payload=payload,
        )
        if claims is None:
            continue
        try:
            event_id = str(claims["event_id"])
            checks.append(
                {
                    "event_id": event_id,
                    "account_id": int(claims["account_id"]),
                    "assignment_id": int(claims["assignment_id"]),
                    "attempt_id": int(claims["attempt_id"]),
                    "payload_sha256": str(claims["payload_sha256"]),
                    "step": step,
                    "kind": "quiz",
                    "manifest_id": manifest_id,
                }
            )
            event_steps[event_id] = step
        except (KeyError, TypeError, ValueError):
            continue
    if not checks:
        return set()

    from gvcsim.classroom import db

    kwargs: dict[str, Any] = {}
    if connection is not None:
        kwargs["connection"] = connection
    if scope is not None:
        kwargs["scope"] = scope
    valid_ids = db.valid_evidence_event_ids(
        subject,
        checks,
        manifest_id=manifest_id,
        **kwargs,
    )
    return {event_steps[event_id] for event_id in valid_ids if event_id in event_steps}


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


def issue_placebo_run(
    *,
    subject: str,
    manifest_id: str,
    design: dict[str, Any],
    result: dict[str, Any],
    event: dict[str, Any],
) -> str:
    """Sign one placebo result so the exact distribution can survive a refresh."""
    payload_sha256 = digest({"design": design, "result": result})
    return issue_claims(
        {
            "type": "placebo",
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


def _settings_match_design(settings: dict[str, Any], design: dict[str, Any]) -> bool:
    """Compare the camelCase session fields that the student actually saved."""
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
    return all(
        session_key not in settings or settings[session_key] == design.get(design_key)
        for session_key, design_key in mapping.items()
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
    if not _settings_match_design(settings, design):
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


def verify_placebo_run(
    token: Any,
    *,
    subject: str,
    manifest_id: str,
    outcome: str,
    settings: dict[str, Any],
    result: dict[str, Any],
    step: int,
) -> dict[str, Any] | None:
    """Validate the exact saved placebo distribution and its append-only event."""
    claims = verify_claims(token)
    if not claims or any(
        (
            claims.get("type") != "placebo",
            claims.get("sub") != subject,
            claims.get("manifest_id") != manifest_id,
            claims.get("step") != step,
            claims.get("result_sha256") != digest(result),
        )
    ):
        return None
    design = claims.get("design")
    if not isinstance(design, dict) or design.get("outcome") != outcome:
        return None
    if not _settings_match_design(settings, design):
        return None
    payload_sha256 = digest({"design": design, "result": result})
    if claims.get("payload_sha256") != payload_sha256:
        return None
    try:
        from gvcsim.classroom import db

        exists = db.evidence_event_exists(
            subject,
            str(claims["event_id"]),
            int(claims["assignment_id"]),
            int(claims["attempt_id"]),
            payload_sha256,
            account_id=int(claims["account_id"]),
            step=step,
            kind="placebo",
            manifest_id=manifest_id,
        )
    except (KeyError, TypeError, ValueError):
        return None
    return claims if exists else None
