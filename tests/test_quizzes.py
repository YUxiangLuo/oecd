"""固定理解检查题库的公开契约与判题边界。"""

import pytest

from gvcsim import quizzes


def test_bank_covers_steps_1_through_14_with_24_questions():
    assert sorted(quizzes.STEP_QUIZZES) == list(range(1, 15))
    # Basic regression checks: three per step; steps 1–9 keep one each.
    assert sum(len(items) for items in quizzes.STEP_QUIZZES.values()) == 24
    assert [len(quizzes.STEP_QUIZZES[step]) for step in range(10, 15)] == [3, 3, 3, 3, 3]
    assert all(1 <= len(items) <= 3 for items in quizzes.STEP_QUIZZES.values())


def test_public_quiz_never_exposes_answers_or_feedback():
    for step in range(1, 15):
        public = quizzes.public_quiz(step)
        assert public and public["version"] == ("course-quiz-v11" if 10 <= step <= 14 else "course-quiz-v8")
        assert all("correct" not in question and "explanation" not in question for question in public["questions"])
    assert quizzes.public_quiz(15) is None


def test_grade_requires_exact_question_set_and_all_correct():
    canonical = quizzes.correct_quiz(12)
    passed, normalized, results = quizzes.grade(12, canonical["version"], canonical["answers"])
    assert passed is True
    assert normalized == canonical["answers"]
    assert all(item["correct"] for item in results)

    wrong = dict(canonical["answers"])
    question = quizzes.STEP_QUIZZES[12][0]
    wrong[question["id"]] = next(option["id"] for option in question["options"] if option["id"] != question["correct"])
    passed, _, results = quizzes.grade(12, canonical["version"], wrong)
    assert passed is False
    assert any(not item["correct"] and item["explanation"] for item in results)

    with pytest.raises(ValueError, match="版本已更新"):
        quizzes.grade(12, "old-version", canonical["answers"])
    with pytest.raises(ValueError, match="未作答"):
        quizzes.grade(12, canonical["version"], {})
    with pytest.raises(ValueError, match="无法识别"):
        quizzes.grade(12, canonical["version"], {**canonical["answers"], "unknown": "a"})


def test_selected_answers_renders_only_a_fully_correct_current_quiz():
    selected = quizzes.selected_answers(1, quizzes.correct_quiz(1))
    assert selected == [
        {
            "question": "Z 表的一个单元格表示什么？",
            "answer": "行方（供给方）为列方（使用方）提供的中间投入",
        }
    ]
    assert quizzes.selected_answers(1, {"version": "old", "answers": {}}) == []


@pytest.mark.parametrize("answer, expected", [("a", False), ("b", True), ("c", False)])
def test_step_11_checks_percentage_points_with_a_simple_independent_example(answer, expected):
    answers = {"s11-cumulative-v10": "a", "s11-control-v10": "c", "s11-reading-v10": answer}
    passed, _, feedback = quizzes.grade(11, "course-quiz-v11", answers)
    assert passed is expected
    assert feedback[2]["correct"] is expected
    if expected:
        assert "−2 个百分点" in feedback[2]["explanation"]
        assert "不是相对变化的百分比" in feedback[2]["explanation"]
        assert "不是本次回归结果" in feedback[2]["explanation"]
    else:
        # A wrong answer gets a hint, not the answer.
        assert feedback[2]["explanation"] == quizzes.HINTS["s11-reading-v10"]
        assert "低 2 个百分点" not in feedback[2]["explanation"]
    assert len(quizzes.public_quiz(11)["questions"]) == 3


def test_regression_defaults_cover_basic_concepts_without_optional_model_experiments():
    """Students can answer from the default lesson without choosing a model or a particular result."""
    prompts = " ".join(question["prompt"] for step in range(10, 15) for question in quizzes.STEP_QUIZZES[step])
    for concept in ("L1.X", "汇率变动", "两年累计", "国家×行业", "控制变量", "生产份额", "模拟回归"):
        assert concept in prompts, concept
    for number in ("−0.55", "-0.55", "0.0182", "40.4"):
        assert number not in prompts
    assert "改模型、对比" not in prompts and "L2.X" not in prompts
    # The correct options do not sit in one position.
    corrects = [question["correct"] for step in range(10, 15) for question in quizzes.STEP_QUIZZES[step]]
    assert len(set(corrects)) == 3


