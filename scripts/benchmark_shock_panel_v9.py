#!/usr/bin/env python3
"""Authenticated v9 shock-panel release benchmark.

This harness deliberately refuses old/unvalidated artifacts.  It exercises the
normal FastAPI authentication middleware and ``/api/shocks/panel`` route through
TestClient, clears only the exposure index for one cold sample, then records
warm sequential and eight-concurrent response latencies.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from gvcsim import artifacts, data_routes
from gvcsim.api import app
from gvcsim.config import PROCESSED_DIR

SEQUENTIAL_BUDGET_MS = 500.0
CONCURRENT_BUDGET_MS = 1500.0
DEFAULT_OUTPUT = Path("benchmarks/shock_panel_v9.json")


def percentile(values: list[float], quantile: float = 0.95) -> float:
    if not values:
        raise ValueError("benchmark sample must not be empty")
    ordered = sorted(values)
    rank = max(0, math.ceil(quantile * len(ordered)) - 1)
    return float(ordered[rank])


def sample_summary(values: list[float], budget_ms: float) -> dict[str, Any]:
    p95 = percentile(values)
    return {
        "samples": len(values),
        "min": min(values),
        "median": statistics.median(values),
        "p95": p95,
        "max": max(values),
        "budget_p95_ms": budget_ms,
        "passed": p95 <= budget_ms,
    }


def _timed_panel_request(client: TestClient, params: dict[str, Any]) -> float:
    started = time.perf_counter()
    response = client.get("/api/shocks/panel", params=params)
    elapsed = (time.perf_counter() - started) * 1000.0
    if response.status_code != 200:
        raise RuntimeError(f"shock panel returned {response.status_code}: {response.text}")
    payload = response.json()
    if payload.get("page_size") != params["page_size"] or "disclaimer" not in payload:
        raise RuntimeError("shock panel response did not satisfy the current response contract")
    return elapsed


def run_benchmark(
    *,
    username: str,
    password: str,
    sequential_samples: int,
    concurrent_samples: int,
) -> dict[str, Any]:
    if sequential_samples < 2:
        raise ValueError("sequential_samples must be at least 2")
    if concurrent_samples < 8 or concurrent_samples % 8:
        raise ValueError("concurrent_samples must be a positive multiple of 8")

    # Match deployment readiness: validate and seed the release cache before
    # traffic rather than manufacturing full raw reconciliation in a request.
    validation = artifacts.validate_release_cached(PROCESSED_DIR)
    metadata = artifacts.dataset_metadata(PROCESSED_DIR)
    if metadata.get("artifact_contract_version") != artifacts.ARTIFACT_CONTRACT_VERSION:
        raise RuntimeError("benchmark requires the active artifact contract v9 release")

    years = metadata.get("years")
    if not isinstance(years, list) or not years:
        raise RuntimeError("validated release has no declared years")
    params = {
        "year": max(years),
        "shock_type": "tariff",
        "filter": "treated",
        "page": 1,
        "page_size": 25,
    }

    with TestClient(app) as client:
        login = client.post("/api/auth/login", json={"username": username, "password": password})
        if login.status_code != 200:
            raise RuntimeError(f"benchmark login failed ({login.status_code}): {login.text}")
        client.headers["Authorization"] = f"Bearer {login.json()['token']}"

        # Clear only the derived lookup.  In a fresh benchmark process the
        # shock/exposure CSV caches are still empty, while release validation
        # remains cached exactly as it is after deployment readiness succeeds.
        data_routes.clear_exposure_index_cache()
        cold_ms = _timed_panel_request(client, params)

        # Re-clear and start eight first requests together. The runtime builder is
        # required to provide single-flight construction rather than multiplying
        # cold memory by the classroom's request concurrency.
        data_routes.clear_exposure_index_cache()
        with ThreadPoolExecutor(max_workers=8) as executor:
            concurrent_cold_ms = list(executor.map(lambda _index: _timed_panel_request(client, params), range(8)))

        warm_ms = [_timed_panel_request(client, params) for _ in range(sequential_samples)]
        with ThreadPoolExecutor(max_workers=8) as executor:
            concurrent_ms = list(
                executor.map(
                    lambda _index: _timed_panel_request(client, params),
                    range(concurrent_samples),
                )
            )

    cold = {
        "samples": 1,
        "milliseconds": cold_ms,
        "budget_ms": SEQUENTIAL_BUDGET_MS,
        "passed": cold_ms <= SEQUENTIAL_BUDGET_MS,
    }
    concurrent_cold = sample_summary(concurrent_cold_ms, CONCURRENT_BUDGET_MS)
    sequential = sample_summary(warm_ms, SEQUENTIAL_BUDGET_MS)
    concurrent = sample_summary(concurrent_ms, CONCURRENT_BUDGET_MS)
    passed = bool(cold["passed"] and concurrent_cold["passed"] and sequential["passed"] and concurrent["passed"])
    return {
        "benchmark": "authenticated_shock_panel_active_v9",
        "status": "passed" if passed else "budget_failure",
        "method": (
            "Validated and cached the active release, authenticated through /api/auth/login, then called "
            "/api/shocks/panel through the normal middleware/route. Only the exposure index is cleared; "
            "in a fresh process the first sample includes cold shock/exposure CSV reads and index construction. "
            "A second cold phase starts eight requests together to verify single-flight behavior."
        ),
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "logical_cpus": os.cpu_count(),
        },
        "release": {
            "release_id": validation["release_id"],
            "artifact_contract_version": metadata["artifact_contract_version"],
            "shock_contract": metadata["shock_contract"],
            "years": years,
            "files": validation["files"],
        },
        "request": params,
        "cold_index_build_ms": cold,
        "eight_concurrent_cold_ms": concurrent_cold,
        "warm_sequential_ms": sequential,
        "eight_concurrent_ms": concurrent,
        "passed": passed,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username", default=os.environ.get("GVCSIM_BENCHMARK_USERNAME", "student"))
    parser.add_argument("--password", default=os.environ.get("GVCSIM_BENCHMARK_PASSWORD", "gvclab2026"))
    parser.add_argument("--sequential-samples", type=int, default=40)
    parser.add_argument("--concurrent-samples", type=int, default=48)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    result = run_benchmark(
        username=args.username,
        password=args.password,
        sequential_samples=args.sequential_samples,
        concurrent_samples=args.concurrent_samples,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
