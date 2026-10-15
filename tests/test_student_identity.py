"""Account identifiers share one case-insensitive namespace, even under concurrent writes."""

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import psycopg
import pytest
from fastapi.testclient import TestClient

from gvcsim import config, demo_accounts
from gvcsim.api import app
from gvcsim.classroom import db, management


def _client():
    client = TestClient(app, raise_server_exceptions=False)
    login = client.post(
        "/api/auth/login", json={"username": "teacher", "password": os.environ["GVCSIM_BOOTSTRAP_PASSWORD"]}
    )
    assert login.status_code == 200, login.text
    client.headers["Authorization"] = "Bearer " + login.json()["token"]
    return client


def _student(username, student_no=""):
    return {
        "username": username,
        "display_name": username,
        "student_no": student_no,
        "password": "identity-test-password",
    }


def _group():
    term = db.create_term("Identity test", "teacher")
    return db.create_class_group(term["id"], "One", "teacher")["id"]


@pytest.mark.parametrize("operation", ["create", "update"])
@pytest.mark.parametrize("existing", ["login", "student-number"])
def test_student_number_case_alias_is_rejected_without_changing_accounts(teaching_db, operation, existing):
    client = _client()
    if existing == "login":
        number = "STUDENT"
    else:
        assert client.post("/api/classroom/students", json=_student("owner", "Roster.A")).status_code == 200
        number = "ROSTER.a"
    if operation == "create":
        path, body = "/api/classroom/students", _student("new-owner", number)
    else:
        original = client.post("/api/classroom/students", json=_student("new-owner", "original-number")).json()
        path, body = f"/api/classroom/students/{original['id']}", {"student_no": number}
    before = client.get("/api/classroom/students").json()
    response = client.post(path, json=body)
    assert response.status_code == 409, response.text
    assert client.get("/api/classroom/students").json() == before


@pytest.mark.parametrize("operation", ["single", "batch-preview", "batch-commit", "teacher"])
def test_login_cannot_claim_existing_mixed_case_student_number(teaching_db, operation):
    client = _client()
    created = client.post("/api/classroom/students", json=_student("owner", "Roster.A"))
    assert created.status_code == 200
    assert created.json()["student_no"] == "Roster.A"
    before = db.find_account("owner")
    if operation == "single":
        response = client.post("/api/classroom/students", json=_student("ROSTER.a"))
        assert response.status_code == 409, response.text
    elif operation == "teacher":
        with pytest.raises(management.StudentNumberTaken):
            db.provision_teacher("ROSTER.a", "Teacher", "identity-test-password")
    else:
        response = client.post(
            "/api/classroom/students/batch",
            json={"class_id": _group(), "preview": operation == "batch-preview", "students": [_student("ROSTER.a")]},
        )
        if operation == "batch-preview":
            assert response.json() == {"existing": ["roster.a"], "created": 0}
        else:
            assert response.status_code == 409, response.text
    assert db.find_account("roster.a") is None
    assert db.find_account("owner") == before


def test_own_login_and_number_are_allowed_and_display_case_is_preserved(teaching_db):
    client = _client()
    first = client.post("/api/classroom/students", json=_student("Roster.A", "ROSTER.A"))
    assert first.status_code == 200
    account = first.json()
    assert account["username"] == "roster.a" and account["student_no"] == "ROSTER.A"
    same = client.post(f"/api/classroom/students/{account['id']}", json={"student_no": "Roster.a"})
    assert same.status_code == 200 and same.json()["student_no"] == "Roster.a"
    assert client.post(f"/api/classroom/students/{account['id']}", json={"student_no": ""}).status_code == 200
    assert client.post("/api/classroom/students", json=_student("blank-one")).status_code == 200
    assert client.post("/api/classroom/students", json=_student("blank-two")).status_code == 200
    # Clearing a separate number frees it for another account, without changing its previous owner's login.
    assert client.post(f"/api/classroom/students/{account['id']}", json={"student_no": "Released"}).status_code == 200
    assert client.post(f"/api/classroom/students/{account['id']}", json={"student_no": ""}).status_code == 200
    assert client.post("/api/classroom/students", json=_student("replacement", "RELEASED")).status_code == 200


def test_legacy_padded_number_conflicts_without_rewriting_saved_data(teaching_db):
    client = _client()
    with db.conn() as connection:
        connection.execute("UPDATE accounts SET student_no='  Roster.A  ' WHERE username='student'")
    before = db.find_account("student")
    response = client.post("/api/classroom/students", json=_student("new-owner", "roster.a"))
    assert response.status_code == 409, response.text
    response = client.post(
        "/api/classroom/students/batch",
        json={
            "class_id": _group(),
            "preview": True,
            "students": [_student("ROSTER.A")],
        },
    )
    assert response.json() == {"existing": ["roster.a"], "created": 0}
    assert db.find_account("student") == before


@pytest.mark.parametrize("claimed", ["STUDENT02", "2026002"])
def test_demo_account_sync_checks_identifiers_and_rolls_back_without_rewriting_conflicts(
    teaching_db, monkeypatch, claimed
):
    client = _client()
    assert client.post("/api/classroom/students", json=_student("number-owner", claimed)).status_code == 200
    before = {name: db.find_account(name) for name in ("teacher", "student", "number-owner")}
    monkeypatch.setattr(demo_accounts, "DEMO_STUDENT_COUNT", 2)
    monkeypatch.setattr(config, "BOOTSTRAP_PASSWORD", "changed-demo-password")
    with pytest.raises(management.StudentNumberTaken):
        db.initialize_schema()
    assert db.find_account("student02") is None
    assert {name: db.find_account(name) for name in before} == before


