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
        assert public and public["version"] == quizzes.QUIZ_VERSION
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
            "question": "Z 表的一格应该怎样解释？",
            "answer": "行方国家×行业向列方国家×行业提供的中间投入",
        }
    ]
    assert quizzes.selected_answers(1, {"version": "old", "answers": {}}) == []
