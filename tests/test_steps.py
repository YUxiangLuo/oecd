import hashlib
import json
import re
from pathlib import Path

from gvcsim.steps import STAGE_NAMES, STEPS


def test_every_existing_step_has_one_complete_handoff_without_adding_steps():
    assert [step["n"] for step in STEPS] == list(range(1, 16))
    for step in STEPS:
        # Steps 11–14 (one button, one bar chart) have two actions; every other step has three.
        assert len(step["tasks"]) == (2 if 11 <= step["n"] <= 14 else 3)
        assert all(str(value).strip() for value in step["tasks"])
        assert set(step["handoff"]) == {"input", "action", "output"}
        assert all(str(value).strip() for value in step["handoff"].values())


def test_course_stage_names_match_login_report_gate_and_manual():
    root = Path(__file__).resolve().parents[1]
    login = (root / "frontend/src/login.tsx").read_text()
    flow = re.search(r"export const LOGIN_FLOW = (\[.*?\]);", login)
    assert flow is not None
    assert json.loads(flow[1]) == list(STAGE_NAMES.values())

    report = (root / "frontend/src/labs/steps/report-lab.tsx").read_text()
    groups = re.findall(r'\{ label: "([^"]+)", first: (\d+), last: (\d+) \}', report)
    assert [label for label, _, _ in groups] == list(STAGE_NAMES.values())
    for step in STEPS:
        labels = [label for label, first, last in groups if int(first) <= step["n"] <= int(last)]
        assert labels == [STAGE_NAMES[step["stage"]]]

    manual = (root / "实验手册.md").read_text()
    for label in STAGE_NAMES.values():
        assert f"| {label} |" in manual


def test_outcome_labels_match_the_indicator_schema():
    from gvcsim.indicator_schema import INDICATOR_SCHEMA
    from gvcsim.regression.design import OUTCOME_DEPVARS

    assert OUTCOME_DEPVARS["trade"] == ("FVA_share", "外国增加值项占比")
    assert INDICATOR_SCHEMA["fields"]["FVA_share"]["label"] == "外国增加值项占比"
    assert "不含被重复计算的部分" in INDICATOR_SCHEMA["fields"]["FVA_share"]["desc"]


def _student_copy() -> str:
    return " ".join(
        " ".join([step["title"], step["goal"], step["concept"], step["tip"], *step["tasks"]]) for step in STEPS
    )


def test_student_copy_never_reverses_the_supply_direction():
    """Z 表行是供给方；把方向说反会直接教错，因此只禁止错误说法、不锁定措辞。"""
    assert "谁买了谁的东西" not in _student_copy()


def test_step_ten_task_names_the_keyboard_readout_too():
    """步骤 10 的国家图可用方向键逐个读数，任务卡不只说悬停。"""
    tasks = "".join(next(step for step in STEPS if step["n"] == 10)["tasks"])
    assert "悬停或用方向键查看各国读数" in tasks


def test_task_cards_count_what_the_page_shows():
    """步骤 2 的六项不再说成“四类”（方法卡 3 写的是 WWZ 五类加 taxsub）；步骤 10 以美国加税为主线，例子叫“举例”。"""
    goal = next(step for step in STEPS if step["n"] == 2)["goal"]
    assert "六项" in goal and "四类" not in goal
    tasks = "".join(next(step for step in STEPS if step["n"] == 10)["tasks"])
    assert "美国加征关税" in tasks and "举例" in tasks and "跟踪" not in tasks and "四个摘要" not in tasks


def test_exploration_only_views_use_one_term_on_steps_six_to_nine():
    """步骤 6–9 页面和手册都说“只供探索”；步骤 9 任务卡不能另写“只供查阅”（round 21）。"""
    tasks = "".join("".join(step["tasks"]) for step in STEPS if 6 <= step["n"] <= 9)
    assert "只供查阅" not in tasks
    assert "只供探索" in "".join(next(step for step in STEPS if step["n"] == 9)["tasks"])


def test_student_copy_never_leaks_internal_field_names():
    copy = _student_copy()
    assert "EXGR_FVASH" not in copy
    assert "课程 FVA" not in copy


def test_student_manual_source_note_matches_screenshot_manifest():
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "docs/student-manual/screenshots.json").read_text())
    manual = (root / "实验手册.md").read_text()
    assert manifest["baseline_commit"]
    assert manifest["data_release"]
    assert manifest["code_state"]
    assert manifest["screenshots"]
    for screenshot in manifest["screenshots"]:
        image = root / "docs/student-manual" / screenshot["file"]
        assert hashlib.sha256(image.read_bytes()).hexdigest() == screenshot["sha256"]
        assert screenshot["data_sources"]
        assert all("production_data" in source for source in screenshot["data_sources"])
        for source in screenshot["data_sources"]:
            if source["production_data"]:
                assert source["release_id"] == screenshot.get("data_release", manifest["data_release"])
    assert "docs/student-manual/screenshots.json" in manual
