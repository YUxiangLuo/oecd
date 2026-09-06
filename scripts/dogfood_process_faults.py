"""Kill owned API subprocesses before/after commits on a dedicated test database."""

import http.client
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import URLError

import psycopg

from dogfood_sync import request


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def main():
    dsn = os.environ["GVCSIM_PG_DSN"]
    with psycopg.connect(dsn) as connection:
        assert (
            Path(connection.execute("SHOW data_directory").fetchone()[0]).resolve()
            == Path(os.environ["GVCSIM_FAULT_PGDATA"]).resolve()
        )
    output = Path(os.environ["GVCSIM_E2E_ARTIFACT_DIR"]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    api_port, proxy_port = free_port(), free_port()
    base, proxy_url = f"http://127.0.0.1:{api_port}", f"http://127.0.0.1:{proxy_port}"
    api = proxy = None
    results = []
    log = (output / "owned-processes.log").open("w")

    def ready():
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                if request(base, "GET", "/health")[0] == 200:
                    return
            except (URLError, OSError, http.client.HTTPException):
                pass
            time.sleep(0.05)
        raise RuntimeError("owned API did not become ready")

    def start():
        process = subprocess.Popen(
            [sys.executable, "-m", "gvcsim.cli", "serve", "--port", str(api_port), "--no-access-log"],
            stdout=log,
            stderr=log,
        )
        try:
            ready()
        except Exception:
            process.kill()
            process.wait(timeout=10)
            raise
        return process

    def mutation(url, payload, token):
        try:
            return request(url, "PUT", "/api/classroom/session", payload, token)[0]
        except (URLError, OSError, http.client.HTTPException):
            return "connection_lost"

    try:
        api = start()
        proxy = subprocess.Popen(
            [
                sys.executable,
                str(Path(__file__).with_name("dogfood_fault_proxy.py")),
                "--port",
                str(proxy_port),
                "--upstream",
                base,
            ],
            stdout=log,
            stderr=log,
        )
        # Wait on the actual control endpoint, not an arbitrary startup sleep.
        deadline = time.monotonic() + 10
        while True:
            try:
                request(proxy_url, "GET", "/__fault/status")
                break
            except (URLError, OSError):
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.02)
        for attempt in (1, 2):
            teacher = request(
                base,
                "POST",
                "/api/auth/login",
                {
                    "username": os.environ["GVCSIM_E2E_TEACHER_USERNAME"],
                    "password": os.environ["GVCSIM_E2E_TEACHER_PASSWORD"],
                },
            )[1]["token"]
            username = "process-fault-" + uuid.uuid4().hex[:8]
            password = os.environ["GVCSIM_E2E_PASSWORD"]
            code, account = request(
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
            assert code == 200
            token = request(base, "POST", "/api/auth/login", {"username": username, "password": password})[1]["token"]
            initial = {"version": "experiment-session-simple-v3", "steps": {}, "shared": {}}
            _, saved = request(
                base, "PUT", "/api/classroom/session", {"session": initial, "base_updated_at": None}, token
            )
            newer = {**initial, "steps": {"15": {"data": {"research_question": "new committed data"}}}}
            payload = {"session": newer, "base_updated_at": saved["updated_at"]}
            with psycopg.connect(dsn) as holder, ThreadPoolExecutor(max_workers=1) as executor:
                holder.execute("SELECT 1 FROM experiment_sessions WHERE account_id=%s FOR UPDATE", (account["id"],))
                future = executor.submit(mutation, base, payload, token)
                try:
                    with psycopg.connect(dsn, autocommit=True) as observer:
                        deadline = time.monotonic() + 10
                        waiting = None
                        while time.monotonic() < deadline:
                            waiting = observer.execute(
                                "SELECT pid FROM pg_stat_activity WHERE datname=current_database()"
                                " AND %s = ANY(pg_blocking_pids(pid))",
                                (holder.info.backend_pid,),
                            ).fetchone()
                            if waiting:
                                break
                            time.sleep(0.01)
                        assert waiting
                    api.kill()
                    api.wait(timeout=10)
                    assert future.result(timeout=10) == "connection_lost"
                finally:
                    holder.rollback()
            api = start()
            _, restored = request(base, "GET", "/api/classroom/session", token=token)
            assert restored["session"] == initial and restored["updated_at"] == saved["updated_at"]
            results.append({"case": "FAIL-01-kill-before-commit", "attempt": attempt, "passed": True})
            print(json.dumps(results[-1]), flush=True)
            request(proxy_url, "POST", "/__fault/arm", {"phase": "after", "action": "drop"})
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(mutation, proxy_url, payload, token)
                try:
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        state = request(proxy_url, "GET", "/__fault/status")[1]
                        if state["phase"] == "after":
                            break
                        time.sleep(0.01)
                    assert state == {"phase": "after", "upstream_status": 200}
                    with psycopg.connect(dsn) as observer:
                        rows = observer.execute(
                            "SELECT session FROM experiment_sessions WHERE account_id=%s", (account["id"],)
                        ).fetchall()
                        assert rows == [(newer,)]
                    api.kill()
                    api.wait(timeout=10)
                finally:
                    request(proxy_url, "POST", "/__fault/release", {})
                assert future.result(timeout=10) == "connection_lost"
            api = start()
            _, restored = request(base, "GET", "/api/classroom/session", token=token)
            assert restored["session"] == newer
            assert request(base, "PUT", "/api/classroom/session", payload, token)[0] == 409
            results.append({"case": "FAIL-01-kill-after-commit", "attempt": attempt, "passed": True})
            print(json.dumps(results[-1]), flush=True)
    finally:
        for process in (proxy, api):
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=15)
        log.close()
        (output / "process-faults.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
