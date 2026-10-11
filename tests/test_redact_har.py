"""Browser evidence must not keep the credentials of the flows it records."""

import base64
import json

from scripts.redact_har import REDACTED, redact


def _entry(method, url, *, body=None, response=None, headers=(), response_headers=(), encoding=None):
    content = {"mimeType": "application/json", "text": response or ""}
    if encoding:
        content["encoding"] = encoding
    entry = {
        "request": {"method": method, "url": url, "headers": list(headers), "queryString": []},
        "response": {"status": 200, "headers": list(response_headers), "content": content},
    }
    if body is not None:
        entry["request"]["postData"] = {"mimeType": "application/json", "text": body}
    return entry


def test_passwords_tokens_and_auth_headers_are_redacted():
    login = _entry(
        "POST",
        "http://127.0.0.1/api/auth/login",
        body=json.dumps({"username": "teacher", "password": "old-secret-1234"}),
        response=json.dumps({"token": "bearer-abc", "user": {"username": "teacher", "role": "teacher"}}),
        response_headers=[{"name": "Set-Cookie", "value": "sid=1"}],
    )
    change = _entry(
        "POST",
        "http://127.0.0.1/api/account/password",
        body=json.dumps({"current_password": "old-secret-1234", "new_password": "new-secret-5678"}),
        headers=[{"name": "Authorization", "value": "Bearer bearer-abc"}, {"name": "Accept", "value": "*/*"}],
    )
    encoded = _entry(
        "POST",
        "http://127.0.0.1/api/auth/login",
        response=base64.b64encode(json.dumps({"token": "bearer-def"}).encode()).decode(),
        encoding="base64",
    )
    page = _entry("GET", "http://127.0.0.1/assets/index.js", response='sessionStorage.getItem("gvcsim_token")')
    form = _entry("POST", "http://127.0.0.1/login", body="username=a&password=plain-secret")
    har = redact({"log": {"entries": [login, change, encoded, page, form]}})
    text = json.dumps(har, ensure_ascii=False)
    for secret in ("old-secret-1234", "new-secret-5678", "bearer-abc", "bearer-def", "sid=1", "plain-secret"):
        assert secret not in text, secret
    entries = har["log"]["entries"]
    # What the evidence is for stays: the requests, their users and statuses, harmless headers and assets.
    assert json.loads(entries[0]["request"]["postData"]["text"]) == {"username": "teacher", "password": REDACTED}
    assert json.loads(entries[0]["response"]["content"]["text"])["user"]["role"] == "teacher"
    assert {"name": "Accept", "value": "*/*"} in entries[1]["request"]["headers"]
    assert "encoding" not in entries[2]["response"]["content"]
    assert entries[3]["response"]["content"]["text"] == 'sessionStorage.getItem("gvcsim_token")'
    assert entries[4]["request"]["postData"]["text"] == REDACTED
