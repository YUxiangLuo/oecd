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
from gvcsim.classroom import db, management, records
from gvcsim.regression.teaching import VERSION as TEACHING_VERSION
from gvcsim.report_saved_run import _STEP_OUTCOMES, _parse_saved_run
from gvcsim.request_validation import TextRequest
from gvcsim.singleflight import AsyncSingleFlightCache

router = APIRouter(prefix="/api/classroom")
_REPORT_FLIGHTS: AsyncSingleFlightCache[
    tuple[str, str], tuple[dict[str, Any], teaching_report.TeachingReport, datetime]
] = AsyncSingleFlightCache(maxsize=64)


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


def _learning_state(session: dict[str, Any], *, report_current: bool) -> dict[str, Any]:
    """Authoritative quiz completion and report-material readiness for one snapshot."""
    return {
        "completion": evidence.completion_summary(session, report_exists=report_current),
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
        **_learning_state(session, report_current=records.report_matches_session(session, report)),
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
    response: dict[str, Any] = {"passed": passed, "version": quizzes.quiz_version(req.step), "results": results}
    if passed:
        response["quiz"] = {"version": quizzes.quiz_version(req.step), "answers": normalized}
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
            and step10.get("teaching_panel_version") == TEACHING_VERSION
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
            if raw is not None and _parse_saved_run(raw, _STEP_OUTCOMES[step]) is None:
                raise HTTPException(
                    status_code=422,
                    detail=f"步骤 {step} 保存的是旧版或不匹配的模型快照；请明确重新运行 {TEACHING_VERSION}",
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
    report = db.latest_report(user["sub"])
    return {
        "session": payload,
        "updated_at": saved["updated_at"],
        **_learning_state(payload, report_current=records.report_matches_session(payload, report)),
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


async def generate_report(
    user: dict = Depends(require_student),
    *,
    request: Request | None = None,
    expected_report_updated_at: datetime | None = None,
):
    async def prepare() -> tuple[dict[str, Any], teaching_report.TeachingReport, datetime]:
        return await _REPORT_FLIGHTS.get_or_compute(
            (str(user.get("rid") or ""), user["sub"]),
            lambda: _prepare_report(user),
            owner=user.get("aid") or user["sub"],
            cache_success=False,
        )

    if request is None:
        session, generated, version = await prepare()
    else:
        session, generated, version = await concurrency.for_request(request, prepare)
    # Only preparation observes disconnects. Once persistence begins, retain the
    # transaction and response bookkeeping even when the response is lost.
    try:
        saved = await concurrency.run_sync(
            db.save_generated_report,
            user["sub"],
            generated.markdown,
            generated.provenance,
            version,
            expected_report_updated_at,
        )
    except records.ReportChanged as error:
        raise HTTPException(
            status_code=409,
            detail={"message": str(error), "code": "report_changed"},
        ) from error
    except records.SessionChanged as error:
        raise HTTPException(
            status_code=409,
            detail={"message": "报告生成期间实验记录已更新，请基于最新记录重新生成。", "code": "session_changed"},
        ) from error
    if saved is None:
        raise HTTPException(status_code=404, detail="学生账号不存在")
    saved["suggested_filename"] = generated.suggested_filename
    learning_state = await concurrency.run_sync(
        lambda: _learning_state(session, report_current=records.report_matches_session(session, saved))
    )
    return {"report": saved, **learning_state}


class ReportGenerateRequest(BaseModel):
    expected_report_updated_at: datetime | None = None


@router.post("/report/generate")
async def generate_report_http(
    request: Request,
    user: dict = Depends(require_student),
    req: ReportGenerateRequest | None = None,
):
    # Legacy body-less first generation remains valid; it can never replace a report.
    return await generate_report(
        user,
        request=request,
        expected_report_updated_at=req.expected_report_updated_at if req else None,
    )


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
        **_learning_state(session, report_current=records.report_matches_session(session, report)),
    }


@router.get("/students")
def students(user: dict = Depends(require_teacher)):
    return {"students": db.list_students(user["sub"])}


class AcademicNameRequest(TextRequest):
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def nonblank_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("名称不能为空")
        return value.strip()


class AcademicUpdateRequest(TextRequest):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=80)
    is_active: bool | None = None

    @field_validator("name", "is_active", mode="before")
    @classmethod
    def supplied_fields_are_not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("更新字段不能为 null；不修改请省略该字段")
        return value

    @field_validator("name")
    @classmethod
    def nonblank_name(cls, value: str) -> str:
        return AcademicNameRequest.nonblank_name(value)


class ClassCreateRequest(AcademicNameRequest):
    term_id: int = Field(gt=0)


@router.get("/semesters")
def semesters(user: dict = Depends(require_teacher)):
    return {"semesters": db.list_academic_structure(user["sub"])}


@router.post("/semesters")
def create_semester(req: AcademicNameRequest, user: dict = Depends(require_teacher)):
    try:
        return db.create_term(req.name, user["sub"])
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail=f"学期 {req.name} 已存在") from error


