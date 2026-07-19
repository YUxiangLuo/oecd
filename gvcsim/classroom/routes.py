"""教学面板路由(/api/classroom):学生进度上报/报告提交 + 教师班级管理/评阅/公告。

Bearer 校验由 api.py 的全局中间件完成并把令牌 payload 放进 request.state.user;
这里只做角色鉴权(require_teacher)。db.Unavailable 由 api.py 的全局异常
处理器统一转 503,核心 16 步接口不受教学数据库影响。
"""

import re
import math
import json
from datetime import datetime
from typing import Any, Self

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, model_validator

from gvcsim import artifacts, evidence, shocks, trusted_evidence
from gvcsim import session as session_model
from gvcsim import teaching_report
from gvcsim.classroom import db
from gvcsim.config import PROCESSED_DIR
from gvcsim.data import icio_browser

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
            "assignment_id": None,
            "attempt_id": None,
            "assignment_scope": None,
            "manifest_mismatch": False,
            "assignment_closed": False,
            "due_at": None,
        }
    return {
        "course_run_id": scope.get("course_run_id"),
        "assignment_id": scope.get("assignment_id"),
        "attempt_id": scope.get("attempt_id"),
        "assignment_scope": scope.get("assignment_scope"),
        "assignment_manifest_id": scope.get("assignment_manifest_id"),
        "manifest_mismatch": bool(scope.get("manifest_mismatch")),
        "assignment_closed": bool(scope.get("assignment_closed")),
        "due_at": scope.get("due_at"),
    }


@router.get("/context")
def classroom_context(user: dict = Depends(require_student)):
    """返回稳定的本地会话隔离键；旧客户端可忽略新增字段。"""
    return _public_context(db.assignment_context(user["sub"], artifacts.manifest_id()))


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
            "read_only": bool(context["manifest_mismatch"] or context["assignment_closed"]),
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
        "read_only": legacy or bool(context["manifest_mismatch"] or context["assignment_closed"]),
        **context,
        "updated_at": row["updated_at"],
        # 完成度由服务端从会话重算,客户端不参与判定,也无法伪造。
        "completion": completion,
    }


class EvidenceIssueRequest(BaseModel):
    step: int = Field(ge=1, le=db.MAX_STEP)
    kind: str = Field(min_length=1, max_length=32)
    payload: dict[str, Any]


_INDICATOR_METRICS = {
    3: "FVA_share",
    4: "3b_VA_GVC_C_share",
    5: "GVCPs",
    6: "betweenesscentrality",
}
_VIZ_METRICS = {
    7: {"FVA_share", "DVAex_share"},
    8: {"3_VA_GVC_share", "3b_VA_GVC_C_share"},
    9: {"PLv_GVC", "PLy_GVC", "GVCPs"},
    10: {"betweenesscentrality", "weighted degree"},
}
_VIZ_CHARTS = {
    7: {"quadrant", "decompose", "rank"},
    8: {"ladder", "rank", "industry"},
    9: {"position", "bars", "rank"},
    10: {"heat", "network"},
}


def _derived_metric(row: dict[str, Any], metric: str) -> float:
    if metric == "FVA_share":
        gross = sum(float(row.get(key) or 0) for key in ("DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"))
        return float(row["FVA"]) / gross if gross > 0 else math.nan
    if metric == "DVAex_share":
        gross = sum(float(row.get(key) or 0) for key in ("DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"))
        return float(row["DVAex"]) / gross if gross > 0 else math.nan
    if metric == "3_VA_GVC_share":
        return float(row["3_VA_GVC"]) / float(row["SVA"]) if float(row["SVA"]) > 0 else math.nan
    if metric == "3b_VA_GVC_C_share":
        return float(row["3b_VA_GVC_C"]) / float(row["SVA"]) if float(row["SVA"]) > 0 else math.nan
    return float(row[metric])


def _verify_observations(
    step: int,
    payload: dict[str, Any],
    *,
    allowed_metrics: set[str],
    industry: bool,
) -> None:
    observations = payload.get("observations")
    metric = str(payload.get("metric") or "")
    if metric not in allowed_metrics:
        raise ValueError(f"步骤 {step} 的可核查指标必须是 {sorted(allowed_metrics)}")
    if not isinstance(observations, list) or len(observations) < 2:
        raise ValueError("请提交至少两个由当前图表/表格读取的数值 observations")
    countries: set[str] = set()
    for observation in observations:
        if not isinstance(observation, dict):
            raise ValueError("observation 必须是对象")
        country = str(observation.get("country") or "")
        year = int(observation.get("year") or 0)
        industry_code = str(observation.get("industry") or "")
        if not country or not year or industry and not industry_code:
            raise ValueError("observation 缺少 country/year/industry")
        path = PROCESSED_DIR / f"indicators_{'industry' if industry else 'country'}_{year}.csv"
        frame = artifacts.read_csv_artifact(path, require_current=True)
        selected = frame[frame["country"].astype(str) == country]
        if industry:
            selected = selected[selected["industry"].astype(str) == industry_code]
        if selected.empty:
            raise ValueError(f"当前产物中找不到 {country}·{industry_code or '国家'}·{year}")
        expected = _derived_metric(selected.iloc[0].to_dict(), metric)
        raw_value = observation.get("value")
        if raw_value is None:
            raise ValueError("observation 缺少 value")
        supplied = float(raw_value)
        if (
            not math.isfinite(expected)
            or not math.isfinite(supplied)
            or not math.isclose(expected, supplied, rel_tol=1e-6, abs_tol=1e-9)
        ):
            raise ValueError(f"{country}·{industry_code or '国家'} 的 {metric} 与当前产物不一致")
        countries.add(country)
    if len(countries) < 2:
        raise ValueError("observations 必须覆盖至少两个不同经济体")
    compared = set(str(item) for item in payload.get("compared") or [])
    if not countries.issubset(compared):
        raise ValueError("observations 与当前 compared 对象不一致")


