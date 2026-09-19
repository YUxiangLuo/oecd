"""Minimal student workspace and teacher administration routes."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from gvcsim import concurrency, demo_accounts, evidence, quizzes
from gvcsim import session as session_model
from gvcsim import teaching_report
from gvcsim.classroom import db, records
from gvcsim.request_validation import TextRequest

router = APIRouter(prefix="/api/classroom")


def current_user(request: Request) -> dict[str, Any]:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="缺少 Bearer 令牌")
    return user


def require_teacher(request: Request) -> dict[str, Any]:
    user = current_user(request)
    if user.get("role") != "teacher":
        raise HTTPException(status_code=403, detail="仅教师可访问")
    return user


def require_student(request: Request) -> dict[str, Any]:
    user = current_user(request)
    if user.get("role") != "student":
        raise HTTPException(status_code=403, detail="仅学生可访问")
    return user


def _workspace(username: str) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any] | None]:
    row = db.get_session(username)
    report = db.latest_report(username)
    return row["session"] if row else session_model.empty_session(), report, row


def _learning_state(session: dict[str, Any], *, report_exists: bool) -> dict[str, Any]:
    """Authoritative quiz completion and report-material readiness for one snapshot."""
    return {
        "completion": evidence.completion_summary(session, report_exists=report_exists),
        "report_gate": teaching_report.check_gate(session),
        "material_gate": teaching_report.check_material_gate(session),
    }


@router.get("/session")
def get_session(user: dict = Depends(require_student)):
    session, report, row = _workspace(user["sub"])
    return {
        "release_id": user["rid"],
        "session": session,
        "updated_at": row["updated_at"] if row else None,
        **_learning_state(session, report_exists=bool(report)),
        "report": report,
    }


class QuizSubmitRequest(BaseModel):
    step: int = Field(ge=1, le=14)
    version: str = Field(min_length=1, max_length=80)
    answers: dict[str, str]


@router.post("/quiz/submit")
def submit_quiz(req: QuizSubmitRequest, _user: dict = Depends(require_student)):
    try:
        passed, normalized, results = quizzes.grade(req.step, req.version, req.answers)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    response: dict[str, Any] = {"passed": passed, "version": quizzes.QUIZ_VERSION, "results": results}
    if passed:
        response["quiz"] = {"version": quizzes.QUIZ_VERSION, "answers": normalized}
    return response


class SessionRequest(BaseModel):
    session: dict[str, Any]
    # Required even when null: null means this browser observed no saved row.
    base_updated_at: datetime | None


@router.put("/session")
def put_session(req: SessionRequest, user: dict = Depends(require_student)):
    try:
        payload = session_model.validate_session(req.session)
    except session_model.SessionError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    step10 = payload.get("steps", {}).get("10", {}).get("data", {})
    if isinstance(step10, dict) and step10.get("viewed_teaching_panel") is True:
        valid_step10 = (
            isinstance(step10.get("teaching_country"), str)
            and bool(step10["teaching_country"].strip())
            and isinstance(step10.get("teaching_year"), int)
            and not isinstance(step10.get("teaching_year"), bool)
            and step10.get("teaching_panel_version") == teaching_report.TEACHING_VERSION
        )
        if not valid_step10:
            raise HTTPException(status_code=422, detail="步骤 10 教学面板的国家、年份或版本无效")
    # A stale DID or renamed-column snapshot may remain visible to the student,
    # but it must never be silently persisted as completion evidence for v1.
    for step in range(11, 15):
        data = payload.get("steps", {}).get(str(step), {}).get("data", {})
        if not isinstance(data, dict):
            continue
        for key in ("run", "qualified_run"):
            raw = data.get(key)
            if raw is not None and teaching_report._parse_saved_run(raw, teaching_report._STEP_OUTCOMES[step]) is None:
                raise HTTPException(
                    status_code=422,
                    detail=f"步骤 {step} 保存的是旧版或不匹配的模型快照；请明确重新运行 {teaching_report.TEACHING_VERSION}",
                )
    try:
        saved = db.save_session(user["sub"], payload, req.base_updated_at)
    except records.SessionChanged as error:
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    "服务器记录版本已变化，本次请求未覆盖服务器内容。"
                    "可能是其他页面已更新，也可能是此前保存成功但未收到响应。"
                    "请载入服务器版本并核对内容后再操作。"
                ),
                "code": "session_changed",
            },
        ) from error
    if saved is None:
        raise HTTPException(status_code=404, detail="学生账号不存在")
    report_exists = db.latest_report(user["sub"]) is not None
    return {
        "session": payload,
        "updated_at": saved["updated_at"],
        **_learning_state(payload, report_exists=report_exists),
    }


async def _prepare_report(user: dict) -> tuple[dict[str, Any], teaching_report.TeachingReport, datetime]:
    # PostgreSQL pool/row-lock waits must not block unrelated requests on the event loop.
    session, _report, row = await concurrency.run_sync(_workspace, user["sub"])
    try:
        generated = await concurrency.run_cpu_bound(teaching_report.build, session, user.get("name") or user["sub"])
    except teaching_report.ReportGateError as error:
        raise HTTPException(status_code=409, detail={"message": str(error), "blocked": error.missing}) from error
    if row is None:
        raise HTTPException(
            status_code=409,
            detail={"message": "报告生成所依据的实验记录已变化，请保存并重试。", "code": "session_changed"},
        )
    return session, generated, row["updated_at"]


async def generate_report(user: dict = Depends(require_student), *, request: Request | None = None):
    if request is None:
        session, generated, version = await _prepare_report(user)
    else:
        session, generated, version = await concurrency.for_request(request, lambda: _prepare_report(user))
    # Only preparation observes disconnects. Once persistence begins, retain the
    # transaction and response bookkeeping even when the response is lost.
    try:
        saved = await concurrency.run_sync(
            db.save_generated_report, user["sub"], generated.markdown, generated.provenance, version
        )
    except records.SessionChanged as error:
        raise HTTPException(
            status_code=409,
            detail={"message": "报告生成期间实验记录已更新，请基于最新记录重新生成。", "code": "session_changed"},
        ) from error
    if saved is None:
        raise HTTPException(status_code=404, detail="学生账号不存在")
    saved["suggested_filename"] = generated.suggested_filename
    learning_state = await concurrency.run_sync(lambda: _learning_state(session, report_exists=True))
    return {"report": saved, **learning_state}


@router.post("/report/generate")
async def generate_report_http(request: Request, user: dict = Depends(require_student)):
    return await generate_report(user, request=request)


@router.post("/report/submit")
def submit_report(user: dict = Depends(require_student)):
    try:
        report = db.submit_report(user["sub"])
    except db.ReportChanged as error:
        raise HTTPException(
            status_code=409,
            detail={"message": "实验记录已更新，请重新生成报告。", "code": "report_outdated"},
        ) from error
    if report is None:
        raise HTTPException(status_code=409, detail="请先生成报告")
    session, _existing, _row = _workspace(user["sub"])
    return {
        "report": report,
        **_learning_state(session, report_exists=True),
    }


@router.get("/students")
def students(user: dict = Depends(require_teacher)):
    return {"students": db.list_students(user["sub"])}


class StudentCreateRequest(TextRequest):
    username: str = Field(min_length=2, max_length=40)
    display_name: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=12, max_length=256)
    student_no: str = ""

    @field_validator("display_name")
    @classmethod
    def nonblank_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("姓名不能为空")
        return value.strip()


@router.post("/students")
def create_student(req: StudentCreateRequest, user: dict = Depends(require_teacher)):
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+", req.username):
        raise HTTPException(status_code=400, detail="用户名只能包含字母、数字、下划线、点与连字符")
    if db.find_account(req.username):
        raise HTTPException(status_code=409, detail=f"用户名 {req.username} 已存在")
    try:
        return db.create_student(req.username, req.display_name, req.password, req.student_no, user["sub"])
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail=f"用户名 {req.username} 已存在") from error
    except (PermissionError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


class StudentUpdateRequest(TextRequest):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, min_length=1, max_length=60)
    student_no: str | None = None
    password: str | None = Field(default=None, min_length=12, max_length=256)

    @field_validator("display_name", "student_no", "password", mode="before")
    @classmethod
    def supplied_fields_are_not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("更新字段不能为 null；不修改请省略该字段，清空学号请使用空字符串")
        return value

    @field_validator("display_name")
    @classmethod
    def nonblank_name(cls, value: str) -> str:
        return StudentCreateRequest.nonblank_name(value)


@router.post("/students/{account_id}")
def update_student(account_id: int, req: StudentUpdateRequest, user: dict = Depends(require_teacher)):
    fields = req.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")
    try:
        row = db.update_student(account_id, fields, user["sub"])
    except demo_accounts.DemoSeedPasswordProtected as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if row is None:
        raise HTTPException(status_code=404, detail="学生不存在")
    return row


@router.get("/reports")
def reports(user: dict = Depends(require_teacher)):
    return {"reports": db.list_reports(user["sub"])}


@router.get("/reports/{account_id}")
def report_detail(account_id: int, user: dict = Depends(require_teacher)):
    row = db.get_report(account_id, user["sub"])
    if row is None:
        raise HTTPException(status_code=404, detail="报告不存在或尚未提交")
    return row


class GradeRequest(TextRequest):
    score: int = Field(ge=0, le=100)
    feedback: str = Field(default="", max_length=4000)
    expected_updated_at: datetime


@router.post("/reports/{account_id}/grade")
def grade(account_id: int, req: GradeRequest, user: dict = Depends(require_teacher)):
    try:
        row = db.grade_report(account_id, req.score, req.feedback, user["sub"], req.expected_updated_at)
    except db.ReportChanged as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if row is None:
        raise HTTPException(status_code=404, detail="报告不存在或尚未提交")
    return row
