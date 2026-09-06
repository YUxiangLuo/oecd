"""Exercise committed-response loss and in-flight edits through agent-browser.

Requires a dedicated classroom and scripts/dogfood_fault_proxy.py. Creates fresh
ordinary students via the public teacher API. Passwords come only from environment.
"""

import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import psycopg


def request(base, method, path, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None if body is None else json.dumps(body).encode()
    try:
        with urlopen(Request(base + path, data=data, headers=headers, method=method), timeout=50) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.load(error)


class Browser:
    def __init__(self, name):
        self.prefix = [
            "agent-browser",
            "--namespace",
            os.environ.get("GVCSIM_E2E_NAMESPACE", "gvcsim-p0"),
            "--session",
            name,
        ]

    def run(self, *args):
        if args[0] == "click":
            # The application scrolls nested panes under a fixed footer. A point
            # inside the viewport may still be clipped by that pane.
            self.run("eval", f'document.querySelector({json.dumps(args[1])})?.scrollIntoView({{block:"center"}})')
        result = subprocess.run([*self.prefix, *args], capture_output=True, text=True, timeout=55)
        if result.returncode:
            raise RuntimeError(f"browser {args[0]} failed: {result.stdout} {result.stderr}")
        return result.stdout.strip()

    def login(self, base, username, password):
        self.run("open", base + "/?step=15")
        self.run("set", "viewport", "1440", "1000")
        self.run("fill", "#login-user", username)
        self.run("fill", "#login-pass", password)
        self.run("click", 'button[type="submit"]')
        self.run("wait", 'button[aria-label="跳过介绍"]')
        self.run("click", 'button[aria-label="跳过介绍"]')
        self.run("wait", "textarea")

    def value(self):
        return json.loads(self.run("eval", 'document.querySelector("textarea").value'))

    def button(self, name):
        self.run(
            "eval",
            'Array.from(document.querySelectorAll("button")).find(e=>'
            f'(e.getAttribute("aria-label")??e.textContent.trim())==={json.dumps(name)})?.scrollIntoView({{block:"center"}})',
        )
        self.run("find", "role", "button", "click", "--name", name, "--exact")


def main():
    base = os.environ["GVCSIM_BASE_URL"].rstrip("/")
    proxy = os.environ["GVCSIM_FAULT_PROXY"].rstrip("/")
    password = os.environ["GVCSIM_E2E_PASSWORD"]
    _, login = request(
        base,
        "POST",
        "/api/auth/login",
        {
            "username": os.environ["GVCSIM_E2E_TEACHER_USERNAME"],
            "password": os.environ["GVCSIM_E2E_TEACHER_PASSWORD"],
        },
    )
    teacher = login["token"]
    output = Path(os.environ["GVCSIM_E2E_ARTIFACT_DIR"]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    results = []
    for attempt in (1, 2):
        for action in ("drop", "pass"):
            name = f"sync-{action}-{uuid.uuid4().hex[:8]}"
            status, _ = request(
                base,
                "POST",
                "/api/classroom/students",
                {
                    "username": name,
                    "display_name": name,
                    "password": password,
                },
                teacher,
            )
            assert status == 200
            browser = Browser(name)
            first = f"已到达服务器的第一份研究问题 {attempt} {action}"
            newer = f"响应尚未到达时继续编辑的第二份研究问题 {attempt} {action}"

            def database_value():
                with psycopg.connect(os.environ["GVCSIM_PG_DSN"]) as connection:
                    row = connection.execute(
                        "SELECT session FROM experiment_sessions s JOIN accounts a ON a.id=s.account_id WHERE username=%s",
                        (name,),
                    ).fetchone()
                return row[0]["steps"]["15"]["data"]["research_question"] if row else None

            try:
                browser.login(base, name, password)
                assert request(proxy, "POST", "/__fault/arm", {"phase": "after", "action": action})[0] == 200
                browser.run("fill", "textarea", first)
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    state = request(proxy, "GET", "/__fault/status")[1]
                    if state["phase"] == "after":
                        break
                    time.sleep(0.02)
                assert state == {"phase": "after", "upstream_status": 200}, state
                assert database_value() == first
                browser.run(
                    "eval",
                    """(() => {
                  window.__p0DebounceFired = false;
                  window.__p0Schedule = window.setTimeout;
                  window.setTimeout = function(callback, delay, ...args) {
                    if (delay === 800 && typeof callback === "function") {
                      return window.__p0Schedule(() => { window.__p0DebounceFired = true; callback(...args); }, delay);
                    }
                    return window.__p0Schedule(callback, delay, ...args);
                  };
                })()""",
                )
                browser.run("fill", "textarea", newer)
                # Observe the newer edit's actual debounce callback while the
                # original request is held; do not race a second scheduled drain.
                browser.run("wait", "--fn", "window.__p0DebounceFired === true")
                browser.run("eval", "window.setTimeout = window.__p0Schedule; true")
                assert browser.value() == newer
                assert database_value() == first
                request(proxy, "POST", "/__fault/release", {})
                if action == "drop":
                    browser.run("wait", "--text", "重试保存")
                    assert browser.value() == newer
                    browser.button("重试保存")
                    browser.run("wait", "--text", "载入服务器版本")
                    assert browser.value() == newer and database_value() == first
                    browser.run("screenshot", str(output / f"{action}-{attempt}-conflict.png"))
                    browser.button("载入服务器版本")
                    browser.run("wait", "--fn", f'document.querySelector("textarea").value === {json.dumps(first)}')
                    # The explicit reload deliberately picks the server version; no silent overwrite.
                    assert database_value() == first
                else:
                    browser.run("wait", "--fn", '!document.body.innerText.includes("正在保存")')
                    deadline = time.monotonic() + 15
                    while database_value() != newer and time.monotonic() < deadline:
                        time.sleep(0.02)
                    assert database_value() == newer and browser.value() == newer
                    browser.run("reload")
                    browser.run("wait", "--fn", f'document.querySelector("textarea")?.value === {json.dumps(newer)}')
                    browser.run("screenshot", str(output / f"{action}-{attempt}-saved.png"))
                results.append(
                    {"case": "SYNC-01" if action == "drop" else "SYNC-02", "attempt": attempt, "passed": True}
                )
                print(json.dumps(results[-1]), flush=True)
            except Exception:
                browser.run("screenshot", str(output / f"{action}-{attempt}-failure.png"))
                (output / f"{action}-{attempt}-failure.json").write_text(
                    browser.run(
                        "eval",
                        '({buttons:Array.from(document.querySelectorAll("button")).map(e=>e.textContent),text:document.body.innerText.slice(0,2200)})',
                    )
                )
                raise
            finally:
                request(proxy, "POST", "/__fault/release", {})
                browser.run("close")
    (output / "sync-results.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
