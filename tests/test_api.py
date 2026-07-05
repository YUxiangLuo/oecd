"""API 集成测试。

依赖预计算产物(data/processed/),没跑过 `gvcsim compute` 时自动跳过,
保证测试套件在全新 clone 上也能通过。
"""

import pytest
from fastapi.testclient import TestClient

from gvcsim import shocks
from gvcsim.api import app
from gvcsim.config import PROCESSED_DIR, RAW_DATA_DIR, SHOCKS_DIR, processed_years

client = TestClient(app)

needs_data = pytest.mark.skipif(
    not (PROCESSED_DIR / "panel_country.csv").exists(),
    reason="缺少预计算产物,请先运行 uv run gvcsim compute",
)

needs_shocks = pytest.mark.skipif(
    not (SHOCKS_DIR / shocks.DEMO_FILE).exists(),
    reason="缺少冲击演示数据,请先运行 uv run gvcsim compute",
)

needs_raw_icio = pytest.mark.skipif(
    not any(RAW_DATA_DIR.glob("ICIO*_*.csv")),
    reason="缺少 OECD ICIO 原始文件",
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
    body = resp.json()
    assert "双重差分 (DID)" in body["methods"]
    assert "ICIO 派生控制变量" in body["control_modes"]
    assert body["ready_shock_types"] == ["关税冲击"]


def test_regression_design():
    # 设计预览不跑回归、不依赖预计算面板
    resp = client.get("/api/regression/design", params={"step": 13})
    assert resp.status_code == 200
    body = resp.json()
    assert body["depvar"] == "share_trade_fva"
    assert body["panel_file"] == "panel_sector.csv"
    assert body["entity"] == "entity_id"
    assert body["cluster"] == "country"
    assert body["control_mode"] == "不加控制变量"
    assert body["controls"] == []
    assert "treated" in body["equation"]

    ctrl = client.get(
        "/api/regression/design",
        params={"step": 13, "control_mode": "ICIO 派生控制变量"},
    )
    assert ctrl.status_code == 200
    assert ctrl.json()["controls"]
    assert "Controls_ct" in ctrl.json()["equation"]

    ev = client.get(
        "/api/regression/design",
        params={"step": 15, "granularity": "国家级", "method": "事件研究"},
    )
    assert ev.status_code == 200
    assert ev.json()["panel_file"] == "panel_country.csv"
    assert "Σ_k" in ev.json()["equation"]

    assert client.get("/api/regression/design", params={"step": 12}).status_code == 400
    assert client.get(
        "/api/regression/design", params={"step": 13, "method": "工具变量"}
    ).status_code == 400
    assert client.get(
        "/api/regression/design", params={"step": 13, "shock_type": "汇率冲击"}
    ).status_code == 400
    unsupported = client.get(
        "/api/regression/design", params={"step": 13, "shock_type": "制裁清单"}
    )
    assert unsupported.status_code == 400
    assert "尚未接入" in unsupported.json()["detail"]
    assert client.get(
        "/api/regression/design", params={"step": 13, "control_mode": "外部宏观控制"}
    ).status_code == 400


def test_indicator_schema():
    resp = client.get("/api/indicators/schema")
    assert resp.status_code == 200
    body = resp.json()
    assert body["groups"][0]["key"] == "trade"
    assert body["fields"]["share_trade_fva"]["label"]


@needs_raw_icio
def test_db_meta_endpoint():
    resp = client.get("/api/db/meta")
    assert resp.status_code == 200
    body = resp.json()
    assert body["years"]
    assert body["default_year"] in body["years"]
    assert "CHN" in body["countries"]
    assert body["sectors"]
    assert "HFCE" in body["final_demand_categories"]


@needs_raw_icio
def test_db_slice_endpoint():
    meta = client.get("/api/db/meta").json()
    year = meta["default_year"]

    z = client.get(
        "/api/db/slice",
        params={
            "year": year,
            "table": "z",
            "row_country": "CHN",
            "col_country": "USA",
            "page": 1,
            "page_size": 5,
        },
    )
    assert z.status_code == 200
    z_body = z.json()
    assert z_body["total"] > 0
    assert z_body["columns"][0] == "row"
    assert 0 < len(z_body["rows"]) <= 5

    accounts = client.get(
        "/api/db/slice",
        params={
            "year": year,
            "table": "accounts",
            "row_country": "CHN",
            "page": 1,
            "page_size": 5,
        },
    )
    assert accounts.status_code == 200
    acc_body = accounts.json()
    assert {"row", "TLS", "VA", "OUT"}.issubset(acc_body["columns"])
    assert 0 < len(acc_body["rows"]) <= 5


@needs_data
def test_meta_and_indicators():
    meta = client.get("/api/meta").json()
    assert meta["years"]
    year = meta["years"][-1]
    assert "CHN" in meta["countries"]

    assert len(meta["sectors"]) == 45

    rows = client.get(f"/api/indicators/country/{year}").json()
    assert len(rows) > 50
    cols = rows[0].keys()
    for col in ["share_trade_fva", "share_prod_complex_gvc", "upstreamness", "betweenness_centrality"]:
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
@needs_shocks
def test_qc_shocks_endpoint():
    resp = client.get("/api/qc/shocks")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) >= 4
    assert any("维度对齐" in c["name"] for c in body)
    assert all({"name", "kind", "passed", "detail", "warnings"}.issubset(c) for c in body)


