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
import math
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from gvcsim import quizzes
from gvcsim.report_gate import AUTO_COMPARISON_SOURCE
from gvcsim.report_saved_run import _result_is_qualified, _result_is_reportable
from gvcsim.regression.teaching import VERSION as TEACHING_VERSION
from gvcsim.session import empty_session, make_record


def _request_json_value(
    base_url: str,
    method: str,
    path: str,
    *,
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    timeout: float = 120.0,
) -> Any:
    """Single HTTP/JSON seam so tests can stub every request in one place."""
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(f"{base_url.rstrip('/')}{path}", data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} returned {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"{method} {path} failed: {error.reason}") from error


def _request_json(
    base_url: str,
    method: str,
    path: str,
    *,
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    timeout: float = 120.0,
) -> dict[str, Any]:
    value = _request_json_value(base_url, method, path, token=token, payload=payload, timeout=timeout)
    if not isinstance(value, dict):
        raise RuntimeError(f"{method} {path} did not return a JSON object")
    return value


def _request_json_rows(base_url: str, token: str, path: str, *, timeout: float = 120.0) -> list[Any]:
    """Fetch a JSON array endpoint (country indicators return a bare list)."""
    value = _request_json_value(base_url, "GET", path, token=token, timeout=timeout)
    if not isinstance(value, list):
        raise RuntimeError(f"GET {path} did not return a JSON array")
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


# Steps 2-5 record one country's country-level reading of the step's headline indicator, automatically, as the
# page does (``COUNTRY_METRIC`` and ``indicatorMaterialPatch`` in frontend/src/labs/steps/indicator/): the metric
# and its unit for each step.
_SINGLE_COUNTRY_STEPS = {
    2: ("FVA_share", "%"),
    3: ("3b_VA_GVC_C_share", "%"),
    4: ("GVCPs", "无量纲"),
    5: ("weighted degree", "百万美元"),
}

# Steps 6-8 compare country A with country B on the step's indicator: the metric and its unit for each step.
_COMPARISON_STEPS = {
    6: ("FVA_share", "%"),
    7: ("3b_VA_GVC_C_share", "%"),
    8: ("GVCPs", "无量纲"),
}


def _country_value_rows(base_url: str, token: str, year: int) -> dict[str, dict[str, Any]]:
    payload = _request_json_rows(base_url, token, f"/api/indicators/country/{year}")
    return {str(row["country"]): row for row in payload if isinstance(row, dict) and "country" in row}


def _country_observation(
    rows: dict[str, dict[str, Any]],
    country: str,
    year: int,
    metric: str,
    release_id: Any,
    *,
    unit: str | None = None,
    source: str = "explicit-indicator-comparison",
) -> dict[str, Any]:
    row = rows.get(country)
    value = row.get(metric) if isinstance(row, dict) else None
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise RuntimeError(f"country metric {metric} is missing for {country}")
    observation = {
        "entity": country,
        "country": country,
        "year": year,
        "value": value,
        "metric": metric,
        "scope": "country",
        "release": release_id,
    }
    if unit is not None:
        observation.update(unit=unit, source=source)
    return observation


