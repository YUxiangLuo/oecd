from gvcsim import auth, trusted_evidence
from gvcsim.classroom import db


EVENT = {
    "event_id": "00000000-0000-0000-0000-000000000001",
    "account_id": 7,
    "assignment_id": 11,
    "attempt_id": 13,
    "step": 12,
    "issued_at": "2026-07-19T00:00:00+00:00",
}


def _trust_test_events(monkeypatch):
    keys = {"auth": b"auth-secret" * 4, "evidence": b"evidence-secret" * 4}
    monkeypatch.setattr(auth, "_secret", lambda: keys["auth"])
    monkeypatch.setattr(auth, "evidence_secret", lambda: keys["evidence"])
    monkeypatch.setattr(db, "evidence_event_exists", lambda *_args, **_kwargs: True)
    return keys


def test_learning_receipt_binds_subject_step_manifest_and_exact_payload(monkeypatch):
    _trust_test_events(monkeypatch)
    payload = {"compared": ["CHN", "VNM"]}
    token = trusted_evidence.issue_learning_evidence(
        subject="alice",
        step=3,
        kind="indicator",
        manifest_id="manifest-a",
        payload=payload,
        event=EVENT,
    )
    assert trusted_evidence.verify_learning_evidence(
        token,
        subject="alice",
        step=3,
        kind="indicator",
        manifest_id="manifest-a",
        payload=payload,
    )
    assert not trusted_evidence.verify_learning_evidence(
        token,
        subject="alice",
        step=3,
        kind="indicator",
        manifest_id="manifest-a",
        payload={**payload, "compared": ["CHN", "USA"]},
    )
    assert not trusted_evidence.verify_learning_evidence(
        token,
        subject="mallory",
        step=3,
        kind="indicator",
        manifest_id="manifest-a",
        payload=payload,
    )


def test_regression_run_id_binds_outcome_and_settings(monkeypatch):
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
        event=EVENT,
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


def test_learning_receipt_uses_independent_evidence_key(monkeypatch):
    keys = _trust_test_events(monkeypatch)
    payload = {"compared": ["CHN", "VNM"]}
    token = trusted_evidence.issue_learning_evidence(
        subject="alice",
        step=3,
        kind="indicator",
        manifest_id="manifest-a",
        payload=payload,
        event=EVENT,
    )

    def valid() -> bool:
        return trusted_evidence.verify_learning_evidence(
            token,
            subject="alice",
            step=3,
            kind="indicator",
            manifest_id="manifest-a",
            payload=payload,
        )

    keys["auth"] = b"rotated-auth-secret" * 2
    assert valid() is True
    keys["evidence"] = b"rotated-evidence-secret" * 2
    assert valid() is False


def test_receipt_database_lookup_carries_full_event_scope(monkeypatch):
    keys = {"evidence": b"evidence-secret" * 4}
    monkeypatch.setattr(auth, "evidence_secret", lambda: keys["evidence"])
    seen: dict = {}

    def exists(*args, **kwargs):
        seen.update(kwargs)
        return True

    monkeypatch.setattr(db, "evidence_event_exists", exists)
    payload = {"compared": ["CHN", "VNM"]}
    token = trusted_evidence.issue_learning_evidence(
        subject="alice", step=3, kind="indicator", manifest_id="manifest-a", payload=payload, event=EVENT
    )
    assert trusted_evidence.verify_learning_evidence(
        token, subject="alice", step=3, kind="indicator", manifest_id="manifest-a", payload=payload
    )
    assert seen == {"account_id": 7, "step": 3, "kind": "indicator", "manifest_id": "manifest-a"}
