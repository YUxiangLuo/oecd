from gvcsim.steps import STEPS


def test_every_existing_step_has_one_complete_handoff_without_adding_steps():
    assert [step["n"] for step in STEPS] == list(range(1, 17))
    for step in STEPS:
        assert len(step["tasks"]) == 3
        assert all(str(value).strip() for value in step["tasks"])
        assert set(step["handoff"]) == {"input", "action", "output"}
        assert all(str(value).strip() for value in step["handoff"].values())


def test_regression_handoffs_keep_treatment_fixed_and_change_the_outcome():
    by_number = {step["n"]: step for step in STEPS}
    assert "第 11 步" in by_number[12]["handoff"]["input"]
    for step in range(13, 16):
        assert "同一处理与比较方法" in by_number[step]["handoff"]["input"]
        assert "只更换结果变量" in by_number[step]["handoff"]["action"]
