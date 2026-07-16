"""实验会话契约:校验、合并与失效。

这些是纯函数测试,不依赖数据库;数据库侧的往返、并发合并与过期标记
见 tests/test_classroom.py。
"""

import pytest

from gvcsim.session import (
    MAX_SESSION_BYTES,
    SESSION_VERSION,
    SessionError,
    empty_session,
    is_stale,
    make_record,
    merge_sessions,
    validate_session,
)

MID = "b08a35374d1021b0"


def _session(steps: dict, manifest_id: str = MID, shared: dict | None = None) -> dict:
    return {"version": SESSION_VERSION, "manifest_id": manifest_id, "steps": steps, "shared": shared or {}}


def test_empty_session_has_no_steps():
    s = empty_session(MID)
    assert validate_session(s) == s
    assert s["steps"] == {}


def test_validate_accepts_well_formed_session():
    record = make_record({"country": "CHN"}, "2026-07-16T10:00:00+00:00")
    assert validate_session(_session({"4": record}))["steps"]["4"]["data"] == {"country": "CHN"}


@pytest.mark.parametrize(
    "payload",
    [
        "not-an-object",
        {"version": "experiment-session-v0", "manifest_id": MID, "steps": {}},  # 旧版本不做兼容
        {"version": SESSION_VERSION, "steps": {}},  # 缺 manifest_id
        {"version": SESSION_VERSION, "manifest_id": MID},  # 缺 steps
    ],
)
def test_validate_rejects_bad_envelope(payload):
    with pytest.raises(SessionError):
        validate_session(payload)


@pytest.mark.parametrize("key", ["0", "17", "abc", "-1", "4.5"])
def test_validate_rejects_out_of_range_step_keys(key):
    with pytest.raises(SessionError):
        validate_session(_session({key: make_record({})}))


@pytest.mark.parametrize(
    "record",
    [
        {"data": {}},  # 缺 updated_at
        {"updated_at": "2026-07-16T10:00:00+00:00"},  # 缺 data
        {"data": {}, "updated_at": "昨天"},  # 时间戳不合法
        "not-a-record",
    ],
)
def test_validate_rejects_bad_records(record):
    with pytest.raises(SessionError):
        validate_session(_session({"4": record}))


def test_validate_rejects_oversized_session():
    big = _session({"4": make_record({"blob": "x" * (MAX_SESSION_BYTES + 1)})})
    with pytest.raises(SessionError, match="过大"):
        validate_session(big)


def test_merge_keeps_both_sides_when_different_steps_changed():
    """两个标签页各改一步:整份覆盖会丢掉一边的实验。"""
    base = _session({"4": make_record({"country": "CHN"}, "2026-07-16T10:00:00+00:00")})
    incoming = _session({"12": make_record({"shock": "tariff"}, "2026-07-16T10:05:00+00:00")})
    merged = merge_sessions(base, incoming)
    assert merged["steps"]["4"]["data"] == {"country": "CHN"}
    assert merged["steps"]["12"]["data"] == {"shock": "tariff"}


def test_merge_prefers_newer_record_for_same_step():
    base = _session({"4": make_record({"v": "old"}, "2026-07-16T10:00:00+00:00")})
    incoming = _session({"4": make_record({"v": "new"}, "2026-07-16T10:05:00+00:00")})
    assert merge_sessions(base, incoming)["steps"]["4"]["data"] == {"v": "new"}


def test_merge_keeps_newer_base_record_over_older_incoming():
    """本次写入者不必然更新:它可能拿着很旧的状态。"""
    base = _session({"4": make_record({"v": "newer"}, "2026-07-16T11:00:00+00:00")})
    incoming = _session({"4": make_record({"v": "stale"}, "2026-07-16T10:00:00+00:00")})
    assert merge_sessions(base, incoming)["steps"]["4"]["data"] == {"v": "newer"}


def test_merge_result_is_valid_session():
    base = _session({"4": make_record({"a": 1}, "2026-07-16T10:00:00+00:00")})
    incoming = _session({"12": make_record({"b": 2}, "2026-07-16T10:01:00+00:00")})
    merged = merge_sessions(base, incoming)
    assert validate_session(merged) == merged


def test_is_stale_detects_other_artifacts():
    assert is_stale(empty_session(MID), MID) is False
    assert is_stale(empty_session("deadbeefdeadbeef"), MID) is True


# ------------------------------------------------------------------ shared 槽


def test_validate_accepts_known_shared_keys():
    s = _session({}, shared={"regression_settings": make_record({"method": "did"})})
    assert validate_session(s)["shared"]["regression_settings"]["data"] == {"method": "did"}


def test_validate_rejects_unknown_shared_keys():
    """shared 是白名单:会话是教学证据载体,不能变成任意 KV 存储。"""
    with pytest.raises(SessionError):
        validate_session(_session({}, shared={"whatever": make_record({})}))


def test_validate_rejects_bad_shared_record():
    with pytest.raises(SessionError):
        validate_session(_session({}, shared={"regression_settings": {"data": {}}}))


def test_missing_shared_defaults_to_empty():
    """shared 可省略:老客户端只发 steps 时不该被拒。"""
    assert validate_session({"version": SESSION_VERSION, "manifest_id": MID, "steps": {}})["shared"] == {}


def test_merge_applies_same_rule_to_shared_slot():
    base = _session(
        {},
        shared={
            "regression_settings": make_record({"v": "old"}, "2026-07-16T10:00:00+00:00"),
            "regression_history": make_record({"trade": []}, "2026-07-16T10:00:00+00:00"),
        },
    )
    incoming = _session({}, shared={"regression_settings": make_record({"v": "new"}, "2026-07-16T10:05:00+00:00")})
    merged = merge_sessions(base, incoming)
    assert merged["shared"]["regression_settings"]["data"] == {"v": "new"}
    # 未被本次写入触及的共享键不能消失。
    assert merged["shared"]["regression_history"]["data"] == {"trade": []}
