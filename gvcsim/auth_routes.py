"""Authentication and self-service password routes."""

from fastapi import APIRouter, Header, HTTPException, Request
import threading
import time
from typing import Any

from pydantic import Field, field_validator

from gvcsim import auth, config, demo_accounts
from gvcsim.classroom import db
from gvcsim.rate_limit import RateLimitExceeded, SlidingWindowRateLimiter
from gvcsim.request_validation import TextRequest

router = APIRouter(prefix="/api/auth", tags=["authentication"])
_LOGIN_ACCOUNT_LIMITER = SlidingWindowRateLimiter(config.LOGIN_ATTEMPTS_PER_MINUTE)
_LOGIN_SOURCE_LIMITER = SlidingWindowRateLimiter(config.LOGIN_SOURCE_ATTEMPTS_PER_MINUTE)


def clear_rate_limits() -> None:
    _LOGIN_ACCOUNT_LIMITER.clear()
    _LOGIN_SOURCE_LIMITER.clear()
    _DEMO_SUGGESTION_LIMITER.clear()


def _limit_login(request: Request, username: str) -> None:
    source = request.client.host if request.client is not None else "unknown"
    try:
        _LOGIN_SOURCE_LIMITER.check(source)
        _LOGIN_ACCOUNT_LIMITER.check((source, username.strip().casefold()))
    except RateLimitExceeded as error:
        raise HTTPException(
            status_code=429,
            detail=f"尝试次数过多，请约 {error.retry_after_header} 秒后再试。",
            headers={"Retry-After": error.retry_after_header},
        ) from error


class LoginRequest(TextRequest):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)

    @field_validator("username", mode="before")
    @classmethod
    def trimmed_username(cls, value: Any) -> Any:
        # Usernames cannot contain whitespace; a name pasted from a roster often carries some around it.
        return value.strip().strip("\ufeff\u200b\u200c\u200d\u2060").strip() if isinstance(value, str) else value


class PasswordChangeRequest(TextRequest):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=12, max_length=256)

    @field_validator("new_password")
    @classmethod
    def nonblank_new_password(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("新密码不能全是空格")
        return value


def _initial_password(role: str, auth_version: int, username: str) -> bool:
    """A teacher still on the password the deployment set (``classroom-init`` or the bootstrap): every password
    change or reset raises the account's auth version past 1. Demo accounts keep their shared password."""
    if role != "teacher" or auth_version != 1:
        return False
    return not (config.DEMO_MODE and demo_accounts.is_demo_account_username(username))


@router.post("/login")
def login(req: LoginRequest, request: Request):
    _limit_login(request, req.username)
    try:
        user = auth.authenticate(req.username, req.password)
        if user is not None:
            token, expires_at = auth.issue_token(user)
    except auth.AuthenticationUnavailable as error:
        # Never the internal reason: it is logged where it is raised.
        raise HTTPException(status_code=503, detail=auth.SERVICE_UNAVAILABLE_MESSAGE) from error
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
            "initial_password": _initial_password(user["role"], user["auth_version"], user["username"]),
        },
    }


_DEMO_SUGGESTION_HOLD_SECONDS = 600.0
# An account logged into or saved within the last hour is someone's: it is never suggested to another person.
_DEMO_IN_USE_SECONDS = 3600.0
_recent_demo_suggestions: dict[str, float] = {}
_demo_suggestion_lock = threading.Lock()
_DEMO_SUGGESTION_LIMITER = SlidingWindowRateLimiter(config.LOGIN_SOURCE_ATTEMPTS_PER_MINUTE)


@router.get("/demo-student")
def demo_student_suggestion(request: Request, keep: str | None = None):
    """Demo builds only: an idle demo student, so two people rarely share an account.

    Accounts active in the last hour are never suggested. Accounts suggested in the last ten minutes are
    skipped (two page loads at the same moment get different ones), except ``keep``: the account this tab
    was given before, which a reload gets back instead of holding another one. When every idle account is
    held, the oldest suggestion nobody has logged into comes back; when none is idle, ``username`` is null.
    """
    if not config.DEMO_MODE:
        raise HTTPException(status_code=404, detail="Not Found")
    source = request.client.host if request.client is not None else "unknown"
    try:
        _DEMO_SUGGESTION_LIMITER.check(source)
    except RateLimitExceeded as error:
        raise HTTPException(
            status_code=429,
            detail=f"请求次数过多，请约 {error.retry_after_header} 秒后再试。",
            headers={"Retry-After": error.retry_after_header},
        ) from error
    try:
        candidates = db.demo_students_by_activity(_DEMO_IN_USE_SECONDS)
    except Exception as error:  # noqa: BLE001 - the login page falls back to its own pick
        raise HTTPException(status_code=503, detail="暂时无法分配演示账号") from error
    if not candidates:
        raise HTTPException(status_code=404, detail="没有可用的演示账号")
    idle = [username for username, in_use in candidates if not in_use]
    now = time.monotonic()
    with _demo_suggestion_lock:
        for username, at in list(_recent_demo_suggestions.items()):
            if now - at > _DEMO_SUGGESTION_HOLD_SECONDS:
                del _recent_demo_suggestions[username]
        if keep in idle:
            chosen: str | None = keep
        else:
            fresh = [username for username in idle if username not in _recent_demo_suggestions]
            chosen = (
                fresh[0] if fresh else min(idle, key=lambda username: _recent_demo_suggestions[username], default=None)
            )
        if chosen is not None:
            _recent_demo_suggestions[chosen] = now
    return {"username": chosen}


@router.get("/me")
def me(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="登录已失效，请重新登录。")
    try:
        payload = auth.verify_token(authorization.removeprefix("Bearer "))
    except auth.AuthenticationUnavailable as error:
        raise HTTPException(status_code=503, detail=auth.SERVICE_UNAVAILABLE_MESSAGE) from error
    if payload is None:
        raise HTTPException(status_code=401, detail="登录已失效，请重新登录。")
    return {
        "username": payload["sub"],
        "name": payload["name"],
        "role": payload["role"],
        "account_id": payload.get("aid"),
        "initial_password": _initial_password(payload["role"], payload["av"], payload["sub"]),
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
