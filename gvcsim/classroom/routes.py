"""Minimal student workspace and teacher administration routes."""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from gvcsim import concurrency, demo_accounts, evidence, quizzes
from gvcsim import session as session_model
from gvcsim import report_workbench, teaching_report
from gvcsim.classroom import db, management, records
from gvcsim.regression.teaching import VERSION as TEACHING_VERSION
from gvcsim.regression.workbench import custom_results_problem
from gvcsim.regression_routes import charge_report_runs
from gvcsim.report_gate import check_gate
from gvcsim.report_saved_run import _STEP_OUTCOMES, _parse_saved_run
from gvcsim.request_validation import TextRequest
from gvcsim.singleflight import AsyncSingleFlightCache
from gvcsim.steps import STEPS

router = APIRouter(prefix="/api/classroom")
_REPORT_FLIGHTS: AsyncSingleFlightCache[
    tuple[str, str], tuple[dict[str, Any], teaching_report.TeachingReport, datetime]
] = AsyncSingleFlightCache(maxsize=64)


def current_user(request: Request) -> dict[str, Any]:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="登录已失效，请重新登录。")
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


def _learning_state(session: dict[str, Any], *, report: dict[str, Any] | None) -> dict[str, Any]:
    """Authoritative quiz completion and report-material readiness for one snapshot, and whether the latest report
    was generated from it (``report_current``: the page's "报告需更新" signal, separate from step 15's completion)."""
    return {
        "completion": evidence.completion_summary(session, report_exists=records.report_handed_in(report)),
        "report_current": records.report_matches_session(session, report),
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
        **_learning_state(session, report=report),
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


def _run_button(step: int) -> str:
    """The step's run button as the page names it: "计算" + the title before "：" (e.g. 计算贸易流回归)."""
    title = next((str(item["title"]) for item in STEPS if item["n"] == step), "")
    return f"计算{title.split('：')[0] or '回归'}"


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
            raise HTTPException(
                status_code=422,
                detail="步骤 10 记录的例子已过期：请回到步骤 10，等关税数据加载完成后再继续。",
            )
    # Only steps 11–14 have the workbench: saved models anywhere else are never shown or printed, so not stored.
    workbench_steps = {str(step) for step in _STEP_OUTCOMES}
    for key, value in payload.get("steps", {}).items():
        data = value.get("data") if isinstance(value, dict) else None
        if isinstance(data, dict) and "custom_results" in data and key not in workbench_steps:
            raise HTTPException(status_code=422, detail=f"步骤 {key} 没有“自己设计模型”，不能保存模型。")
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
                    detail=f"步骤 {step} 保存的回归结果已过期，请回到步骤 {step} 点“{_run_button(step)}”重新计算。",
                )
        # The workbench's saved models (自己设计模型): the report recomputes the ones marked 放入报告.
        if "custom_results" in data:
            problem = custom_results_problem(data["custom_results"], _STEP_OUTCOMES[step])
            if problem:
                raise HTTPException(status_code=422, detail=f"步骤 {step} 自己设计的模型没有保存：{problem}。")
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
        **_learning_state(payload, report=report),
    }


