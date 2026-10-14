"""Complete the course through browser controls, without seeded learning records.

Only account creation, browser input and ordinary UI requests mutate application
state. PostgreSQL is read to independently verify durability after each step.
"""

import json
import os
import time
import uuid
from pathlib import Path

import psycopg

from dogfood_sync import Browser
from gvcsim import quizzes
from gvcsim.regression.spec import DEFAULT_SPEC, EXCHANGE_RATE_COLUMN, X_LAG_COLUMNS
from gvcsim.regression.teaching import VERSION as TEACHING_VERSION
from gvcsim.regression.teaching import X_COLUMN

# The answers are clicked in the page; the server's bank only says which option is right, so a revised question
# bank cannot leave this journey answering the previous one.
QUIZ_ANSWERS = {
    step: {question["id"]: question["correct"] for question in quizzes.STEP_QUIZZES[step]} for step in range(1, 15)
}
# The default model's terms: X, L1.X and the exchange-rate control.
DEFAULT_TERMS = {X_LAG_COLUMNS[lag] for lag in DEFAULT_SPEC.x_lags} | {EXCHANGE_RATE_COLUMN}


def choose(browser, name, value):
    """Pick a quiz option by element, not by screen position: right after step 1's fullscreen table closes the page is
    still settling, and a coordinate click can land on the neighbouring option."""
    selector = f'input[name="{name}"][value="{value}"]'
    browser.run("eval", f"document.querySelector({json.dumps(selector)}).click()")
    browser.run("wait", "--fn", f"document.querySelector({json.dumps(selector)}).checked")


