#!/usr/bin/env python3
"""Remove credentials and signed classroom receipts from an agent-browser HAR.

CI browser artifacts are useful for diagnosing routing failures, but HAR request
headers and JSON bodies otherwise retain Bearer tokens and password-rotation
payloads.  Sanitization is atomic and fail-closed: malformed input is never
silently kept as a publishable artifact.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

_REDACTED = "[REDACTED]"
_SENSITIVE_KEYS = frozenset(
    {
        "access_token",
        "authorization",
        "cookie",
        "current_password",
        "new_password",
        "old_password",
        "password",
        "placebo_id",
        "quiz_id",
        "receipt",
        "run_id",
        "set-cookie",
        "token",
    }
)
_BODY_SECRET = re.compile(
    r'(?i)("?(?:access_token|authorization|current_password|new_password|old_password|password|'
    r'placebo_id|quiz_id|run_id|token)"?\s*[:=]\s*")([^"&\s]+)'
)


def _sensitive(key: str) -> bool:
    lowered = key.lower()
    return lowered in _SENSITIVE_KEYS or lowered.endswith("_password")


def _scrub(value: Any) -> Any:
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    if not isinstance(value, dict):
        return value

    # HAR headers and cookies use {name, value} rather than the name as a key.
    header_name = value.get("name")
    source = dict(value)
    if isinstance(header_name, str) and _sensitive(header_name) and "value" in source:
        source["value"] = _REDACTED

    cleaned: dict[str, Any] = {}
    for key, item in source.items():
        if _sensitive(key):
            cleaned[key] = _REDACTED
            continue
        if key == "cookies" and isinstance(item, list):
            cleaned[key] = [
                {**cookie, "value": _REDACTED} if isinstance(cookie, dict) and "value" in cookie else _scrub(cookie)
                for cookie in item
            ]
            continue
        if key == "text" and isinstance(item, str):
            try:
                parsed = json.loads(item)
            except (json.JSONDecodeError, TypeError):
                cleaned[key] = _BODY_SECRET.sub(r"\1[REDACTED]", item)
            else:
                cleaned[key] = json.dumps(_scrub(parsed), ensure_ascii=False, separators=(",", ":"))
            continue
        cleaned[key] = _scrub(item)
    return cleaned


def sanitize_har(path: Path) -> None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot sanitize HAR {path}: {type(error).__name__}") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("log"), dict):
        raise RuntimeError(f"cannot sanitize HAR {path}: missing HAR log object")

    cleaned = _scrub(payload)
    cleaned["log"]["_gvcsim_credentials_redacted"] = True
    mode = path.stat().st_mode & 0o777
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(cleaned, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Redact credentials from a browser HAR in place")
    parser.add_argument("har", type=Path)
    args = parser.parse_args()
    sanitize_har(args.har)


if __name__ == "__main__":
    main()
