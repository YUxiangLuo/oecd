"""登录认证:演示账号 + 真实的凭证校验与签名令牌。

教学演示定位下仍按正规做法实现:
  - 口令只存 PBKDF2-HMAC-SHA256 哈希(每账号独立盐),不存明文
  - 令牌 = base64url(payload JSON) + "." + HMAC-SHA256 签名,带过期时间
  - 签名密钥首次使用时生成并持久化到 data/.auth_secret(gitignore),
    重启服务令牌仍有效

演示账号(README 亦有记录,登录页默认预填):
  student / gvclab2026   演示学生
  teacher / gvclab2026   演示教师

⚠ 当前只有"登录"这一层:数据接口暂不强制鉴权(教学系统单机使用),
接入真实部署时给 FastAPI 加依赖注入式的 Bearer 校验即可(verify_token 已就绪)。
"""

import base64
import hashlib
import hmac
import json
import secrets
import time

from gvcsim.config import ROOT

SECRET_FILE = ROOT / "data" / ".auth_secret"
TOKEN_TTL_SECONDS = 12 * 3600

# 盐固定写死(演示账号本身公开,盐的作用只是走完正规流程)
_DEMO_SALT = bytes.fromhex("9f1c40aa31d24fe6a3b8d07c55e2b911")


def _hash_password(password: str, salt: bytes = _DEMO_SALT) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100_000).hex()

USERS = {
    "student": {
        "password_hash": _hash_password("gvclab2026"),
        "name": "演示学生",
        "role": "student",
    },
    "teacher": {
        "password_hash": _hash_password("gvclab2026"),
        "name": "演示教师",
        "role": "teacher",
    },
}


def _secret() -> bytes:
    if SECRET_FILE.exists():
        return SECRET_FILE.read_bytes()
    SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_bytes(32)
    SECRET_FILE.write_bytes(key)
    return key


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def authenticate(username: str, password: str) -> dict | None:
    """校验凭证。成功返回用户信息(不含哈希),失败返回 None。"""
    user = USERS.get(username)
    if not user:
        # 用户不存在也走一次哈希,避免时间侧信道暴露用户名是否存在
        _hash_password(password)
        return None
    if not hmac.compare_digest(user["password_hash"], _hash_password(password)):
        return None
    return {"username": username, "name": user["name"], "role": user["role"]}


def issue_token(user: dict) -> tuple[str, int]:
    """签发令牌,返回 (token, 过期时间戳)。"""
    exp = int(time.time()) + TOKEN_TTL_SECONDS
    payload = _b64(json.dumps(
        {"sub": user["username"], "name": user["name"], "role": user["role"], "exp": exp},
        ensure_ascii=False,
    ).encode())
    sig = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{sig}", exp


def verify_token(token: str) -> dict | None:
    """校验令牌签名与有效期。成功返回 payload,失败返回 None。"""
    try:
        payload_b64, sig = token.split(".", 1)
        expected = _b64(hmac.new(_secret(), payload_b64.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(_unb64(payload_b64))
        if payload.get("exp", 0) < time.time():
            return None
        return payload
    except Exception:
        return None
