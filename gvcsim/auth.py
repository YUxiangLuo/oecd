"""Password authentication and release/account-bound signed access tokens."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

from gvcsim import artifacts, config

SECRET_FILE = config.DATA_DIR / ".auth_secret"


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
            "auth_version": account["auth_version"],
        }
    except (db.Unavailable, db.SchemaVersionMismatch) as error:
        raise AuthenticationUnavailable("认证数据库不可用或未就绪") from error


def issue_token(user: dict) -> tuple[str, int]:
    now = int(time.time())
    exp = now + config.TOKEN_TTL_SECONDS
    try:
        release_id = artifacts.release_identity()
    except (artifacts.ArtifactContractError, OSError) as error:
        raise AuthenticationUnavailable("当前数据发布不可用") from error
    body = {
        "sub": user["username"],
        "role": user["role"],
        "aid": user["account_id"],
        "av": user["auth_version"],
        "rid": release_id,
        "exp": exp,
    }
    payload = _b64(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode())
    signature = _b64(hmac.new(_secret(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{signature}", exp


def verify_token(token: str) -> dict | None:
    from gvcsim.classroom import db

    try:
        payload_b64, signature = token.split(".", 1)
        expected = _b64(hmac.new(_secret(), payload_b64.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            return None
        payload = json.loads(_unb64(payload_b64))
        if payload.get("exp", 0) <= time.time():
            return None
        role = payload.get("role")
        username = payload.get("sub")
        account_id = payload.get("aid")
        auth_version = payload.get("av")
        release_id = payload.get("rid")
        if (
            role not in {"student", "teacher"}
            or not isinstance(username, str)
            or not username
            or isinstance(account_id, bool)
            or not isinstance(account_id, int)
            or isinstance(auth_version, bool)
            or not isinstance(auth_version, int)
            or auth_version <= 0
            or not isinstance(release_id, str)
        ):
            return None
        try:
            if not hmac.compare_digest(release_id, artifacts.release_identity()):
                return None
            subject = db.current_auth_subject(account_id, username, role, auth_version)
            if subject is None:
                return None
            # Never use a potentially stale profile snapshot from the signed token
            # for UI identity or report authorship. Authorization is still bound to
            # the immutable account id/username/role/auth_version claims above.
            payload["name"] = subject["display_name"]
        except (artifacts.ArtifactContractError, OSError, db.Unavailable, db.SchemaVersionMismatch) as error:
            raise AuthenticationUnavailable("认证依赖的数据发布或数据库不可用") from error
        return payload
    except AuthenticationUnavailable:
        raise
    except Exception:
        return None
