"""Password authentication and stateless signed access tokens."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

from gvcsim import config

SECRET_FILE = config.ROOT / "data" / ".auth_secret"


class AuthenticationUnavailable(Exception):
    pass


def _persistent_secret(configured: str, path: Path) -> bytes:
    if configured:
        key = configured.encode()
        if len(key) < 32:
            raise AuthenticationUnavailable("GVCSIM_AUTH_SECRET 至少需要 32 字节")
        return key
    if path.exists():
        return path.read_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_bytes(32)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(key)
    except FileExistsError:
        return path.read_bytes()
    return key


def _secret() -> bytes:
    return _persistent_secret(config.AUTH_SECRET, SECRET_FILE)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def authenticate(username: str, password: str) -> dict | None:
    from gvcsim.classroom import db

    try:
        account = db.find_account(username)
        if not account:
            db.hash_password(password, "00" * 16)
            return None
        supplied = db.hash_password(password, account["pw_salt"])
        if not hmac.compare_digest(account["pw_hash"], supplied):
            return None
        db.touch_login(username)
        return {
            "username": username,
            "name": account["display_name"],
            "role": account["role"],
            "account_id": account["id"],
        }
    except (db.Unavailable, db.SchemaVersionMismatch) as error:
        raise AuthenticationUnavailable("认证数据库不可用或未就绪") from error


def _current_release_id() -> str:
    from gvcsim import artifacts

    try:
        return artifacts.release_identity()
    except (artifacts.ArtifactContractError, OSError) as error:
        raise AuthenticationUnavailable("当前数据发布不可用") from error


def issue_token(user: dict) -> tuple[str, int]:
    now = int(time.time())
    exp = now + config.TOKEN_TTL_SECONDS
    body = {
        "sub": user["username"],
        "name": user["name"],
        "role": user["role"],
        "aid": user["account_id"],
        "rid": _current_release_id(),
        "exp": exp,
    }
    payload = _b64(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode())
    signature = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{signature}", exp


def verify_token(token: str) -> dict | None:
    try:
        payload_b64, signature = token.split(".", 1)
        expected = _b64(hmac.new(_secret(), payload_b64.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            return None
        payload = json.loads(_unb64(payload_b64))
        if payload.get("exp", 0) <= time.time():
            return None
        if payload.get("role") not in {"student", "teacher"} or not payload.get("sub"):
            return None
        if payload.get("rid") != _current_release_id():
            return None
        return payload
    except AuthenticationUnavailable:
        raise
    except Exception:
        return None
