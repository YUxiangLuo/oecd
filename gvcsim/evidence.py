"""课程完成度的服务端真值。

学生可以自由使用每一步的实验台，实验状态也会自动保存，但步骤 1–15 的完成
条件只有一个：当前学生在当前 assignment/attempt/manifest 下答对本步全部选择题。
实验操作不参与完成判定。步骤 16 仍以服务端真实生成的报告为完成条件。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, cast

from gvcsim import quizzes, trusted_evidence
from gvcsim.steps import STEPS


@dataclass
class StepCompletion:
    """一步的完成判定结果。"""

    step: int
    complete: bool
    missing: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"step": self.step, "complete": self.complete, "missing": list(self.missing)}


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _quiz_missing(step: int, data: dict[str, Any]) -> list[str]:
    quiz = data.get("quiz")
    if not isinstance(quiz, dict):
        return ["请完成本步理解检查并答对全部选择题"]
    try:
        passed, normalized, _ = quizzes.grade(
            step,
            str(quiz.get("version") or ""),
            quiz.get("answers"),
        )
    except ValueError as error:
        return [str(error)]
    if not passed:
        return ["本步理解检查尚未全部答对"]
    if normalized != quiz.get("answers"):
        return ["理解检查答案格式无效，请重新提交"]
    return []


def _report_missing(data: dict[str, Any]) -> list[str]:
    if not _text(data.get("report_key")):
        return ["请在前 15 步答题通过后生成实验报告"]
    return []


# 步号 → lab 类型。以 steps.py 为唯一来源；报告步骤由 lab=rep 识别。
STEP_LABS: dict[int, str] = {cast(int, step["n"]): cast(str, step["lab"]) for step in STEPS}


def evaluate_step(
    step: int,
    session: dict[str, Any],
    *,
    subject: str | None = None,
    require_trusted: bool = False,
    connection: Any | None = None,
) -> StepCompletion:
    """判定单步是否完成；实验操作字段一律不参与。"""
    lab = STEP_LABS.get(step)
    if lab is None:
        raise ValueError(f"未知步骤:{step}")
    record = session.get("steps", {}).get(str(step))
    raw_data = record.get("data") if isinstance(record, dict) else None
    data = raw_data if isinstance(raw_data, dict) else {}

    if lab == "rep":
        missing = _report_missing(data)
        if require_trusted and not missing:
            if not subject:
                missing.append("服务端无法确认这份报告属于当前学生")
            else:
                try:
                    from gvcsim.classroom import db

                    report_key = str(data.get("report_key") or "")
                    if not report_key:
                        report = None
                    elif connection is None:
                        report = db.report_by_key(subject, report_key)
                    else:
                        report = db.report_by_key(subject, report_key, connection=connection)
                except Exception:
                    report = None
                if not isinstance(report, dict) or report.get("manifest_id") != session.get("manifest_id"):
                    missing.append("report_key 没有绑定当前学生、attempt 与 manifest 的真实服务端报告")
        return StepCompletion(step=step, complete=not missing, missing=missing)

    missing = _quiz_missing(step, data)
    if require_trusted and not missing:
        quiz_payload = _as_dict(data.get("quiz"))
        if not subject:
            missing.append("服务端无法确认这次答题属于当前学生")
        else:
            connection_arg = {"connection": connection} if connection is not None else {}
            if not trusted_evidence.verify_quiz_completion(
                data.get("quiz_id"),
                subject=subject,
                step=step,
                manifest_id=str(session.get("manifest_id") or ""),
                payload=quiz_payload,
                **connection_arg,
            ):
                missing.append("理解检查答案已变化或完成凭证无效，请重新提交")
    return StepCompletion(step=step, complete=not missing, missing=missing)


def evaluate(
    session: dict[str, Any],
    *,
    subject: str | None = None,
    require_trusted: bool = False,
    connection: Any | None = None,
) -> list[StepCompletion]:
    return [
        evaluate_step(
            n,
            session,
            subject=subject,
            require_trusted=require_trusted,
            connection=connection,
        )
        for n in sorted(STEP_LABS)
    ]


def completion_summary(
    session: dict[str, Any],
    *,
    subject: str | None = None,
    require_trusted: bool = False,
    connection: Any | None = None,
) -> dict[str, Any]:
    items = evaluate(
        session,
        subject=subject,
        require_trusted=require_trusted,
        connection=connection,
    )
    return {
        "steps": [item.to_dict() for item in items],
        "completed": [item.step for item in items if item.complete],
        "completed_count": sum(1 for item in items if item.complete),
        "total": len(items),
    }