def test_defaults_preserve_share_and_simulation_boundaries():
    for step, question_id in ((12, "s12-share-v11"), (14, "s14-source-v11")):
        answers = quizzes.correct_quiz(step)["answers"]
        assert answers[question_id] == "c"
        for wrong in ("a", "b"):
            assert not quizzes.grade(step, quizzes.quiz_version(step), {**answers, question_id: wrong})[0]


def test_regression_quizzes_read_an_association_not_a_change_over_time():
    for step in range(10, 15):
        for question in quizzes.STEP_QUIZZES[step]:
            text = " ".join(
                [
                    question["prompt"],
                    question["explanation"],
                    quizzes.HINTS[question["id"]],
                    *(o["label"] for o in question["options"]),
                ]
            )
            for phrase in ("每增加", "平均下降", "平均上升", "上升还是下降", "平均变化"):
                assert phrase not in text, (question["id"], phrase)


def test_wrong_answer_hints_never_state_the_correct_option():
    for questions in quizzes.STEP_QUIZZES.values():
        for question in questions:
            hint = quizzes.HINTS[question["id"]]
            correct = next(option["label"] for option in question["options"] if option["id"] == question["correct"])
            assert correct not in hint, question["id"]
            assert hint != question["explanation"]


def test_step_11_old_answers_cannot_pass_under_any_version():
    old = {"s11-metric": "b", "s11-reading-v9": "a"}
    for version in ("course-quiz-v8", "course-quiz-v9"):
        with pytest.raises(ValueError, match="版本已更新"):
            quizzes.grade(11, version, old)
    with pytest.raises(ValueError, match="未作答"):
        quizzes.grade(11, "course-quiz-v11", old)
    assert quizzes.selected_answers(11, {"version": "course-quiz-v9", "answers": old}) == []


@pytest.mark.parametrize("step, version", [(9, "course-quiz-v8"), (10, "course-quiz-v11"), (11, "course-quiz-v11")])
def test_submission_response_preserves_step_version_for_session_save(teaching_db, step, version):
    from gvcsim.classroom.routes import QuizSubmitRequest, submit_quiz

    canonical = quizzes.correct_quiz(step)
    result = submit_quiz(QuizSubmitRequest(step=step, version=version, answers=canonical["answers"]), _user={})
    assert result["passed"]
    assert result["version"] == version
    assert result["quiz"]["version"] == version
    assert quizzes.grade(step, result["quiz"]["version"], result["quiz"]["answers"])[0]


def test_step_12_interval_question_does_not_require_changing_saved_y():
    """The basic quiz is self-contained; exploring the grey bar remains a separate lesson task."""
    from gvcsim.steps import STEPS

    question = next(item for item in quizzes.STEP_QUIZZES[12] if item["id"] == "s12-compare")
    assert "点击" not in question["prompt"] and "95% 区间包含 0" in question["prompt"]
    assert question["correct"] == "b" and quizzes.quiz_version(12) == "course-quiz-v11"
    tasks = " ".join(next(step for step in STEPS if step["n"] == 12)["tasks"])
    # Hovering or clicking the grey bar only previews its interval; the saved Y stays the step's default.
    assert "点灰色" not in tasks and "悬停或点它看区间" in tasks


def _quiz_text(question):
    return " ".join(
        [
            question["prompt"],
            question["explanation"],
            quizzes.HINTS[question["id"]],
            *(o["label"] for o in question["options"]),
        ]
    )


QUIZ_BY_ID = {question["id"]: question for questions in quizzes.STEP_QUIZZES.values() for question in questions}


def test_betweenness_reads_as_a_sum_of_shares_and_shortest_routes_have_one_name_round_27():
    from gvcsim.indicator_schema import _INDICATOR_DESCRIPTIONS as FIELD_DESCRIPTIONS
    from gvcsim.steps import STEPS

    every = " ".join(_quiz_text(question) for question in QUIZ_BY_ID.values())
    assert "最短路径" not in every
    assert "对所有节点对求和（未归一化" in QUIZ_BY_ID["s05-between"]["explanation"]
    assert "有多少条最短路线经过这个节点（" not in QUIZ_BY_ID["s05-between"]["explanation"]
    step5 = next(step for step in STEPS if step["n"] == 5)
    assert "多少条最短路线" not in step5["goal"] and "对所有节点对求和" in step5["goal"]
    assert "最短路线条数" not in FIELD_DESCRIPTIONS["betweenesscentrality"]
    assert "对所有节点对求和（未归一化）" in FIELD_DESCRIPTIONS["betweenesscentrality"]
    assert all("最短路径" not in text for text in FIELD_DESCRIPTIONS.values())


