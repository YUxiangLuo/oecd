"""Real clock expiry and browser draft recovery using owned short-TTL services."""

import http.client
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.error import URLError

import psycopg

from dogfood_process_faults import free_port
from dogfood_sync import Browser, request


def main():
    output = Path(os.environ["GVCSIM_E2E_ARTIFACT_DIR"]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    api_port, ui_port = free_port(), free_port()
    api_url, base = f"http://127.0.0.1:{api_port}", f"http://127.0.0.1:{ui_port}"
    env = {**os.environ, "GVCSIM_TOKEN_TTL_SECONDS": "10", "GVCSIM_API_PROXY": api_url}
    frontend = Path(__file__).resolve().parents[1] / "frontend"
    processes = []
    results = []
    with (output / "services.log").open("w") as log:
        try:
            processes.append(
                subprocess.Popen(
                    [sys.executable, "-m", "gvcsim.cli", "serve", "--port", str(api_port)],
                    env=env,
                    stdout=log,
                    stderr=log,
                )
            )
            processes.append(
                subprocess.Popen(
                    [
                        "bun",
                        "./node_modules/vite/bin/vite.js",
                        "preview",
                        "--host",
                        "127.0.0.1",
                        "--port",
                        str(ui_port),
                        "--strictPort",
                    ],
                    cwd=frontend,
                    env=env,
                    stdout=log,
                    stderr=log,
                )
            )
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                try:
                    if request(api_url, "GET", "/health")[0] == 200:
                        break
                except (URLError, OSError, http.client.HTTPException):
                    pass
                time.sleep(0.05)
            password = os.environ["GVCSIM_E2E_PASSWORD"]
            for attempt in (1, 2):
                teacher = request(
                    api_url,
                    "POST",
                    "/api/auth/login",
                    {
                        "username": os.environ["GVCSIM_E2E_TEACHER_USERNAME"],
                        "password": os.environ["GVCSIM_E2E_TEACHER_PASSWORD"],
                    },
                )[1]["token"]
                name = "real-expiry-" + uuid.uuid4().hex[:8]
                _, account = request(
                    api_url,
                    "POST",
                    "/api/classroom/students",
                    {"username": name, "display_name": name, "password": password},
                    teacher,
                )
                browser = Browser(name)
                try:
                    browser.login(base, name, password)
                    expiry = json.loads(
                        browser.run(
                            "eval",
                            """(() => {
                              const token = sessionStorage.getItem('gvcsim_token');
                              if (!token) return null;
                              const encoded = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
                              const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
                              return {exp: payload.exp, now: Date.now() / 1000};
                            })()""",
                        )
                    )
                    assert expiry is not None
                    assert isinstance(expiry["exp"], (int, float))
                    assert expiry["exp"] > expiry["now"] and expiry["exp"] < expiry["now"] + 30
                    browser.run("wait", "--fn", f"Date.now()/1000 > {expiry['exp']}")
                    note = "令牌自然到期后的未保存研究问题，重新登录后应该恢复。"
                    browser.run("fill", "textarea", note)
                    browser.run("wait", "#login-user")
                    browser.run("screenshot", str(output / f"expired-{attempt}.png"))
                    browser.run("fill", "#login-user", name)
                    browser.run("fill", "#login-pass", password)
                    browser.run("click", 'button[type="submit"]')
                    # Dismiss the per-login intro before the accessibility-based button click.
                    browser.dismiss_intro()
                    browser.run("wait", "--text", "恢复未保存内容")
                    browser.button("恢复未保存内容")
                    browser.run("wait", "--load", "networkidle")
                    with psycopg.connect(os.environ["GVCSIM_PG_DSN"]) as connection:
                        session = connection.execute(
                            "SELECT session FROM experiment_sessions WHERE account_id=%s", (account["id"],)
                        ).fetchone()[0]
                    assert session["steps"]["15"]["data"]["research_question"] == note and browser.value() == note
                    browser.run("screenshot", str(output / f"restored-{attempt}.png"))
                    results.append(
                        {"case": "AUTH-01-natural-expiry", "attempt": attempt, "ttl_seconds": 10, "passed": True}
                    )
                    print(json.dumps(results[-1]), flush=True)
                finally:
                    browser.run("close")
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=15)
            (output / "results.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