def test_demo_sync_cannot_restore_a_number_now_owned_by_someone_else(teaching_db, monkeypatch):
    client = _client()
    seed = db.find_account("student")
    assert client.post(f"/api/classroom/students/{seed['id']}", json={"student_no": "moved"}).status_code == 200
    assert client.post("/api/classroom/students", json=_student("number-owner", seed["student_no"])).status_code == 200
    before = {name: db.find_account(name) for name in ("teacher", "student", "number-owner")}
    monkeypatch.setattr(config, "BOOTSTRAP_PASSWORD", "changed-demo-password")
    with pytest.raises(management.StudentNumberTaken):
        db.initialize_schema()
    assert {name: db.find_account(name) for name in before} == before


def test_cli_teacher_provisioning_rejects_student_number_alias_without_changing_owner(teaching_db, monkeypatch):
    import sys

    from gvcsim.cli import main

    client = _client()
    assert client.post("/api/classroom/students", json=_student("number-owner", "Teacher.Two")).status_code == 200
    before = db.find_account("number-owner")
    monkeypatch.setattr(sys, "argv", ["gvcsim", "classroom-init", "--teacher-username", "TEACHER.two"])
    monkeypatch.setenv("GVCSIM_INITIAL_TEACHER_PASSWORD", "identity-test-password")
    with pytest.raises(SystemExit, match="未创建教师"):
        main()
    assert db.find_account("teacher.two") is None
    assert db.find_account("number-owner") == before


def _wait_for_database_waiters(connection, count):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        rows = connection.execute(
            "SELECT DISTINCT pid FROM pg_locks WHERE locktype='advisory' AND NOT granted "
            "AND database=(SELECT oid FROM pg_database WHERE datname=current_database())"
        ).fetchall()
        if len(rows) >= count:
            return
        # Poll an observed PostgreSQL state; elapsed time alone never releases the gate.
        threading.Event().wait(0.01)
    pytest.fail(f"Expected {count} database writers to reach the controlled wait, got {rows}")


@pytest.mark.parametrize(
    "operation",
    [
        "create",
        "update",
        "create-versus-update",
        "batch-versus-create",
        "batch-versus-update",
        "cross-field-create",
        "reverse-batches",
        "teacher-versus-student",
    ],
)
def test_concurrent_identity_claims_have_one_winner_and_no_partial_batch(teaching_db, operation):
    first, second = _client(), _client()
    number = "Race.Claim"
    group = _group()
    batch = {"class_id": group, "preview": False, "students": [_student(number), _student("batch-extra")]}
    jobs = [
        (first, "/api/classroom/students", _student("race-a", number)),
        (second, "/api/classroom/students", _student("race-b", number.lower())),
    ]
    if operation in {"update", "create-versus-update", "batch-versus-update"}:
        owners = [
            first.post("/api/classroom/students", json=_student(name)).json() for name in ("update-a", "update-b")
        ]
        jobs[1] = (second, f"/api/classroom/students/{owners[1]['id']}", {"student_no": number.lower()})
        if operation == "update":
            jobs[0] = (first, f"/api/classroom/students/{owners[0]['id']}", {"student_no": number})
    if operation in {"batch-versus-create", "batch-versus-update", "reverse-batches"}:
        jobs[0] = (first, "/api/classroom/students/batch", batch)
    if operation == "reverse-batches":
        jobs[1] = (second, "/api/classroom/students/batch", {**batch, "students": list(reversed(batch["students"]))})
    if operation == "cross-field-create":
        jobs[1] = (second, "/api/classroom/students", _student(number.lower()))

    def request(job):
        if operation == "teacher-versus-student" and job is jobs[1]:
            try:
                db.provision_teacher(number.lower(), "Teacher", "identity-test-password")
            except management.StudentNumberTaken:
                return 409
            return 200
        client, path, body = job
        response = client.post(path, json=body)
        assert response.status_code in {200, 409}, response.text
        return response.status_code

    # A database trigger pauses the first writer after its real ownership checks.
    # Without atomic ownership checks the second writer passes them too; with the
    # fix it waits before checking. Both reach actual PG waits before we release.
    with psycopg.connect(config.PG_DSN, autocommit=True) as control:
        control.execute("SELECT pg_advisory_lock(92706015)")
        control.execute("""
            CREATE FUNCTION hold_account_write() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                PERFORM pg_advisory_xact_lock(92706015);
                RETURN NEW;
            END $$;
            CREATE TRIGGER hold_account_write BEFORE INSERT OR UPDATE ON accounts
            FOR EACH ROW EXECUTE FUNCTION hold_account_write();
        """)
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(request, job) for job in jobs]
            try:
                _wait_for_database_waiters(control, 2)
            finally:
                control.execute("SELECT pg_advisory_unlock(92706015)")
            statuses = [future.result(timeout=10) for future in futures]
    assert sorted(statuses) == [200, 409]
    with db.conn() as connection:
        owners = connection.execute(
            "SELECT username,student_no FROM accounts WHERE lower(btrim(student_no))=%s OR lower(username)=%s",
            (number.lower(), number.lower()),
        ).fetchall()
        assert len(owners) == 1, owners
        enrollments = connection.execute(
            "SELECT count(*) AS n FROM class_enrollments WHERE class_id=%s", (group,)
        ).fetchone()["n"]
    if operation in {"batch-versus-create", "batch-versus-update", "reverse-batches"}:
        batch_won = operation == "reverse-batches" or statuses[0] == 200
        assert enrollments == (2 if batch_won else 0)
        assert (db.find_account("batch-extra") is not None) == batch_won
