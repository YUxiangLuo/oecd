"""教学面板路由(/api/classroom):学生进度上报/报告提交 + 教师班级管理/评阅/公告。

Bearer 校验由 api.py 的全局中间件完成并把令牌 payload 放进 request.state.user;
这里只做角色鉴权(require_teacher)。db.Unavailable 由 api.py 的全局异常
处理器统一转 503,核心 17 步接口不受教学数据库影响。
"""

import re
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

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


# ---------------------------------------------------------------- 任意登录用户 / 学生


@router.get("/announcements")
def announcements(user: dict = Depends(current_user)):
    return {"announcements": db.list_announcements(user["sub"])}


class ProgressRequest(BaseModel):
    step: int = Field(ge=1, le=db.MAX_STEP)


@router.post("/progress")
def report_progress(req: ProgressRequest, user: dict = Depends(current_user)):
    db.upsert_progress(user["sub"], req.step)
    return {"ok": True}


class SubmitRequest(BaseModel):
    year: int
    title: str = Field(min_length=1, max_length=200)
    design: dict[str, Any]
    markdown: str = Field(min_length=1)


@router.post("/report/submit")
def submit_report(req: SubmitRequest, user: dict = Depends(current_user)):
    row = db.submit_report(user["sub"], req.year, req.title, req.design, req.markdown)
    if row is None:
        raise HTTPException(status_code=404, detail="账号不存在于教学数据库,无法提交")
    return row


@router.get("/report/mine")
def my_report(user: dict = Depends(current_user)):
    return db.my_submission(user["sub"]) or {"state": "none"}


# ---------------------------------------------------------------- 教师


@router.get("/overview")
def overview(class_id: int | None = Query(default=None), _: dict = Depends(require_teacher)):
    return db.overview_stats(class_id)


@router.get("/classes")
def classes(_: dict = Depends(require_teacher)):
    return {"classes": db.list_classes()}


class ClassRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    code: str = Field(min_length=1, max_length=40)
    semester: str = ""
    note: str = ""


@router.post("/classes")
def create_class(req: ClassRequest, _: dict = Depends(require_teacher)):
    try:
        return db.create_class(req.name, req.code, req.semester, req.note)
    except psycopg.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail=f"班级代码 {req.code} 已存在")


@router.get("/students")
def students(class_id: int | None = Query(default=None), _: dict = Depends(require_teacher)):
    return {"students": db.list_students(class_id)}


class StudentCreateRequest(BaseModel):
    username: str = Field(min_length=2, max_length=40)
    display_name: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=6, max_length=100)
    student_no: str = ""
    class_id: int | None = None


@router.post("/students")
def create_student(req: StudentCreateRequest, _: dict = Depends(require_teacher)):
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+", req.username):
        raise HTTPException(status_code=400, detail="用户名只能包含字母、数字、下划线、点与连字符")
    if db.find_account(req.username):
        raise HTTPException(status_code=409, detail=f"用户名 {req.username} 已存在")
    return db.create_student(req.username, req.display_name, req.password, req.student_no, req.class_id)


class StudentUpdateRequest(BaseModel):
    display_name: str | None = None
    student_no: str | None = None
    class_id: int | None = None
    active: bool | None = None
    password: str | None = Field(default=None, min_length=6, max_length=100)


@router.post("/students/{account_id}")
def update_student(account_id: int, req: StudentUpdateRequest, _: dict = Depends(require_teacher)):
    fields = req.model_dump(exclude_none=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")
    row = db.update_student(account_id, fields)
    if row is None:
        raise HTTPException(status_code=404, detail="学生不存在")
    return row


@router.get("/submissions")
def submissions(_: dict = Depends(require_teacher)):
    return {"submissions": db.list_submissions()}


@router.get("/submissions/{submission_id}")
def submission_detail(submission_id: int, _: dict = Depends(require_teacher)):
    row = db.get_submission(submission_id)
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
    return db.create_announcement(req.title, req.body, user["sub"], req.class_id)


@router.delete("/announcements/{announcement_id}")
def delete_announcement(announcement_id: int, _: dict = Depends(require_teacher)):
    if not db.delete_announcement(announcement_id):
        raise HTTPException(status_code=404, detail="公告不存在")
    return {"ok": True}
