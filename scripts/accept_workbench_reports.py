#!/usr/bin/env python3
"""HTTP acceptance on explicitly disposable accounts; never initializes/resets a DB.

prepare saves complete public-API evidence and one actual model-experiment snapshot a step.
Restart the isolated API (all workers) before run to measure genuinely cold reports.
Credentials are a JSON array of {username,password} in GVCSIM_ACCEPT_ACCOUNTS.
Only aggregate timings/status codes are emitted, never response bodies or identities.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import itertools
import json
import math
import os
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit

from seed_full_journey import _request_json, seed_full_journey
from gvcsim.regression.spec import CONTROLS
from gvcsim.regression.teaching import selectable_baselines
from gvcsim.regression.workbench import experiment_problem


OUTCOMES = ((11, "trade"), (12, "production"), (13, "length"), (14, "network"))


def models(slot: int, outcome: str) -> list[dict]:
    """Distinct canonical custom specs across up to 20 students, three per step."""
    choices = list(itertools.product((None, 0, 1), repeat=len(CONTROLS)))
    return [
        dict(
            outcome=outcome,
            baseline=selectable_baselines(outcome)[0].key,
            spec={
                "x_lags": [0, 1],
                "fixed_effects": ["country", "industry", "year"],
                "controls": [
                    {"name": name, "lag": lag} for name, lag in zip(CONTROLS, choices[slot * 3 + j]) if lag is not None
                ],
            },
        )
        for j in range(3)
    ]


class Acceptance:
    def __init__(self, base: str, budget: float):
        self.base, self.budget = base, budget
        self.samples: list[tuple[str, int, float]] = []

    def request(self, phase: str, method: str, path: str, token=None, payload=None, expected=200):
        start = time.perf_counter()
        status, value = 200, None
        try:
            value = _request_json(self.base, method, path, token=token, payload=payload, timeout=self.budget + 30)
        except RuntimeError as error:
            if isinstance(error.__cause__, HTTPError):
                status = error.__cause__.code
            else:
                status = 0  # Do not log exception text: helper includes response bodies.
        elapsed = time.perf_counter() - start
        self.samples.append((phase, status, elapsed))
        if status != expected or elapsed > self.budget:
            raise RuntimeError("acceptance status/latency budget failed")
        return value

    def summary(self):
        for phase in sorted({s[0] for s in self.samples}):
            rows = [s for s in self.samples if s[0] == phase]
            times = sorted(s[2] for s in rows)
            print(
                json.dumps(
                    {
                        "phase": phase,
                        "requests": len(rows),
                        "statuses": {
                            str(code): sum(s[1] == code for s in rows) for code in sorted({s[1] for s in rows})
                        },
                        "p50_s": times[(len(times) - 1) // 2],
                        "p95_s": times[min(len(times) - 1, int(len(times) * 0.95))],
                        "max_s": times[-1],
                    }
                )
            )


def execute(a: Acceptance, accounts: list[dict], mode: str):
    tokens = [a.request("login", "POST", "/api/auth/login", payload=account)["token"] for account in accounts]
    workspaces = [a.request("precheck", "GET", "/api/classroom/session", token) for token in tokens]
    # Precheck every account before modifying any. Never clobber genuine work.
    for workspace in workspaces:
        if workspace.get("report") is not None:
            raise RuntimeError("requires accounts without reports")
        if mode == "prepare" and (workspace["session"].get("steps") or workspace["session"].get("shared")):
            raise RuntimeError("prepare requires empty disposable student sessions")
    if mode == "prepare":
        for slot, (account, token) in enumerate(zip(accounts, tokens)):
            seed_full_journey(a.base, account["username"], account["password"])
            workspace = a.request("seed-read", "GET", "/api/classroom/session", token)
            session = workspace["session"]
            for step, outcome in OUTCOMES:
                # One experiment a step: the first of this slot's distinct models.
                model = models(slot, outcome)[0]
                response = a.request("prepare-custom", "POST", "/api/regression/run", token, model)
                snapshot = {
                    "depvar_label": response["design"]["depvar_label"],
                    "depvar_kind": response["design"].get("depvar_kind", ""),
                    "result": response["result"],
                }
                experiment = {
                    "spec": model["spec"],
                    "saved_at": datetime.now(timezone.utc).isoformat(),
                    "snapshot": snapshot,
                }
                if experiment_problem(experiment) is not None:
                    raise RuntimeError("invalid real model snapshot")
                session["steps"][str(step)]["data"]["experiment"] = experiment
            saved = a.request(
                "prepare-save",
                "PUT",
                "/api/classroom/session",
                token,
                {"session": session, "base_updated_at": workspace["updated_at"]},
            )
            if saved["report_gate"] or saved["material_gate"]:
                raise RuntimeError("incomplete session")
        return
    for slot, workspace in enumerate(workspaces):
        if workspace["report_gate"] or workspace["material_gate"]:
            raise RuntimeError("run requires prepared complete sessions")
        for step, outcome in OUTCOMES:
            experiment = workspace["session"]["steps"][str(step)]["data"].get("experiment")
            if (
                experiment_problem(experiment) is not None
                or experiment is None
                or experiment["spec"] != models(slot, outcome)[0]["spec"]
            ):
                raise RuntimeError("run requires this harness's prepared models")

    def report(token, phase, version=None):
        return a.request(
            phase, "POST", "/api/classroom/report/generate", token, {"expected_report_updated_at": version}
        )["report"]

    with ThreadPoolExecutor(max_workers=len(tokens)) as pool:
        cold = list(pool.map(lambda token: report(token, "cold-report-burst"), tokens))
        warm = list(
            pool.map(lambda pair: report(pair[0], "warm-report-burst", pair[1]["updated_at"]), zip(tokens, cold))
        )
    for slot, token in enumerate(tokens):
        for _, outcome in OUTCOMES:
            a.request("warm-default", "POST", "/api/regression/run", token, {"outcome": outcome})
            model = models(slot, outcome)[0]
            first = a.request("custom-repeat", "POST", "/api/regression/run", token, model)
            second = a.request("custom-repeat", "POST", "/api/regression/run", token, model)
            if first != second:
                raise RuntimeError("repeat model differs")
        a.request(
            "invalid-model",
            "POST",
            "/api/regression/run",
            token,
            {"outcome": "trade", "baseline": "not-offered"},
            expected=400,
        )
        a.request(
            "stale-report",
            "POST",
            "/api/classroom/report/generate",
            token,
            {"expected_report_updated_at": "2000-01-01T00:00:00Z"},
            expected=409,
        )
        after = a.request("failure-readback", "GET", "/api/classroom/session", token)
        if after["report"]["updated_at"] != warm[slot]["updated_at"]:
            raise RuntimeError("failed report changed persisted version")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "run"))
    parser.add_argument("--disposable-demo-target", required=True, help="explicit isolated HTTP base URL")
    parser.add_argument("--max-seconds", type=float, default=120)
    args = parser.parse_args()
    url = urlsplit(args.disposable_demo_target)
    if (
        url.scheme not in ("http", "https")
        or not url.netloc
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        parser.error("provide a credential-free isolated HTTP base URL")
    try:
        accounts = json.loads(os.environ["GVCSIM_ACCEPT_ACCOUNTS"])
        if not isinstance(accounts, list) or not 2 <= len(accounts) <= 20:
            raise ValueError
        if not all(
            isinstance(a, dict)
            and set(a) == {"username", "password"}
            and all(isinstance(v, str) and v for v in a.values())
            for a in accounts
        ):
            raise ValueError
        if len({a["username"].lower() for a in accounts}) != len(accounts):
            raise ValueError
        if not math.isfinite(args.max_seconds) or args.max_seconds <= 0:
            raise ValueError
    except (KeyError, ValueError, TypeError):
        parser.error("require 2–20 unique disposable credentials in GVCSIM_ACCEPT_ACCOUNTS and positive budget")
    acceptance = Acceptance(args.disposable_demo_target, args.max_seconds)
    try:
        execute(acceptance, accounts, args.mode)
    except Exception:
        raise SystemExit("FAIL: acceptance aborted (details suppressed to protect records/credentials)") from None
    finally:
        acceptance.summary()
    print(
        json.dumps(
            {
                "result": "pass",
                "mode": args.mode,
                "billing": "not observable via public HTTP; inspect isolated server counters separately",
                "cold": "requires operator restart before run",
            }
        )
    )


if __name__ == "__main__":
    main()
