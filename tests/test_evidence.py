"""课程完成的真值判定。

这里守住的核心不变量:**访问不算完成**。HEAD 把“到过第 n 步”当成完成,
本模块的判定必须让那种行为拿不到任何一个对勾。
"""

import pytest

from gvcsim.evidence import (
    MIN_JUDGMENT_CHARS,
    QC_DISPOSITIONS,
    REQUIRED_SHOCK_TYPES,
    STEP_LABS,
    completion_summary,
    evaluate,
    evaluate_step,
)
from gvcsim.session import empty_session, make_record

MID = "b08a35374d1021b0"


def _session(steps: dict) -> dict:
    s = empty_session(MID)
    s["steps"] = {str(k): make_record(v) for k, v in steps.items()}
    return s


JUDGMENT = "制裁只有 2 个处理聚类,推断被抑制,不能作因果解释"


def _step_of(lab: str) -> int:
    return next(n for n, value in STEP_LABS.items() if value == lab)


# ---------------------------------------------------------------- 核心不变量


def test_empty_session_completes_nothing():
    """全新会话:16 步一个都不算完成。"""
    summary = completion_summary(empty_session(MID))
    assert summary["completed"] == []
    assert summary["completed_count"] == 0
    assert summary["total"] == 16


def test_visiting_every_step_completes_nothing():
    """把 16 步全部“到过”——即使每步都留下空记录——仍然 0/16。

    这正是 HEAD 会显示 16/16 的行为。
    """
    session = _session({n: {} for n in range(1, 17)})
    assert completion_summary(session)["completed"] == []


def test_unrelated_payload_does_not_complete_a_step():
    """往会话里塞无关内容不能换来对勾。"""
    session = _session({n: {"visited": True, "seconds": 999} for n in range(1, 17)})
    assert completion_summary(session)["completed"] == []


def test_every_step_has_a_check():
    assert sorted(STEP_LABS) == list(range(1, 17))
    for step in STEP_LABS:
        assert evaluate_step(step, empty_session(MID)).missing, f"步骤 {step} 没有任何证据要求"


def test_unknown_step_is_rejected():
    with pytest.raises(ValueError):
        evaluate_step(99, empty_session(MID))


# ---------------------------------------------------------------- 各 lab 证据


def test_db_step_needs_a_complete_slice():
    step = _step_of("db")
    partial = _session({step: {"slice": {"year": 2020, "table": "z"}}})
    assert not evaluate_step(step, partial).complete
    full = _session(
        {
            step: {
                "slice": {"year": 2020, "table": "z", "row_country": "CHN", "col_country": "USA"},
                "observation": {"row": "CHN_D01T02", "column": "USA_D01T02", "value": 12.5},
            }
        }
    )
    assert evaluate_step(step, full).complete


def test_slice_receipt_rechecks_the_exact_server_cell(monkeypatch):
    from gvcsim.classroom import routes

    monkeypatch.setattr(
        routes.icio_browser,
        "slice_table",
        lambda **_kwargs: {
            "columns": ["row", "USA_D01T02"],
            "rows": [{"row": "CHN_D01T02", "USA_D01T02": 12.5}],
        },
    )
    payload = {
        "slice": {"year": 2020, "table": "z", "row_country": "CHN", "col_country": "USA"},
        "observation": {"row": "CHN_D01T02", "column": "USA_D01T02", "value": 12.5},
    }
    routes._verify_learning_payload(1, "slice", payload)

    payload["observation"]["value"] = 999
    with pytest.raises(ValueError, match="服务端原始值不一致"):
        routes._verify_learning_payload(1, "slice", payload)


def test_shock_step_needs_all_three_shock_types():
    """只看关税会形成错误直觉:三类冲击的处理密度完全不同。"""
    step = _step_of("shock")
    one = _session({step: {"viewed_shock_types": ["tariff"]}})
    assert not evaluate_step(step, one).complete
    # 证据存稳定键,但给学生的提示必须是中文文案,不能把 `sanctions` 甩到界面上。
    assert "制裁清单" in evaluate_step(step, one).missing[0]
    assert "sanctions" not in evaluate_step(step, one).missing[0]
    all_three = _session({step: {"viewed_shock_types": list(REQUIRED_SHOCK_TYPES)}})
    assert evaluate_step(step, all_three).complete


