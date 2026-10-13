"""Completion rules: locally stored answers are regraded by the server."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, cast

from gvcsim import quizzes
from gvcsim.steps import STEPS


@dataclass
class StepCompletion:
    step: int
    complete: bool
    missing: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"step": self.step, "complete": self.complete, "missing": self.missing}


STEP_LABS: dict[int, str] = {cast(int, step["n"]): cast(str, step["lab"]) for step in STEPS}


def evaluate_step(
    step: int,
    session: dict[str, Any],
    *,
    report_exists: bool = False,
    quiz_bank: dict[str, Any] | None = None,
    **_unused: Any,
) -> StepCompletion:
    lab = STEP_LABS.get(step)
    if lab is None:
        raise ValueError(f"未知步骤:{step}")
    if lab == "rep":
        missing = [] if report_exists else ["先答对理解题、补齐实验材料、写完你的分析，才能生成报告"]
        return StepCompletion(step, not missing, missing)
    record = session.get("steps", {}).get(str(step))
    data = record.get("data") if isinstance(record, dict) else None
    quiz = data.get("quiz") if isinstance(data, dict) else None
    if not isinstance(quiz, dict):
        return StepCompletion(step, False, ["请答对本步全部理解题"])
    try:
        passed, normalized, _results = quizzes.grade(
            step, str(quiz.get("version") or ""), quiz.get("answers"), quiz_bank
        )
    except ValueError as error:
        return StepCompletion(step, False, [str(error)])
    valid = passed and normalized == quiz.get("answers")
    return StepCompletion(step, valid, [] if valid else ["本步理解题还没有全部答对"])


def evaluate(session: dict[str, Any], *, report_exists: bool = False, **unused: Any) -> list[StepCompletion]:
    return [evaluate_step(step, session, report_exists=report_exists, **unused) for step in sorted(STEP_LABS)]


def completion_summary(session: dict[str, Any], *, report_exists: bool = False, **unused: Any) -> dict[str, Any]:
    items = evaluate(session, report_exists=report_exists, **unused)
    completed = [item.step for item in items if item.complete]
    return {
        "steps": [item.to_dict() for item in items],
        "completed": completed,
        "completed_count": len(completed),
        "total": len(items),
    }
