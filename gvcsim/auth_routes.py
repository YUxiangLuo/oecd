"""Authentication and self-service account routes for the FastAPI application."""

import logging

from fastapi import APIRouter, Header, HTTPException
from fastapi.requests import Request
from pydantic import BaseModel, Field

from gvcsim import auth, config as app_config
from gvcsim.classroom import db as classroom_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["authentication"])


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=12, max_length=256)


@router.post("/login")
def login(req: LoginRequest, request: Request):
    ip = request.client.host if request.client else None
    client_key = ip or "unknown"
    ip_rate_key = f"ip:{client_key}"
    identity_rate_key = f"identity:{client_key}|{req.username.casefold()}"
    try:
        auth.reserve_login_attempt(ip_rate_key, identity_rate_key)
    except auth.TooManyLoginAttempts as error:
        raise HTTPException(
            status_code=429,
            detail="登录尝试过于频繁，请稍后再试",
            headers={"Retry-After": str(error.retry_after)},
        ) from error
    except auth.AuthenticationUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    try:
        user = auth.authenticate(req.username, req.password)
    except auth.AuthenticationUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if user is None:
        try:
            classroom_db.record_audit_event(
                "auth.login_failed", target_type="account", target_id=req.username, ip_address=ip
            )
        except Exception as error:
            logger.warning("failed-login audit write failed: error=%s", type(error).__name__)
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    # token + 服务端 auth_session 是登录的关键提交点，失败时必须 fail-closed。
    try:
        token, exp = auth.issue_token(user)
    except auth.AuthenticationUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    # 此后都是非关键收尾：不能让一次清理/审计故障把已经创建的有效 session
    # 改写成 503，并在数据库留下客户端永远拿不到 token 的孤儿会话。
    try:
        # 成功只清理该身份的口令猜测窗口；per-IP 总预算仍应统计这次请求。
        auth.clear_login_rate(identity_rate_key)
    except Exception as error:
        logger.warning("post-auth rate-limit cleanup failed: error=%s", type(error).__name__)
    if not user.get("demo"):
        try:
            classroom_db.record_audit_event(
                "auth.login_succeeded",
                actor_id=user.get("account_id"),
                actor_name=user["username"],
                target_type="auth_session",
                ip_address=ip,
            )
        except Exception as error:
            logger.warning("successful-login audit write failed: error=%s", type(error).__name__)
    public_user = {
        "username": user["username"],
        "name": user["name"],
        "role": user["role"],
        "account_id": user.get("account_id"),
    }
    return {"token": token, "user": public_user, "expires_at": exp}


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


@router.post("/logout")
def logout(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少 Bearer 令牌")
    token = authorization.removeprefix("Bearer ")
    try:
        payload = auth.verify_token(token)
    except auth.AuthenticationUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if payload is None:
        raise HTTPException(status_code=401, detail="令牌无效或已过期")
    if not auth.revoke_token(token):
        raise HTTPException(status_code=409, detail="该会话无法撤销")
    classroom_db.record_audit_event(
        "auth.logout", actor_id=payload.get("aid"), actor_name=payload["sub"], target_type="auth_session"
    )
    return {"ok": True}


@router.post("/password")
def change_password(req: PasswordChangeRequest, request: Request):
    """修改当前账号密码；成功后撤销该账号全部会话并要求重新登录。"""
    user = getattr(request.state, "user", {})
    if user.get("demo") or user.get("aid") is None:
        raise HTTPException(status_code=409, detail="临时演示账号不能修改密码")
    rate_key = f"password-change:{user['aid']}"
    retry_after = classroom_db.reserve_login_attempt(
        rate_key,
        app_config.LOGIN_WINDOW_SECONDS,
        app_config.LOGIN_MAX_ATTEMPTS,
    )
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail="密码验证尝试过于频繁，请稍后再试",
            headers={"Retry-After": str(retry_after)},
        )
    try:
        changed = classroom_db.change_own_password(user["sub"], req.current_password, req.new_password)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if not changed:
        raise HTTPException(status_code=400, detail="当前密码不正确")
    try:
        classroom_db.clear_login_attempts(rate_key)
    except Exception as error:
        # 密码更新与全会话撤销已经在同一事务提交；限流清理不能把成功改写成 503。
        logger.warning("post-password-change rate-limit cleanup failed: error=%s", type(error).__name__)
    return {"ok": True, "reauthenticate": True}
