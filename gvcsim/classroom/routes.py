"""教学面板路由(/api/classroom):学生进度上报/报告提交 + 教师班级管理/评阅/公告。

Bearer 校验由 api.py 的全局中间件完成并把令牌 payload 放进 request.state.user;
这里只做角色鉴权(require_teacher)。db.Unavailable 由 api.py 的全局异常
处理器统一转 503,核心 16 步接口不受教学数据库影响。
"""

import re
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from gvcsim import artifacts, evidence
from gvcsim import session as session_model
from gvcsim import teaching_report
from gvcsim.classroom import db

router = APIRouter(prefix="/api/classroom")

# 第 16 步(报告)的步号:以 steps.py 为准,不硬编码 16。
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
    """进度上报/报告提交只接受学生令牌,避免教师账号被计入待评阅提交,守住教师/学生分离。"""
    user = current_user(request)
    if user.get("role") != "student":
        raise HTTPException(status_code=403, detail="仅学生可提交")
    return user


# ---------------------------------------------------------------- 任意登录用户 / 学生


@router.get("/announcements")
def announcements(user: dict = Depends(current_user)):
    return {"announcements": db.list_announcements(user["sub"])}


class ProgressRequest(BaseModel):
    step: int = Field(ge=1, le=db.MAX_STEP)


# ---------------------------------------------------------------- 实验会话


@router.get("/session")
def get_session(user: dict = Depends(require_student)):
    """读取可恢复的实验会话。

    会话由另一套数据产物生成时(重新 compute / 换算法),返回 stale=true:
    里面的回归结果已不对应当前产物,不能被静默当作有效结果继续使用。
    """
    current_manifest = artifacts.manifest_id()
    row = db.get_session(user["sub"])
    if row is None:
        empty = session_model.empty_session(current_manifest)
        return {
            "revision": 0,
            "manifest_id": current_manifest,
            "session": empty,
            "stale": False,
            "updated_at": None,
            "completion": evidence.completion_summary(empty),
        }
    return {
        "revision": row["revision"],
        "manifest_id": row["manifest_id"],
        "session": row["session"],
        "stale": session_model.is_stale(row["session"], current_manifest),
        "updated_at": row["updated_at"],
        # 完成度由服务端从会话重算,客户端不参与判定,也无法伪造。
        "completion": evidence.completion_summary(row["session"]),
    }


class SessionRequest(BaseModel):
    # 客户端读到的版本;服务端已被其它标签页推进时用它触发记录级合并。
    base_revision: int = Field(ge=0)
    session: dict[str, Any]


