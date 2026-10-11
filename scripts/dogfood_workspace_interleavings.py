"""Three real tabs: conflict recovery, password revocation, account switch, draft restore."""

import json
import os
import time
import uuid
from pathlib import Path

import psycopg

from dogfood_sync import Browser, request


def main():
    base, proxy = os.environ["GVCSIM_BASE_URL"].rstrip("/"), os.environ["GVCSIM_FAULT_PROXY"].rstrip("/")
    output = Path(os.environ["GVCSIM_E2E_ARTIFACT_DIR"]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    password = os.environ["GVCSIM_E2E_PASSWORD"]
    teacher = request(
        base,
        "POST",
        "/api/auth/login",
        {
            "username": os.environ["GVCSIM_E2E_TEACHER_USERNAME"],
            "password": os.environ["GVCSIM_E2E_TEACHER_PASSWORD"],
        },
    )[1]["token"]
    results = []

    def stored(username):
        with psycopg.connect(os.environ["GVCSIM_PG_DSN"]) as connection:
            row = connection.execute(
                "SELECT session FROM experiment_sessions s JOIN accounts a ON a.id=s.account_id WHERE username=%s",
                (username,),
            ).fetchone()
        # An account may have saved other steps (step 1 records a cell on its first visit) before step 15.
        return row[0].get("steps", {}).get("15", {}).get("data", {}).get("research_question") if row else None

    def wait_stored(username, value):
        deadline = time.monotonic() + 15
        while stored(username) != value and time.monotonic() < deadline:
            time.sleep(0.02)
        assert stored(username) == value

    for attempt in (1, 2):
        first, second = "tabs-" + uuid.uuid4().hex[:8], "other-" + uuid.uuid4().hex[:8]
        accounts = []
        for name in (first, second):
            code, account = request(
                base,
                "POST",
                "/api/classroom/students",
                {"username": name, "display_name": name, "password": password},
                teacher,
            )
            assert code == 200
            accounts.append(account)
        browser = Browser(first)
        try:
            browser.login(base, first, password)
            browser.run("fill", "textarea", "initial")
            wait_stored(first, "initial")
            for _ in range(2):
                browser.run("tab", "new", base + "/?step=15")
                # Authentication is held in sessionStorage, which is isolated
                # per tab. Log each tab in explicitly instead of relying on the
                # old localStorage-based cross-tab authentication contract.
                browser.run("wait", "#login-user")
                browser.run("fill", "#login-user", first)
                browser.run("fill", "#login-pass", password)
                browser.run("click", 'button[type="submit"]')
                browser.dismiss_intro()
                browser.run("wait", "textarea")
            browser.run("tab", "t1")
            browser.run("fill", "textarea", "first committed")
            wait_stored(first, "first committed")
            for tab in ("t2", "t3"):
                browser.run("tab", tab)
                browser.run("fill", "textarea", "stale " + tab)
                browser.run("wait", "--text", "载入服务器版本")
                assert browser.value() == "stale " + tab
            browser.run("tab", "t2")
            browser.button("载入服务器版本")
            browser.run("wait", "--fn", 'document.querySelector("textarea").value==="first committed"')
            browser.run("fill", "textarea", "second committed")
            wait_stored(first, "second committed")
            browser.run("tab", "t3")
            browser.button("载入服务器版本")
            browser.run("wait", "--fn", 'document.querySelector("textarea").value==="second committed"')
            browser.run("fill", "textarea", "third committed")
            wait_stored(first, "third committed")
            browser.run("tab", "t1")
            browser.run("fill", "textarea", "first stale again")
            browser.run("wait", "--text", "载入服务器版本")
            browser.button("载入服务器版本")
            browser.run("wait", "--fn", 'document.querySelector("textarea").value==="third committed"')
            results.append({"case": "SYNC-03-three-tabs", "attempt": attempt, "passed": True})
            print(json.dumps(results[-1]), flush=True)
            request(proxy, "POST", "/__fault/arm", {"phase": "before", "action": "pass"})
            browser.run("fill", "textarea", "pending old account")
            deadline = time.monotonic() + 10
            while request(proxy, "GET", "/__fault/status")[1]["phase"] != "before" and time.monotonic() < deadline:
                time.sleep(0.02)
            assert request(proxy, "GET", "/__fault/status")[1]["phase"] == "before"
            changed_password = password + "-new"
            assert (
                request(
                    base,
                    "POST",
                    f"/api/classroom/students/{accounts[0]['id']}",
                    {"password": changed_password},
                    teacher,
                )[0]
                == 200
            )
            browser.run("tab", "t2")
            # Coming back to t2 re-checks its session: the reset password may already have signed it out, or it
            # still shows the workspace until its next request. Log out if it is still in (one page evaluation, so
            # the button cannot vanish between finding and clicking it); either way it then signs in as the other
            # account.
            browser.run(
                "eval",
                'Array.from(document.querySelectorAll("button")).find(e=>e.textContent.trim()==="退出登录")?.click()',
            )
            browser.run("wait", "#login-user")
            # Another account signing in where the first one left does not inherit its step: it opens step 1, so
            # go to step 15 explicitly.
            browser.run("fill", "#login-user", second)
            browser.run("fill", "#login-pass", password)
            browser.run("click", 'button[type="submit"]')
            browser.dismiss_intro()
            browser.run("open", base + "/?step=15")
            browser.run("wait", "textarea")
            request(proxy, "POST", "/__fault/release", {})
            deadline = time.monotonic() + 10
            while request(proxy, "GET", "/__fault/status")[1]["phase"] != "done" and time.monotonic() < deadline:
                time.sleep(0.02)
            assert stored(first) == "third committed"
            # Logging into a different account in t2 must not change t1. Its
            # revoked request should independently expire t1's session and
            # retain the unsaved account-scoped draft for recovery.
            browser.run("tab", "t1")
            browser.run("wait", "#login-user")
            browser.run("tab", "t2")
            browser.run("wait", "textarea")
            assert browser.value() == ""
            browser.run("fill", "textarea", "new account evidence")
            wait_stored(second, "new account evidence")
            assert stored(first) == "third committed"
            browser.run("screenshot", str(output / f"account-switch-{attempt}.png"))
            browser.run("tab", "t1")
            browser.run("fill", "#login-user", first)
            browser.run("fill", "#login-pass", changed_password)
            browser.run("click", 'button[type="submit"]')
            browser.run("wait", "textarea")
            # Dismiss the per-login intro before any accessibility-tree lookup.
            browser.dismiss_intro()
            # Kept edits are put back and saved automatically after login.
            wait_stored(first, "pending old account")
            assert stored(second) == "new account evidence"
            browser.run("screenshot", str(output / f"account-restored-{attempt}.png"))
            results.append({"case": "AUTH-01-revoked-request-and-account-switch", "attempt": attempt, "passed": True})
            print(json.dumps(results[-1]), flush=True)
        except Exception:
            browser.run("screenshot", str(output / "failure.png"))
            (output / "failure.json").write_text(browser.run("eval", "document.body.innerText.slice(0,2200)"))
            raise
        finally:
            request(proxy, "POST", "/__fault/release", {})
            browser.run("close")
            (output / "results.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
