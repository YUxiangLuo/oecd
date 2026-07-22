"""课程完成度契约：步骤 1–15 只看答题，步骤 16 只看服务端报告。"""

from __future__ import annotations

import pytest

from gvcsim.evidence import STEP_LABS, completion_summary, evaluate, evaluate_step
from gvcsim.quizzes import correct_quiz
from gvcsim.session import empty_session, make_record

MID = "b08a35374d1021b0"


def _session(steps: dict[int, dict]) -> dict:
    value = empty_session(MID)
    value["steps"] = {str(step): make_record(data) for step, data in steps.items()}
    return value


def _passed(step: int, **snapshots: object) -> dict:
    return {**snapshots, "quiz": correct_quiz(step)}


def test_empty_or_visited_session_completes_nothing():
    assert completion_summary(empty_session(MID))["completed"] == []
    visited = _session({step: {} for step in range(1, 17)})
    assert completion_summary(visited)["completed"] == []


def test_experiment_snapshots_never_complete_a_step():
    snapshots = {
        1: {"slice": {"year": 2020, "table": "z"}, "observation": {"value": 12.5}},
        2: {"viewed_shock_types": ["tariff", "sanctions", "export_control"]},
        3: {"selected_rows": ["CHN", "USA"]},
        4: {"compared": ["CHN", "USA"]},
        8: {"chart": "quadrant", "compared": ["CHN", "USA"]},
        12: {"run": {"depvar": "FVA_share"}, "run_id": "forged"},
    }
    assert completion_summary(_session(snapshots))["completed"] == []


@pytest.mark.parametrize("step", range(1, 16))
def test_correct_quiz_alone_completes_each_learning_step(step: int):
    result = evaluate_step(step, _session({step: _passed(step)}))
    assert result.complete
    assert result.missing == []


def test_experiment_fields_do_not_change_quiz_completion():
    step = 12
    quiz_only = evaluate_step(step, _session({step: _passed(step)}))
    with_arbitrary_snapshots = evaluate_step(
        step,
        _session(
            {
                step: _passed(
                    step,
                    run={"settings": {"shockType": "not-a-real-shock"}},
                    run_id="not-a-real-receipt",
                    client_noise={"ignored": True},
                    selected_rows=["CHN", "USA"],
                )
            }
        ),
    )
    assert quiz_only.complete
    assert with_arbitrary_snapshots.complete


def test_missing_wrong_or_stale_quiz_is_incomplete():
    step = 5
    assert not evaluate_step(step, _session({step: {}})).complete

    wrong = correct_quiz(step)
    question_id = next(iter(wrong["answers"]))
    wrong["answers"][question_id] = "not-an-option"
    assert not evaluate_step(step, _session({step: {"quiz": wrong}})).complete

    stale = correct_quiz(step)
    stale["version"] = "old-quiz"
    result = evaluate_step(step, _session({step: {"quiz": stale}}))
    assert not result.complete
    assert any("版本" in item for item in result.missing)


def test_trusted_completion_requires_the_signed_quiz_receipt(monkeypatch):
    step = 7
    session = _session({step: {**_passed(step), "quiz_id": "signed-quiz"}})
    calls: list[dict] = []

    def verify(token, **kwargs):
        calls.append({"token": token, **kwargs})
        return True

    monkeypatch.setattr("gvcsim.evidence.trusted_evidence.verify_quiz_completion", verify)
    assert evaluate_step(step, session, subject="student", require_trusted=True).complete
    assert calls == [
        {
            "token": "signed-quiz",
            "subject": "student",
            "step": step,
            "manifest_id": MID,
            "payload": correct_quiz(step),
        }
    ]


def test_trusted_completion_rejects_missing_subject_or_invalid_receipt(monkeypatch):
    step = 7
    session = _session({step: {**_passed(step), "quiz_id": "forged"}})
    assert not evaluate_step(step, session, require_trusted=True).complete
    monkeypatch.setattr(
        "gvcsim.evidence.trusted_evidence.verify_quiz_completion",
        lambda *_args, **_kwargs: False,
    )
    result = evaluate_step(step, session, subject="student", require_trusted=True)
    assert not result.complete
    assert any("凭证无效" in item for item in result.missing)


def test_report_step_requires_a_real_current_manifest_report(monkeypatch):
    session = _session({16: {"report_key": "report-1"}})
    assert evaluate_step(16, session).complete

    from gvcsim.classroom import db

    monkeypatch.setattr(db, "report_by_key", lambda subject, key: {"manifest_id": MID})
    assert evaluate_step(16, session, subject="student", require_trusted=True).complete

    monkeypatch.setattr(db, "report_by_key", lambda subject, key: {"manifest_id": "other"})
    assert not evaluate_step(16, session, subject="student", require_trusted=True).complete


def test_all_quizzes_then_report_produce_15_then_16_completed_steps():
    steps = {step: _passed(step) for step in range(1, 16)}
    summary = completion_summary(_session(steps))
    assert summary["completed"] == list(range(1, 16))
    assert summary["completed_count"] == 15
    assert summary["total"] == 16

    steps[16] = {"report_key": "report-1"}
    assert completion_summary(_session(steps))["completed"] == list(range(1, 17))


def test_every_step_has_a_completion_check_and_unknown_steps_are_rejected():
    assert sorted(STEP_LABS) == list(range(1, 17))
    assert [item.step for item in evaluate(empty_session(MID))] == list(range(1, 17))
    assert all(item.missing for item in evaluate(empty_session(MID)))
    with pytest.raises(ValueError, match="未知步骤"):
        evaluate_step(99, empty_session(MID))