async def _prepare_report(user: dict) -> tuple[dict[str, Any], teaching_report.TeachingReport, datetime]:
    # PostgreSQL pool/row-lock waits must not block unrelated requests on the event loop.
    session, _report, row = await concurrency.run_sync(_workspace, user["sub"])

    # The appendix recomputes the workbench models marked 放入报告: a run not computed yet counts against the student's
    # calculations of the minute, as on the page (checked once the gate passes, before anything is computed). The gate
    # grades every quiz and the charge reads the release: off the event loop, as the reads above.
    def charge() -> None:
        if not check_gate(session):
            charge_report_runs(user.get("aid"), report_workbench.run_designs(report_workbench.reported_models(session)))

    await concurrency.run_sync(charge)
    try:
        generated = await concurrency.run_cpu_bound(teaching_report.build, session, user.get("name") or user["sub"])
    except teaching_report.ReportGateError as error:
        raise HTTPException(status_code=409, detail={"message": str(error), "blocked": error.missing}) from error
    if row is None:
        raise HTTPException(
            status_code=409,
            detail={"message": "实验记录刚刚更新，请再点一次生成报告。", "code": "session_changed"},
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
    learning_state = await concurrency.run_sync(lambda: _learning_state(session, report=saved))
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
        raise HTTPException(status_code=409, detail="请先点“生成并提交报告”。")
    session, _existing, _row = _workspace(user["sub"])
    return {
        "report": report,
        **_learning_state(session, report=report),
    }


@router.get("/students")
def students(user: dict = Depends(require_teacher)):
    return {"students": db.list_students(user["sub"])}


# Full-width punctuation (！＂＃…／ ：；…＠ ［＼…｀ ｛｜｝～｟｠), split out as runs so NFKC still composes the rest.
_FULLWIDTH_PUNCTUATION = re.compile("([\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff60]+)")
_ZERO_WIDTH = re.compile("[\u200b\u200c\u200d\u2060\ufeff]")
_WHITESPACE_RUN = re.compile(r"\s+")


def normalize_label(value: Any) -> Any:
    """Canonical form of a teacher-typed label (semester/class name, 姓名, 学号).

    NFKC folds full-width letters and digits, zero-width characters are dropped everywhere, and any run
    of whitespace becomes one space, so names that look the same are stored the same (and collide on the
    unique indexes). Full-width punctuation is how Chinese is written (“王五（转专业）”, “国贸：一班”), so it is
    kept as typed rather than folded to ASCII. Runs as a ``mode="before"`` validator: length limits apply to
    the normalized text.
    """
    if not isinstance(value, str):
        return value
    parts = _FULLWIDTH_PUNCTUATION.split(value)
    value = "".join(part if index % 2 else unicodedata.normalize("NFKC", part) for index, part in enumerate(parts))
    value = _ZERO_WIDTH.sub("", value)
    return _WHITESPACE_RUN.sub(" ", value).strip()


class AcademicNameRequest(TextRequest):
    name: str = Field(min_length=1, max_length=80)

    _normalize_name = field_validator("name", mode="before")(normalize_label)

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
            raise ValueError("提交的内容不完整，请刷新页面后重试")
        return value

    _normalize_name = field_validator("name", mode="before")(normalize_label)

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
        raise HTTPException(status_code=409, detail=f"已有同名学期“{req.name}”，请换一个名称") from error


@router.post("/semesters/{term_id}")
def update_semester(term_id: int, req: AcademicUpdateRequest, user: dict = Depends(require_teacher)):
    fields = req.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要保存的修改")
    try:
        row = db.update_term(term_id, fields, user["sub"])
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail="已有同名学期，请换一个名称") from error
    if row is None:
        raise HTTPException(status_code=404, detail="学期不存在")
    return row


@router.post("/classes")
def create_class(req: ClassCreateRequest, user: dict = Depends(require_teacher)):
    try:
        row = db.create_class_group(req.term_id, req.name, user["sub"])
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail=f"本学期已有同名班级“{req.name}”，请换一个名称") from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if row is None:
        raise HTTPException(status_code=404, detail="学期不存在")
    return row


@router.post("/classes/{class_id}")
def update_class(class_id: int, req: AcademicUpdateRequest, user: dict = Depends(require_teacher)):
    fields = req.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要保存的修改")
    try:
        row = db.update_class_group(class_id, fields, user["sub"])
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail="本学期已有同名班级，请换一个名称") from error
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
        raise ValueError("密码不能全是空格")
    return value


class StudentCreateRequest(TextRequest):
    username: str = Field(min_length=2, max_length=40)
    display_name: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=12, max_length=256)
    student_no: str = Field(default="", max_length=STUDENT_NO_MAX_LENGTH)
    class_id: int | None = Field(default=None, gt=0)

    # Uniqueness of 学号 and login both compare exact text, so surrounding spaces must not survive. Usernames
    # keep the plain edge strip (internal spaces stay an error); 学号 and 姓名 are normalized like labels.
    _strip_username = field_validator("username", mode="before")(_strip_text)
    _normalize_labels = field_validator("display_name", "student_no", mode="before")(normalize_label)
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
        raise HTTPException(status_code=409, detail="部分学号已有账号，本次没有创建任何学生") from error
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
            raise ValueError("提交的内容不完整，请刷新页面后重试")
        return value

    _normalize_labels = field_validator("display_name", "student_no", mode="before")(normalize_label)
    _password_not_blank = field_validator("password")(_nonblank_password)

    @field_validator("display_name")
    @classmethod
    def nonblank_name(cls, value: str) -> str:
        return StudentCreateRequest.nonblank_name(value)


@router.post("/students/{account_id}")
def update_student(account_id: int, req: StudentUpdateRequest, user: dict = Depends(require_teacher)):
    fields = req.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要保存的修改")
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
        raise HTTPException(status_code=404, detail="这份报告不存在或还没提交，请返回列表刷新")
    return row


class GradeRequest(TextRequest):
    score: int = Field(ge=0, le=100)
    feedback: str = Field(default="", max_length=4000)
    expected_updated_at: datetime

    # Whitespace-only feedback is no feedback; otherwise students saw an empty "教师评语".
    @field_validator("feedback", mode="before")
    @classmethod
    def strip_feedback(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


@router.post("/reports/{account_id}/grade")
def grade(account_id: int, req: GradeRequest, user: dict = Depends(require_teacher)):
    try:
        row = db.grade_report(account_id, req.score, req.feedback, user["sub"], req.expected_updated_at)
    except db.ReportChanged as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if row is None:
        raise HTTPException(status_code=404, detail="这份报告不存在或还没提交，请返回列表刷新")
    return row
