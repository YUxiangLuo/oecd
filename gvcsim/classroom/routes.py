"""Manifest-scoped student records and global teacher administration routes."""

import re
from typing import Any

import anyio
import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from gvcsim import artifacts, concurrency, config, evidence, quizzes, trusted_evidence
from gvcsim import session as session_model
from gvcsim import teaching_report
from gvcsim.classroom import db

router = APIRouter(prefix="/api/classroom")
_REPORT_STEP = next(n for n, lab in evidence.STEP_LABS.items() if lab == "rep")


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
        raise HTTPException(status_code=403, detail="仅学生可提交")
    return user


@router.get("/announcements")
def announcements(user: dict = Depends(current_user)):
    return {"announcements": db.list_announcements(user["sub"])}


@router.get("/session")
def get_session(user: dict = Depends(require_student)):
    manifest_id = artifacts.manifest_id()
    row = db.get_session(user["sub"], manifest_id)
    session = row["session"] if row else session_model.empty_session(manifest_id)
    return {
        "revision": row["revision"] if row else 0,
        "manifest_id": manifest_id,
        "session": session,
        "updated_at": row["updated_at"] if row else None,
        "completion": evidence.completion_summary(session, subject=user["sub"], require_trusted=True),
    }


class QuizSubmitRequest(BaseModel):
    step: int = Field(ge=1, le=15)
    version: str = Field(min_length=1, max_length=80)
    answers: dict[str, str]


@router.post("/quiz/submit")
def submit_quiz(req: QuizSubmitRequest, user: dict = Depends(require_student)):
    try:
        passed, normalized, results = quizzes.grade(req.step, req.version, req.answers)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    response: dict[str, Any] = {"passed": passed, "version": quizzes.QUIZ_VERSION, "results": results}
    if not passed:
        return response
    manifest_id = artifacts.manifest_id()
    payload = {"version": quizzes.QUIZ_VERSION, "answers": normalized}
    event = db.record_evidence_event(
        user["sub"], req.step, "quiz", manifest_id, trusted_evidence.digest(payload), {"payload": payload}
    )
    if artifacts.manifest_id() != manifest_id:
        raise HTTPException(status_code=409, detail="判定答题期间数据产物已切换，请刷新后重新提交")
    response["quiz_id"] = trusted_evidence.issue_quiz_completion(
        subject=user["sub"], step=req.step, manifest_id=manifest_id, payload=payload, event=event
    )
    response["quiz"] = payload
    return response


class SessionRequest(BaseModel):
    base_revision: int = Field(ge=0)
    session: dict[str, Any]