@router.post("/semesters/{term_id}")
def update_semester(term_id: int, req: AcademicUpdateRequest, user: dict = Depends(require_teacher)):
    fields = req.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")
    try:
        row = db.update_term(term_id, fields, user["sub"])
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail="学期名称已存在") from error
    if row is None:
        raise HTTPException(status_code=404, detail="学期不存在")
    return row


@router.post("/classes")
def create_class(req: ClassCreateRequest, user: dict = Depends(require_teacher)):
    try:
        row = db.create_class_group(req.term_id, req.name, user["sub"])
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail=f"该学期已存在班级 {req.name}") from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if row is None:
        raise HTTPException(status_code=404, detail="学期不存在")
    return row


@router.post("/classes/{class_id}")
def update_class(class_id: int, req: AcademicUpdateRequest, user: dict = Depends(require_teacher)):
    fields = req.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")
    try:
        row = db.update_class_group(class_id, fields, user["sub"])
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail="该学期已存在同名班级") from error
    if row is None:
        raise HTTPException(status_code=404, detail="班级不存在")
    return row


STUDENT_NO_MAX_LENGTH = 40


# Python's str.strip() keeps a byte-order mark and zero-width spaces that a pasted roster often carries.
_INVISIBLE_EDGES = "\ufeff\u200b\u200c\u200d\u2060"


def _strip_text(value: Any) -> Any:
    return value.strip().strip(_INVISIBLE_EDGES).strip() if isinstance(value, str) else value


def _nonblank_password(value: Any) -> Any:
    if isinstance(value, str) and not value.strip():
        raise ValueError("口令不能全是空白字符")
    return value


class StudentCreateRequest(TextRequest):
    username: str = Field(min_length=2, max_length=40)
    display_name: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=12, max_length=256)
    student_no: str = Field(default="", max_length=STUDENT_NO_MAX_LENGTH)
    class_id: int | None = Field(default=None, gt=0)

    # Uniqueness of 学号 and login both compare exact text, so surrounding spaces must not survive.
    _strip_identifiers = field_validator("username", "student_no", mode="before")(_strip_text)
    # Reject a blank password as a field error (422) up front, also in the batch preview.
    _password_not_blank = field_validator("password")(_nonblank_password)

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
        return db.create_student(
            req.username,
            req.display_name,
            req.password,
            req.student_no,
            user["sub"],
            req.class_id,
        )
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail=f"用户名 {req.username} 已存在") from error
    except management.StudentNumberTaken as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (PermissionError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


class StudentBatchRequest(BaseModel):
    class_id: int = Field(gt=0)
    students: list[StudentCreateRequest] = Field(min_length=1, max_length=200)
    preview: bool = True


@router.post("/students/batch")
def create_student_batch(req: StudentBatchRequest, user: dict = Depends(require_teacher)):
    names = [student.username for student in req.students]
    if len(set(names)) != len(names):
        raise HTTPException(status_code=400, detail="名单中有重复学号")
    if any(not re.fullmatch(r"[a-zA-Z0-9_.-]{2,40}", name) for name in names):
        raise HTTPException(status_code=400, detail="学号须为 2–40 位字母、数字、下划线、点或连字符")
    try:
        return management.create_student_batch(
            [student.model_dump() for student in req.students], req.class_id, user["sub"], req.preview
        )
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail="账号已被创建，本次未添加任何学生；请重新预览名单") from error
    except (ValueError, PermissionError) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


class StudentUpdateRequest(TextRequest):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, min_length=1, max_length=60)
    student_no: str | None = Field(default=None, max_length=STUDENT_NO_MAX_LENGTH)
    password: str | None = Field(default=None, min_length=12, max_length=256)

    @field_validator("display_name", "student_no", "password", mode="before")
    @classmethod
    def supplied_fields_are_not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("更新字段不能为 null；不修改请省略该字段，清空学号请使用空字符串")
        return value

    _strip_student_no = field_validator("student_no", mode="before")(_strip_text)
    _password_not_blank = field_validator("password")(_nonblank_password)

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
    except (demo_accounts.DemoSeedPasswordProtected, management.StudentNumberTaken) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if row is None:
        raise HTTPException(status_code=404, detail="学生不存在")
    return row


class EnrollmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    term_id: int = Field(gt=0)
    class_id: int | None


@router.post("/students/{account_id}/enrollment")
def update_student_enrollment(account_id: int, req: EnrollmentRequest, user: dict = Depends(require_teacher)):
    try:
        enrollments = db.set_student_enrollment(account_id, req.term_id, req.class_id, user["sub"])
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if enrollments is None:
        raise HTTPException(status_code=404, detail="学生不存在")
    return {"enrollments": enrollments}


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
