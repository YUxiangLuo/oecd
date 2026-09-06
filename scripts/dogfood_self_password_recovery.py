"""Keep an unsaved student draft across their own successful password change."""

import json
import os
import uuid
from pathlib import Path

import psycopg

from dogfood_sync import Browser, request


def main():
    base = os.environ["GVCSIM_BASE_URL"].rstrip("/")
    out = Path(os.environ["GVCSIM_E2E_ARTIFACT_DIR"]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    teacher = request(
        base,
        "POST",
        "/api/auth/login",
        {"username": os.environ["GVCSIM_E2E_TEACHER_USERNAME"], "password": os.environ["GVCSIM_E2E_TEACHER_PASSWORD"]},
    )[1]["token"]
    password = os.environ["GVCSIM_E2E_PASSWORD"]
    results = []
    for attempt in (1, 2):
        name = "self-recover-" + uuid.uuid4().hex[:8]
        assert (
            request(
                base,
                "POST",
                "/api/classroom/students",
                {"username": name, "display_name": name, "password": password},
                teacher,
            )[0]
            == 200
        )
        browser = Browser(name)
        text = f"本人改密前尚未保存的研究问题，应在重新登录后恢复 {attempt}。"
        try:
            browser.login(base, name, password)
            browser.run("network", "route", "**/api/classroom/session", "--abort")
            browser.run("fill", "textarea", text)
            browser.run("wait", "--text", "重试保存")
            browser.button("修改密码")
            browser.run("fill", "#account-current-password", password)
            browser.run("fill", "#account-new-password", password + "-new")
            browser.run("fill", "#account-confirm-password", password + "-new")
            browser.button("修改并重新登录")
            browser.run("wait", "#login-user")
            browser.run("network", "unroute")
            browser.run("fill", "#login-user", name)
            browser.run("fill", "#login-pass", password + "-new")
            browser.run("click", 'button[type="submit"]')
            browser.run("wait", "textarea")
            offered = json.loads(
                browser.run(
                    "eval", 'Array.from(document.querySelectorAll("button")).some(e=>e.textContent==="恢复未保存内容")'
                )
            )
            if offered:
                browser.button("恢复未保存内容")
                browser.run("wait", "--load", "networkidle")
            with psycopg.connect(os.environ["GVCSIM_PG_DSN"]) as connection:
                row = connection.execute(
                    "SELECT session FROM experiment_sessions s JOIN accounts a ON a.id=s.account_id WHERE username=%s",
                    (name,),
                ).fetchone()
            recovered = bool(row and row[0]["steps"]["15"]["data"]["research_question"] == text)
            results.append(
                {
                    "case": "AUTH-01-self-password-unsaved",
                    "attempt": attempt,
                    "offered": offered,
                    "recovered": recovered,
                }
            )
            print(json.dumps(results[-1]), flush=True)
            browser.run("screenshot", str(out / f"self-password-{attempt}.png"))
        finally:
            browser.run("close")
            (out / "results.json").write_text(json.dumps(results, indent=2))
    assert all(result["offered"] and result["recovered"] for result in results)


if __name__ == "__main__":
    main()
