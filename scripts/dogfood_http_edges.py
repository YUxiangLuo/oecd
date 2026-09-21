"""Probe a deployed classroom through HTTP; use only disposable test accounts.

Requires GVCSIM_BASE_URL and GVCSIM_E2E_{PASSWORD,TEACHER_USERNAME,
TEACHER_PASSWORD,ARTIFACT_DIR}. Records no credentials or bearer tokens.
"""

import argparse
import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dev-server", action="store_true", help="Expect Vite fallback and no nginx body limit")
    args = parser.parse_args()
    base = os.environ["GVCSIM_BASE_URL"].rstrip("/")
    output = Path(os.environ["GVCSIM_E2E_ARTIFACT_DIR"])
    output.mkdir(parents=True, exist_ok=True)
    results = []

    def request(method, path, body=None, token=None, raw=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        data = raw if raw is not None else None if body is None else json.dumps(body).encode()
        start = time.monotonic()
        try:
            response = urlopen(Request(base + path, data=data, headers=headers, method=method), timeout=60)
        except HTTPError as error:
            response = error
        with response:
            content = response.read()
            return response.status, content, dict(response.headers), time.monotonic() - start

    def check(name, expected, method, path, body=None, token=None, raw=None):
        status, content, headers, elapsed = request(method, path, body, token, raw)
        results.append({"case": name, "status": status, "seconds": round(elapsed, 4), "passed": status in expected})
        print(json.dumps(results[-1]), flush=True)
        assert status in expected, (name, status, content[:600])
        return content, headers

    def login(username, password):
        content, _ = check("login", {200}, "POST", "/api/auth/login", {"username": username, "password": password})
        return json.loads(content)["token"]

    try:
        check("health", {200}, "GET", "/health")
        check("anonymous-data", {401}, "GET", "/api/meta")
        check("forged-token", {401}, "GET", "/api/classroom/session", token="invalid.signature")
        check("malformed-json", {422}, "POST", "/api/auth/login", raw=b'{"username":')
        check(
            "buffered-body-reaches-application",
            {422},
            "POST",
            "/api/auth/login",
            {"username": "", "password": "unused", "padding": "x" * 65536},
        )
        for field, value in [
            ("username", ""),
            ("username", "x" * 129),
            ("password", "x" * 257),
            ("password", "\ud800"),
            ("username", "\x00"),
        ]:
            check(
                "login-boundary-" + field,
                {422},
                "POST",
                "/api/auth/login",
                {"username": "unknown", "password": "unused-password", field: value},
            )
        teacher = login(os.environ["GVCSIM_E2E_TEACHER_USERNAME"], os.environ["GVCSIM_E2E_TEACHER_PASSWORD"])
        username = "http-edges-" + uuid.uuid4().hex[:10]
        password = os.environ["GVCSIM_E2E_PASSWORD"]
        account = {"username": username, "display_name": "边界 👩🏽‍💻 <script>test</script>", "password": password}
        check("unicode-account", {200}, "POST", "/api/classroom/students", account, teacher)
        check("duplicate-account", {409}, "POST", "/api/classroom/students", account, teacher)
        student = login(username, password)
        for path in ("/api/classroom/students", "/api/classroom/reports", "/api/classroom/reports/1"):
            check("student-role-boundary", {403}, "GET", path, token=student)
        check("teacher-role-boundary", {403}, "GET", "/api/classroom/session", token=teacher)
        check("empty-report-generate", {409}, "POST", "/api/classroom/report/generate", token=student)
        check("empty-report-submit", {409}, "POST", "/api/classroom/report/submit", token=student)
        for query in ("page=0", "page=-1", "page_size=0", "page_size=201", "page=NaN", "page=1e309"):
            check("pagination-" + query, {422}, "GET", "/api/db/slice?year=2020&" + query, token=student)
        check("unknown-year", {404}, "GET", "/api/db/slice?year=1900", token=student)
        check("unknown-table", {400}, "GET", "/api/db/slice?year=2020&table=unknown", token=student)
        check("unknown-sort", {422}, "GET", "/api/shocks/panel?year=2020&sort=unknown", token=student)
        session = {"version": "experiment-session-simple-v3", "steps": {}, "shared": {}}
        for value in (float("nan"), float("inf"), "\ud800", "\x00"):
            invalid = {**session, "steps": {"15": {"data": {"research_question": value}}}}
            check(
                "invalid-session-value",
                {422},
                "PUT",
                "/api/classroom/session",
                {"session": invalid, "base_updated_at": None},
                student,
            )
        content, _ = check("invalid-input-does-not-save", {200}, "GET", "/api/classroom/session", token=student)
        assert json.loads(content)["updated_at"] is None
        body = {"session": session, "base_updated_at": None}
        with ThreadPoolExecutor(max_workers=8) as pool:
            responses = list(pool.map(lambda _: request("PUT", "/api/classroom/session", body, student), range(8)))
        codes = sorted(response[0] for response in responses)
        assert codes == [200] + [409] * 7, codes
        results.append({"case": "eight-concurrent-first-saves", "statuses": codes, "passed": True})
        with ThreadPoolExecutor(max_workers=16) as pool:
            responses = list(pool.map(lambda _: request("GET", "/api/meta", token=student), range(32)))
        assert all(response[0] == 200 for response in responses)
        results.append({"case": "32-reads-16-concurrent", "max_seconds": max(r[3] for r in responses), "passed": True})
        for attempt in range(11):
            _, headers = check(
                "login-rate-limit",
                {401} if attempt < 10 else {429},
                "POST",
                "/api/auth/login",
                {"username": "rate-" + username, "password": "wrong-password"},
            )
        assert int(next(value for key, value in headers.items() if key.lower() == "retry-after")) > 0
        # Production's nginx rejects this body with 413; the local fault-proxy
        # topology intentionally has no nginx and the application parses it,
        # then rejects the invalid JSON with 422. Both are safe rejection.
        check(
            "oversized-invalid-body",
            {422} if args.dev_server else {413},
            "POST",
            "/api/auth/login",
            raw=b" " * (2 * 1024 * 1024 + 1),
        )
        missing_content, _ = check(
            "missing-static-asset", {200} if args.dev_server else {404}, "GET", "/assets/does-not-exist.js"
        )
        # Vite's development history fallback returns the SPA shell for unknown
        # asset paths, unlike the production static server's 404.
        if results[-1]["status"] == 200:
            assert b"<!doctype html>" in missing_content.lower()
        check("health-after-boundaries", {200}, "GET", "/health")
    finally:
        (output / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
