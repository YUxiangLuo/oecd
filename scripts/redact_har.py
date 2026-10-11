"""Strip credentials from a HAR before it is kept as browser evidence.

The smoke scripts record HAR files of login and password flows. Passwords (request bodies), bearer tokens
(Authorization headers, login responses) and cookies are replaced with "[redacted]"; everything else stays,
so the file still shows which requests ran and how they answered. Rewrites the file in place.
"""

import argparse
import base64
import json
from pathlib import Path
from typing import Any

REDACTED = "[redacted]"
SECRET_HEADERS = {"authorization", "proxy-authorization", "cookie", "set-cookie"}


def _secret_key(key: str) -> bool:
    key = key.lower()
    return "password" in key or "token" in key or key in {"secret", "authorization"}


def _scrub(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: REDACTED if _secret_key(str(key)) else _scrub(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    return value


def _scrub_text(text: str, *, request: bool) -> str:
    try:
        return json.dumps(_scrub(json.loads(text)), ensure_ascii=False)
    except ValueError:
        # A non-JSON request body (form, plain text) is kept only if it names no secret; non-JSON responses
        # (pages, scripts, styles) carry no credentials and stay as they are.
        lowered = text.lower()
        return REDACTED if request and ("password" in lowered or "token" in lowered) else text


def _scrub_headers(headers: list[dict[str, Any]]) -> None:
    for header in headers:
        if str(header.get("name", "")).lower() in SECRET_HEADERS:
            header["value"] = REDACTED


def redact(har: dict[str, Any]) -> dict[str, Any]:
    for entry in har.get("log", {}).get("entries", []):
        request, response = entry.get("request", {}), entry.get("response", {})
        _scrub_headers(request.get("headers", []))
        _scrub_headers(response.get("headers", []))
        for item in request.get("queryString", []):
            if _secret_key(str(item.get("name", ""))):
                item["value"] = REDACTED
        post = request.get("postData")
        if isinstance(post, dict):
            if isinstance(post.get("text"), str):
                post["text"] = _scrub_text(post["text"], request=True)
            for item in post.get("params", []):
                if _secret_key(str(item.get("name", ""))):
                    item["value"] = REDACTED
        content = response.get("content")
        if isinstance(content, dict) and isinstance(content.get("text"), str):
            if content.get("encoding") == "base64":
                try:
                    decoded = base64.b64decode(content["text"]).decode("utf-8")
                except ValueError:
                    pass  # binary (an image, a font): no credentials to strip
                else:
                    content["text"] = _scrub_text(decoded, request=False)
                    content.pop("encoding")
            else:
                content["text"] = _scrub_text(content["text"], request=False)
    return har


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("har", type=Path)
    args = parser.parse_args()
    har = json.loads(args.har.read_text(encoding="utf-8"))
    args.har.write_text(json.dumps(redact(har), ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
