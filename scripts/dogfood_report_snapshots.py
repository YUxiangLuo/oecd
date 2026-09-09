"""Verify report snapshots while settings, latest estimates and reflections change."""

import json
import os
import time
import uuid
from pathlib import Path

import psycopg

from dogfood_sync import Browser, request
from seed_full_journey import seed_full_journey


def main():
    base = os.environ["GVCSIM_BASE_URL"].rstrip("/")
    output = Path(os.environ["GVCSIM_E2E_ARTIFACT_DIR"]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    password = os.environ["GVCSIM_E2E_PASSWORD"]
    teacher = request(
        base,
        "POST",
        "/api/auth/login",
        {"username": os.environ["GVCSIM_E2E_TEACHER_USERNAME"], "password": os.environ["GVCSIM_E2E_TEACHER_PASSWORD"]},
    )[1]["token"]
    results = []
    for attempt in (1, 2):
        name = "report-snapshot-" + uuid.uuid4().hex[:8]
        _, account = request(
            base,
            "POST",
            "/api/classroom/students",
            {"username": name, "display_name": name, "password": password},
            teacher,
        )
        seed_full_journey(base, name, password)
        token = request(base, "POST", "/api/auth/login", {"username": name, "password": password})[1]["token"]
        assert request(base, "POST", "/api/classroom/report/generate", {}, token)[0] == 200
        _, submitted = request(base, "POST", "/api/classroom/report/submit", {}, token)
        assert (
            request(
                base,
                "POST",
                f"/api/classroom/reports/{account['id']}/grade",
                {"score": 50, "expected_updated_at": submitted["report"]["updated_at"]},
                teacher,
            )[0]
            == 200
        )

        def snapshot():
            with psycopg.connect(os.environ["GVCSIM_PG_DSN"]) as connection:
                session = connection.execute(
                    "SELECT session FROM experiment_sessions WHERE account_id=%s", (account["id"],)
                ).fetchone()[0]
                report = connection.execute(
                    "SELECT markdown,state,score,provenance FROM reports WHERE account_id=%s", (account["id"],)
                ).fetchone()
            return session, report

        def wait_for(predicate):
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                state = snapshot()
                if predicate(*state):
                    return state
                time.sleep(0.02)
            raise AssertionError("expected snapshot was not persisted")

        original_session, original_report = snapshot()
        original_data = original_session["steps"]["11"]["data"]
        qualified = original_data.get("qualified_run")
        if qualified is None:
            assert original_data["run"]["result"]["support"]["suppress_inference"] is True
        browser = Browser(name)
        try:
            browser.login(base, name, password)
            browser.run("open", base + "/?step=11")
            browser.run("wait", "--text", "重新运行当前设定")
            browser.button("出口管制")
            browser.run("wait", "--text", "运行修改后的设定")
            if qualified is not None:
                browser.run("click", ".qualified-run-summary")
                assert "关税" in json.loads(
                    browser.run("eval", 'document.querySelector(".qualified-run-settings").innerText')
                )
            current, report = snapshot()
            assert current["steps"]["11"]["data"]["run"] == original_data["run"]
            assert current["steps"]["11"]["data"].get("qualified_run") == qualified and report == original_report
            browser.run("screenshot", str(output / f"settings-only-{attempt}.png"))
            browser.button("运行修改后的设定")
            current, report = wait_for(
                lambda s, r: s["steps"]["11"]["data"]["run"]["design"]["shock_type"] == "export_control"
            )
            latest = current["steps"]["11"]["data"]
            assert latest["run"]["result"]["support"]["suppress_inference"] is True
            assert latest.get("qualified_run") == qualified and report == original_report
            browser.run("screenshot", str(output / f"insufficient-followup-{attempt}.png"))
            browser.run("open", base + "/?step=15")
            browser.run("wait", "textarea")
            marker = f"新研究问题 {name}：比较四种指标的关税估计，同时明确出口管制的支持度不足。"
            browser.run("fill", "textarea", marker)
            _, report = wait_for(lambda s, r: s["steps"]["15"]["data"]["research_question"] == marker)
            assert report == original_report and marker not in report[0]
            browser.run(
                "wait",
                "--fn",
                'Array.from(document.querySelectorAll("button")).some(e=>e.textContent==="重新生成并提交")',
            )
            browser.button("重新生成并提交")
            _, report = wait_for(lambda s, r: r[1] == "pending" and marker in r[0])
            assert report[2] is None
            step_runs = [run for run in report[3]["runs"] if run["step"] == 11]
            latest_report_run = next(run for run in step_runs if run["design"]["shock_type"] == "export_control")
            assert latest_report_run["result"]["support"]["suppress_inference"] is True
            assert latest_report_run["design"] == latest["run"]["design"]
            assert latest_report_run["result"] == latest["run"]["result"]
            comparison = next(line for line in report[0].splitlines() if line.startswith("| 11 |"))
            # The latest complete diagnosis belongs in the comparison table.
            # An older inferential estimate must not hide its design limitations.
            assert "出口管制" in comparison and "关税冲击" not in comparison
            assert "无法" in comparison or "不可" in comparison
            if qualified is not None:
                report_run = next(run for run in step_runs if run["design"]["shock_type"] == "tariff")
                assert report_run["design"] == qualified["design"] and report_run["result"] == qualified["result"]
                assert len(step_runs) == 2
            else:
                # Current economics contracts can stop inference even for the
                # baseline. Such a run is reportable, never a qualified estimate.
                assert len(step_runs) == 1
            browser.run("eval", 'document.querySelector(".submit-card")?.scrollIntoView({block:"center"})')
            browser.run("screenshot", str(output / f"regenerated-{attempt}.png"))
            results.append(
                {
                    "case": "REPORT-03",
                    "attempt": attempt,
                    "passed": True,
                    "kept_qualified_tariff_run": qualified is not None,
                    "diagnostic_only_baseline": qualified is None,
                    "latest_diagnosis_in_comparison": True,
                    "baseline_method": original_data["run"]["design"]["method"],
                    "old_report_immutable_until_regeneration": True,
                    "old_grade_cleared": True,
                }
            )
            print(json.dumps(results[-1]), flush=True)
        except Exception:
            browser.run("screenshot", str(output / "failure.png"))
            (output / "failure.json").write_text(browser.run("eval", "document.body.innerText.slice(-5000)"))
            raise
        finally:
            browser.run("close")
            (output / "results.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
