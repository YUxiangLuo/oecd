import json
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from gvcsim import data_routes, regression_routes, shocks
from gvcsim.api import app
from gvcsim.regression.design import RegressionDesign


def _indicator_frame(*, industry: bool = False) -> pd.DataFrame:
    rows = []
    for country, scale in (("AAA", 1.0), ("BBB", 2.0)):
        row = {
            "country": country,
            "DVAex": scale,
            "DVArt": scale,
            "DDC": scale,
            "FVA": scale,
            "FDC": scale,
            "taxsub": scale,
            "3_VA_GVC": scale,
            "SVA": 10 * scale,
            "3b_VA_GVC_C": scale / 2,
            "weighted degree": scale,
            "betweenesscentrality": scale / 10,
        }
        if industry:
            row["industry"] = "s1"
        rows.append(row)
    return pd.DataFrame(rows)


def _shock_frame() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "year": 2020,
                "country": "AAA",
                "sector": "s1",
                "tariff_shock": 0.2,
                "treated": 1,
                "announced_date": "2020-01-01",
                "effective_date": "2020-02-01",
                "note": "tariff-event",
                "sanction_shock": 0.4,
                "sanction_treated": 1,
                "sanction_announced_date": "2020-03-01",
                "sanction_effective_date": "2020-04-01",
                "sanction_note": "sanction-event",
                "export_control_shock": 0.0,
                "export_control_treated": 0,
                "export_control_announced_date": "",
                "export_control_effective_date": "",
                "export_control_note": "",
            },
            {
                "year": 2020,
                "country": "BBB",
                "sector": "s2",
                "tariff_shock": 0.0,
                "treated": 0,
                "announced_date": "",
                "effective_date": "",
                "note": "",
                "sanction_shock": 0.0,
                "sanction_treated": 0,
                "sanction_announced_date": "",
                "sanction_effective_date": "",
                "sanction_note": "",
                "export_control_shock": 0.0,
                "export_control_treated": 0,
                "export_control_announced_date": "",
                "export_control_effective_date": "",
                "export_control_note": "",
            },
        ]
    )


