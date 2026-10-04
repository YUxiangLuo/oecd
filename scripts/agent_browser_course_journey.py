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
from gvcsim.regression.teaching import VERSION as TEACHING_VERSION

# Choices derived from the question wording and the rendered course explanations.
QUIZ_CHOICES = {
    1: "a",
    2: "b",
    3: "c",
    4: "a",
    5: "b",
    6: "b",
    7: "b",
    8: "a",
    9: "b",
    10: "aa",
    11: "ba",
    12: "bb",
    13: "aa",
    14: "ab",
}


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
            if step == 1:
                student.run("click", "tbody tr:first-child td:first-of-type button")
                student.run("wait", '[role="dialog"]')
                student.run("press", "Escape")
            elif 2 <= step <= 5:
                # The comparison is recorded automatically once the step's data loads.
                wait_saved(
                    step,
                    lambda row: (
                        {"CHN", "USA"}.issubset(row.get("compared", []))
                        and all(
                            item.get("source") == "auto-indicator-comparison" for item in row.get("observations", [])
                        )
                    ),
                )
            elif 6 <= step <= 8:
                student.button("沿用这组比较对象")
                # The current complete chart is recorded automatically.
                wait_saved(
                    step,
                    lambda row: (
                        {"CHN", "USA"}.issubset(row.get("compared", [])) and len(row.get("observations", [])) >= 2
                    ),
                )
            elif step == 9:
                # Supplementary charts open in a modal; the main comparison is recorded automatically.
                student.button("贸易联系概览（国家间网络图）")
                for country in ("CHN", "USA"):
                    selector = f'.network-node[aria-label^="{country} "]'
                    student.run("wait", selector)
                    student.run("focus", selector)
                    student.run("press", "Enter")
                    student.run("wait", ".network-fullscreen-scrim")
                    student.run("press", "Escape")
                    student.run("wait", "--fn", '!document.querySelector(".network-fullscreen-scrim")')
                student.button("关闭")
                student.run("wait", "--fn", '!document.querySelector(".chart-modal-scrim")')
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
                student.run("wait", ".bounded-data-table tbody tr")
                student.run("wait", "--fn", 'document.querySelectorAll(".bounded-data-table tbody tr").length === 10')
                wait_saved(step, lambda row: bool(row.get("teaching_observation")))
            else:
                student.run("find", "role", "button", "click", "--name", "运行回归")
                student.run("wait", "--text", "重新运行回归")
                wait_saved(step, lambda row: bool(row.get("run")), timeout=30)
            names = json.loads(
                student.run(
                    "eval",
                    'Array.from(document.querySelectorAll(".quiz-question")).map(e=>e.querySelector("input").name)',
                )
            )
            assert len(names) == len(QUIZ_CHOICES[step]), (step, names)
            if step == 1:
                student.run("click", f'input[name="{names[0]}"][value="c"]')
                student.button("提交答案")
                student.run("wait", "--text", "这项还不对")
            for name, choice in zip(names, QUIZ_CHOICES[step], strict=True):
                student.run("click", f'input[name="{name}"][value="{choice}"]')
            student.button("提交答案")
            student.run("wait", ".quiz-complete")
            row = saved()["steps"][str(step)]["data"]
            assert row["quiz"]["version"] == ("course-quiz-v9" if step == 11 else "course-quiz-v8")
            if step == 1:
                assert row["observation"]["row"].startswith("CHN_")
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
                assert len(result["coefs"]) == 1
                coefficient = result["coefs"][0]
                if result["status"] == "insufficient":
                    # Small CI panels must stop inference without blocking the course.
                    assert not row.get("qualified_run")
                    assert support["suppress_inference"] is True
                    assert support["reasons"] and all(reason.strip() for reason in support["reasons"])
                    assert all(coefficient[key] is None for key in ("p", "ci_low", "ci_high"))
                    student.run("wait", "--text", "无法推断：")
                else:
                    assert result["status"] in {"ok", "warning"}
                    assert support.get("suppress_inference") is not True
                    assert 0 <= coefficient["p"] <= 1
                    assert coefficient["ci_low"] <= coefficient["ci_high"]
                    assert row["qualified_run"] == row["run"]
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
            'Array.from(document.querySelectorAll("button")).some(e=>e.textContent==="根据实验记录生成报告" && !e.disabled)',
        )
        student.button("根据实验记录生成报告")
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
        student.run("wait", "--text", "报告或评分已更新，请刷新页面核对后再确认重新生成")
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
