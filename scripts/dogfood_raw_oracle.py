"""Compare raw OECD bytes to API slices, then record a zero cell through the UI.

The oracle uses only csv/float/fsum, not the application's ICIO parser or indicator
functions. Other report prerequisites are prepared via the existing API helper.
"""

import csv
import json
import math
import os
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode

import psycopg

from dogfood_sync import Browser, request
from seed_full_journey import seed_full_journey


def main():
    base = os.environ["GVCSIM_BASE_URL"].rstrip("/")
    raw = Path(os.environ["GVCSIM_RAW_DATA_DIR"])
    output = Path(os.environ["GVCSIM_E2E_ARTIFACT_DIR"]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    password = os.environ["GVCSIM_E2E_PASSWORD"]
    teacher = request(
        base,
        "POST",
        "/api/auth/login",
        {"username": os.environ["GVCSIM_E2E_TEACHER_USERNAME"], "password": os.environ["GVCSIM_E2E_TEACHER_PASSWORD"]},
    )[1]["token"]
    name = "raw-oracle-" + uuid.uuid4().hex[:8]
    _, account = request(
        base, "POST", "/api/classroom/students", {"username": name, "display_name": name, "password": password}, teacher
    )
    token = request(base, "POST", "/api/auth/login", {"username": name, "password": password})[1]["token"]
    results = []
    zero = None

    def same(actual, expected):
        assert isinstance(actual, (int, float)) and math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-8), (
            actual,
            expected,
        )

    for year in range(2016, 2021):
        selected = {}
        china_rows = []
        negative_y = None
        negative_tls = None
        with (raw / f"ICIO2023_{year}.csv").open(newline="") as handle:
            reader = csv.reader(handle)
            header = next(reader)
            indices = {label: index for index, label in enumerate(header)}
            invnt = [i for i, label in enumerate(header) if label.endswith("_INVNT")]
            industry = [
                i
                for i, label in enumerate(header)
                if "_" in label and label.split("_", 1)[1] not in {"HFCE", "NPISH", "GGFC", "GFCF", "INVNT", "DPABR"}
            ]
            usa_z = [i for i in industry if header[i].startswith("USA_")]
            for row in reader:
                label = row[0]
                if label.startswith("CHN_"):
                    china_rows.append(label)
                if label in {"CHN_A01_02", "CHN_D", "CHN_C26", "TLS", "VA", "OUT"}:
                    selected[label] = row
                if "_" in label and negative_y is None:
                    negative_y = next(
                        ((label, header[i], float(row[i])) for i in invnt if row[i] and float(row[i]) < 0), None
                    )
                if label == "TLS":
                    negative_tls = next(
                        ((header[i], "TLS", float(row[i])) for i in industry if row[i] and float(row[i]) < 0), None
                    )
        cases = [
            ("z", "CHN_A01_02", "USA_A01_02", float(selected["CHN_A01_02"][indices["USA_A01_02"]])),
            ("z", "CHN_A01_02", "USA_A03", float(selected["CHN_A01_02"][indices["USA_A03"]])),
            ("z", "CHN_D", "USA_A01_02", float(selected["CHN_D"][indices["USA_A01_02"]])),
            ("y", "CHN_C26", "USA_HFCE", float(selected["CHN_C26"][indices["USA_HFCE"]])),
            *[
                ("accounts", "CHN_C26", field, float(selected[field][indices["CHN_C26"]]))
                for field in ("TLS", "VA", "OUT")
            ],
        ]
        assert negative_y and negative_tls
        cases.extend([("y", *negative_y), ("accounts", *negative_tls)])
        for table, row, column, expected in cases:
            country, sector = row.split("_", 1)
            params = {"year": year, "table": table, "row_country": country, "row_sector": sector}
            if table != "accounts":
                params["col_country"], params["col_sector"] = column.split("_", 1)
            status, payload = request(base, "GET", "/api/db/slice?" + urlencode(params), token=token)
            assert status == 200 and payload["total"] == 1, payload
            actual = payload["rows"][0][column]
            same(actual, expected)
            results.append(
                {
                    "year": year,
                    "table": table,
                    "row": row,
                    "column": column,
                    "expected": expected,
                    "actual": actual,
                    "passed": True,
                }
            )
            if year == 2020 and row == "CHN_A01_02" and column == "USA_A03":
                zero = expected
        for page in (1, 2):
            _, payload = request(
                base,
                "GET",
                "/api/db/slice?"
                + urlencode(
                    {
                        "year": year,
                        "table": "z",
                        "row_country": "CHN",
                        "col_country": "USA",
                        "page": page,
                        "page_size": 25,
                    }
                ),
                token=token,
            )
            assert payload["total"] == len(china_rows) == 45
            assert [row["row"] for row in payload["rows"]] == china_rows[(page - 1) * 25 : page * 25]
            if page == 1:
                summary = next(item for item in payload["row_summaries"] if item["row"] == "CHN_A01_02")
                same(summary["slice_total"], math.fsum(float(selected["CHN_A01_02"][i]) for i in usa_z))
                same(summary["out"], float(selected["CHN_A01_02"][indices["OUT"]]))
            results.append({"year": year, "pagination": page, "passed": True})
        print(json.dumps({"year": year, "cases": len(cases) + 2, "passed": True}), flush=True)
    assert zero == 0
    seed_full_journey(base, name, password)
    browser = Browser(name)
    try:
        browser.login(base, name, password)
        browser.run("open", base + "/?step=1")
        browser.run("wait", ".db-observation-cell")
        browser.run("click", "tbody tr:first-child td:nth-of-type(2) button")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            with psycopg.connect(os.environ["GVCSIM_PG_DSN"]) as connection:
                session = connection.execute(
                    "SELECT session FROM experiment_sessions WHERE account_id=%s", (account["id"],)
                ).fetchone()[0]
            observation = session["steps"]["1"]["data"]["observation"]
            if observation["column"] == "USA_A03":
                break
            time.sleep(0.02)
        assert observation["value"] == zero and observation["row"] == "CHN_A01_02" and observation["year"] == 2020
        browser.run("screenshot", str(output / "zero-cell.png"))
        browser.run("open", base + "/?step=15")
        browser.run("wait", "--text", "根据实验记录生成报告")
        browser.button("根据实验记录生成报告")
        browser.run("wait", "--text", "草稿 · 尚未提交")
        with psycopg.connect(os.environ["GVCSIM_PG_DSN"]) as connection:
            markdown = connection.execute(
                "SELECT markdown FROM reports WHERE account_id=%s", (account["id"],)
            ).fetchone()[0]
        assert "CHN_A01_02(行·供给方) → USA_A03(列·使用方) = 0" in markdown
        results.append({"case": "DATA-01-zero-raw-api-browser-report", "passed": True})
        print(json.dumps(results[-1]), flush=True)
    finally:
        browser.run("close")
        (output / "results.json").write_text(
            json.dumps(
                {"relative_tolerance": 1e-12, "absolute_tolerance": 1e-8, "results": results},
                ensure_ascii=False,
                indent=2,
            )
        )


if __name__ == "__main__":
    main()
