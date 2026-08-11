"""Authentication and self-service password routes."""

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from gvcsim import auth
from gvcsim.classroom import db

router = APIRouter(prefix="/api/auth", tags=["authentication"])


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=12, max_length=256)


@router.post("/login")
def login(req: LoginRequest):
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
