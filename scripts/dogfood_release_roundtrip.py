"""Publish A -> B -> A around owned API processes; preserve sessions and reports."""

import argparse
import http.client
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.error import URLError

import psycopg

from dogfood_process_faults import free_port
from dogfood_sync import request
from seed_full_journey import seed_full_journey


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-a", type=Path, required=True)
    parser.add_argument("--release-b", type=Path, required=True)
    parser.add_argument("--raw-a", type=Path, required=True)
    parser.add_argument("--raw-b", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    from gvcsim import artifacts, publication

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    sources = [args.release_a.resolve(), args.release_b.resolve()]
    identities = [artifacts.validate_release(path)["release_id"] for path in sources]
    assert identities[0] != identities[1]
    password = os.environ["GVCSIM_E2E_PASSWORD"]
    results = []
    for attempt in (1, 2):
        case = output / str(attempt)
        case.mkdir()
        active = case / "data" / "processed"
        store = publication.release_store(active)
        store.mkdir(parents=True)
        releases = [store / identity for identity in identities]
        for source, release in zip(sources, releases, strict=True):
            shutil.copytree(source, release)
        port = free_port()
        base = f"http://127.0.0.1:{port}"
        process = None
        username = "release-roundtrip-" + uuid.uuid4().hex[:8]
        snapshots = []
        tokens = []
        values = []
        log = (case / "api.log").open("w")
        try:
            for phase, index in enumerate((0, 1, 0)):
                if process:
                    process.terminate()
                    process.wait(timeout=15)
                artifacts.validate_release(releases[index])
                publication.publish_release(active, releases[index])
                env = {
                    **os.environ,
                    "GVCSIM_DATA_DIR": str(active.parent),
                    "GVCSIM_RAW_DATA_DIR": str((args.raw_a if index == 0 else args.raw_b).resolve()),
                    "CI": "true",
                    "GVCSIM_CI_SYNTHETIC": "1",
                }
                process = subprocess.Popen(
                    [sys.executable, "-m", "gvcsim.cli", "serve", "--port", str(port)], env=env, stdout=log, stderr=log
                )
                deadline = time.monotonic() + 40
                while time.monotonic() < deadline:
                    try:
                        if request(base, "GET", "/health")[0] == 200:
                            break
                    except (URLError, OSError, http.client.HTTPException):
                        pass
                    time.sleep(0.05)
                teacher = request(
                    base,
                    "POST",
                    "/api/auth/login",
                    {
                        "username": os.environ["GVCSIM_E2E_TEACHER_USERNAME"],
                        "password": os.environ["GVCSIM_E2E_TEACHER_PASSWORD"],
                    },
                )[1]["token"]
                if phase == 0:
                    status, account = request(
                        base,
                        "POST",
                        "/api/classroom/students",
                        {"username": username, "display_name": username, "password": password},
                        teacher,
                    )
                    assert status == 200
                login = request(base, "POST", "/api/auth/login", {"username": username, "password": password})[1]
                assert login["user"]["account_id"] == account["id"]
                token = login["token"]
                if phase:
                    assert request(base, "GET", "/api/classroom/session", token=tokens[-1])[0] == 401
                if phase < 2:
                    workspace = request(base, "GET", "/api/classroom/session", token=token)[1]
                    assert workspace["updated_at"] is None and workspace["report"] is None
                    seed_full_journey(base, username, password)
                    status, generated = request(base, "POST", "/api/classroom/report/generate", {}, token)
                    assert status == 200, generated
                    _, submitted = request(base, "POST", "/api/classroom/report/submit", {}, token)
                    status, graded = request(
                        base,
                        "POST",
                        f"/api/classroom/reports/{account['id']}/grade",
                        {
                            "score": 41 + phase,
                            "feedback": f"release {index}",
                            "expected_updated_at": submitted["report"]["updated_at"],
                        },
                        teacher,
                    )
                    assert status == 200, graded
                    snapshots.append(request(base, "GET", "/api/classroom/session", token=token)[1])
                    values.append(request(base, "GET", "/api/indicators/country/2016", token=token)[1])
                    tokens.append(token)
                else:
                    assert request(base, "GET", "/api/classroom/session", token=token)[1] == snapshots[0]
                    assert request(base, "GET", "/api/indicators/country/2016", token=token)[1] == values[0]
                    # The existing contract binds tokens to release identity, not a
                    # publication counter: an unexpired A token is valid again on A.
                    assert request(base, "GET", "/api/classroom/session", token=tokens[0])[0] == 200
            assert values[0] != values[1], "use distinct valid data to exercise cache identity"
            with psycopg.connect(os.environ["GVCSIM_PG_DSN"]) as connection:
                saved = connection.execute(
                    "SELECT release_id,score,state FROM reports WHERE account_id=%s ORDER BY score", (account["id"],)
                ).fetchall()
                assert saved == [(identities[0], 41, "graded"), (identities[1], 42, "graded")]
                assert (
                    connection.execute(
                        "SELECT count(*) FROM experiment_sessions WHERE account_id=%s", (account["id"],)
                    ).fetchone()[0]
                    == 2
                )
            results.append(
                {
                    "case": "REL-01",
                    "attempt": attempt,
                    "passed": True,
                    "distinct_data": True,
                    "account_preserved": True,
                    "report_scores": [41, 42],
                    "original_a_token_valid_again_on_a": True,
                }
            )
            print(json.dumps(results[-1]), flush=True)
        finally:
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=15)
            log.close()
            (output / "results.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
