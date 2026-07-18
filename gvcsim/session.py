"""实验会话:学生逐步实验状态的一等公民模型。

HEAD 缺的不是“再加一个进度字段”,而是一个可恢复、可审计、可失效的会话:
筛选、比较、图表设定与回归结果都只存在浏览器内存里,刷新即丢,教师也无从
知道某一步究竟做了什么。

本模块只定义会话的**契约**(信封、校验、合并),不关心持久化后端:

  - ``manifest_id`` 把会话绑定到产出它的那套数据产物。重新 compute 或换算法后
    ID 改变,旧会话里的结果即被判定为过期,而不是被静默当成当前数据。
  - ``revision`` 由服务端单调递增,用于并发写入检测。
  - 每个步骤记录自带 ``updated_at``,冲突时按记录级时间戳合并,而不是整份覆盖——
    学生在两个标签页里分别做了第 4 步和第 12 步,不该有一边被整体丢掉。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

# v2:回归设定与冲击类型改用稳定英文键(tariff / did / ...)。旧会话里存的是
# 中文界面文案,语义无法与新枚举对应——按"不做历史格式兼容"的原则整份拒绝,
# 而不是猜测旧值的含义。学生会从空会话重新开始,但不会拿到一份被误读的实验。
SESSION_VERSION = "experiment-session-v3"

MIN_STEP = 1
MAX_STEP = 16

# 确实跨步骤共享的实验状态。刻意用白名单而不是任意键:
# 会话是教学证据的载体,不能变成一个什么都能塞的杂物袋。
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
    """构造带时间戳的步骤记录。"""
    return {"data": data, "updated_at": updated_at or utc_now_iso()}


def _validate_record(step: str, record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise SessionError(f"步骤 {step} 的会话记录必须是对象")
    if "data" not in record:
        raise SessionError(f"步骤 {step} 的会话记录缺少 data")
    updated_at = record.get("updated_at")
    if not isinstance(updated_at, str) or not updated_at:
        raise SessionError(f"步骤 {step} 的会话记录缺少 updated_at")
    try:
        datetime.fromisoformat(updated_at)
    except ValueError as error:
        raise SessionError(f"步骤 {step} 的 updated_at 不是合法时间戳:{updated_at}") from error
    return {"data": record["data"], "updated_at": updated_at}


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
    """按记录级时间戳合并两份会话,较新的步骤记录获胜。

    用于并发写入:两个标签页可能各自更新了不同步骤,整份覆盖会丢掉一边的工作。
    时间戳相同则保留 incoming(调用方是本次写入者)。
    """

    def merge_slot(base_slot: dict[str, Any], incoming_slot: dict[str, Any]) -> dict[str, Any]:
        merged = dict(base_slot)
        for key, record in incoming_slot.items():
            current = merged.get(key)
            if current is None or record["updated_at"] >= current["updated_at"]:
                merged[key] = record
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
