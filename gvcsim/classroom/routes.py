"""教学面板路由(/api/classroom):学生进度上报/报告提交 + 教师班级管理/评阅/公告。

Bearer 校验由 api.py 的全局中间件完成并把令牌 payload 放进 request.state.user;
这里只做角色鉴权(require_teacher)。db.Unavailable 由 api.py 的全局异常
处理器统一转 503,核心 16 步接口不受教学数据库影响。
"""

import re
from datetime import datetime
from typing import Any, Self

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, model_validator

from gvcsim import artifacts, evidence, quizzes, trusted_evidence
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


def _public_context(scope: dict[str, Any] | None) -> dict[str, Any]:
    if not scope:
        return {
            "course_run_id": None,
            "course_run_code": None,
            "course_run_name": None,
            "course_run_term": None,
            "assignment_id": None,
            "assignment_title": None,
            "attempt_id": None,
            "assignment_scope": None,
            "manifest_mismatch": False,
            "assignment_closed": False,
            "assignment_historical": False,
            "due_at": None,
        }
    return {
        "course_run_id": scope.get("course_run_id"),
        "course_run_code": scope.get("course_run_code"),
        "course_run_name": scope.get("course_run_name"),
        "course_run_term": scope.get("course_run_term"),
        "assignment_id": scope.get("assignment_id"),
        "assignment_title": scope.get("assignment_title"),
        "attempt_id": scope.get("attempt_id"),
        "assignment_scope": scope.get("assignment_scope"),
        "assignment_manifest_id": scope.get("assignment_manifest_id"),
        "manifest_mismatch": bool(scope.get("manifest_mismatch")),
        "assignment_closed": bool(scope.get("assignment_closed")),
        "assignment_historical": bool(scope.get("assignment_historical")),
        "due_at": scope.get("due_at"),
    }


@router.get("/context")
def classroom_context(user: dict = Depends(require_student)):
    """返回稳定的本地会话隔离键；旧客户端可忽略新增字段。"""
    return _public_context(db.assignment_context(user["sub"], artifacts.manifest_id()))


class AssignmentSelectionRequest(BaseModel):
    assignment_id: int = Field(gt=0)


@router.get("/assignment-contexts")
def assignment_contexts(user: dict = Depends(require_student)):
    """显式列出当前作业和有记录的历史作业，不再让“最新”代替用户选择。"""
    rows = db.list_student_assignment_contexts(user["sub"], artifacts.manifest_id())
    return {"assignments": rows}


@router.post("/assignment-context/select")
def select_assignment_context(req: AssignmentSelectionRequest, user: dict = Depends(require_student)):
    scope = db.select_student_assignment(user["sub"], req.assignment_id, artifacts.manifest_id())
    if scope is None:
        raise HTTPException(status_code=404, detail="作业不属于当前账号，或尚未开放且没有可查看的历史记录")
    return _public_context(scope)


# ---------------------------------------------------------------- 实验会话


@router.get("/session")
def get_session(user: dict = Depends(require_student)):
    """读取可恢复的实验会话。

    会话由另一套数据产物生成时(重新 compute / 换算法),返回 stale=true:
    里面的回归结果已不对应当前产物,不能被静默当作有效结果继续使用。
    """
    current_manifest = artifacts.manifest_id()
    scope = db.assignment_context(user["sub"], current_manifest)
    context = _public_context(scope)
    row = db.get_session(user["sub"])
    if row is None:
        empty = session_model.empty_session(current_manifest)
        return {
            "revision": 0,
            "manifest_id": current_manifest,
            "session": empty,
            "stale": bool(context["manifest_mismatch"]),
            "legacy_unverified": False,
            "read_only": bool(
                context["manifest_mismatch"]
                or context["assignment_closed"]
                or context["assignment_historical"]
            ),
            **context,
            "updated_at": None,
            "completion": evidence.completion_summary(empty, subject=user["sub"], require_trusted=True),
        }
    legacy = bool(row.get("legacy_unverified"))
    stale = bool(context["manifest_mismatch"]) or legacy or session_model.is_stale(row["session"], current_manifest)
    completion = (
        evidence.completion_summary(
            session_model.empty_session(current_manifest), subject=user["sub"], require_trusted=True
        )
        if legacy
        else evidence.completion_summary(row["session"], subject=user["sub"], require_trusted=True)
    )
    return {
        "revision": row["revision"],
        "manifest_id": row["manifest_id"],
        "session": row["session"],
        "stale": stale,
        "legacy_unverified": legacy,
        "read_only": legacy or bool(
            context["manifest_mismatch"]
            or context["assignment_closed"]
            or context["assignment_historical"]
        ),
        **context,
        "updated_at": row["updated_at"],
        # 完成度由服务端从会话重算,客户端不参与判定,也无法伪造。
        "completion": completion,
    }


