"""登录认证:演示账号 + 真实的凭证校验与签名令牌。

教学演示定位下仍按正规做法实现:
  - 口令只存 PBKDF2-HMAC-SHA256 哈希(每账号独立盐),不存明文
  - 令牌 = base64url(payload JSON) + "." + HMAC-SHA256 签名,带过期时间
  - 签名密钥首次使用时生成并持久化到 data/.auth_secret(gitignore),
    重启服务令牌仍有效

演示账号(README 亦有记录,登录页默认预填;name 用于界面称呼,避免
"演示学生"这类系统腔文案):
  student / gvclab2026   同学(学生身份)
  teacher / gvclab2026   老师(教师身份)

API 层已对除登录/令牌校验外的 `/api/*` 数据接口强制 Bearer 校验。

已知的教学部署取舍:当前登录端点没有速率限制或账号锁定，不应直接用于
公网生产环境。对外部署时应在反向代理/身份提供方增加限流、审计和暴力破解防护。
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
        "name": "同学",
        "role": "student",
    },
    "teacher": {
        "password_hash": _hash_password("gvclab2026"),
        "name": "老师",
        "role": "teacher",
    },
}


class AuthenticationUnavailable(Exception):
    """教学数据库不可用，且请求不是合法的内置演示账号。"""


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
    """校验凭证。成功返回用户信息(不含哈希),失败返回 None。

    优先走教学数据库(教师在面板创建的学生账号、每账号独立盐);
    数据库不可用时回退硬编码演示账号,保证课堂演示不因 DB 停机而无法登录。
    """
    from gvcsim.classroom import db as classroom_db

    try:
        account = classroom_db.find_account(username)
        if not account:
            classroom_db.hash_password(password, "00" * 16)  # 等时哈希,避免暴露用户名是否存在
            return None
        if not account["active"]:
            return None
        if not hmac.compare_digest(account["pw_hash"], classroom_db.hash_password(password, account["pw_salt"])):
            return None
        try:
            classroom_db.touch_login(username)
        except classroom_db.Unavailable:
            pass
        return {"username": username, "name": account["display_name"], "role": account["role"]}
    except classroom_db.Unavailable as e:
        user = USERS.get(username)
        supplied_hash = _hash_password(password)
        if user and hmac.compare_digest(user["password_hash"], supplied_hash):
            return {"username": username, "name": user["name"], "role": user["role"]}
        # 数据库停机时无法判断非演示账号是“不存在”还是“暂时无法校验”，
        # 因此明确返回可用性错误，不伪装成密码错误。
        raise AuthenticationUnavailable("教学数据库不可用，请使用演示账号 student 或 teacher") from e


def issue_token(user: dict) -> tuple[str, int]:
    """签发令牌,返回 (token, 过期时间戳)。"""
    exp = int(time.time()) + TOKEN_TTL_SECONDS
    payload = _b64(
        json.dumps(
            {"sub": user["username"], "name": user["name"], "role": user["role"], "exp": exp},
            ensure_ascii=False,
        ).encode()
    )
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
