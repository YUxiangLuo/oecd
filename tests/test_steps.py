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


def test_outcome_labels_match_the_indicator_schema():
    from gvcsim.indicator_schema import INDICATOR_SCHEMA
    from gvcsim.regression.design import OUTCOME_DEPVARS

    assert OUTCOME_DEPVARS["trade"] == ("FVA_share", "外国增加值项占比")
    assert INDICATOR_SCHEMA["fields"]["FVA_share"]["label"] == "外国增加值项占比"
    assert "FVA+FDC" in INDICATOR_SCHEMA["fields"]["FVA_share"]["desc"]


def _student_copy() -> str:
    return " ".join(
        " ".join([step["title"], step["goal"], step["concept"], step["tip"], *step["tasks"]]) for step in STEPS
    )


def test_student_copy_never_reverses_the_supply_direction():
    """Z 表行是供给方；把方向说反会直接教错，因此只禁止错误说法、不锁定措辞。"""
    assert "谁买了谁的东西" not in _student_copy()


def test_student_copy_never_leaks_internal_field_names():
    copy = _student_copy()
    assert "EXGR_FVASH" not in copy
    assert "课程 FVA" not in copy


def test_student_manual_source_note_matches_screenshot_manifest():
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "docs/student-manual/screenshots.json").read_text())
    manual = (root / "实验手册.md").read_text()
    assert manifest["screenshots"]
    for screenshot in manifest["screenshots"]:
        assert f"`{screenshot['code_commit']}`" in manual
        assert f"`{screenshot['data_release']}`" in manual
        assert screenshot["data_sources"]
        assert all("production_data" in source for source in screenshot["data_sources"])
        if "uncommitted" in screenshot["code_state"]:
            assert "未提交" in manual
    assert "docs/student-manual/screenshots.json" in manual
