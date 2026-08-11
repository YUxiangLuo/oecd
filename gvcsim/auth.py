"""认证、短期可撤销访问会话、登录限流与安全审计。

生产环境没有硬编码账号、口令或签名密钥，也不会在数据库故障时回退到
高权限账号。演示回退必须同时显式设置 ``GVCSIM_DEMO_MODE=1`` 和
``GVCSIM_BOOTSTRAP_PASSWORD``；生产配置会拒绝这一组合。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from collections import defaultdict, deque
from pathlib import Path

from gvcsim import config

SECRET_FILE = config.ROOT / "data" / ".auth_secret"
EVIDENCE_SECRET_FILE = config.ROOT / "data" / ".evidence_secret"


class AuthenticationUnavailable(Exception):
    """认证依赖不可用；调用方应返回 503，不能伪装为密码错误。"""


class TooManyLoginAttempts(Exception):
    """登录失败次数超过窗口限制。"""

    def __init__(self, retry_after: int):
        super().__init__("登录尝试过于频繁")
        self.retry_after = max(1, retry_after)


_attempts: dict[str, deque[float]] = defaultdict(deque)
_attempt_lock = threading.Lock()


def _demo_user(username: str, password: str) -> dict | None:
    """仅显式开发演示模式可用；配置中没有口令就绝不启用。"""
    expected = config.BOOTSTRAP_PASSWORD
    if not config.DEMO_MODE or not expected or username not in {"student", "teacher"}:
        return None
    if not hmac.compare_digest(password.encode(), expected.encode()):
        return None
    return {
        "username": username,
        "name": "同学" if username == "student" else "老师",
        "role": username,
        "account_id": None,
        "auth_version": 0,
        "demo": True,
    }


def check_login_rate(key: str, now: float | None = None, *, max_attempts: int | None = None) -> None:
    """进程内 demo 滑动窗口；生产流量使用 PostgreSQL 共享实现。"""
    now = time.time() if now is None else now
    window = config.LOGIN_WINDOW_SECONDS
    limit = config.LOGIN_MAX_ATTEMPTS if max_attempts is None else max_attempts
    with _attempt_lock:
        q = _attempts[key]
        while q and q[0] <= now - window:
            q.popleft()
        if len(q) >= limit:
            raise TooManyLoginAttempts(int(q[0] + window - now) + 1)


def record_login_result(key: str, *, success: bool, now: float | None = None) -> None:
    now = time.time() if now is None else now
    with _attempt_lock:
        if success:
            _attempts.pop(key, None)
        else:
            _attempts[key].append(now)


def reserve_login_attempt(ip_key: str, identity_key: str) -> None:
    """在校验口令前原子预占一次尝试。

    先消耗不含用户名的 per-IP 总预算，再消耗 ``IP|username`` 精确预算。
    因此轮换用户名不能把登录端点变成无界数据库写路径。生产状态存于
    PostgreSQL，所有 Uvicorn worker 共享；显式 demo 才允许进程内回退。
    """
    from gvcsim.classroom import db as classroom_db

    try:
        retry_after = classroom_db.reserve_login_attempts(
            (
                (ip_key, config.LOGIN_IP_MAX_ATTEMPTS),
                (identity_key, config.LOGIN_MAX_ATTEMPTS),
            ),
            config.LOGIN_WINDOW_SECONDS,
        )
    except (classroom_db.Unavailable, classroom_db.SchemaVersionMismatch) as exc:
        if not config.DEMO_MODE:
            raise AuthenticationUnavailable("登录限流数据库不可用或未就绪") from exc
        check_login_rate(ip_key, max_attempts=config.LOGIN_IP_MAX_ATTEMPTS)
        record_login_result(ip_key, success=False)
        check_login_rate(identity_key, max_attempts=config.LOGIN_MAX_ATTEMPTS)
        record_login_result(identity_key, success=False)
        return
    if retry_after is not None:
        raise TooManyLoginAttempts(retry_after)


def clear_login_rate(key: str) -> None:
    """成功认证后清空失败窗口；失败尝试已经在 reserve 阶段持久化。"""
    from gvcsim.classroom import db as classroom_db

    try:
        classroom_db.clear_login_attempts(key)
    except (classroom_db.Unavailable, classroom_db.SchemaVersionMismatch) as exc:
        if not config.DEMO_MODE:
            raise AuthenticationUnavailable("登录限流数据库不可用或未就绪") from exc
        record_login_result(key, success=True)


def _persistent_secret(configured: str, path: Path, env_name: str) -> bytes:
    """读取独立显式密钥，或在非生产环境创建 0600 持久密钥。"""
    if configured:
        key = configured.encode()
        if len(key) < 32:
            raise AuthenticationUnavailable(f"{env_name} 至少需要 32 字节")
        return key
    if config.IS_PRODUCTION:
        raise AuthenticationUnavailable(f"生产环境缺少 {env_name}")
    if path.exists():
        os.chmod(path, 0o600)
        return path.read_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_bytes(32)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(key)
    except FileExistsError:  # 并发首启：另一进程已经安全创建
        os.chmod(path, 0o600)
        return path.read_bytes()
    return key


def _secret() -> bytes:
    """访问令牌签名密钥（兼容 trusted callers，但不可用于答题/运行收据）。"""
    return _persistent_secret(config.AUTH_SECRET, SECRET_FILE, "GVCSIM_AUTH_SECRET")


def evidence_secret() -> bytes:
    """长期答题/运行收据专用密钥；轮换访问令牌密钥不会使既有收据失效。"""
    return _persistent_secret(config.EVIDENCE_SECRET, EVIDENCE_SECRET_FILE, "GVCSIM_EVIDENCE_SECRET")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def authenticate(username: str, password: str) -> dict | None:
    """数据库凭证校验；数据库故障默认 fail-closed。"""
    from gvcsim.classroom import db as classroom_db

    try:
        account = classroom_db.authenticate_account(username, password)
        if not account:
            return None
        return {
            "username": username,
            "name": account["display_name"],
            "role": account["role"],
            "account_id": account["id"],
            "auth_version": account.get("auth_version", 1),
        }
    except (classroom_db.SchemaVersionMismatch, classroom_db.PasswordHashError) as exc:
        # schema/口令参数身份不明不是“暂时断线”，演示账号也不得绕过迁移闸门。
        raise AuthenticationUnavailable("认证数据库不可用或未就绪") from exc
    except classroom_db.Unavailable as exc:
        demo = _demo_user(username, password)
        if demo is not None:
            return demo
        raise AuthenticationUnavailable("认证数据库不可用或未就绪") from exc


def issue_token(user: dict) -> tuple[str, int]:
    """签发短期、可撤销访问令牌并登记服务端安全会话。"""
    ttl = config.TOKEN_TTL_SECONDS
    if ttl <= 0 or ttl > config.MAX_TOKEN_TTL_SECONDS:
        raise AuthenticationUnavailable(f"访问令牌有效期必须在 1..{config.MAX_TOKEN_TTL_SECONDS} 秒之间")
    now = int(time.time())
    exp = now + ttl
    jti = secrets.token_urlsafe(24)
    body = {
        "sub": user["username"],
        "name": user["name"],
        "role": user["role"],
        "aid": user.get("account_id"),
        "av": user.get("auth_version", 1),
        "jti": jti,
        "iat": now,
        "exp": exp,
    }
    if user.get("demo"):
        body["demo"] = True
    payload = _b64(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode())
    sig = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
    token = f"{payload}.{sig}"

    if user.get("account_id") is not None:
        from gvcsim.classroom import db as classroom_db

        try:
            classroom_db.create_auth_session(
                int(user["account_id"]), jti, hashlib.sha256(token.encode()).hexdigest(), exp
            )
        except (classroom_db.Unavailable, classroom_db.SchemaVersionMismatch) as exc:
            raise AuthenticationUnavailable("无法登记登录会话；认证数据库不可用或未就绪") from exc
    elif not config.DEMO_MODE:
        raise AuthenticationUnavailable("账号缺少稳定 account_id")
    return token, exp


def _decode_signed(token: str) -> dict | None:
    try:
        payload_b64, sig = token.split(".", 1)
        expected = _b64(hmac.new(_secret(), payload_b64.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(_unb64(payload_b64))
        if payload.get("exp", 0) <= time.time() or not payload.get("jti"):
            return None
        return payload
    except Exception:
        return None


def verify_token(token: str) -> dict | None:
    """校验签名并逐请求复查安全会话、账号启用状态和认证版本。"""
    payload = _decode_signed(token)
    if payload is None:
        return None
    if payload.get("demo"):
        return payload if config.DEMO_MODE else None
    from gvcsim.classroom import db as classroom_db

    try:
        account = classroom_db.validate_auth_session(
            payload["jti"], hashlib.sha256(token.encode()).hexdigest(), payload.get("aid"), payload.get("av")
        )
    except (classroom_db.Unavailable, classroom_db.SchemaVersionMismatch) as exc:
        raise AuthenticationUnavailable("认证会话数据库不可用或未就绪") from exc
    if account is None:
        return None
    # 姓名可改，角色/账号由数据库成为每次请求的最终真相。
    payload.update(
        {
            "sub": account["username"],
            "name": account["display_name"],
            "role": account["role"],
            "aid": account["id"],
        }
    )
    return payload


def revoke_token(token: str) -> bool:
    payload = _decode_signed(token)
    if not payload or payload.get("demo"):
        return False
    from gvcsim.classroom import db as classroom_db

    try:
        return classroom_db.revoke_auth_session(payload["jti"])
    except (classroom_db.Unavailable, classroom_db.SchemaVersionMismatch) as exc:
        raise AuthenticationUnavailable("认证会话数据库不可用或未就绪") from exc