def test_data_discovery_qc_and_db_adapters(tmp_path, monkeypatch):
    monkeypatch.setattr(data_routes, "PROCESSED_DIR", tmp_path)
    monkeypatch.setattr(data_routes, "RAW_DATA_DIR", tmp_path)
    monkeypatch.setattr(data_routes, "processed_years", lambda: [2020])
    monkeypatch.setattr(data_routes, "dataset_metadata", lambda: {"years": [2020], "generated_at": "now"})

    country = _indicator_frame()
    industry = _indicator_frame(industry=True)
    monkeypatch.setattr(
        data_routes,
        "_read_csv",
        lambda name: industry.copy() if "industry" in name else country.copy(),
    )
    assert data_routes.meta()["countries"] == ["AAA", "BBB"]
    assert data_routes.steps()["steps"]
    assert data_routes.indicators_schema()

    monkeypatch.setattr(data_routes.icio_browser, "meta", lambda: {"years": [2020]})
    assert data_routes.db_meta() == {"years": [2020]}
    with pytest.raises(HTTPException) as missing:
        data_routes.db_slice(2020, page=1, page_size=10)
    assert missing.value.status_code == 404

    (tmp_path / "ICIO-demo_2020.csv").write_text("x\n1\n", encoding="utf-8")
    monkeypatch.setattr(data_routes.icio_browser, "slice_table", lambda **kwargs: kwargs)
    assert data_routes.db_slice(2020, table="z", page=2, page_size=10)["page"] == 2
    monkeypatch.setattr(data_routes.icio_browser, "slice_table", lambda **kwargs: (_ for _ in ()).throw(ValueError("bad")))
    with pytest.raises(HTTPException) as invalid:
        data_routes.db_slice(2020, page=1, page_size=10)
    assert invalid.value.status_code == 400

    (tmp_path / "qc_shocks.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
    (tmp_path / "qc_controls.json").write_text(json.dumps([{"status": "ok"}]), encoding="utf-8")
    (tmp_path / "qc_2020.json").write_text(json.dumps({"year": 2020}), encoding="utf-8")
    assert data_routes.qc_shocks() == {"ok": True}
    assert data_routes.qc_controls() == [{"status": "ok"}]
    assert data_routes.qc(2020) == {"year": 2020}
    with pytest.raises(HTTPException):
        data_routes.qc(2019)


def test_indicator_network_and_missing_artifact_views(tmp_path, monkeypatch):
    monkeypatch.setattr(data_routes, "PROCESSED_DIR", tmp_path)
    country = _indicator_frame()
    industry = _indicator_frame(industry=True)
    edges = pd.DataFrame([{"source": "AAA", "target": "BBB", "weight": np.inf}])

    def read(name: str) -> pd.DataFrame:
        if name.startswith("network"):
            return edges.copy()
        if "industry" in name:
            return industry.copy()
        return country.copy()

    monkeypatch.setattr(data_routes, "_read_csv", read)
    rows = data_routes.indicators_country(2020, "AAA")
    assert rows[0]["gross_exports"] == 6
    page = data_routes.indicators_industry(2020, "AAA", "s1", 1, 5)
    assert page["total"] == 1 and page["rows"][0]["country"] == "AAA"
    network = data_routes.viz_network(2020)
    assert len(network["nodes"]) == 2 and network["edges"][0]["weight"] is None
    assert data_routes._clean_value(float("nan")) is None

    with pytest.raises(HTTPException) as missing:
        data_routes._read_path(tmp_path / "missing.csv")
    assert missing.value.status_code == 404
    with pytest.raises(HTTPException):
        data_routes.qc_shocks()
    with pytest.raises(HTTPException):
        data_routes.qc_controls()

    (tmp_path / "controls_country.csv").write_text("country,year\nAAA,2020\n", encoding="utf-8")
    monkeypatch.setattr(data_routes, "_read_path", lambda path: pd.DataFrame({"country": ["AAA"], "year": [2020]}))
    monkeypatch.setattr(
        data_routes.quality,
        "check_controls_country",
        lambda frame: [SimpleNamespace(to_dict=lambda: {"status": "ok"})],
    )
    assert data_routes.qc_controls() == [{"status": "ok"}]


def test_shock_and_crosswalk_views(monkeypatch):
    frame = _shock_frame()
    monkeypatch.setattr(data_routes, "_read_shocks", lambda: frame.copy())
    monkeypatch.setattr(
        data_routes.shocks,
        "events_metadata",
        lambda: [
            {"name": "tariff-event", "shock_type": "tariff"},
            {"name": "sanction-event", "shock_type": "sanctions"},
            {"name": "not-in-panel", "shock_type": "tariff"},
        ],
    )
    assert [row["name"] for row in data_routes.shock_events()["events"]] == ["tariff-event", "sanction-event"]
    summary = data_routes.shock_summary("sanctions")
    assert summary["years"][0]["treated_pairs"] == 1
    panel = data_routes.shock_panel(2020, "sanctions", "AAA", "s1", True, 1, 10)
    assert panel["total"] == 1
    assert panel["rows"][0]["main_imposer"] is None

    with pytest.raises(HTTPException) as invalid:
        data_routes.shock_summary("unknown")
    assert invalid.value.status_code == 400

    monkeypatch.setattr(data_routes.crosswalk, "demo_payload", lambda year: {"year": year})
    assert data_routes.crosswalk_demo(2019) == {"year": 2019}
    monkeypatch.setattr(data_routes.crosswalk, "demo_payload", lambda year: (_ for _ in ()).throw(ValueError("bad")))
    with pytest.raises(HTTPException):
        data_routes.crosswalk_demo(2019)


def _authenticated_client(teaching_db, username: str = "student") -> TestClient:
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": username, "password": "gvclab2026"})
    assert login.status_code == 200
    client.headers["Authorization"] = f"Bearer {login.json()['token']}"
    return client


def test_regression_options_design_and_validation(teaching_db):
    client = _authenticated_client(teaching_db)
    assert client.get("/api/regression/options").status_code == 200
    design = client.get("/api/regression/design", params={"outcome": "trade"})
    assert design.status_code == 200
    assert design.json()["outcome"] == "trade"
    assert client.get("/api/regression/design", params={"outcome": "bad"}).status_code == 400
    assert client.get("/api/regression/design", params={"outcome": "trade", "step": 12}).status_code == 422
    assert client.get(
        "/api/regression/design",
        params={"outcome": "trade", "shock_type": "sanctions", "weight_mode": "contemporaneous"},
    ).status_code == 400


def test_regression_run_and_placebo_are_simple_current_results(teaching_db, monkeypatch):
    client = _authenticated_client(teaching_db)
    panel = pd.DataFrame({"country": ["AAA"], "entity_id": ["AAA-s1"]})
    monkeypatch.setattr(regression_routes, "_read_csv", lambda name: panel)

    class Result:
        def to_dict(self):
            return {
                "status": "invalid_design",
                "support": {
                    "untreated_clusters": 0,
                    "treated_clusters": 2,
                    "reversal_entities": ["AAA"],
                    "suppress_inference": True,
                },
            }

    async def fake_cpu(func, *args, **kwargs):
        if func is regression_routes.run_design_with_benchmark:
            return Result(), {"method": "benchmark"}
        return {"draws": kwargs["n_draws"], "seed": kwargs["seed"]}

    monkeypatch.setattr(regression_routes.concurrency, "run_cpu_bound", fake_cpu)
    run = client.post("/api/regression/run", json={"outcome": "network"})
    assert run.status_code == 200
    codes = {check["code"] for check in run.json()["preflight"]["checks"]}
    assert {"no_never_treated_entity", "treatment_reversal", "network_interference", "treatment_weighting"} <= codes
    assert run.json()["preflight"]["can_infer"] is False

    placebo = client.post("/api/regression/placebo", json={"outcome": "trade", "n_draws": 10, "seed": 7})
    assert placebo.status_code == 200
    assert placebo.json()["placebo"] == {"draws": 10, "seed": 7}


def test_regression_weight_panel_and_teacher_rejection(teaching_db):
    design = RegressionDesign("trade")
    fixed = pd.DataFrame({"tariff_shock": [0.1], "treated": [1]})
    assert regression_routes._panel_for_weight_mode(fixed, design, shocks.EXPOSURE_MODE_FIXED_PRETREATMENT) is fixed
    with pytest.raises(HTTPException) as missing:
        regression_routes._panel_for_weight_mode(fixed, design, shocks.EXPOSURE_MODE_CONTEMPORANEOUS)
    assert missing.value.status_code == 409
    current = fixed.assign(tariff_shock_contemporaneous=0.3, treated_contemporaneous=0)
    selected = regression_routes._panel_for_weight_mode(current, design, shocks.EXPOSURE_MODE_CONTEMPORANEOUS)
    assert selected[design.shock_col].iloc[0] == 0.3

    teacher = _authenticated_client(teaching_db, "teacher")
    assert teacher.post("/api/regression/run", json={"outcome": "trade"}).status_code == 403
