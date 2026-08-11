"""Student workspace and teacher administration routes."""

from __future__ import annotations

import re
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from gvcsim import concurrency, evidence, quizzes
from gvcsim import session as session_model
from gvcsim import teaching_report
from gvcsim.classroom import db

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


def _session_and_report(username: str) -> tuple[dict[str, Any], bool, Any]:
    row = db.get_session(username)
    report = db.latest_report(username)
    return (row["session"] if row else session_model.empty_session(), bool(report), row)


@router.get("/announcements")
def announcements(user: dict = Depends(current_user)):
    return {"announcements": db.list_announcements(user["sub"])}


@router.get("/session")
def get_session(user: dict = Depends(require_student)):
    session, report_exists, row = _session_and_report(user["sub"])
    return {
        "session": session,
        "updated_at": row["updated_at"] if row else None,
        "completion": evidence.completion_summary(session, report_exists=report_exists),
    }


class QuizSubmitRequest(BaseModel):
    step: int = Field(ge=1, le=15)
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


@router.put("/session")
def put_session(req: SessionRequest, user: dict = Depends(require_student)):
    try:
        payload = session_model.validate_session(req.session)
    except session_model.SessionError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    payload["steps"].pop("16", None)
    saved = db.save_session(user["sub"], payload)
    if saved is None:
        raise HTTPException(status_code=404, detail="学生账号不可用")
    report_exists = db.latest_report(user["sub"]) is not None
    return {
        "session": saved["session"],
        "updated_at": saved["updated_at"],
        "completion": evidence.completion_summary(saved["session"], report_exists=report_exists),
    }


class ProgressRequest(BaseModel):
    step: int = Field(ge=1, le=16)


@router.get("/progress")
def get_progress(user: dict = Depends(require_student)):
    return db.get_progress(user["sub"]) or {"current_step": None, "max_step": None, "updated_at": None}


@router.post("/progress")
def report_progress(req: ProgressRequest, user: dict = Depends(require_student)):
    db.upsert_progress(user["sub"], req.step)
    return {"ok": True}


@router.post("/report/generate")
async def generate_report(user: dict = Depends(require_student)):
    session, _exists, _row = _session_and_report(user["sub"])
    try:
        report = await concurrency.run_cpu_bound(teaching_report.build, session, user.get("name") or user["sub"])
    except teaching_report.ReportGateError as error:
        raise HTTPException(status_code=409, detail={"message": str(error), "blocked": error.missing}) from error
    saved = db.save_generated_report(user["sub"], report.markdown, report.provenance)
    if saved is None:
        raise HTTPException(status_code=404, detail="学生账号不可用")
    return {
        "markdown": saved["markdown"],
        "provenance": saved["provenance"],
        "suggested_filename": report.suggested_filename,
    }


@router.get("/report/gate")
def report_gate(user: dict = Depends(require_student)):
    session, _exists, _row = _session_and_report(user["sub"])
    return {"blocked": teaching_report.check_gate(session)}


@router.get("/report/generated")
def my_generated_report(user: dict = Depends(require_student)):
    return db.latest_report(user["sub"]) or {"markdown": None, "provenance": None, "updated_at": None}


class SubmitRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@router.post("/report/submit")
def submit_report(req: SubmitRequest, user: dict = Depends(require_student)):
    row = db.submit_report(user["sub"], req.title)
    if row is None:
        raise HTTPException(status_code=409, detail="请先生成报告")
    return row


@router.get("/report/mine")
def my_report(user: dict = Depends(require_student)):
    return db.my_submission(user["sub"]) or {"state": "none"}


class WorkspaceResetRequest(BaseModel):
    confirmation: str = Field(min_length=1, max_length=40)


@router.post("/workspace/reset")
def reset_workspace(req: WorkspaceResetRequest, user: dict = Depends(require_student)):
    try:
        result = db.reset_workspace(user["sub"], req.confirmation)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if result is None:
        raise HTTPException(status_code=404, detail="学生账号不可用")
    return result


@router.get("/overview")
def overview(class_id: int | None = Query(default=None), user: dict = Depends(require_teacher)):
    if class_id is not None and not db.teacher_can_access_class(user["sub"], class_id):
        raise HTTPException(status_code=404, detail="班级不存在")
    return db.overview_stats(class_id, user["sub"])


@router.get("/classes")
def classes(user: dict = Depends(require_teacher)):
    return {"classes": db.list_classes(user["sub"])}


class ClassRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    code: str = Field(min_length=1, max_length=40)
    semester: str = ""
    note: str = ""


@router.post("/classes")
def create_class(req: ClassRequest, user: dict = Depends(require_teacher)):
    try:
        return db.create_class(req.name, req.code, req.semester, req.note, user["sub"])
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail=f"班级代码 {req.code} 已存在") from error


@router.get("/students")
def students(class_id: int | None = Query(default=None), user: dict = Depends(require_teacher)):
    if class_id is not None and not db.teacher_can_access_class(user["sub"], class_id):
        raise HTTPException(status_code=404, detail="班级不存在")
    return {"students": db.list_students(class_id, user["sub"])}


class StudentCreateRequest(BaseModel):
    username: str = Field(min_length=2, max_length=40)
    display_name: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=12, max_length=256)
    student_no: str = ""
    class_id: int | None = None


@router.post("/students")
def create_student(req: StudentCreateRequest, user: dict = Depends(require_teacher)):
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+", req.username):
        raise HTTPException(status_code=400, detail="用户名只能包含字母、数字、下划线、点与连字符")
    if db.find_account(req.username):
        raise HTTPException(status_code=409, detail=f"用户名 {req.username} 已存在")
    try:
        return db.create_student(req.username, req.display_name, req.password, req.student_no, req.class_id, user["sub"])
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


class StudentUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = None
    student_no: str | None = None
    class_id: int | None = None
    password: str | None = Field(default=None, min_length=12, max_length=256)


@router.post("/students/{account_id}")
def update_student(account_id: int, req: StudentUpdateRequest, user: dict = Depends(require_teacher)):
    fields = req.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")
    row = db.update_student(account_id, fields, user["sub"])
    if row is None:
        raise HTTPException(status_code=404, detail="学生或班级不存在")
    return row


@router.get("/submissions")
def submissions(user: dict = Depends(require_teacher)):
    return {"submissions": db.list_submissions(user["sub"])}


@router.get("/submissions/{submission_id}")
def submission_detail(submission_id: int, user: dict = Depends(require_teacher)):
    row = db.get_submission(submission_id, user["sub"])
    if row is None:
        raise HTTPException(status_code=404, detail="提交不存在")
    return row


class GradeRequest(BaseModel):
    score: int = Field(ge=0, le=100)
    feedback: str = ""


@router.post("/submissions/{submission_id}/grade")
def grade(submission_id: int, req: GradeRequest, user: dict = Depends(require_teacher)):
    row = db.grade_submission(submission_id, req.score, req.feedback, user["sub"])
    if row is None:
        raise HTTPException(status_code=404, detail="提交不存在")
    return row


class AnnouncementRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = ""
    class_id: int | None = None


@router.post("/announcements")
def create_announcement(req: AnnouncementRequest, user: dict = Depends(require_teacher)):
    try:
        return db.create_announcement(req.title, req.body, user["sub"], req.class_id)
    except PermissionError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.delete("/announcements/{announcement_id}")
def delete_announcement(announcement_id: int, user: dict = Depends(require_teacher)):
    if not db.delete_announcement(announcement_id, user["sub"]):
        raise HTTPException(status_code=404, detail="公告不存在")
    return {"ok": True}