def _verify_learning_payload(step: int, kind: str, payload: dict[str, Any]) -> None:
    if kind == "qc_resolution":
        year = int(payload.get("year") or 0)
        path = PROCESSED_DIR / f"qc_{year}.json"
        artifacts.validate_artifact(path)
        checks = json.loads(path.read_text(encoding="utf-8"))
        disclosure_levels = {"disclosure", "warning", "fatal"}
        failed = [
            str(item.get("name"))
            for item in checks
            if isinstance(item, dict) and (not item.get("passed") or item.get("severity") in disclosure_levels)
        ]
        controls_path = PROCESSED_DIR / "qc_controls.json"
        artifacts.validate_artifact(controls_path)
        controls_checks = json.loads(controls_path.read_text(encoding="utf-8"))
        failed += [
            "控制变量: " + str(item.get("name"))
            for item in controls_checks
            if isinstance(item, dict) and (not item.get("passed") or item.get("severity") in disclosure_levels)
        ]
        payload["failed_checks"] = failed
        payload["disclosure_checks"] = failed
        payload["qc_manifest_id"] = artifacts.manifest_id()
        disposition = payload.get("disposition")
        if disposition == "stop":
            payload["retest_passed"] = False
        elif disposition == "fix":
            year_status = (artifacts.manifest_provenance().get("qc") or {}).get("years", {}).get(str(year), {})
            if failed or year_status.get("fatal") or year_status.get("override"):
                raise ValueError("当前 manifest 的 QC 仍有 fatal/override；请先修正原始数据、重算并通过复检")
            payload["retest_passed"] = True
        elif disposition == "disclose":
            disclosed = set(str(item) for item in payload.get("disclosures") or [])
            if not failed or not set(failed).issubset(disclosed):
                raise ValueError("披露列表必须逐项包含当前 QC 的全部失败检查")
            payload["disclosures"] = failed
            payload["retest_passed"] = False
    elif kind == "slice":
        slice_ = payload.get("slice")
        if not isinstance(slice_, dict):
            raise ValueError("缺少 slice")
        observation = payload.get("observation")
        if not isinstance(observation, dict):
            raise ValueError("缺少当前切片的 observation")
        result = icio_browser.slice_table(
            year=int(slice_["year"]),
            table=str(slice_["table"]),
            row_country=str(slice_["row_country"]),
            col_country=str(slice_.get("col_country") or "") or None,
            row_sector=str(slice_.get("row_sector") or "") or None,
            col_sector=str(slice_.get("col_sector") or "") or None,
            page=1,
            page_size=200,
        )
        if not result.get("rows"):
            raise ValueError("当前 OECD ICIO 原始数据中该切片为空")
        row_label = str(observation.get("row") or "")
        column = str(observation.get("column") or "")
        if not row_label or column == "row" or column not in result.get("columns", []):
            raise ValueError("observation 的行或列不属于当前切片")
        matched = next(
            (row for row in result["rows"] if isinstance(row, dict) and str(row.get("row") or "") == row_label),
            None,
        )
        if matched is None or column not in matched:
            raise ValueError("observation 的行或列不属于当前切片")
        supplied_raw = observation.get("value")
        expected_raw = matched[column]
        if (
            isinstance(supplied_raw, bool)
            or not isinstance(supplied_raw, (int, float))
            or isinstance(expected_raw, bool)
            or not isinstance(expected_raw, (int, float))
        ):
            raise ValueError("observation.value 必须是当前切片中的有限数值")
        supplied = float(supplied_raw)
        expected = float(expected_raw)
        if (
            not math.isfinite(supplied)
            or not math.isfinite(expected)
            or not math.isclose(supplied, expected, rel_tol=1e-9, abs_tol=1e-12)
        ):
            raise ValueError("observation.value 与当前切片中的服务端原始值不一致")
    elif kind == "indicator":
        _verify_observations(
            step,
            payload,
            allowed_metrics={_INDICATOR_METRICS[step]},
            industry=True,
        )
    elif kind == "visualization":
        if payload.get("chart") not in _VIZ_CHARTS[step]:
            raise ValueError(f"步骤 {step} 的 chart 无法识别")
        _verify_observations(
            step,
            payload,
            allowed_metrics=_VIZ_METRICS[step],
            industry=step == 10,
        )
    elif kind == "shock":
        if payload.get("qc_reviewed") is not True:
            raise ValueError("必须查看并确认当前 shock panel QC 后才能签发证据")
        shock_qc_path = PROCESSED_DIR / "qc_shocks.json"
        artifacts.validate_artifact(shock_qc_path)
        shock_qc = json.loads(shock_qc_path.read_text(encoding="utf-8"))
        payload["shock_qc_failures"] = [
            str(item.get("name")) for item in shock_qc if isinstance(item, dict) and not item.get("passed")
        ]
        viewed = set(str(name) for name in payload.get("viewed_events") or [])
        metadata = {str(item["name"]): str(item["shock_type"]) for item in shocks.events_metadata()}
        if any(name not in metadata for name in viewed):
            raise ValueError("viewed_events 含未登记事件")
        frame = shocks.load_shocks()
        note_columns = [column for column in frame if column == "note" or column.endswith("_note")]
        panel_events = {
            str(value) for column in note_columns for value in frame[column].dropna().unique() if str(value)
        }
        absent = viewed - panel_events
        if absent:
            raise ValueError("事件没有对应当前 shock panel 行:" + "、".join(sorted(absent)))