def test_qc_step_needs_a_disposition_and_a_reason():
    """质检的产出是处置决定,不是“已阅”布尔值——后者与“到过”没有区别。"""
    step = _step_of("qc")
    assert not evaluate_step(step, _session({step: {"disposition": "fix"}})).complete
    assert not evaluate_step(step, _session({step: {"judgment": JUDGMENT}})).complete
    # 处置必须是三条真实路径之一,不接受任意字符串。
    assert not evaluate_step(step, _session({step: {"disposition": "whatever", "judgment": JUDGMENT}})).complete
    for disposition in QC_DISPOSITIONS:
        assert evaluate_step(step, _session({step: {"disposition": disposition, "judgment": JUDGMENT}})).complete


def test_indicator_step_needs_two_distinct_entities():
    step = _step_of("ind")
    assert not evaluate_step(step, _session({step: {"compared": ["CHN"]}})).complete
    # 同一个实体重复两次不算对比。
    assert not evaluate_step(step, _session({step: {"compared": ["CHN", "CHN"]}})).complete
    assert evaluate_step(step, _session({step: {"compared": ["CHN", "USA"]}})).complete


def test_viz_step_needs_chart_and_two_targets():
    step = _step_of("viz")
    assert not evaluate_step(step, _session({step: {"chart": "quadrant"}})).complete
    assert not evaluate_step(step, _session({step: {"compared": ["CHN", "USA"]}})).complete
    assert evaluate_step(step, _session({step: {"chart": "quadrant", "compared": ["CHN", "USA"]}})).complete


def test_regression_step_needs_a_run_and_a_judgment():
    step = _step_of("reg")
    ran = {"run": {"depvar": "FVA_share", "status": "insufficient"}}
    assert not evaluate_step(step, _session({step: ran})).complete
    assert not evaluate_step(step, _session({step: {"judgment": JUDGMENT}})).complete
    assert evaluate_step(step, _session({step: {**ran, "judgment": JUDGMENT}})).complete


def test_short_judgment_is_rejected_with_a_helpful_message():
    step = _step_of("reg")
    ran = {"run": {"depvar": "FVA_share"}}
    result = evaluate_step(step, _session({step: {**ran, "judgment": "不知道"}}))
    assert not result.complete
    assert str(MIN_JUDGMENT_CHARS) in result.missing[0]


def test_whitespace_judgment_is_not_evidence():
    step = _step_of("reg")
    session = _session({step: {"run": {"depvar": "FVA_share"}, "judgment": "   " * 20}})
    assert not evaluate_step(step, session).complete


def test_report_step_needs_a_report_key():
    step = _step_of("rep")
    assert not evaluate_step(step, _session({step: {}})).complete
    assert evaluate_step(step, _session({step: {"report_key": "abc123"}})).complete


def test_completion_summary_counts_only_evidenced_steps():
    step = _step_of("ind")
    session = _session({step: {"compared": ["CHN", "USA"]}, 1: {}, 2: {}})
    summary = completion_summary(session)
    assert summary["completed"] == [step]
    assert summary["completed_count"] == 1


def test_evaluate_returns_all_steps_in_order():
    items = evaluate(empty_session(MID))
    assert [item.step for item in items] == list(range(1, 17))


def test_forged_regression_settings_do_not_complete_a_step():
    """会话的 data 是客户端可写的不透明 blob:伪造的设定不能换来对勾。

    未校验时,伪造的 shockType 会一路走到 SHOCK_SPECS[...] 抛 KeyError,
    把 /report/generate 变成 500。第一道防线是让这一步压根不算完成。
    """
    step = _step_of("reg")
    forged = {"run": {"depvar": "FVA_share", "settings": {"shockType": "bogus_shock"}}, "judgment": JUDGMENT}
    result = evaluate_step(step, _session({step: forged}))
    assert not result.complete
    assert "无法识别" in result.missing[0]

    ok = {
        "run": {"depvar": "FVA_share", "settings": {"shockType": "export_control", "method": "did"}},
        "judgment": JUDGMENT,
    }
    assert evaluate_step(step, _session({step: ok})).complete