def main():
    base = os.environ["GVCSIM_BASE_URL"].rstrip("/")
    output = Path(os.environ["GVCSIM_E2E_ARTIFACT_DIR"]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    username = "browser-course-" + uuid.uuid4().hex[:8]
    password = os.environ["GVCSIM_E2E_PASSWORD"]
    teacher, student = Browser(username + "-teacher"), Browser(username)
    results = []

    def saved():
        with psycopg.connect(os.environ["GVCSIM_PG_DSN"]) as connection:
            row = connection.execute(
                "SELECT s.session FROM experiment_sessions s JOIN accounts a ON a.id=s.account_id WHERE username=%s",
                (username,),
            ).fetchone()
        return row[0] if row else None

    def wait_saved(step, predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            session = saved()
            row = session and session.get("steps", {}).get(str(step), {}).get("data", {})
            if row and predicate(row):
                return row
            time.sleep(0.1)
        raise AssertionError(f"step {step} material was not durably saved")

    try:
        teacher.run("open", base)
        teacher.run("set", "viewport", "1440", "1000")
        teacher.run("fill", "#login-user", os.environ["GVCSIM_E2E_TEACHER_USERNAME"])
        teacher.run("fill", "#login-pass", os.environ["GVCSIM_E2E_TEACHER_PASSWORD"])
        teacher.run("click", 'button[type="submit"]')
        teacher.run("wait", "--text", "教师工作台")
        teacher.button("+ 添加学生")
        for field, value in {
            "username": username,
            "display-name": username,
            "number": "PURE-BROWSER",
            "password": password,
        }.items():
            teacher.run("fill", f'[name="student-{field}"]', value)
        teacher.button("创建账号")
        teacher.run("wait", "--text", username)
        assert saved() is None
        student.login(base, username, password)
        for step in range(1, 15):
            student.run("open", f"{base}/?step={step}")
            student.run("wait", ".quiz-question")
            student.run("wait", "--load", "networkidle")
            if 6 <= step <= 9:
                # Hard requirements: a time-series view and a country-comparison view on every chart step.
                views = json.loads(
                    student.run(
                        "eval",
                        'Array.from(document.querySelectorAll(\'[role="group"][aria-label="图表视角"] button\')).map(e=>e.textContent)',
                    )
                )
                assert "历年变化" in views, (step, views)
                # Step 9 compares countries in its 行业排名 view (each country's global rank per industry).
                assert ("行业排名" if step == 9 else "国家对比") in views, (step, views)
            if step == 1:
                student.run("click", "tbody tr:first-child td:first-of-type button")
                student.run("wait", '[role="dialog"]')
                student.run("press", "Escape")
                # The table returns from fullscreen and the recorded cell is shown: let the page settle before the quiz.
                student.run("wait", "--fn", "!document.querySelector('[role=\"dialog\"]')")
                student.run("wait", "--load", "networkidle")
            elif 2 <= step <= 5:
                # Steps 2–5 take apart one country; its reading is recorded automatically once the data loads.
                wait_saved(
                    step,
                    lambda row: (
                        "CHN" in row.get("compared", [])
                        and bool(row.get("observations"))
                        and all(
                            item.get("source") == "auto-indicator-comparison" for item in row.get("observations", [])
                        )
                    ),
                )
            elif 6 <= step <= 8:
                # The first visit carries the comparison pair over from the previous step and
                # records the current complete chart automatically; there is no button to press.
                wait_saved(
                    step,
                    lambda row: (
                        {"CHN", "USA"}.issubset(row.get("compared", [])) and len(row.get("observations", [])) >= 2
                    ),
                )
            elif step == 9:
                # 贸易伙伴 is an exploration view in the view bar (ego network, partner table, region matrix).
                student.button("贸易伙伴")
                student.run("wait", "table.region-matrix")
                student.run("wait", "[data-partner]")
                student.button("历年变化")
                student.run("wait", 'select[name="network-metric"]')
                student.run(
                    "select",
                    'section[aria-label="行业网络指标趋势"] select[name="network-country-a"]',
                    "CHN",
                )
                student.run(
                    "select",
                    'section[aria-label="行业网络指标趋势"] select[name="network-country-b"]',
                    "USA",
                )
                student.run(
                    "select",
                    'section[aria-label="行业网络指标趋势"] select[name="network-metric"]',
                    "betweenesscentrality",
                )
                wait_saved(
                    step,
                    lambda row: (
                        {"CHN", "USA"}.issubset(row.get("compared", []))
                        and any(o.get("metric") == "betweenesscentrality" for o in row.get("observations", []))
                    ),
                )
            elif step == 10:
                # The two example rows and their year table (5 years each; X, L1.X and the exchange-rate change).
                student.run("wait", ".teaching-example-summary li")
                student.run("wait", "--fn", 'document.querySelectorAll(".teaching-example-summary li").length === 2')
                student.run(
                    "wait",
                    "--fn",
                    "document.querySelectorAll('[aria-label=\"所选例子的逐年变量表\"] tbody tr').length === 10",
                )
                wait_saved(step, lambda row: bool(row.get("teaching_observation")))
            else:
                # The default model's run button ("计算贸易流回归（用全部 16,000 条记录）"), not the workbench's.
                student.run(
                    "eval",
                    'Array.from(document.querySelectorAll(".reg-run-card .run-btn")).find(e=>e.textContent.startsWith("计算"))'
                    ".click()",
                )
                student.run("wait", "--text", "重新计算")
                wait_saved(step, lambda row: bool(row.get("run")), timeout=30)
            names = json.loads(
                student.run(
                    "eval",
                    'Array.from(document.querySelectorAll(".quiz-question")).map(e=>e.querySelector("input").name)',
                )
            )
            answers = QUIZ_ANSWERS[step]
            # Each radio group is named quiz-<step>-<question id>.
            question_ids = [name.removeprefix(f"quiz-{step}-") for name in names]
            assert sorted(question_ids) == sorted(answers), (step, names)
            if step == 1:
                question = quizzes.STEP_QUIZZES[1][0]
                wrong = next(option["id"] for option in question["options"] if option["id"] != question["correct"])
                choose(student, names[0], wrong)
                student.button("提交答案")
                student.run("wait", "--text", "回答有误")
            for name, question_id in zip(names, question_ids, strict=True):
                choose(student, name, answers[question_id])
            student.button("提交答案")
            student.run("wait", ".quiz-complete")
            row = saved()["steps"][str(step)]["data"]
            assert row["quiz"]["version"] == quizzes.quiz_version(step)
            if step == 1:
                assert row["observation"]["row"].startswith("CHN_")
            elif step <= 5:
                assert "CHN" in row["compared"], (step, row)
            elif step <= 9:
                assert {"CHN", "USA"}.issubset(row["compared"]), (step, row)
                if step == 9:
                    assert any(o["metric"] == "betweenesscentrality" and o.get("industry") for o in row["observations"])
            elif step == 10:
                observation = row["teaching_observation"]
                assert row["viewed_teaching_panel"] is True
                assert row["teaching_panel_version"] == observation["version"]
                expected_exposure = observation["teaching_export_share_w"] * observation["teaching_tariff_rate_tau"]
                assert abs(observation["teaching_tariff_exposure"] - expected_exposure) < 1e-12
            else:
                assert row["run"]["result"], step
                assert row["run"]["design"]["method"] == "twfe_intensity"
                assert row["run"]["model_snapshot"]["version"] == TEACHING_VERSION
                result = row["run"]["result"]
                support = result["support"]
                assert result["status"] == support["status"]
                assert result["diagnostics"]["study_contract"] == "economics-v2"
                assert {item["name"] for item in result["coefs"]} == DEFAULT_TERMS, result["coefs"]
                coefficient = next(item for item in result["coefs"] if item["name"] == X_COLUMN)
                if result["status"] == "insufficient":
                    # Small CI panels must stop inference without blocking the course.
                    assert support["suppress_inference"] is True
                    assert support["reasons"] and all(reason.strip() for reason in support["reasons"])
                    assert all(coefficient[key] is None for key in ("p", "ci_low", "ci_high"))
                    student.run("wait", "--text", "无法推断：")
                else:
                    assert result["status"] in {"ok", "warning"}
                    assert support.get("suppress_inference") is not True
                    assert 0 <= coefficient["p"] <= 1
                    assert coefficient["ci_low"] <= coefficient["ci_high"]
                assert "qualified_run" not in row
            student.run("screenshot", str(output / f"step-{step}.png"))
            results.append({"step": step, "passed": True})
            print(json.dumps(results[-1]), flush=True)
        student.run("open", base + "/?step=15")
        student.run("wait", "textarea")
        reflections = [
            "在2016至2020年的中国和美国比较中，同一组关税冲击如何影响外国投入依赖、复杂生产、链条长度和网络位置？",
            "我通过原始表记录了中国向美国的中间投入，并在各步分别保存了中美比较。四项回归需要并读各自的方向和置信区间，份额、生产长度与网络中心性的单位不同，不能把系数直接相减或仅挑选显著结果。",
            "政策冲击是教学模拟，支持度、外溢和同期冲击都限制解释。网络结果使用全正边二值拓扑，尚未检验边阈值敏感性。区间跨零不能证明没有影响，这些记录不构成真实政策因果结论。",
        ]
        for index, text in enumerate(reflections, 1):
            student.run("fill", f".report-reflection-fields > label:nth-of-type({index}) textarea", text)
        student.run(
            "wait",
            "--fn",
            'Array.from(document.querySelectorAll("button")).some(e=>e.textContent==="只生成草稿（不提交）" && !e.disabled)',
        )
        student.button("只生成草稿（不提交）")
        student.run("wait", "--text", "草稿 · 尚未提交")
        student.run("screenshot", str(output / "report-draft.png"))
        student.button("提交报告给老师")
        student.run("wait", "--text", "等待教师评阅")
        student.run("screenshot", str(output / "report-submitted.png"))
        teacher.run("find", "role", "button", "click", "--name", "报告评阅")
        teacher.run("wait", "--text", username)
        teacher.button("评阅报告：" + username)
        teacher.run("wait", 'input[type="number"]')
        teacher.run("fill", 'input[type="number"]', "93")
        teacher.run("fill", ".grade-field textarea", "纯浏览器全课程测试：全部步骤、持久化及报告状态通过。")
        teacher.button("提交评阅")
        teacher.run("wait", "--text", f"已保存对 {username} 的评阅")
        # The student's still-open pending view must not erase the teacher's new grade.
        student.button("查看已提交报告")
        student.button("重新生成并提交")
        # The page refuses with the reason it found (the teacher's new grade) and shows the latest state.
        student.run("wait", "--text", "老师刚刚评阅了这份报告")
        student.run("reload")
        student.run("wait", "--text", "93")
        student.run("eval", 'document.querySelector(".submit-card")?.scrollIntoView({block:"center"})')
        student.run("screenshot", str(output / "student-graded.png"))
        with psycopg.connect(os.environ["GVCSIM_PG_DSN"]) as connection:
            report = connection.execute(
                "SELECT r.state,r.score,r.markdown FROM reports r JOIN accounts a ON a.id=r.account_id WHERE username=%s",
                (username,),
            ).fetchone()
        assert report[0:2] == ("graded", 93)
        assert all(text in report[2] for text in reflections)
        results.append({"step": 15, "passed": True, "username": username})
        print(json.dumps(results[-1]), flush=True)
        assert not student.run("errors") and not teacher.run("errors")
    except Exception:
        student.run("screenshot", str(output / "failure.png"))
        (output / "failure.json").write_text(student.run("eval", "document.body.innerText.slice(-6000)"))
        raise
    finally:
        (output / "results.json").write_text(json.dumps(results, indent=2))
        student.run("close")
        teacher.run("close")


if __name__ == "__main__":
    main()