class QuizSubmitRequest(BaseModel):
    step: int = Field(ge=1, le=15)
    version: str = Field(min_length=1, max_length=80)
    answers: dict[str, str]


@router.post("/quiz/submit")
def submit_quiz(req: QuizSubmitRequest, user: dict = Depends(require_student)):
    """判定固定单选题；全部正确后才持久化事件并签发可信凭证。"""
    _ensure_current_assignment(user["sub"])
    try:
        passed, normalized, results = quizzes.grade(req.step, req.version, req.answers)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    response: dict[str, Any] = {
        "passed": passed,
        "version": quizzes.QUIZ_VERSION,
        "results": results,
    }
    if not passed:
        return response

    current_manifest = artifacts.manifest_id()
    payload = {"version": quizzes.QUIZ_VERSION, "answers": normalized}
    payload_sha256 = trusted_evidence.digest(payload)
    try:
        event = db.record_evidence_event(
            user["sub"],
            req.step,
            "quiz",
            current_manifest,
            payload_sha256,
            {"payload": payload},
        )
    except (db.AssignmentScopeMismatch, db.AssignmentClosed) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if artifacts.manifest_id() != current_manifest:
        raise HTTPException(status_code=409, detail="判定答题期间数据产物已切换，请刷新后重新提交")
    response["quiz_id"] = trusted_evidence.issue_quiz_completion(
        subject=user["sub"],
        step=req.step,
        manifest_id=current_manifest,
        payload=payload,
        event=event,
    )
    response["quiz"] = payload
    return response


class SessionRequest(BaseModel):
    # 客户端读到的版本;服务端已被其它标签页推进时用它触发记录/字段级合并。
    base_revision: int = Field(ge=0)
    # 浏览器加载会话时看到的稳定边界。服务端必须在同一事务里核对，防止旧标签页
    # 在教师重置/重新发布后把旧会话写进刚创建的新 attempt。
    expected_assignment_id: int = Field(gt=0)
    expected_attempt_id: int = Field(gt=0)
    session: dict[str, Any]


class AttemptBoundaryRequest(BaseModel):
    """调用方看到的作业边界；reset 不得漂移到另一个标签页新建的 attempt。"""

    expected_assignment_id: int = Field(gt=0)
    expected_attempt_id: int = Field(gt=0)


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

    # 第 16 步是服务端报告生成事件，客户端上传的 report_key 一律忽略；合并时
    # 仍会保留 base 中由服务端写入的真实记录。
    payload["steps"].pop(str(_REPORT_STEP), None)

    current_manifest = artifacts.manifest_id()
    if payload["manifest_id"] != current_manifest:
        raise HTTPException(
            status_code=409,
            detail=f"会话对应的产物({payload['manifest_id']})不是当前产物({current_manifest});请刷新后重新开始实验",
        )

    try:
        saved = db.save_session(
            user["sub"],
            payload,
            req.base_revision,
            _merge_and_validate,
            expected_assignment_id=req.expected_assignment_id,
            expected_attempt_id=req.expected_attempt_id,
        )
    except (db.AssignmentScopeMismatch, db.AssignmentClosed, db.LegacySessionReadOnly) as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
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
        "completion": evidence.completion_summary(saved["session"], subject=user["sub"], require_trusted=True),
    }


@router.delete("/session")
def delete_session(req: AttemptBoundaryRequest, user: dict = Depends(require_student)):
    try:
        db.clear_session(
            user["sub"],
            expected_assignment_id=req.expected_assignment_id,
            expected_attempt_id=req.expected_attempt_id,
        )
    except (db.AssignmentScopeMismatch, db.AssignmentClosed) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    after = db.assignment_context(user["sub"], artifacts.manifest_id())
    db.record_audit_event(
        "experiment.reset",
        actor_id=user.get("aid"),
        actor_name=user["sub"],
        target_type="attempt",
        target_id=str(req.expected_attempt_id),
        details={"new_attempt_id": (after or {}).get("attempt_id")},
    )
    return {"ok": True, **_public_context(after)}


