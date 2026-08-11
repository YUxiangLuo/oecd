from __future__ import annotations

from gvcsim import auth, trusted_evidence
from gvcsim.classroom import db


EVENT = {
    "event_id": "00000000-0000-0000-0000-000000000001",
    "account_id": 7,
    "assignment_id": 11,
    "attempt_id": 13,
    "step": 3,
    "issued_at": "2026-07-19T00:00:00+00:00",
}


def _trust_test_events(monkeypatch):
    keys = {"auth": b"auth-secret" * 4, "receipt": b"receipt-secret" * 4}
    monkeypatch.setattr(auth, "_secret", lambda: keys["auth"])
    monkeypatch.setattr(auth, "evidence_secret", lambda: keys["receipt"])
    monkeypatch.setattr(db, "evidence_event_exists", lambda *_args, **_kwargs: True)
    return keys


def _quiz_token(payload: dict, *, subject: str = "alice", step: int = 3) -> str:
    return trusted_evidence.issue_quiz_completion(
        subject=subject,
        step=step,
        manifest_id="manifest-a",
        payload=payload,
        event=EVENT,
    )


def test_quiz_receipt_binds_subject_step_manifest_and_exact_answers(monkeypatch):
    _trust_test_events(monkeypatch)
    payload = {"version": "course-quiz-v2", "answers": {"q1": "a"}}
    token = _quiz_token(payload)
    assert trusted_evidence.verify_quiz_completion(
        token, subject="alice", step=3, manifest_id="manifest-a", payload=payload
    )
    assert not trusted_evidence.verify_quiz_completion(
        token,
        subject="alice",
        step=3,
        manifest_id="manifest-a",
        payload={**payload, "answers": {"q1": "b"}},
    )
    assert not trusted_evidence.verify_quiz_completion(
        token, subject="mallory", step=3, manifest_id="manifest-a", payload=payload
    )
    assert not trusted_evidence.verify_quiz_completion(
        token, subject="alice", step=4, manifest_id="manifest-a", payload=payload
    )
    assert not trusted_evidence.verify_quiz_completion(
        token, subject="alice", step=3, manifest_id="manifest-b", payload=payload
    )


def test_quiz_receipt_uses_an_independent_long_lived_key(monkeypatch):
    keys = _trust_test_events(monkeypatch)
    payload = {"version": "course-quiz-v2", "answers": {"q1": "a"}}
    token = _quiz_token(payload)

    def valid() -> bool:
        return trusted_evidence.verify_quiz_completion(
            token, subject="alice", step=3, manifest_id="manifest-a", payload=payload
        )

    keys["auth"] = b"rotated-auth-secret" * 2
    assert valid()
    keys["receipt"] = b"rotated-receipt-secret" * 2
    assert not valid()


def test_quiz_receipt_database_lookup_carries_full_event_scope(monkeypatch):
    monkeypatch.setattr(auth, "evidence_secret", lambda: b"receipt-secret" * 4)
    seen: dict = {}

    def exists(*args, **kwargs):
        seen.update(kwargs)
        return True

    monkeypatch.setattr(db, "evidence_event_exists", exists)
    payload = {"version": "course-quiz-v2", "answers": {"q1": "a"}}
    token = _quiz_token(payload)
    assert trusted_evidence.verify_quiz_completion(
        token, subject="alice", step=3, manifest_id="manifest-a", payload=payload
    )
    assert seen == {"account_id": 7, "step": 3, "kind": "quiz", "manifest_id": "manifest-a"}


def test_quiz_receipt_requires_a_live_database_event(monkeypatch):
    _trust_test_events(monkeypatch)
    monkeypatch.setattr(db, "evidence_event_exists", lambda *_args, **_kwargs: False)
    payload = {"version": "course-quiz-v2", "answers": {"q1": "a"}}
    assert not trusted_evidence.verify_quiz_completion(
        _quiz_token(payload), subject="alice", step=3, manifest_id="manifest-a", payload=payload
    )


