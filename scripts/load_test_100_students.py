#!/usr/bin/env python3
"""以独立账号模拟 50-100 名学生同时登录、读取、回归和写进度。

示例：
  uv run python scripts/load_test_100_students.py \
    --base-url http://127.0.0.1:18000 \
    --users-file data/loadtest-users.json \
    --students 100 --json-output data/loadtest-result.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import time
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import httpx2 as httpx


@dataclass(frozen=True)
class Sample:
    operation: str
    status: int
    seconds: float
    error: str = ""


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return math.nan
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.ceil(percentile * len(ordered)) - 1)
    return ordered[max(0, index)]


async def _request(
    client: httpx.AsyncClient,
    operation: str,
    method: str,
    path: str,
    *,
    token: str | None = None,
    body: dict[str, Any] | None = None,
) -> tuple[Sample, dict[str, Any] | None]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    started = time.perf_counter()
    try:
        response = await client.request(method, path, headers=headers, json=body)
        seconds = time.perf_counter() - started
        payload = response.json() if response.content else None
        detail = ""
        if response.status_code >= 400:
            detail = str(payload.get("detail", ""))[:240] if isinstance(payload, dict) else response.text[:240]
        return Sample(operation, response.status_code, seconds, detail), payload if isinstance(payload, dict) else None
    except Exception as error:
        rendered = f"{type(error).__name__}: {error}".strip()
        return Sample(operation, 0, time.perf_counter() - started, rendered[:240]), None


async def _phase(
    client: httpx.AsyncClient,
    operation: str,
    method: str,
    path: str,
    tokens: list[str],
    *,
    body: dict[str, Any] | None = None,
) -> list[Sample]:
    rows = await asyncio.gather(
        *(_request(client, operation, method, path, token=token, body=body) for token in tokens)
    )
    return [sample for sample, _payload in rows]


def _summarize(samples: list[Sample]) -> dict[str, Any]:
    grouped: dict[str, list[Sample]] = defaultdict(list)
    for sample in samples:
        grouped[sample.operation].append(sample)
    operations: dict[str, Any] = {}
    for operation, rows in grouped.items():
        latencies = [row.seconds for row in rows]
        operations[operation] = {
            "requests": len(rows),
            "status_counts": dict(sorted(Counter(row.status for row in rows).items())),
            "p50_seconds": round(_percentile(latencies, 0.50), 3),
            "p95_seconds": round(_percentile(latencies, 0.95), 3),
            "p99_seconds": round(_percentile(latencies, 0.99), 3),
            "max_seconds": round(max(latencies), 3),
        }
    failures = [asdict(sample) for sample in samples if not 200 <= sample.status < 300]
    return {"operations": operations, "failures": failures[:30], "failure_count": len(failures)}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="GVC Lab 50-100 学生容量验收")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--users-file", type=Path, required=True)
    parser.add_argument("--students", type=int, default=100)
    parser.add_argument("--placebo-ratio", type=float, default=0.25)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--max-read-p95", type=float, default=3)
    parser.add_argument("--max-regression-p95", type=float, default=35)
    parser.add_argument("--max-placebo-p95", type=float, default=50)
    parser.add_argument("--max-total-seconds", type=float, default=120)
    parser.add_argument("--json-output", type=Path)
    return parser


async def _run(args: argparse.Namespace) -> tuple[dict[str, Any], bool]:
    credentials = json.loads(args.users_file.read_text(encoding="utf-8"))
    if credentials.get("kind") != "gvcsim-capacity-test-users-v1":
        raise SystemExit("users file 契约不正确")
    users = list(credentials.get("users") or [])[: args.students]
    if not 50 <= len(users) <= 100:
        raise SystemExit("容量验收必须使用 50..100 个独立学生账号")
    if not 0 <= args.placebo_ratio <= 1:
        raise SystemExit("--placebo-ratio 必须在 0..1 之间")

    limits = httpx.Limits(
        max_connections=max(200, len(users) * 2),
        max_keepalive_connections=max(100, len(users)),
    )
    samples: list[Sample] = []
    overall_started = time.perf_counter()
    async with httpx.AsyncClient(
        base_url=args.base_url.rstrip("/"),
        timeout=args.timeout,
        limits=limits,
    ) as client:
        login_rows = await asyncio.gather(
            *(
                _request(
                    client,
                    "login",
                    "POST",
                    "/api/auth/login",
                    body={"username": user["username"], "password": user["password"]},
                )
                for user in users
            )
        )
        samples.extend(sample for sample, _payload in login_rows)
        tokens = [
            str(payload["token"])
            for sample, payload in login_rows
            if sample.status == 200 and payload and payload.get("token")
        ]
        if len(tokens) != len(users):
            summary = _summarize(samples)
            summary.update({"students": len(users), "authenticated": len(tokens)})
            return summary, False

        read_paths = (
            ("meta", "/api/meta"),
            ("steps", "/api/steps"),
            ("classroom_context", "/api/classroom/context"),
            ("country_indicators", "/api/indicators/country/2020?country=CHN"),
            ("raw_accounts", "/api/db/slice?year=2020&table=accounts&page=1&page_size=25"),
        )
        for operation, path in read_paths:
            samples.extend(await _phase(client, operation, "GET", path, tokens))

        samples.extend(
            await _phase(
                client,
                "regression",
                "POST",
                "/api/regression/run",
                tokens,
                body={"outcome": "trade"},
            )
        )

        placebo_count = round(len(tokens) * args.placebo_ratio)
        if placebo_count:
            samples.extend(
                await _phase(
                    client,
                    "placebo",
                    "POST",
                    "/api/regression/placebo",
                    tokens[:placebo_count],
                    body={"outcome": "network", "n_draws": 40, "seed": 2026},
                )
            )

        samples.extend(
            await _phase(
                client,
                "progress_write",
                "POST",
                "/api/classroom/progress",
                tokens,
                body={"step": 12},
            )
        )

    elapsed = time.perf_counter() - overall_started
    summary = _summarize(samples)
    summary.update(
        {
            "students": len(users),
            "authenticated": len(tokens),
            "placebo_students": placebo_count,
            "total_seconds": round(elapsed, 3),
        }
    )
    operations = summary["operations"]
    read_operations = [operations[name]["p95_seconds"] for name, _path in read_paths if name in operations]
    gates = {
        "all_requests_succeeded": summary["failure_count"] == 0,
        "read_p95_within_budget": max(read_operations, default=0) <= args.max_read_p95,
        "regression_p95_within_budget": operations.get("regression", {}).get("p95_seconds", math.inf)
        <= args.max_regression_p95,
        "placebo_p95_within_budget": operations.get("placebo", {}).get("p95_seconds", 0) <= args.max_placebo_p95,
        "total_time_within_budget": elapsed <= args.max_total_seconds,
    }
    summary["gates"] = gates
    return summary, all(gates.values())


def main() -> None:
    args = _parser().parse_args()
    summary, passed = asyncio.run(_run(args))
    for operation, row in summary.get("operations", {}).items():
        print(
            f"{operation:20} n={row['requests']:3d} "
            f"p50={row['p50_seconds']:6.3f}s p95={row['p95_seconds']:6.3f}s "
            f"p99={row['p99_seconds']:6.3f}s status={row['status_counts']}"
        )
    print(f"总耗时 {summary.get('total_seconds', 0):.3f}s；验收 {'通过' if passed else '失败'}")
    if args.json_output:
        args.json_output.parent.mkdir(parents=True, exist_ok=True)
        args.json_output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"JSON 结果：{args.json_output}")
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
