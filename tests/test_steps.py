import json
from pathlib import Path

from gvcsim.steps import STEPS


def test_every_existing_step_has_one_complete_handoff_without_adding_steps():
    assert [step["n"] for step in STEPS] == list(range(1, 16))
    for step in STEPS:
        assert len(step["tasks"]) == 3
        assert all(str(value).strip() for value in step["tasks"])
        assert set(step["handoff"]) == {"input", "action", "output"}
        assert all(str(value).strip() for value in step["handoff"].values())


def test_step1_uses_the_supply_direction_wording_shared_by_the_intro():
    concept = STEPS[0]["concept"]
    assert "谁向谁供货" in concept
    assert "谁买了谁的东西" not in concept


def test_beginner_copy_names_the_observation_without_repeated_accounting_disclaimers():
    from gvcsim.indicator_schema import INDICATOR_SCHEMA
    from gvcsim.regression.design import OUTCOME_DEPVARS

    assert OUTCOME_DEPVARS["trade"] == ("FVA_share", "外国增加值项占比")
    assert INDICATOR_SCHEMA["fields"]["FVA_share"]["label"] == "外国增加值项占比"
    assert "FVA+FDC" in INDICATOR_SCHEMA["fields"]["FVA_share"]["desc"]
    for number in (2, 6, 11):
        step = STEPS[number - 1]
        copy = " ".join([step["title"], step["goal"], *step["tasks"], step["tip"]])
        assert "课程 FVA" not in copy
        assert "EXGR_FVASH" not in copy
    assert "探索性" in STEPS[13]["title"]
    assert "不保存图表全部分项" in STEPS[5]["tip"]
    assert STEPS[5]["handoff"]["output"] == "保存比较对象及可用的代表指标，供第 15 步引用"


def test_visualization_tasks_disclose_only_the_saved_representative_metric():
    production, length = STEPS[6], STEPS[7]
    assert "个人笔记" in production["tasks"][2]
    assert "国家级复杂 GVC 份额" in production["handoff"]["output"]
    assert "不保存行业读数或全部分项" in production["tip"]
    assert "个人笔记" in length["tasks"][2]
    assert "国家级 GVCPs" in length["handoff"]["output"]
    assert "不保存前后向长度的完整读数" in length["tip"]


def test_source_and_actions_follow_current_data_and_actual_controls():
    assert "以课程来源标签为准" in STEPS[0]["concept"]
    assert "新加坡" not in STEPS[6]["tip"]
    assert "行业网络指标" in STEPS[8]["tip"]
    assert "记录拓扑基准" in STEPS[8]["tip"]
    assert "先看结果状态" in STEPS[10]["tasks"][2]
    assert "换冲击、方法或样本口径（选做）" in STEPS[12]["concept"]
    assert "不能代替提交" in STEPS[14]["tip"]


def test_regression_tasks_progress_from_one_worked_example_to_indicator_specific_reading():
    assert "四格例子" in STEPS[10]["tasks"][0]
    assert "练习不阻挡结果阅读" in STEPS[10]["tasks"][2]
    assert "构成变化与生产规模变化" in STEPS[11]["tasks"][0]
    assert "不是百分点或跨境次数" in STEPS[12]["tasks"][0]
    assert "探索性拓扑证据" in STEPS[13]["tasks"][0]
    for item in STEPS[10:14]:
        assert "实体置换" not in " ".join(item["tasks"])


def test_student_manual_source_note_matches_screenshot_manifest():
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "docs/student-manual/screenshots.json").read_text())
    source_note = (root / "实验手册.md").read_text().split("### 版本与截图说明", 1)[1]
    assert f"`{manifest['code_commit']}`" in source_note
    assert f"`{manifest['data_release']}`" in source_note
    if "uncommitted" in manifest["code_state"]:
        assert "未提交" in source_note
        assert "不是干净提交版本" in source_note
    assert "docs/student-manual/screenshots.json" in source_note


def test_regression_handoffs_keep_treatment_fixed_and_change_the_outcome():
    by_number = {step["n"]: step for step in STEPS}
    assert "第 10 步" in by_number[11]["handoff"]["input"]
    for step in range(12, 15):
        assert "同一处理与比较方法" in by_number[step]["handoff"]["input"]
        assert "只更换结果变量" in by_number[step]["handoff"]["action"]