@router.get("/progress")
def get_progress(user: dict = Depends(require_student)):
    row = db.get_progress(user["sub"])
    return row or {"current_step": None, "max_step": None, "updated_at": None}


@router.post("/progress")
def report_progress(req: ProgressRequest, user: dict = Depends(require_student)):
    try:
        db.upsert_progress(user["sub"], req.step)
    except db.AssignmentClosed as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return {"ok": True}


# ---------------------------------------------------------------- 第 16 步:实验报告


def _load_session_for_report(username: str) -> tuple[dict[str, Any], int]:
    """没有会话时当作空会话:这样"还没开始做"和"做了一半"走同一条门槛路径,
    学生得到的都是"还差哪几步",而不是一句无从下手的"没有会话"。"""
    row = db.get_session(username)
    if row is None:
        return session_model.empty_session(artifacts.manifest_id()), 0
    return row["session"], row["revision"]


def _ensure_current_assignment(username: str) -> dict[str, Any]:
    scope = db.assignment_context(username, artifacts.manifest_id())
    if not scope:
        raise HTTPException(status_code=409, detail="账号没有开放的课程作业/enrollment")
    if scope.get("manifest_mismatch"):
        raise HTTPException(
            status_code=409,
            detail="当前作业绑定的产物版本与服务器当前 release 不一致；请联系教师发布新 assignment",
        )
    if scope.get("assignment_historical"):
        raise HTTPException(status_code=409, detail="这是历史作业；进度、报告与评分可查看，但不能继续写入")
    if scope.get("assignment_closed"):
        raise HTTPException(
            status_code=409,
            detail=f"作业已于 {scope.get('due_at')} 截止；既有记录仍可查看，但不能继续生成或提交报告",
        )
    return scope


def _step_data_for_gate(session: dict[str, Any], lab: str) -> dict[str, Any]:
    step = next(n for n, value in evidence.STEP_LABS.items() if value == lab)
    record = session.get("steps", {}).get(str(step))
    data = record.get("data") if isinstance(record, dict) else None
    return data if isinstance(data, dict) else {}


@router.post("/report/generate")
def generate_report(user: dict = Depends(require_student)):
    """由服务端从实验会话生成报告。

    前 15 步答题未全部通过时拒绝(409),并返回还差什么;报告正文与其中实际
    运行过的回归结果都由服务端生成,不接受任何客户端提供的正文。
    """
    _ensure_current_assignment(user["sub"])
    session, revision = _load_session_for_report(user["sub"])
    try:
        report = teaching_report.build(
            session,
            user.get("name") or user["sub"],
            revision,
            subject=user["sub"],
            require_trusted=True,
        )
    except teaching_report.ReportGateError as e:
        raise HTTPException(status_code=409, detail={"message": str(e), "blocked": e.missing}) from e
    except teaching_report.ReportReplayError as e:
        # 已通过可信收据校验的运行不能被静默降级成“未运行”。复估异常通常表示
        # 当前服务实例或产物暂时不完整；不落半份报告，让学生可以重试。
        raise HTTPException(status_code=503, detail=str(e)) from e

    # 第 16 步的完成记录由服务端写入,而不是让客户端声称“我生成过报告”。
    # 先把记录写进会话并校验，再与报告一起原子落库。
    existing_report_key = str(_step_data_for_gate(session, "rep").get("report_key") or "")
    if existing_report_key != report.report_key:
        session["steps"][str(_REPORT_STEP)] = session_model.make_record({"report_key": report.report_key})
    try:
        updated = session_model.validate_session(session)
    except session_model.SessionError as e:
        raise HTTPException(status_code=422, detail=f"写入报告记录后会话不合规:{e}") from e

    try:
        saved = db.save_generated_report_and_session(
            user["sub"],
            report.report_key,
            revision,
            report.provenance["manifest_id"],
            report.markdown,
            report.provenance,
            updated,
        )
    except (
        db.AssignmentScopeMismatch,
        db.AssignmentClosed,
        db.LegacySessionReadOnly,
        db.SessionRevisionConflict,
    ) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if saved is None:
        raise HTTPException(status_code=404, detail="账号不存在于教学数据库,无法保存实验会话")
    # 相同 report_key 是不可变内容实体。重复生成时返回数据库中第一次落下的
    # canonical 正文/溯源，而不是带新 generated_at/session revision 的临时对象。
    canonical = saved["report"]
    return {
        "report_key": canonical["report_key"],
        "markdown": canonical["markdown"],
        "provenance": canonical["provenance"],
        "suggested_filename": report.suggested_filename,
    }