def test_quiz_receipts_use_one_batch_database_lookup(monkeypatch):
    monkeypatch.setattr(auth, "evidence_secret", lambda: b"receipt-secret" * 4)
    payload3 = {"version": "course-quiz-v2", "answers": {"q1": "a"}}
    payload4 = {"version": "course-quiz-v2", "answers": {"q1": "b"}}
    token3 = _quiz_token(payload3, step=3)
    token4 = trusted_evidence.issue_quiz_completion(
        subject="alice",
        step=4,
        manifest_id="manifest-a",
        payload=payload4,
        event={**EVENT, "event_id": "00000000-0000-0000-0000-000000000002", "step": 4},
    )
    calls: list[list[dict]] = []

    def valid(_subject, checks, **kwargs):
        calls.append(checks)
        assert kwargs["manifest_id"] == "manifest-a"
        return {check["event_id"] for check in checks}

    monkeypatch.setattr(db, "valid_evidence_event_ids", valid)
    monkeypatch.setattr(
        db,
        "evidence_event_exists",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("不得逐题查询")),
    )

    completed = trusted_evidence.verify_quiz_completions(
        {
            3: (token3, payload3),
            4: (token4, payload4),
            # 同一 token 不能跨步骤复用；它应在数据库查询前就被排除。
            5: (token3, payload3),
        },
        subject="alice",
        manifest_id="manifest-a",
    )

    assert completed == {3, 4}
    assert len(calls) == 1 and {check["step"] for check in calls[0]} == {3, 4}


def test_regression_run_id_binds_outcome_settings_and_step(monkeypatch):
    _trust_test_events(monkeypatch)
    design = {
        "outcome": "trade",
        "granularity": "country_industry",
        "shock_type": "tariff",
        "method": "did",
        "control_mode": "none",
        "interaction": False,
        "price_mode": "nominal",
        "scenario": "clean",
        "exclude_row": True,
    }
    token = trusted_evidence.issue_regression_run(
        subject="alice",
        manifest_id="manifest-a",
        design=design,
        result={"depvar": "FVA_share", "coefs": []},
        event={**EVENT, "step": 12},
    )
    assert trusted_evidence.verify_regression_run(
        token,
        subject="alice",
        manifest_id="manifest-a",
        outcome="trade",
        settings={"method": "did", "controlMode": "none"},
        step=12,
    )
    assert not trusted_evidence.verify_regression_run(
        token,
        subject="alice",
        manifest_id="manifest-a",
        outcome="trade",
        settings={"method": "did", "controlMode": "none"},
        step=13,
    )
    assert not trusted_evidence.verify_regression_run(
        token,
        subject="alice",
        manifest_id="manifest-a",
        outcome="network",
        settings={"method": "did"},
    )
    assert not trusted_evidence.verify_regression_run(
        token,
        subject="alice",
        manifest_id="manifest-a",
        outcome="trade",
        settings={"controlMode": "icio_derived"},
    )


def test_placebo_id_binds_exact_distribution_settings_step_and_event(monkeypatch):
    _trust_test_events(monkeypatch)
    design = {
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
    result = {
        "policy_name": "treated×post",
        "true_coef": -1.2,
        "placebo_coefs": [-0.2, 0.1],
        "empirical_p": 0.05,
        "n_draws": 2,
        "requested_draws": 2,
        "seed": 2026,
    }
    token = trusted_evidence.issue_placebo_run(
        subject="alice",
        manifest_id="manifest-a",
        design=design,
        result=result,
        event={**EVENT, "step": 15},
    )
    arguments = {
        "subject": "alice",
        "manifest_id": "manifest-a",
        "outcome": "network",
        "settings": {"method": "did", "controlMode": "none"},
        "result": result,
        "step": 15,
    }

    assert trusted_evidence.verify_placebo_run(token, **arguments)
    assert not trusted_evidence.verify_placebo_run(
        token,
        **{**arguments, "result": {**result, "empirical_p": 0.9}},
    )
    assert not trusted_evidence.verify_placebo_run(
        token,
        **{**arguments, "settings": {"method": "did", "controlMode": "icio_derived"}},
    )
    assert not trusted_evidence.verify_placebo_run(token, **{**arguments, "step": 12})
    assert not trusted_evidence.verify_placebo_run(token, **{**arguments, "subject": "mallory"})


def test_placebo_id_database_lookup_uses_placebo_scope(monkeypatch):
    monkeypatch.setattr(auth, "evidence_secret", lambda: b"receipt-secret" * 4)
    seen: dict = {}

    def exists(*args, **kwargs):
        seen.update(kwargs)
        return True

    monkeypatch.setattr(db, "evidence_event_exists", exists)
    design = {"outcome": "trade", "method": "did", "weight_mode": "fixed_pretreatment"}
    result = {"true_coef": 1.0, "placebo_coefs": [0.0], "empirical_p": 0.5}
    token = trusted_evidence.issue_placebo_run(
        subject="alice",
        manifest_id="manifest-a",
        design=design,
        result=result,
        event={**EVENT, "step": 12},
    )

    assert trusted_evidence.verify_placebo_run(
        token,
        subject="alice",
        manifest_id="manifest-a",
        outcome="trade",
        settings={"method": "did"},
        result=result,
        step=12,
    )
    assert seen == {"account_id": 7, "step": 12, "kind": "placebo", "manifest_id": "manifest-a"}