def test_quizzes_read_x_as_exposure_an_association_and_step_14_y_as_no_amount_round_27():
    every = " ".join(_quiz_text(question) for question in QUIZ_BY_ID.values())
    assert "受新关税影响" not in every
    assert "没有影响" not in every and "没有关联" in QUIZ_BY_ID["s12-compare"]["explanation"]
    # Step 14's Y is generated on the real 加权总度 ranking, in 中心性原始单位: not an amount.
    assert "中心性原始单位" in QUIZ_BY_ID["s14-metric-v9"]["explanation"]
    assert "不是金额" in QUIZ_BY_ID["s14-metric-v9"]["explanation"]
    assert "金额" not in quizzes.HINTS["s14-metric-v9"]
    # The options and correct answers stay as the owner kept them.
    assert [q["correct"] for q in QUIZ_BY_ID.values() if q["id"] in ("s12-compare", "s14-metric-v9")] == ["b", "a"]


def test_hints_guide_without_giving_the_answer_away_round_27():
    x_hint = quizzes.HINTS["s10-x-definition-v8"]
    # No formula to copy, and the page's word for the yearly readouts.
    assert "w × τ" not in x_hint and "相乘" not in x_hint
    assert "逐年表" not in x_hint and "逐年读数" in x_hint
    compare_hint = quizzes.HINTS["s13-compare"]
    assert "单位不同的数能直接比较大小吗" not in compare_hint and "标准差" in compare_hint
    assert [q["correct"] for q in quizzes.STEP_QUIZZES[10]] == ["a", "b", "c"]
    assert [q["correct"] for q in quizzes.STEP_QUIZZES[13]] == ["a", "a", "b"]


def test_custom_bank_is_explicit_private_and_has_generic_feedback():
    bank = quizzes.default_bank()
    question = {
        "id": "custom",
        "kind": "true_false",
        "prompt": " 判断 ",
        "options": [{"id": "true", "label": "正确"}, {"id": "false", "label": "错误"}],
        "correct": "true",
        "hint": None,
        "explanation": "",
    }
    bank["steps"]["7"]["questions"] = quizzes.validate_questions(7, [question])
    bank["steps"]["7"]["version"] = "custom-v1"
    public = quizzes.public_quiz(7, bank)
    assert set(public["questions"][0]) == {"id", "kind", "prompt", "options"}
    assert public["questions"][0]["kind"] == "true_false"
    public["questions"][0]["options"][0]["label"] = "changed"
    canonical = quizzes.correct_quiz(7, bank)
    assert quizzes.quiz_version(7, bank) == "custom-v1"
    assert quizzes.grade(7, canonical["version"], canonical["answers"], bank)[2][0]["explanation"]
    assert quizzes.grade(7, "custom-v1", {"custom": "false"}, bank)[2][0]["explanation"]
    assert quizzes.selected_answers(7, canonical, bank) == [{"question": "判断", "answer": "正确"}]
    assert quizzes.default_bank()["steps"]["7"]["version"] == "course-quiz-v8"


@pytest.mark.parametrize(
    "change",
    [
        {"extra": 1},
        {"id": " "},
        {"prompt": "x" * 2001},
        {"correct": "missing"},
        {"kind": "unknown"},
        {"options": [{"id": "a", "label": "A"}]},
        {"options": [{"id": "a", "label": "A"}, {"id": "a", "label": "B"}]},
        {"options": [{"id": "a", "label": "A"}, {"id": "b", "label": "A"}]},
        {"kind": "true_false"},
        {"options": [{"id": "a", "label": "A", "extra": 1}, {"id": "b", "label": "B"}]},
    ],
)
def test_question_validation_rejects_invalid_input(change):
    question = quizzes.default_bank()["steps"]["1"]["questions"][0]
    with pytest.raises(ValueError):
        quizzes.validate_questions(1, [{**question, **change}])


@pytest.mark.parametrize("step, raw", [(15, []), (True, []), (1, []), (1, {}), (1, [None])])
def test_question_validation_rejects_invalid_shape(step, raw):
    with pytest.raises(ValueError):
        quizzes.validate_questions(step, raw)


def test_question_validation_rejects_duplicate_questions():
    question = quizzes.default_bank()["steps"]["1"]["questions"][0]
    with pytest.raises(ValueError):
        quizzes.validate_questions(1, [question, question])