@router.get("/report/gate")
def report_gate(user: dict = Depends(require_student)):
    """第 16 步的前置门槛状态:还差哪些步骤的理解检查。"""
    _ensure_current_assignment(user["sub"])
    row = db.get_session(user["sub"])
    session = row["session"] if row else session_model.empty_session(artifacts.manifest_id())
    return {"blocked": teaching_report.check_gate(session, subject=user["sub"], require_trusted=True)}


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
    _ensure_current_assignment(user["sub"])
    row = db.submit_report(user["sub"], req.title, req.report_key, artifacts.manifest_id())
    if row is None:
        raise HTTPException(
            status_code=409,
            detail="找不到该 report_key 对应的报告;请先在第 16 步生成报告后再提交",
        )
    db.record_audit_event(
        "submission.created",
        actor_id=user.get("aid"),
        actor_name=user["sub"],
        target_type="submission",
        target_id=str(row["id"]),
        details={"version_no": row.get("version_no")},
    )
    return row


@router.get("/report/mine")
def my_report(user: dict = Depends(require_student)):
    return db.my_submission(user["sub"]) or {"state": "none"}


@router.post("/attempts/new")
def new_attempt(req: AttemptBoundaryRequest, user: dict = Depends(require_student)):
    try:
        scope = db.start_new_attempt(
            user["sub"],
            artifacts.manifest_id(),
            expected_assignment_id=req.expected_assignment_id,
            expected_attempt_id=req.expected_attempt_id,
        )
    except (db.AssignmentScopeMismatch, db.AssignmentClosed) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    db.record_audit_event(
        "attempt.started",
        actor_id=user.get("aid"),
        actor_name=user["sub"],
        target_type="attempt",
        target_id=str(scope["attempt_id"]),
        details={"assignment_id": scope["assignment_id"], "attempt_no": scope["attempt_no"]},
    )
    return _public_context(scope)


# ---------------------------------------------------------------- 教师


class CourseRunRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    code: str = Field(min_length=1, max_length=40, pattern=r"^[a-zA-Z0-9_.-]+$")
    term: str = Field(default="", max_length=80)
    release_tag: str = Field(default="", max_length=80)


class ArchiveRequest(BaseModel):
    archived: bool = True


@router.get("/course-runs")
def course_runs(user: dict = Depends(require_teacher)):
    return {"course_runs": db.list_course_runs(user["sub"])}


@router.post("/course-runs")
def create_course_run(req: CourseRunRequest, user: dict = Depends(require_teacher)):
    try:
        row = db.create_course_run(user["sub"], req.name, req.code, req.term, req.release_tag)
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail=f"课程运行代码 {req.code} 已存在") from error
    db.record_audit_event(
        "course_run.created",
        actor_id=user.get("aid"),
        actor_name=user["sub"],
        target_type="course_run",
        target_id=str(row["id"]),
        details={"code": row["code"]},
    )
    return row


@router.post("/course-runs/{course_run_id}/archive")
def archive_course_run(course_run_id: int, req: ArchiveRequest, user: dict = Depends(require_teacher)):
    row = db.set_course_run_archived(user["sub"], course_run_id, req.archived)
    if row is None:
        raise HTTPException(status_code=404, detail="课程运行不存在或无权访问")
    return row


class AssignmentRequest(BaseModel):
    course_run_id: int
    slug: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_.-]+$")
    title: str = Field(min_length=1, max_length=160)
    manifest_id: str = Field(min_length=1, max_length=128)
    release_tag: str = Field(default="", max_length=80)
    opens_at: datetime | None = None
    due_at: datetime | None = None

    @model_validator(mode="after")
    def valid_window(self) -> Self:
        if self.opens_at is not None and self.due_at is not None:
            try:
                invalid_window = self.due_at <= self.opens_at
            except TypeError as error:
                raise ValueError("opens_at 与 due_at 必须使用一致的时区格式") from error
            if invalid_window:
                raise ValueError("due_at 必须晚于 opens_at")
        return self


class AssignmentStateRequest(BaseModel):
    active: bool


@router.get("/assignments")
def assignments(course_run_id: int | None = Query(default=None), user: dict = Depends(require_teacher)):
    return {"assignments": db.list_assignments(user["sub"], course_run_id)}


