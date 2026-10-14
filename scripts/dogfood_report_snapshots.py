"""Verify fixed-TWFE report snapshots while display context and reflections change."""

import json
import os
import time
import uuid
from pathlib import Path

import psycopg

from dogfood_sync import Browser, request
from seed_full_journey import seed_full_journey

from gvcsim.classroom.records import _VIEW_ONLY_KEYS


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
        original_run = original_data["run"]
        assert original_run["design"]["method"] == "twfe_intensity"
        assert original_run["design"]["shock_type"] == "tariff"
        browser = Browser(name)
        try:
            browser.login(base, name, password)
            browser.run("open", base + "/?step=11")
            browser.run("wait", "--text", "重新计算")
            # Loading the display-only two-country chart must not rewrite the
            # estimate that the report already snapshots.
            current, report = snapshot()
            assert current["steps"]["11"]["data"]["run"] == original_run and report == original_report

            browser.run("open", base + "/?step=10")
            browser.run("wait", ".controls select")
            changed = json.loads(
                browser.run(
                    "eval",
                    """(() => {
                      const selects = [...document.querySelectorAll('.controls select')];
                      const before = selects.map(e => e.value);
                      for (const select of [selects[0], selects[2]]) {
                        const option = [...select.options].find(e => e.value !== select.value);
                        if (!option) throw new Error('no alternate display option');
                        select.value = option.value;
                        select.dispatchEvent(new Event('change', {bubbles: true}));
                      }
                      return {before, after: selects.map(e => e.value)};
                    })()""",
                )
            )
            assert changed["before"][0] != changed["after"][0]
            assert changed["before"][2] != changed["after"][2]
            # A submitted report pauses automatic recording: the new example is shown (the view-only
            # browse_selection may follow it) but not recorded, so neither step 10's material, step 11's estimate
            # nor the report changes (past the autosave delay).
            browser.run("wait", "--text", "报告已提交")
            time.sleep(2)
            current, report = snapshot()

            def material(data):
                return {key: value for key, value in data.items() if key not in _VIEW_ONLY_KEYS}

            assert material(current["steps"]["10"]["data"]) == material(original_session["steps"]["10"]["data"])
            assert current["steps"]["11"]["data"]["run"] == original_run and report == original_report
            browser.run("screenshot", str(output / f"display-only-{attempt}.png"))

            browser.run("open", base + "/?step=11")
            browser.run("wait", "--text", "重新计算")
            browser.run(
                "eval",
                """(() => {
                  window.__reportRerunComplete = false;
                  const originalFetch = window.fetch;
                  window.fetch = async (...args) => {
                    const response = await originalFetch(...args);
                    if (String(args[0]).includes('/api/regression/run')) window.__reportRerunComplete = true;
                    return response;
                  };
                })()""",
            )
            # The default model's button reads "重新计算贸易流回归"; the workbench below has its own.
            browser.run(
                "eval",
                'Array.from(document.querySelectorAll(".reg-run-card .run-btn")).find(e=>e.textContent.startsWith("重新计算"))'
                ".click()",
            )
            browser.run("wait", "--fn", "window.__reportRerunComplete === true")
            current, report = wait_for(
                lambda s, r: s["steps"]["11"]["data"]["run"]["design"]["method"] == "twfe_intensity"
            )
            rerun = current["steps"]["11"]["data"]["run"]
            assert rerun["design"] == original_run["design"]
            assert rerun["result"] == original_run["result"]
            assert report == original_report
            browser.run("screenshot", str(output / f"fixed-twfe-rerun-{attempt}.png"))

            browser.run("open", base + "/?step=15")
            browser.run("wait", "textarea")
            marker = f"新研究问题 {name}：比较四种指标的固定双向效应关税估计，并说明教学模拟边界。"
            browser.run("fill", "textarea", marker)
            _, report = wait_for(lambda s, r: s["steps"]["15"]["data"]["research_question"] == marker)
            assert report == original_report and marker not in report[0]
            browser.run(
                "wait",
                "--fn",
                'Array.from(document.querySelectorAll("button")).some(e=>e.textContent==="更新报告并提交给老师")',
            )
            # The edited analysis makes the graded report outdated: updating it asks first (an in-page dialog),
            # and cancelling keeps the report and its grade.
            browser.button("更新报告并提交给老师")
            browser.run("wait", "--text", "清除现有评分和评语")
            browser.button("取消")
            assert snapshot()[1] == original_report
            browser.button("更新报告并提交给老师")
            browser.run("wait", "--text", "清除现有评分和评语")
            browser.button("确定重新生成")
            _, report = wait_for(lambda s, r: r[1] == "pending" and marker in r[0])
            assert report[2] is None
            step_runs = [run for run in report[3]["runs"] if run["step"] == 11]
            assert len(step_runs) == 1
            latest_report_run = step_runs[0]
            assert latest_report_run["design"] == rerun["design"]
            assert latest_report_run["result"] == rerun["result"]
            comparison = next(line for line in report[0].splitlines() if line.startswith("| 11 |"))
            assert "外国增加值项占比" in comparison
            assert "| 模型 | 双向固定效应（TWFE） · 国家×行业 · 控制：汇率变动 |" in report[0]
            browser.run("eval", 'document.querySelector(".submit-card")?.scrollIntoView({block:"center"})')
            browser.run("screenshot", str(output / f"regenerated-{attempt}.png"))
            results.append(
                {
                    "case": "REPORT-03",
                    "attempt": attempt,
                    "passed": True,
                    "display_context_did_not_rewrite_run": True,
                    "fixed_twfe_rerun_preserved_contract": True,
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