@router.post("/evidence/issue")
def issue_evidence(req: EvidenceIssueRequest, user: dict = Depends(require_student)):
    """校验一次学习动作/CER，并签发绑定学生、步骤与当前 manifest 的收据。"""
    current_manifest = artifacts.manifest_id()
    try:
        clean = evidence.normalize_issue_payload(req.step, req.kind, req.payload)
        _verify_learning_payload(req.step, req.kind, clean)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if artifacts.manifest_id() != current_manifest:
        raise HTTPException(status_code=409, detail="核验证据期间数据产物已切换，请刷新后重新提交")
    payload_sha256 = trusted_evidence.digest(clean)
    try:
        event = db.record_evidence_event(
            user["sub"],
            req.step,
            req.kind,
            current_manifest,
            payload_sha256,
            {"payload": clean},
        )
    except (db.AssignmentScopeMismatch, db.AssignmentClosed) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    evidence_id = trusted_evidence.issue_learning_evidence(
        subject=user["sub"],
        step=req.step,
        kind=req.kind,
        manifest_id=current_manifest,
        payload=clean,
        event=event,
    )
    return {"evidence_id": evidence_id, "evidence": clean}


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
        saved = db.save_session(user["sub"], payload, req.base_revision, _merge_and_validate)
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
def delete_session(user: dict = Depends(require_student)):
    before = db.assignment_context(user["sub"])
    try:
        db.clear_session(user["sub"])
    except db.AssignmentClosed as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    after = db.assignment_context(user["sub"], artifacts.manifest_id())
    db.record_audit_event(
        "experiment.reset",
        actor_id=user.get("aid"),
        actor_name=user["sub"],
        target_type="attempt",
        target_id=str((before or {}).get("attempt_id") or ""),
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

    前 15 步证据不齐时拒绝(409),并返回还差什么;报告正文与其中的回归结果
    都由服务端重算,不接受任何客户端提供的内容。
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

    # 第 16 步的证据由服务端写入,而不是让客户端声称“我生成过报告”。
    # 先把带报告证据的会话校验好再落库:否则校验失败时报告已经写进 reports 表,
    # 学生看到 500、库里却躺着一份报告、第 16 步证据还没写上,三者互相矛盾。
    existing_report_key = str(_step_data_for_gate(session, "rep").get("report_key") or "")
    if existing_report_key != report.report_key:
        session["steps"][str(_REPORT_STEP)] = session_model.make_record({"report_key": report.report_key})
    try:
        updated = session_model.validate_session(session)
    except session_model.SessionError as e:
        raise HTTPException(status_code=422, detail=f"写入报告证据后会话不合规:{e}") from e

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
        "suggested_filename": f"gvc_experiment_report_{canonical['report_key']}.md",
    }


@router.get("/report/gate")
def report_gate(user: dict = Depends(require_student)):
    """第 16 步的前置门槛状态:还差哪些步骤的证据。"""
    _ensure_current_assignment(user["sub"])
    row = db.get_session(user["sub"])
    session = row["session"] if row else session_model.empty_session(artifacts.manifest_id())
    return {
        "blocked": teaching_report.check_gate(session, subject=user["sub"], require_trusted=True),
        "halted": _step_data_for_gate(session, "qc").get("disposition") == "stop",
    }


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
def new_attempt(user: dict = Depends(require_student)):
    try:
        scope = db.start_new_attempt(user["sub"], artifacts.manifest_id())
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