def test_shock_events():
    """事件时间线不依赖预计算产物。"""
    resp = client.get("/api/shocks/events")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["events"]) >= 8
    ev = body["events"][0]
    for key in ["name", "imposer", "targets", "announced", "effective", "peak_rate"]:
        assert key in ev
    names = " ".join(e["name"] for e in body["events"])
    assert "232" in names and "301" in names


@needs_shocks
def test_shock_summary_and_panel():
    summary = client.get("/api/shocks/summary").json()
    assert summary["n_countries"] == 77
    assert summary["n_sectors"] == 45
    y2019 = next(r for r in summary["years"] if r["year"] == 2019)
    # 232 覆盖全球:2019 年绝大多数经济体受处理
    assert y2019["treated_countries"] > 70
    assert y2019["max_shock"] > 0.05

    panel = client.get("/api/shocks/panel", params={"year": 2019}).json()
    assert panel["total"] > 100
    rows = panel["rows"]
    # 默认按冲击强度降序
    assert rows[0]["tariff_shock"] >= rows[-1]["tariff_shock"]
    assert rows[0]["note"]

    chn = client.get(
        "/api/shocks/panel", params={"year": 2019, "country": "CHN", "only_hit": True}
    ).json()
    assert chn["total"] > 10
    assert all(r["country"] == "CHN" for r in chn["rows"])


@needs_data
def test_regression_run():
    # 默认:国家–行业级 + DID
    resp = client.post("/api/regression/run", json={"step": 13})
    assert resp.status_code == 200
    body = resp.json()
    assert body["design"]["depvar"] == "share_trade_fva"
    assert body["design"]["granularity"] == "国家–行业级"
    assert body["design"]["method"] == "双重差分 (DID)"
    assert body["result"]["coefs"][0]["name"] == "treated×post"
    assert "benchmark" in body
    assert body["benchmark"]["backend"] == "linearmodels.PanelOLS"
    # 行业级个体数远多于国家数;标准误按国家聚类
    assert body["result"]["n_entities"] > 1000
    assert body["result"]["n_clusters"] < 100

    # 显式国家级粒度仍可用
    resp_c = client.post(
        "/api/regression/run", json={"step": 13, "granularity": "国家级"}
    )
    assert resp_c.status_code == 200
    assert resp_c.json()["result"]["n_entities"] < 100

    # 非法粒度/方法报 400
    bad = client.post("/api/regression/run", json={"step": 13, "granularity": "城市级"})
    assert bad.status_code == 400
    bad = client.post("/api/regression/run", json={"step": 13, "method": "工具变量"})
    assert bad.status_code == 400

    ctrl = client.post(
        "/api/regression/run",
        json={"step": 13, "granularity": "国家级", "control_mode": "ICIO 派生控制变量"},
    )
    assert ctrl.status_code == 200
    assert ctrl.json()["design"]["controls"]
    names = [c["name"] for c in ctrl.json()["result"]["coefs"]]
    assert "treated×post" in names


@needs_data
def test_regression_methods():
    # 双向固定效应(强度法):解释变量为连续冲击
    fe = client.post("/api/regression/run", json={"step": 14, "method": "双向固定效应"})
    assert fe.status_code == 200
    assert fe.json()["result"]["coefs"][0]["name"] == "tariff_shock"

    # 事件研究:基期 k=-1 省略,动态系数逐年一个
    ev = client.post("/api/regression/run", json={"step": 14, "method": "事件研究"})
    assert ev.status_code == 200
    names = [c["name"] for c in ev.json()["result"]["coefs"]]
    assert names == ["k=-2", "k=0", "k=+1", "k=+2"]
    assert "T₀=2018" in " ".join(ev.json()["result"]["notes"])


@needs_data
def test_parameterized_report_endpoint():
    year = processed_years()[-1]
    resp = client.post(
        "/api/report",
        json={"year": year, "granularity": "国家级", "method": "双向固定效应"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "country_fe_no_controls" in body["path"]
    assert "国家级 · 双向固定效应" in body["markdown"]
    assert "tariff_shock" in body["markdown"]
