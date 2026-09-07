#!/usr/bin/env python3
"""Seed one real student session through public APIs for browser journey E2E.

The helper is intentionally a test harness: it imports the server-owned quiz key,
runs all four public regression endpoints, records real release-bound evidence, and
saves through the same optimistic-concurrency session route used by the browser.
It never writes PostgreSQL directly and refuses a pre-existing report.
"""

from __future__ import annotations

import argparse
import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from gvcsim import quizzes, teaching_report
from gvcsim.session import empty_session, make_record


def _request_json(
    base_url: str,
    method: str,
    path: str,
    *,
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    timeout: float = 120.0,
) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(f"{base_url.rstrip('/')}{path}", data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} returned {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"{method} {path} failed: {error.reason}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{method} {path} did not return a JSON object")
    return value


def _countries(meta: dict[str, Any]) -> tuple[str, str]:
    available = [str(value) for value in meta.get("countries", []) if str(value) != "ROW"]
    if {"CHN", "USA"}.issubset(available):
        return "CHN", "USA"
    if len(available) < 2:
        raise RuntimeError("active release needs at least two non-ROW economies for the full journey")
    return available[0], available[1]


def _step_one_observation(
    base_url: str,
    token: str,
    year: int,
    left: str,
    right: str,
) -> dict[str, Any]:
    query = urlencode(
        {
            "year": year,
            "table": "z",
            "row_country": left,
            "col_country": right,
            "page": 1,
            "page_size": 25,
        }
    )
    payload = _request_json(base_url, "GET", f"/api/db/slice?{query}", token=token)
    rows = payload.get("rows")
    columns = payload.get("columns")
    if not isinstance(rows, list) or not rows or not isinstance(columns, list):
        raise RuntimeError("Step 1 slice did not contain a recordable cell")
    row = rows[0]
    if not isinstance(row, dict):
        raise RuntimeError("Step 1 slice row is malformed")
    column = next(
        (
            str(name)
            for name in columns
            if name != "row"
            and isinstance(row.get(str(name)), (int, float))
            and not isinstance(row.get(str(name)), bool)
        ),
        None,
    )
    if column is None:
        raise RuntimeError("Step 1 slice did not contain a finite numeric cell")
    return {
        "row": str(row["row"]),
        "column": column,
        "value": row[column],
        "year": year,
        "table": "z",
        "row_country": left,
        "col_country": right,
    }