@router.post("/assignments")
def create_assignment(req: AssignmentRequest, user: dict = Depends(require_teacher)):
    if req.manifest_id != artifacts.manifest_id():
        raise HTTPException(status_code=409, detail="新作业必须绑定当前服务器 artifact manifest")
    try:
        row = db.create_assignment(
            user["sub"],
            req.course_run_id,
            req.slug,
            req.title,
            req.manifest_id,
            req.release_tag,
            req.opens_at,
            req.due_at,
        )
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail="该课程运行内 assignment slug 已存在") from error
    db.record_audit_event(
        "assignment.created",
        actor_id=user.get("aid"),
        actor_name=user["sub"],
        target_type="assignment",
        target_id=str(row["id"]),
        details={"manifest_id": row["manifest_id"]},
    )
    return row


@router.post("/assignments/{assignment_id}/state")
def assignment_state(assignment_id: int, req: AssignmentStateRequest, user: dict = Depends(require_teacher)):
    if req.active:
        assignment = next(
            (row for row in db.list_assignments(user["sub"]) if row["id"] == assignment_id),
            None,
        )
        if assignment is None:
            raise HTTPException(status_code=404, detail="作业不存在或无权访问")
        if assignment["manifest_id"] != artifacts.manifest_id():
            raise HTTPException(status_code=409, detail="历史 artifact manifest 的作业不能重新激活；请发布新作业")
    row = db.set_assignment_active(user["sub"], assignment_id, req.active)
    if row is None:
        raise HTTPException(status_code=404, detail="作业不存在或无权访问")
    return row


class EnrollmentRequest(BaseModel):
    course_run_id: int
    account_id: int
    class_id: int | None = None


@router.get("/enrollments")
def enrollments(course_run_id: int = Query(gt=0), user: dict = Depends(require_teacher)):
    try:
        return {"enrollments": db.list_enrollments(user["sub"], course_run_id)}
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error


@router.post("/enrollments")
def enroll(req: EnrollmentRequest, user: dict = Depends(require_teacher)):
    try:
        row = db.enroll_student(user["sub"], req.course_run_id, req.account_id, req.class_id)
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    db.record_audit_event(
        "enrollment.upserted",
        actor_id=user.get("aid"),
        actor_name=user["sub"],
        target_type="enrollment",
        target_id=str(row["id"]),
        details={"account_id": req.account_id},
    )
    return row


@router.get("/overview")
def overview(class_id: int | None = Query(default=None), user: dict = Depends(require_teacher)):
    if class_id is not None and not db.teacher_can_access_class(user["sub"], class_id):
        raise HTTPException(status_code=403, detail="教师无权访问该班级")
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
    except psycopg.errors.UniqueViolation as e:
        raise HTTPException(status_code=409, detail=f"班级代码 {req.code} 已存在") from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e


@router.get("/students")
def students(class_id: int | None = Query(default=None), user: dict = Depends(require_teacher)):
    if class_id is not None and not db.teacher_can_access_class(user["sub"], class_id):
        raise HTTPException(status_code=403, detail="教师无权访问该班级")
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
    if req.class_id is None:
        raise HTTPException(status_code=400, detail="必须选择当前教师有权管理的班级")
    try:
        row = db.create_student(req.username, req.display_name, req.password, req.student_no, req.class_id, user["sub"])
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
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
    fields = req.model_dump(exclude_none=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")
    row = db.update_student(account_id, fields, user["sub"])
    if row is None:
        raise HTTPException(status_code=404, detail="学生不存在")
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
    db.record_audit_event(
        "submission.graded",
        actor_id=user.get("aid"),
        actor_name=user["sub"],
        target_type="submission",
        target_id=str(submission_id),
        details={"score": req.score},
    )
    return row


@router.get("/submissions/{submission_id}/history")
def submission_history(submission_id: int, user: dict = Depends(require_teacher)):
    row = db.submission_history(submission_id, user["sub"])
    if row is None:
        raise HTTPException(status_code=404, detail="提交不存在或无权访问")
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
        raise HTTPException(status_code=403, detail=str(error)) from error


@router.delete("/announcements/{announcement_id}")
def delete_announcement(announcement_id: int, user: dict = Depends(require_teacher)):
    if not db.delete_announcement(announcement_id, user["sub"]):
        raise HTTPException(status_code=404, detail="公告不存在")
    return {"ok": True}