def _step_nine_observation(
    base_url: str,
    token: str,
    year: int,
    country: str,
    release_id: Any,
) -> dict[str, Any]:
    """One recorded industry betweenness row, shaped like the UI ranking record.

    Step 9 asks for readings from both compared countries, so the caller records
    one ranking row for each country rather than stopping at ``compared``.
    """
    query = urlencode({"country": country, "page_size": 200})
    payload = _request_json(base_url, "GET", f"/api/indicators/industry/{year}?{query}", token=token)
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise RuntimeError("Step 9 industry table is malformed")
    for row in rows:
        if not isinstance(row, dict):
            continue
        industry = row.get("industry")
        if not isinstance(industry, str) or not industry:
            continue
        value = row.get("betweenesscentrality")
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            return {
                "entity": f"{country}·{industry}",
                "country": country,
                "industry": industry,
                "year": year,
                "value": value,
                "metric": "betweenesscentrality",
                "unit": "未归一化介数",
                "release": release_id,
                "scope": "country-industry",
                "source": "explicit-network-ranking",
            }
    raise RuntimeError("Step 9 industry table has no finite betweenness value")


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
    dataset = meta.get("dataset")
    release_id = dataset.get("release_id") if isinstance(dataset, dict) else None

    session = empty_session()
    session["steps"] = {str(step): make_record({"quiz": quizzes.correct_quiz(step)}) for step in range(1, 15)}
    session["steps"]["1"]["data"]["observation"] = _step_one_observation(base_url, token, year, left, right)
    # Steps 2-8 record the country values for that step's metric, mirroring what the UI captures. Seeding
    # ``compared`` alone would leave the report's per-step value tables empty and unlike a real student's report.
    country_rows = _country_value_rows(base_url, token, year)
    # Steps 2-5 record the one country being viewed (country A), as the page does when it opens.
    for step, (metric, unit) in _SINGLE_COUNTRY_STEPS.items():
        observation = _country_observation(
            country_rows, left, year, metric, release_id, unit=unit, source=AUTO_COMPARISON_SOURCE
        )
        session["steps"][str(step)]["data"].update(
            {
                "year": year,
                "country": left,
                "compared": [left],
                "metric": metric,
                "observations": [{**observation, "industry": ""}],
            }
        )
    # Steps 6-8 record countries A and B.
    for step, (metric, unit) in _COMPARISON_STEPS.items():
        session["steps"][str(step)]["data"].update(
            {
                "compared": [left, right],
                "metric": metric,
                "observations": [
                    _country_observation(country_rows, country, year, metric, release_id, unit=unit)
                    for country in (left, right)
                ],
            }
        )
    # Step 9's observations are industry ranking rows, not country values.
    session["steps"]["9"]["data"].update(
        {
            "compared": [left, right],
            "metric": "betweenesscentrality",
            "observations": [
                _step_nine_observation(base_url, token, year, country, release_id) for country in (left, right)
            ],
        }
    )

    teaching_query = urlencode({"country": left, "year": year, "limit": 60})
    teaching_panel = _request_json(
        base_url, "GET", f"/api/regression/teaching-panel?{teaching_query}", token=token, timeout=20.0
    )
    teaching_rows = teaching_panel.get("rows")
    if teaching_panel.get("version") != TEACHING_VERSION or not isinstance(teaching_rows, list) or not teaching_rows:
        raise RuntimeError("Step 10 teaching panel is missing or uses an unsupported simulation contract")
    teaching_row = next(
        (
            row
            for row in teaching_rows
            if isinstance(row, dict)
            and row.get("country") == left
            and row.get("year") == year
            and isinstance(row.get("industry"), str)
            and all(
                isinstance(row.get(key), (int, float))
                and not isinstance(row.get(key), bool)
                and math.isfinite(row[key])
                for key in (
                    "teaching_export_share_w",
                    "teaching_tariff_rate_tau",
                    "teaching_tariff_exposure",
                )
            )
        ),
        None,
    )
    if teaching_row is None:
        raise RuntimeError("Step 10 teaching panel has no complete observation for the selected country and year")
    session["steps"]["10"]["data"].update(
        {
            "compared": [left, right],
            "teaching_industry": teaching_row["industry"],
            "teaching_country": teaching_row["country"],
            "teaching_year": teaching_row["year"],
            "viewed_teaching_panel": True,
            "teaching_panel_version": TEACHING_VERSION,
            "teaching_observation": {
                key: teaching_row[key]
                for key in (
                    "country",
                    "industry",
                    "year",
                    "teaching_export_share_w",
                    "teaching_tariff_rate_tau",
                    "teaching_tariff_exposure",
                )
            }
            | {"version": TEACHING_VERSION},
        }
    )

    regression_statuses: dict[str, str] = {}
    for step, outcome in ((11, "trade"), (12, "production"), (13, "length"), (14, "network")):
        response = _request_json(
            base_url,
            "POST",
            "/api/regression/run",
            token=token,
            payload={"outcome": outcome},
        )
        result = response.get("result")
        design = response.get("design")
        snapshot = response.get("model_snapshot")
        catalog = response.get("variable_catalog")
        if (
            not isinstance(result, dict)
            or not isinstance(design, dict)
            or design.get("outcome") != outcome
            or design.get("method") != "twfe_intensity"
            or not isinstance(snapshot, dict)
            or snapshot.get("version") != TEACHING_VERSION
            or not isinstance(catalog, list)
            or not catalog
            or not _result_is_reportable(result, design)
        ):
            status = result.get("status") if isinstance(result, dict) else None
            raise RuntimeError(f"{outcome} default regression is not reportable: status={status}")
        saved = {
            "design": design,
            "result": result,
            "model_snapshot": snapshot,
            "variable_catalog": catalog,
        }
        data = session["steps"][str(step)]["data"]
        data["run"] = saved
        # A complete stopped-inference diagnosis satisfies the course gate but
        # must never be stored as the optional inferential reference snapshot.
        if _result_is_qualified(result, design):
            data["qualified_run"] = saved
        regression_statuses[outcome] = str(result.get("status"))

    session["steps"]["15"] = make_record(
        {
            "research_question": "关税暴露 X 每高 1 个百分点，贸易流、生产、长度和网络指标平均相差多少，方向是否一致？",
            "evidence_interpretation": (
                "我把四步保存的结果并列比较：先看估计值的方向，再看 95% 区间是否包含 0；"
                "方向不确定的结果照实写出，不写成“没有关联”。四个 Y 单位不同，只比较方向，不直接比较数值大小。"
            ),
            "limitations": (
                "回归只说明 X 与 Y 的关联，不能证明关税造成了这些变化；数据只有五年，同期还有其他冲击，"
                "没被加税的国家也可能间接受到影响。"
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
        "regression_outcomes": list(regression_statuses),
        "regression_statuses": regression_statuses,
        "teaching_panel_version": TEACHING_VERSION,
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