def seed_full_journey(base_url: str, username: str, password: str) -> dict[str, Any]:
    login = _request_json(
        base_url,
        "POST",
        "/api/auth/login",
        payload={"username": username, "password": password},
        timeout=20.0,
    )
    token = login.get("token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("login did not return a bearer token")

    meta = _request_json(base_url, "GET", "/api/meta", token=token, timeout=20.0)
    workspace = _request_json(base_url, "GET", "/api/classroom/session", token=token, timeout=20.0)
    if workspace.get("report") is not None:
        raise RuntimeError("full-journey seed requires a student without an existing report")
    years = meta.get("years")
    if not isinstance(years, list) or not years or not all(isinstance(year, int) for year in years):
        raise RuntimeError("active release metadata has no valid years")
    left, right = _countries(meta)
    year = max(years)

    session = empty_session()
    session["steps"] = {str(step): make_record({"quiz": quizzes.correct_quiz(step)}) for step in range(1, 15)}
    session["steps"]["1"]["data"]["observation"] = _step_one_observation(base_url, token, year, left, right)
    for step in range(2, 10):
        session["steps"][str(step)]["data"]["compared"] = [left, right]

    events_payload = _request_json(base_url, "GET", "/api/shocks/events", token=token, timeout=20.0)
    events = events_payload.get("events")
    if not isinstance(events, list):
        raise RuntimeError("shock event catalogue is malformed")
    selected: dict[str, str] = {}
    for event in events:
        if not isinstance(event, dict):
            continue
        shock_type, name = event.get("shock_type"), event.get("name")
        if isinstance(shock_type, str) and isinstance(name, str) and shock_type not in selected:
            selected[shock_type] = name
    if not selected:
        raise RuntimeError("active release has no selectable shock events")
    session["steps"]["10"]["data"].update(
        {"viewed_shock_types": list(selected), "viewed_events": list(selected.values())}
    )

    request_settings = {
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
    stored_settings = {
        "granularity": "country_industry",
        "shockType": "tariff",
        "method": "did",
        "controlMode": "none",
        "interaction": False,
        "priceMode": "nominal",
        "scenario": "clean",
        "weightMode": "fixed_pretreatment",
    }
    settings_by_outcome: dict[str, dict[str, Any]] = {}
    regression_statuses: dict[str, str] = {}
    for step, outcome in ((11, "trade"), (12, "production"), (13, "length"), (14, "network")):
        response = _request_json(
            base_url,
            "POST",
            "/api/regression/run",
            token=token,
            payload={"outcome": outcome, **request_settings},
        )
        result = response.get("result")
        design = response.get("design")
        if (
            not isinstance(result, dict)
            or not isinstance(design, dict)
            or design.get("outcome") != outcome
            or not teaching_report._result_is_reportable(result, design)
        ):
            status = result.get("status") if isinstance(result, dict) else None
            raise RuntimeError(f"{outcome} default regression is not reportable: status={status}")
        saved = {"settings": dict(stored_settings), "design": design, "result": result}
        data = session["steps"][str(step)]["data"]
        data["run"] = saved
        # A complete stopped-inference diagnosis satisfies the course gate but
        # must never be stored as the optional inferential reference snapshot.
        if teaching_report._result_is_qualified(result, design):
            data["qualified_run"] = saved
        settings_by_outcome[outcome] = dict(stored_settings)
        regression_statuses[outcome] = str(result.get("status"))

    session["shared"] = {"regression_settings": make_record(settings_by_outcome)}
    session["steps"]["15"] = make_record(
        {
            "research_question": "同一套关税冲击后，贸易流、生产、长度和网络指标分别怎样变化？",
            "evidence_interpretation": (
                "我将四项保存结果并排阅读，区分可推断估计与停止推断的诊断；仅在支持充分时引用区间，"
                "否则记录样本或设计限制，不将缺少区间解释为没有效应，也不忽略其余预设结果。"
            ),
            "limitations": (
                "政策冲击与宏观量含教学编码，短面板与同期冲击限制解释，全球投入链外溢也意味着"
                "未处理实体不一定完全不受影响。"
            ),
        }
    )

    saved = _request_json(
        base_url,
        "PUT",
        "/api/classroom/session",
        token=token,
        payload={"session": session, "base_updated_at": workspace.get("updated_at")},
    )
    completion = saved.get("completion")
    if not isinstance(completion, dict) or completion.get("completed_count") != 14:
        raise RuntimeError("server did not confirm quiz completion for Steps 1-14 before report generation")
    if saved.get("report_gate") != [] or saved.get("material_gate") != []:
        raise RuntimeError(
            "server report gate remained blocked: "
            + json.dumps({key: saved.get(key) for key in ("report_gate", "material_gate")}, ensure_ascii=False)
        )
    dataset = meta.get("dataset")
    return {
        "username": username,
        "display_name": (login.get("user") or {}).get("name"),
        "release_id": dataset.get("release_id") if isinstance(dataset, dict) else None,
        "completed_steps": completion["completed_count"],
        "regression_outcomes": list(settings_by_outcome),
        "regression_statuses": regression_statuses,
        "viewed_shock_types": list(selected),
        "report_gate": [],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("GVCSIM_BASE_URL", "http://127.0.0.1:5173"))
    parser.add_argument("--username", default=os.environ.get("GVCSIM_E2E_USERNAME", "student"))
    parser.add_argument("--password", default=os.environ.get("GVCSIM_E2E_PASSWORD", ""))
    args = parser.parse_args()
    if not args.password:
        raise SystemExit("full-journey seed requires --password or GVCSIM_E2E_PASSWORD")
    print(json.dumps(seed_full_journey(args.base_url, args.username, args.password), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
