"""实验会话:学生逐步实验状态的一等公民模型。

HEAD 缺的不是“再加一个进度字段”,而是一个可恢复、可审计、可失效的会话:
筛选、比较、图表设定与回归结果都只存在浏览器内存里,刷新即丢,最终报告也
无法如实记录学生实际探索过的状态。

本模块只定义会话的**契约**(信封、校验、合并),不关心持久化后端:

  - ``manifest_id`` 把会话绑定到产出它的那套数据产物。重新 compute 或换算法后
    ID 改变,旧会话里的结果即被判定为过期,而不是被静默当成当前数据。
  - ``revision`` 由服务端单调递增,用于并发写入检测。
  - 每个步骤记录自带记录级与字段级时间戳。不同步骤按记录合并，同一步骤按字段
    合并——学生在两个标签页分别探索实验与完成答题时，两类最终状态都不能丢失。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

# v7:步骤 1–15 只以版本化固定单选题判定完成；实验操作仅自动保存为报告快照，
# 不参与完成判定。账号在新的 manifest 下自然得到空白工作区。
SESSION_VERSION = "experiment-session-v7"

MIN_STEP = 1
MAX_STEP = 16

# 确实跨步骤共享的实验状态。刻意用白名单而不是任意键:
# 会话承载实验状态与答题结果,不能变成一个什么都能塞的杂物袋。
#   regression_settings 步骤 12–15 的回归设定,按 outcome 分别保存(每步各有招牌默认)
#   regression_history  按 outcome 保存最近几次运行,用于跨步骤对照
SHARED_KEYS = frozenset({"regression_settings", "regression_history"})

# 单份会话的 JSON 上限。回归快照会带上完整结果,给出宽裕但有限的额度,
# 避免单个账号把教学库撑爆;超限时明确报错,不静默截断学生的实验记录。
MAX_SESSION_BYTES = 1_000_000


class SessionError(ValueError):
    """会话载荷不符合契约。"""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def empty_session(manifest_id: str) -> dict[str, Any]:
    """全新学生的空会话:没有任何步骤记录。"""
    return {"version": SESSION_VERSION, "manifest_id": manifest_id, "steps": {}, "shared": {}}


def make_record(data: Any, updated_at: str | None = None) -> dict[str, Any]:
    """构造带记录级、字段级时间戳的步骤记录。"""
    timestamp = updated_at or utc_now_iso()
    field_updated_at = {key: timestamp for key in data} if isinstance(data, dict) else {}
    return {"data": data, "updated_at": timestamp, "field_updated_at": field_updated_at}


def _parse_timestamp(value: str) -> datetime:
    """把合法 ISO 时间统一成可比较的 UTC 时间；无时区值按 UTC 处理。"""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _validate_record(step: str, record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise SessionError(f"步骤 {step} 的会话记录必须是对象")
    if "data" not in record:
        raise SessionError(f"步骤 {step} 的会话记录缺少 data")
    updated_at = record.get("updated_at")
    if not isinstance(updated_at, str) or not updated_at:
        raise SessionError(f"步骤 {step} 的会话记录缺少 updated_at")
    try:
        record_time = _parse_timestamp(updated_at)
    except ValueError as error:
        raise SessionError(f"步骤 {step} 的 updated_at 不是合法时间戳:{updated_at}") from error

    field_updated_at = record.get("field_updated_at")
    if not isinstance(field_updated_at, dict):
        raise SessionError(f"步骤 {step} 的会话记录缺少 field_updated_at")
    clean_field_times: dict[str, str] = {}
    for key, value in field_updated_at.items():
        if not isinstance(key, str) or not isinstance(value, str) or not value:
            raise SessionError(f"步骤 {step} 的 field_updated_at 必须是字段名到时间戳的映射")
        try:
            field_time = _parse_timestamp(value)
        except ValueError as error:
            raise SessionError(f"步骤 {step} 字段 {key!r} 的时间戳不合法:{value}") from error
        if field_time > record_time:
            raise SessionError(f"步骤 {step} 字段 {key!r} 的时间戳不能晚于 updated_at")
        clean_field_times[key] = value

    data = record["data"]
    if isinstance(data, dict):
        if not all(isinstance(key, str) for key in data):
            raise SessionError(f"步骤 {step} 的 data 字段名必须是字符串")
        missing = set(data) - set(clean_field_times)
        if missing:
            raise SessionError(f"步骤 {step} 的 field_updated_at 缺少字段:{sorted(missing)}")
    elif clean_field_times:
        raise SessionError(f"步骤 {step} 的非对象 data 不能带字段时间戳")

    return {"data": data, "updated_at": updated_at, "field_updated_at": clean_field_times}


def validate_session(payload: Any) -> dict[str, Any]:
    """校验并归一化一份会话载荷。

    只接受当前版本:本系统不做历史格式兼容,版本不符即明确失败,
    不猜测旧结构的含义。
    """
    if not isinstance(payload, dict):
        raise SessionError("会话必须是对象")
    version = payload.get("version")
    if version != SESSION_VERSION:
        raise SessionError(f"会话版本不受支持:{version!r};当前为 {SESSION_VERSION}")
    manifest_id = payload.get("manifest_id")
    if not isinstance(manifest_id, str) or not manifest_id:
        raise SessionError("会话缺少 manifest_id")
    steps = payload.get("steps")
    if not isinstance(steps, dict):
        raise SessionError("会话缺少 steps 对象")
    shared = payload.get("shared", {})
    if not isinstance(shared, dict):
        raise SessionError("会话的 shared 必须是对象")

    clean_steps: dict[str, dict[str, Any]] = {}
    for key, record in steps.items():
        if not (isinstance(key, str) and key.isdigit() and MIN_STEP <= int(key) <= MAX_STEP):
            raise SessionError(f"会话步骤键必须是 {MIN_STEP}–{MAX_STEP} 的字符串,收到 {key!r}")
        clean_steps[key] = _validate_record(key, record)

    clean_shared: dict[str, dict[str, Any]] = {}
    for key, record in shared.items():
        if not (isinstance(key, str) and key in SHARED_KEYS):
            raise SessionError(f"会话 shared 键必须是 {sorted(SHARED_KEYS)} 之一,收到 {key!r}")
        clean_shared[key] = _validate_record(key, record)

    session = {
        "version": SESSION_VERSION,
        "manifest_id": manifest_id,
        "steps": clean_steps,
        "shared": clean_shared,
    }
    size = len(json.dumps(session, ensure_ascii=False).encode("utf-8"))
    if size > MAX_SESSION_BYTES:
        raise SessionError(f"会话过大({size} 字节,上限 {MAX_SESSION_BYTES});请先清理旧的回归运行记录")
    return session


def merge_sessions(base: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    """按记录与字段时间戳合并两份会话。

    不同步骤保留双方；同一步骤的对象数据逐字段合并。因此一个标签页保存实验快照、
    另一个标签页完成选择题时，两者不会因整条记录后写覆盖而互相删除。时间戳
    相同则保留 incoming（调用方是本次写入者）。
    """

    def merge_record(current: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
        current_data = current["data"]
        incoming_data = record["data"]
        if not isinstance(current_data, dict) or not isinstance(incoming_data, dict):
            return (
                record if _parse_timestamp(record["updated_at"]) >= _parse_timestamp(current["updated_at"]) else current
            )

        current_times = current["field_updated_at"]
        incoming_times = record["field_updated_at"]
        merged_data: dict[str, Any] = {}
        merged_times: dict[str, str] = {}
        for key in current_times.keys() | incoming_times.keys():
            current_time = current_times.get(key)
            incoming_time = incoming_times.get(key)
            use_incoming = incoming_time is not None and (
                current_time is None or _parse_timestamp(incoming_time) >= _parse_timestamp(current_time)
            )
            source_data = incoming_data if use_incoming else current_data
            selected_time = incoming_time if use_incoming else current_time
            if key in source_data:
                merged_data[key] = source_data[key]
            if selected_time is not None:
                # 仅存在于 field_updated_at 的键是删除墓碑，也必须保留以阻止旧值复活。
                merged_times[key] = selected_time

        latest = (
            record if _parse_timestamp(record["updated_at"]) >= _parse_timestamp(current["updated_at"]) else current
        )
        return {
            "data": merged_data,
            "updated_at": latest["updated_at"],
            "field_updated_at": merged_times,
        }

    def merge_slot(base_slot: dict[str, Any], incoming_slot: dict[str, Any]) -> dict[str, Any]:
        merged = dict(base_slot)
        for key, record in incoming_slot.items():
            current = merged.get(key)
            merged[key] = record if current is None else merge_record(current, record)
        return merged

    return {
        "version": SESSION_VERSION,
        # manifest_id 以本次写入者为准:它对应学生刚刚看到的数据。
        "manifest_id": incoming["manifest_id"],
        "steps": merge_slot(base.get("steps", {}), incoming.get("steps", {})),
        "shared": merge_slot(base.get("shared", {}), incoming.get("shared", {})),
    }


def is_stale(session: dict[str, Any], current_manifest_id: str) -> bool:
    """会话是否由另一套数据产物生成。"""
    return session.get("manifest_id") != current_manifest_id
