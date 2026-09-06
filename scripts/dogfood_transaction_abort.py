"""Abort only the PostgreSQL backend blocked by this test's own row lock."""

import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import psycopg

from dogfood_sync import request


def main():
    pgdata = Path(os.environ["GVCSIM_FAULT_PGDATA"]).resolve()
    dsn = os.environ["GVCSIM_PG_DSN"]
    with psycopg.connect(dsn) as connection:
        assert Path(connection.execute("SHOW data_directory").fetchone()[0]).resolve() == pgdata
    base = os.environ["GVCSIM_BASE_URL"].rstrip("/")
    teacher = request(
        base,
        "POST",
        "/api/auth/login",
        {
            "username": os.environ["GVCSIM_E2E_TEACHER_USERNAME"],
            "password": os.environ["GVCSIM_E2E_TEACHER_PASSWORD"],
        },
    )[1]["token"]
    password = os.environ["GVCSIM_E2E_PASSWORD"]
    results = []
    for attempt in (1, 2):
        username = "abort-transaction-" + uuid.uuid4().hex[:8]
        status, account = request(
            base,
            "POST",
            "/api/classroom/students",
            {
                "username": username,
                "display_name": username,
                "password": password,
            },
            teacher,
        )
        assert status == 200
        token = request(base, "POST", "/api/auth/login", {"username": username, "password": password})[1]["token"]
        initial = {"version": "experiment-session-simple-v3", "steps": {}, "shared": {}}
        status, saved = request(
            base, "PUT", "/api/classroom/session", {"session": initial, "base_updated_at": None}, token
        )
        assert status == 200
        latest = {**initial, "steps": {"15": {"data": {"research_question": "write after restart"}}}}
        payload = {"session": latest, "base_updated_at": saved["updated_at"]}
        with psycopg.connect(dsn) as holder, ThreadPoolExecutor(max_workers=1) as executor:
            holder.execute("SELECT 1 FROM experiment_sessions WHERE account_id=%s FOR UPDATE", (account["id"],))
            pending = executor.submit(request, base, "PUT", "/api/classroom/session", payload, token)
            try:
                with psycopg.connect(dsn, autocommit=True) as observer:
                    deadline = time.monotonic() + 10
                    victim = None
                    while time.monotonic() < deadline:
                        victim = observer.execute(
                            "SELECT pid FROM pg_stat_activity WHERE datname=current_database()"
                            " AND wait_event_type='Lock' AND %s = ANY(pg_blocking_pids(pid))"
                            " AND query LIKE 'UPDATE experiment_sessions%%'",
                            (holder.info.backend_pid,),
                        ).fetchone()
                        if victim:
                            break
                        time.sleep(0.01)
                    assert victim, "request did not reach the controlled row lock"
                    assert observer.execute("SELECT pg_terminate_backend(%s)", (victim[0],)).fetchone()[0]
                status, _ = pending.result(timeout=15)
                assert status == 503, status
            finally:
                holder.rollback()
            status, after = request(base, "GET", "/api/classroom/session", token=token)
            assert status == 200 and after["session"] == initial and after["updated_at"] == saved["updated_at"]
            status, after = request(base, "PUT", "/api/classroom/session", payload, token)
            assert status == 200 and after["session"] == latest
        results.append({"case": "FAIL-01-abort-uncommitted-transaction", "attempt": attempt, "passed": True})
        print(json.dumps(results[-1]), flush=True)
    target = Path(os.environ["GVCSIM_E2E_ARTIFACT_DIR"])
    target.mkdir(parents=True, exist_ok=True)
    (target / "transaction-abort.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
