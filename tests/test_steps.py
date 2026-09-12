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


def test_regression_handoffs_keep_treatment_fixed_and_change_the_outcome():
    by_number = {step["n"]: step for step in STEPS}
    assert "第 10 步" in by_number[11]["handoff"]["input"]
    for step in range(12, 15):
        assert "同一处理与比较方法" in by_number[step]["handoff"]["input"]
        assert "只更换结果变量" in by_number[step]["handoff"]["action"]