def test_invalid_regression_settings_checks_every_enum():
    from gvcsim.evidence import invalid_regression_settings as check

    assert check({}) == []
    assert check({"granularity": "country", "method": "did", "priceMode": "nominal"}) == []
    assert check("not-an-object")
    for key, bad in [
        ("granularity", "国家级"),  # 旧中文枚举也不再接受
        ("method", "双重差分 (DID)"),
        ("controlMode", "nope"),
        ("priceMode", "nope"),
        ("scenario", "nope"),
    ]:
        assert check({key: bad}), f"{key}={bad} 应被判非法"


def test_trusted_trade_comparison_rejects_two_incomparable_designs(monkeypatch):
    step = 12
    base_design = {
        "outcome": "trade",
        "granularity": "country_industry",
        "shock_type": "tariff",
        "method": "did",
        "control_mode": "none",
        "interaction": False,
        "price_mode": "nominal",
        "scenario": "clean",
        "exclude_row": True,
        "weight_mode": "fixed_pretreatment",
    }
    designs = {
        "main": {**base_design, "control_mode": "icio_derived", "shock_type": "sanctions"},
        "baseline": base_design,
        "controlled": {**base_design, "control_mode": "icio_derived", "shock_type": "sanctions"},
    }
    monkeypatch.setattr(
        "gvcsim.evidence.trusted_evidence.verify_regression_run",
        lambda token, **_kwargs: {"design": designs[token]} if token in designs else None,
    )
    cer = {
        "claim": "控制变量改变了估计方向，需要谨慎解释",
        "evidence": "基准系数为 0.10，控制后为 0.20",
        "reasoning": "只有其余设定相同，差异才可归因于控制变量",
        "boundary": "这是拟真冲击且无永不处理组，不能直接外推",
    }
    data = {
        "run_id": "main",
        "run": {"depvar": "FVA_share", "settings": {"shockType": "sanctions", "controlMode": "icio_derived"}},
        "checks": {"baseline_run_id": "baseline", "controlled_run_id": "controlled"},
        "judgment": JUDGMENT,
        "cer": cer,
    }
    result = evaluate_step(step, _session({step: data}), subject="student", require_trusted=True)
    assert not result.complete
    assert any("除控制变量外" in item for item in result.missing)


def test_trusted_network_rejects_placebo_from_a_different_design(monkeypatch):
    step = 15
    base_design = {
        "outcome": "network",
        "granularity": "country_industry",
        "shock_type": "tariff",
        "method": "did",
        "control_mode": "none",
        "interaction": False,
        "price_mode": "nominal",
        "scenario": "clean",
        "exclude_row": True,
        "weight_mode": "fixed_pretreatment",
    }
    designs = {
        "main": base_design,
        "placebo": {**base_design, "shock_type": "sanctions"},
    }
    monkeypatch.setattr(
        "gvcsim.evidence.trusted_evidence.verify_regression_run",
        lambda token, **_kwargs: {"design": designs[token]} if token in designs else None,
    )
    cer = {
        "claim": "网络位置在冲击后出现了可见变化，需要谨慎解释",
        "evidence": "主回归系数为 0.10，安慰剂分布均值为 0.01",
        "reasoning": "只有安慰剂和主回归设计相同，随机化比较才有意义",
        "boundary": "网络节点存在 SUTVA 干扰和跨国网络外溢，不能孤立解释",
    }
    data = {
        "run_id": "main",
        "placebo_run_id": "placebo",
        "run": {"depvar": "betweenesscentrality", "settings": {"shockType": "tariff", "method": "did"}},
        "checks": {"placebo_run_id": "placebo"},
        "judgment": JUDGMENT,
        "cer": cer,
    }
    result = evaluate_step(step, _session({step: data}), subject="student", require_trusted=True)
    assert not result.complete
    assert any("安慰剂必须与本步主回归" in item for item in result.missing)