def _merge_and_validate(base: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    return session_model.validate_session(session_model.merge_sessions(base, incoming))


@router.put("/session")
def put_session(req: SessionRequest, user: dict = Depends(require_student)):
    try:
        payload = session_model.validate_session(req.session)
    except session_model.SessionError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    payload["steps"].pop(str(_REPORT_STEP), None)
    manifest_id = artifacts.manifest_id()
    if payload["manifest_id"] != manifest_id:
        raise HTTPException(status_code=409, detail="会话不属于服务器当前数据版本，请刷新后重试")
    try:
        saved = db.save_session(user["sub"], payload, req.base_revision, _merge_and_validate)
    except db.WorkspaceScopeMismatch as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except session_model.SessionError as error:
        raise HTTPException(status_code=422, detail=f"与服务端已有会话合并后不合规:{error}") from error
    if saved is None:
        raise HTTPException(status_code=404, detail="学生账号不可用")
    if artifacts.manifest_id() != manifest_id:
        raise HTTPException(status_code=409, detail="保存期间数据产物已切换，请刷新页面")
    return {
        "revision": saved["revision"],
        "manifest_id": manifest_id,
        "session": saved["session"],
        "merged_from": saved["merged_from"],
        "completion": evidence.completion_summary(saved["session"], subject=user["sub"], require_trusted=True),
    }


class ProgressRequest(BaseModel):
    step: int = Field(ge=1, le=db.MAX_STEP)


@router.get("/progress")
def get_progress(user: dict = Depends(require_student)):
    return db.get_progress(user["sub"]) or {"current_step": None, "max_step": None, "updated_at": None}


@router.post("/progress")
def report_progress(req: ProgressRequest, user: dict = Depends(require_student)):
    db.upsert_progress(user["sub"], req.step)
    return {"ok": True}


def _load_session_for_report(username: str) -> tuple[dict[str, Any], int]:
    manifest_id = artifacts.manifest_id()
    row = db.get_session(username, manifest_id)
    return (row["session"], row["revision"]) if row else (session_model.empty_session(manifest_id), 0)


def _step_data_for_gate(session: dict[str, Any], lab: str) -> dict[str, Any]:
    step = next(n for n, value in evidence.STEP_LABS.items() if value == lab)
    record = session.get("steps", {}).get(str(step))
    data = record.get("data") if isinstance(record, dict) else None
    return data if isinstance(data, dict) else {}


@router.post("/report/generate")
async def generate_report(user: dict = Depends(require_student)):
    session, revision = await anyio.to_thread.run_sync(lambda: _load_session_for_report(user["sub"]))
    try:
        async with concurrency.async_cpu_workload("report", permits=config.REPORT_CPU_PERMITS):
            report = await concurrency.run_cpu_bound(
                teaching_report.build,
                session,
                user.get("name") or user["sub"],
                revision,
                subject=user["sub"],
                require_trusted=True,
            )
    except teaching_report.ReportGateError as error:
        raise HTTPException(status_code=409, detail={"message": str(error), "blocked": error.missing}) from error
    except teaching_report.ReportReplayError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if str(_step_data_for_gate(session, "rep").get("report_key") or "") != report.report_key:
        session["steps"][str(_REPORT_STEP)] = session_model.make_record({"report_key": report.report_key})
    try:
        updated = session_model.validate_session(session)
        saved = await anyio.to_thread.run_sync(
            lambda: db.save_generated_report_and_session(
                user["sub"],
                report.report_key,
                revision,
                report.provenance["manifest_id"],
                report.markdown,
                report.provenance,
                updated,
            )
        )
    except (db.WorkspaceScopeMismatch, db.SessionRevisionConflict) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except session_model.SessionError as error:
        raise HTTPException(status_code=422, detail=f"写入报告记录后会话不合规:{error}") from error
    if saved is None:
        raise HTTPException(status_code=404, detail="学生账号不可用")
    canonical = saved["report"]
    return {
        "report_key": canonical["report_key"],
        "markdown": canonical["markdown"],
        "provenance": canonical["provenance"],
        "suggested_filename": report.suggested_filename,
    }


@router.get("/report/gate")
def report_gate(user: dict = Depends(require_student)):
    row = db.get_session(user["sub"], artifacts.manifest_id())
    session = row["session"] if row else session_model.empty_session(artifacts.manifest_id())
    return {"blocked": teaching_report.check_gate(session, subject=user["sub"], require_trusted=True)}


@router.get("/report/generated")
def my_generated_report(user: dict = Depends(require_student)):
    return db.latest_report(user["sub"]) or {
        "report_key": None,
        "markdown": None,
        "provenance": None,
        "created_at": None,
    }


class SubmitRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    report_key: str = Field(min_length=1, max_length=64)


@router.post("/report/submit")
def submit_report(req: SubmitRequest, user: dict = Depends(require_student)):
    row = db.submit_report(user["sub"], req.title, req.report_key, artifacts.manifest_id())
    if row is None:
        raise HTTPException(status_code=409, detail="找不到当前数据版本下由服务器生成的报告")
    db.record_audit_event(
        "submission.created",
        actor_id=user.get("aid"),
        actor_name=user["sub"],
        target_type="submission",
        target_id=str(row["id"]),
        details={"version_no": row.get("version_no"), "manifest_id": artifacts.manifest_id()},
    )
    return row


@router.get("/report/mine")
def my_report(user: dict = Depends(require_student)):
    return db.my_submission(user["sub"]) or {"state": "none"}


class WorkspaceResetRequest(BaseModel):
    manifest_id: str = Field(min_length=1, max_length=128)
    confirmation: str = Field(min_length=1, max_length=40)


@router.post("/workspace/reset")
def reset_workspace(req: WorkspaceResetRequest, user: dict = Depends(require_student)):
    try:
        result = db.reset_workspace(user["sub"], req.manifest_id, req.confirmation)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except db.WorkspaceScopeMismatch as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
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
        row = db.create_student(req.username, req.display_name, req.password, req.student_no, req.class_id, user["sub"])
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    db.record_audit_event(
        "student.created",
        actor_id=user.get("aid"),
        actor_name=user["sub"],
        target_type="account",
        target_id=str(row["id"]),
        details={"class_id": req.class_id},
    )
    return row


class StudentUpdateRequest(BaseModel):
    display_name: str | None = None
    student_no: str | None = None
    class_id: int | None = None
    active: bool | None = None
    password: str | None = Field(default=None, min_length=12, max_length=256)


@router.post("/students/{account_id}")
def update_student(account_id: int, req: StudentUpdateRequest, user: dict = Depends(require_teacher)):
    fields = req.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")
    row = db.update_student(account_id, fields, user["sub"])
    if row is None:
        raise HTTPException(status_code=404, detail="学生或班级不存在")
    db.record_audit_event(
        "student.updated",
        actor_id=user.get("aid"),
        actor_name=user["sub"],
        target_type="account",
        target_id=str(account_id),
        details={"fields": sorted(fields)},
    )
    return row


@router.get("/submissions")
def submissions(user: dict = Depends(require_teacher)):
    return {"submissions": db.list_submissions(user["sub"])}


@router.get("/submissions/{submission_id}")
def submission_detail(submission_id: int, user: dict = Depends(require_teacher)):
    row = db.get_submission(submission_id, user["sub"])
    if row is None:
        raise HTTPException(status_code=404, detail="当前数据版本下不存在该提交")
    return row


class GradeRequest(BaseModel):
    score: int = Field(ge=0, le=100)
    feedback: str = ""


@router.post("/submissions/{submission_id}/grade")
def grade(submission_id: int, req: GradeRequest, user: dict = Depends(require_teacher)):
    row = db.grade_submission(submission_id, req.score, req.feedback, user["sub"])
    if row is None:
        raise HTTPException(status_code=404, detail="当前数据版本下不存在该提交")
    db.record_audit_event(
        "submission.graded",
        actor_id=user.get("aid"),
        actor_name=user["sub"],
        target_type="submission",
        target_id=str(submission_id),
        details={"score": req.score, "manifest_id": artifacts.manifest_id()},
    )
    return row


@router.get("/submissions/{submission_id}/history")
def submission_history(submission_id: int, user: dict = Depends(require_teacher)):
    row = db.submission_history(submission_id, user["sub"])
    if row is None:
        raise HTTPException(status_code=404, detail="当前数据版本下不存在该提交")
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
