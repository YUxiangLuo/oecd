"""固定理解检查题库的公开契约与判题边界。"""

import pytest

from gvcsim import quizzes


def test_bank_covers_steps_1_through_14_with_19_questions():
    assert sorted(quizzes.STEP_QUIZZES) == list(range(1, 15))
    assert sum(len(items) for items in quizzes.STEP_QUIZZES.values()) == 19
    assert all(1 <= len(items) <= 3 for items in quizzes.STEP_QUIZZES.values())


def test_public_quiz_never_exposes_answers_or_feedback():
    for step in range(1, 15):
        public = quizzes.public_quiz(step)
        assert public and public["version"] == ("course-quiz-v9" if step in (11, 14) else "course-quiz-v8")
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
            "question": "Z 表的一格表示什么？",
            "answer": "行方向列方提供的中间投入",
        }
    ]
    assert quizzes.selected_answers(1, {"version": "old", "answers": {}}) == []


@pytest.mark.parametrize("answer, expected", [("a", True), ("b", False), ("c", False)])
def test_step_11_reads_percentage_points_without_claiming_real_causation(answer, expected):
    answers = {"s11-metric": "b", "s11-reading-v9": answer}
    passed, _, feedback = quizzes.grade(11, "course-quiz-v9", answers)
    assert passed is expected
    assert feedback[1]["correct"] is expected
    if expected:
        assert "平均下降 0.60 个百分点" in feedback[1]["explanation"]
        assert "不是相对下降 0.60%" in feedback[1]["explanation"]
        assert "不是平均变化" in feedback[1]["explanation"]
        assert "模拟" not in feedback[1]["explanation"]
    else:
        # A wrong answer gets a hint, not the answer.
        assert feedback[1]["explanation"] == quizzes.HINTS["s11-reading-v9"]
        assert "平均下降 0.60 个百分点" not in feedback[1]["explanation"]
    assert len(quizzes.public_quiz(11)["questions"]) == 2


def test_wrong_answer_hints_never_state_the_correct_option():
    for questions in quizzes.STEP_QUIZZES.values():
        for question in questions:
            hint = quizzes.HINTS[question["id"]]
            correct = next(option["label"] for option in question["options"] if option["id"] == question["correct"])
            assert correct not in hint, question["id"]
            assert hint != question["explanation"]


def test_step_11_old_answers_cannot_pass_under_either_version():
    old = {"s11-metric": "b", "s11-compare": "b"}
    with pytest.raises(ValueError, match="版本已更新"):
        quizzes.grade(11, "course-quiz-v8", old)
    with pytest.raises(ValueError, match="未作答"):
        quizzes.grade(11, "course-quiz-v9", old)
    assert quizzes.selected_answers(11, {"version": "course-quiz-v8", "answers": old}) == []


@pytest.mark.parametrize("step, version", [(10, "course-quiz-v8"), (11, "course-quiz-v9"), (12, "course-quiz-v8")])
def test_submission_response_preserves_step_version_for_session_save(step, version):
    from gvcsim.classroom.routes import QuizSubmitRequest, submit_quiz

    canonical = quizzes.correct_quiz(step)
    result = submit_quiz(QuizSubmitRequest(step=step, version=version, answers=canonical["answers"]), _user={})
    assert result["passed"]
    assert result["version"] == version
    assert result["quiz"]["version"] == version
    assert quizzes.grade(step, result["quiz"]["version"], result["quiz"]["answers"])[0]
