"""API 集成测试。

依赖预计算产物(data/processed/),没跑过 `gvcsim compute` 时自动跳过,
保证测试套件在全新 clone 上也能通过。
"""

import pytest
from fastapi.testclient import TestClient

from gvcsim.api import app
from gvcsim.config import PROCESSED_DIR, processed_years

client = TestClient(app)

needs_data = pytest.mark.skipif(
    not (PROCESSED_DIR / "panel_country.csv").exists(),
    reason="缺少预计算产物,请先运行 uv run gvcsim compute",
)


def test_steps_metadata():
    resp = client.get("/api/steps")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["steps"]) == 17
    assert body["stages"]["2"] == "指标计算"


def test_regression_options():
    resp = client.get("/api/regression/options")
    assert resp.status_code == 200
    assert "双重差分 (DID)" in resp.json()["methods"]


@needs_data
def test_meta_and_indicators():
    meta = client.get("/api/meta").json()
    assert meta["years"]
    year = meta["years"][-1]
    assert "CHN" in meta["countries"]

    rows = client.get(f"/api/indicators/country/{year}").json()
    assert len(rows) > 50
    cols = rows[0].keys()
    for col in ["backward_fva_share", "share_complex_gvc", "upstreamness", "betweenness_centrality"]:
        assert col in cols

    paged = client.get(
        f"/api/indicators/sector/{year}", params={"country": "CHN", "page": 1}
    ).json()
    assert paged["total"] == 45  # ICIO 45个行业
    assert len(paged["rows"]) == 25


@needs_data
def test_qc_and_network():
    year = processed_years()[-1]
    qc = client.get(f"/api/qc/{year}").json()
    assert len(qc) == 5

    net = client.get(f"/api/viz/network/{year}").json()
    assert net["nodes"] and net["edges"]


@needs_data
def test_regression_run():
    resp = client.post("/api/regression/run", json={"step": 13})
    assert resp.status_code == 200
    body = resp.json()
    assert body["design"]["depvar"] == "backward_fva_share"
    assert body["result"]["coefs"][0]["name"] == "tariff_shock"
    assert body["result"]["n_obs"] > 0
