"""Authentication and self-service password routes."""

from fastapi import APIRouter, Header, HTTPException, Request
import threading
import time
from typing import Any

from pydantic import Field, field_validator

from gvcsim import auth, config
from gvcsim.classroom import db
from gvcsim.rate_limit import RateLimitExceeded, SlidingWindowRateLimiter
from gvcsim.request_validation import TextRequest

router = APIRouter(prefix="/api/auth", tags=["authentication"])
_LOGIN_ACCOUNT_LIMITER = SlidingWindowRateLimiter(config.LOGIN_ATTEMPTS_PER_MINUTE)
_LOGIN_SOURCE_LIMITER = SlidingWindowRateLimiter(config.LOGIN_SOURCE_ATTEMPTS_PER_MINUTE)


def clear_rate_limits() -> None:
    _LOGIN_ACCOUNT_LIMITER.clear()
    _LOGIN_SOURCE_LIMITER.clear()


def _limit_login(request: Request, username: str) -> None:
    source = request.client.host if request.client is not None else "unknown"
    try:
        _LOGIN_SOURCE_LIMITER.check(source)
        _LOGIN_ACCOUNT_LIMITER.check((source, username.strip().casefold()))
    except RateLimitExceeded as error:
        raise HTTPException(
            status_code=429,
            detail=f"登录尝试过于频繁，请约 {error.retry_after_header} 秒后重试",
            headers={"Retry-After": error.retry_after_header},
        ) from error


class LoginRequest(TextRequest):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)

    @field_validator("username", mode="before")
    @classmethod
    def trimmed_username(cls, value: Any) -> Any:
        # Usernames cannot contain whitespace; a name pasted from a roster often carries some around it.
        return value.strip() if isinstance(value, str) else value


class PasswordChangeRequest(TextRequest):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=12, max_length=256)


@router.post("/login")
def login(req: LoginRequest, request: Request):
    _limit_login(request, req.username)
    try:
        user = auth.authenticate(req.username, req.password)
        if user is not None:
            token, expires_at = auth.issue_token(user)
    except auth.AuthenticationUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if user is None:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    return {
        "token": token,
        "expires_at": expires_at,
        "user": {
            "username": user["username"],
            "name": user["name"],
            "role": user["role"],
            "account_id": user["account_id"],
        },
    }


_DEMO_SUGGESTION_HOLD_SECONDS = 600.0
_recent_demo_suggestions: dict[str, float] = {}
_demo_suggestion_lock = threading.Lock()


@router.get("/demo-student")
def demo_student_suggestion():
    """Demo builds only: the demo student least recently used, so two people rarely share an account.

    Accounts suggested in the last ten minutes are skipped (two page loads at the same moment get
    different ones); only when every account was just suggested does the oldest suggestion come back.
    """
    if not config.DEMO_MODE:
        raise HTTPException(status_code=404, detail="Not Found")
    try:
        candidates = db.demo_students_by_activity()
    except Exception as error:  # noqa: BLE001 - the login page falls back to its own rotation
        raise HTTPException(status_code=503, detail="暂时无法分配演示账号") from error
    if not candidates:
        raise HTTPException(status_code=404, detail="没有可用的演示账号")
    now = time.monotonic()
    with _demo_suggestion_lock:
        for username, at in list(_recent_demo_suggestions.items()):
            if now - at > _DEMO_SUGGESTION_HOLD_SECONDS:
                del _recent_demo_suggestions[username]
        fresh = [username for username in candidates if username not in _recent_demo_suggestions]
        chosen = fresh[0] if fresh else min(candidates, key=lambda username: _recent_demo_suggestions[username])
        _recent_demo_suggestions[chosen] = now
    return {"username": chosen}


@router.get("/me")
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


@router.post("/password")
def change_password(req: PasswordChangeRequest, request: Request):
    user = getattr(request.state, "user", {})
    try:
        changed = db.change_own_password(user["sub"], req.current_password, req.new_password)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if not changed:
        raise HTTPException(status_code=400, detail="当前密码不正确")
    return {"ok": True, "reauthenticate": True}
