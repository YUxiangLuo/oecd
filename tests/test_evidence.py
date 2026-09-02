import pytest

from gvcsim import evidence, quizzes
from gvcsim.session import empty_session, make_record


def _complete_through_14():
    session = empty_session()
    session["steps"] = {str(step): make_record({"quiz": quizzes.correct_quiz(step)}) for step in range(1, 15)}
    return session


def test_snapshots_and_receipt_like_noise_do_not_complete_steps():
    session = empty_session()
    session["steps"]["4"] = make_record({"chart": "rank", "quiz_id": "forged"})
    assert evidence.completion_summary(session)["completed"] == []


@pytest.mark.parametrize("step", range(1, 15))
def test_saved_correct_answers_are_regraded(step):
    session = empty_session()
    session["steps"][str(step)] = make_record({"quiz": quizzes.correct_quiz(step)})
    assert evidence.evaluate_step(step, session).complete


def test_client_can_supply_correct_answers_without_a_receipt():
    session = _complete_through_14()
    summary = evidence.completion_summary(session)
    assert summary["completed"] == list(range(1, 15))
    assert 15 not in summary["completed"]
    assert evidence.completion_summary(session, report_exists=True)["completed"] == list(range(1, 16))


def test_wrong_or_old_answers_fail_and_unknown_step_is_rejected():
    session = _complete_through_14()
    session["steps"]["5"]["data"]["quiz"]["version"] = "old"
    assert not evidence.evaluate_step(5, session).complete
    with pytest.raises(ValueError, match="未知步骤"):
        evidence.evaluate_step(99, session)