def _merge_and_validate(base: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    """合并两份会话,并对**合并结果**再校验一次。

    put_session 校验的是客户端入参,落库的却是合并结果:两份各自合规的会话
    合起来可能超过 MAX_SESSION_BYTES,不重校验就等于上限可以被合并绕过。
    """
    return session_model.validate_session(session_model.merge_sessions(base, incoming))


@router.put("/session")
def put_session(req: SessionRequest, user: dict = Depends(require_student)):
    try:
        payload = session_model.validate_session(req.session)
    except session_model.SessionError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    current_manifest = artifacts.manifest_id()
    if payload["manifest_id"] != current_manifest:
        raise HTTPException(
            status_code=409,
            detail=f"会话对应的产物({payload['manifest_id']})不是当前产物({current_manifest});请刷新后重新开始实验",
        )

    try:
        saved = db.save_session(user["sub"], payload, req.base_revision, _merge_and_validate)
    except session_model.SessionError as e:
        # 合并结果越界(如两边各自接近上限);入参本身是合规的,所以这里单独报。
        raise HTTPException(status_code=422, detail=f"与服务端已有会话合并后不合规:{e}") from e
    if saved is None:
        raise HTTPException(status_code=404, detail="账号不存在于教学数据库,无法保存实验会话")
    return {
        "revision": saved["revision"],
        "manifest_id": current_manifest,
        "session": saved["session"],
        # 非 None 表示本次写入与另一处的改动做了合并,客户端应改用返回的会话。
        "merged_from": saved["merged_from"],
        "stale": False,
        # 就地回传重算后的完成度:学生做完一步后,对勾来自服务端判定。
        "completion": evidence.completion_summary(saved["session"]),
    }


@router.delete("/session")
def delete_session(user: dict = Depends(require_student)):
    db.clear_session(user["sub"])
    return {"ok": True}


@router.get("/progress")
def get_progress(user: dict = Depends(require_student)):
    row = db.get_progress(user["sub"])
    return row or {"current_step": None, "max_step": None, "updated_at": None}


@router.post("/progress")
def report_progress(req: ProgressRequest, user: dict = Depends(require_student)):
    db.upsert_progress(user["sub"], req.step)
    return {"ok": True}


# ---------------------------------------------------------------- 第 16 步:实验报告


def _load_session_for_report(username: str) -> tuple[dict[str, Any], int]:
    """没有会话时当作空会话:这样"还没开始做"和"做了一半"走同一条门槛路径,
    学生得到的都是"还差哪几步",而不是一句无从下手的"没有会话"。"""
    row = db.get_session(username)
    if row is None:
        return session_model.empty_session(artifacts.manifest_id()), 0
    return row["session"], row["revision"]


@router.post("/report/generate")
def generate_report(user: dict = Depends(require_student)):
    """由服务端从实验会话生成报告。

    前 15 步证据不齐时拒绝(409),并返回还差什么;报告正文与其中的回归结果
    都由服务端重算,不接受任何客户端提供的内容。
    """
    session, revision = _load_session_for_report(user["sub"])
    try:
        report = teaching_report.build(session, user.get("name") or user["sub"], revision)
    except teaching_report.ReportGateError as e:
        raise HTTPException(status_code=409, detail={"message": str(e), "blocked": e.missing}) from e

    # 第 16 步的证据由服务端写入,而不是让客户端声称“我生成过报告”。
    # 先把带报告证据的会话校验好再落库:否则校验失败时报告已经写进 reports 表,
    # 学生看到 500、库里却躺着一份报告、第 16 步证据还没写上,三者互相矛盾。
    session["steps"][str(_REPORT_STEP)] = session_model.make_record({"report_key": report.report_key})
    try:
        updated = session_model.validate_session(session)
    except session_model.SessionError as e:
        raise HTTPException(status_code=422, detail=f"写入报告证据后会话不合规:{e}") from e

    saved = db.save_report(
        user["sub"], report.report_key, revision, report.provenance["manifest_id"], report.markdown, report.provenance
    )
    if saved is None:
        raise HTTPException(status_code=404, detail="账号不存在于教学数据库,无法保存报告")
    if db.save_session(user["sub"], updated, revision, _merge_and_validate) is None:
        raise HTTPException(status_code=404, detail="账号不存在于教学数据库,无法保存实验会话")
    return report.to_dict()


@router.get("/report/gate")
def report_gate(user: dict = Depends(require_student)):
    """第 16 步的前置门槛状态:还差哪些步骤的证据。"""
    row = db.get_session(user["sub"])
    session = row["session"] if row else session_model.empty_session(artifacts.manifest_id())
    return {"blocked": teaching_report.check_gate(session)}


@router.get("/report/generated")
def my_generated_report(user: dict = Depends(require_student)):
    """重新打开上次生成的报告全文(刷新/重新登录后仍可读)。"""
    row = db.latest_report(user["sub"])
    if row is None:
        return {"report_key": None, "markdown": None, "provenance": None, "created_at": None}
    return row


class SubmitRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    # 只接受报告指纹;正文由服务端从 reports 表取,接口不收 Markdown。
    report_key: str = Field(min_length=1, max_length=64)


@router.post("/report/submit")
def submit_report(req: SubmitRequest, user: dict = Depends(require_student)):
    row = db.submit_report(user["sub"], req.title, req.report_key)
    if row is None:
        raise HTTPException(
            status_code=409,
            detail="找不到该 report_key 对应的报告;请先在第 16 步生成报告后再提交",
        )
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
    except psycopg.errors.UniqueViolation as e:
        raise HTTPException(status_code=409, detail=f"班级代码 {req.code} 已存在") from e


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
