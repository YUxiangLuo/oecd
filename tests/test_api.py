"""API 集成测试。

依赖预计算产物(data/processed/),没跑过 `gvcsim compute` 时自动跳过,
保证测试套件在全新 clone 上也能通过。
"""

import math

import pytest
from fastapi.testclient import TestClient

from gvcsim import shocks
from gvcsim.api import _clean, app
from gvcsim.config import PROCESSED_DIR, RAW_DATA_DIR, SHOCKS_DIR, processed_years

client = TestClient(app)
login_resp = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})
client.headers.update({"Authorization": f"Bearer {login_resp.json()['token']}"})

needs_data = pytest.mark.skipif(
    not (PROCESSED_DIR / "panel_country.csv").exists(),
    reason="缺少预计算产物,请先运行 uv run gvcsim compute",
)

needs_shocks = pytest.mark.skipif(
    not (SHOCKS_DIR / shocks.DEMO_FILE).exists(),
    reason="缺少冲击演示数据,请先运行 uv run gvcsim compute",
)

needs_shock_qc = pytest.mark.skipif(
    not (PROCESSED_DIR / "qc_shocks.json").exists(),
    reason="缺少冲击质检产物,请先运行 uv run gvcsim compute",
)

needs_controls_qc = pytest.mark.skipif(
    not (PROCESSED_DIR / "controls_country.csv").exists(),
    reason="缺少控制变量产物,请先运行 uv run gvcsim compute",
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


def test_data_endpoints_require_bearer():
    anon = TestClient(app)
    assert anon.get("/api/steps").status_code == 401
    assert anon.get("/api/steps", headers={"Authorization": "Bearer bad"}).status_code == 401

    login = anon.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})
    assert login.status_code == 200
    token = login.json()["token"]
    me = anon.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["username"] == "student"


def test_regression_options():
    resp = client.get("/api/regression/options")
    assert resp.status_code == 200
    body = resp.json()
    assert "双重差分 (DID)" in body["methods"]
    assert "ICIO 派生控制变量" in body["control_modes"]
    assert "模拟宏观控制" in body["control_modes"]
    assert "实际值(2016=1)" in body["price_modes"]
    assert body["scenarios"] == ["clean", "noisy", "confounded"]
    assert "前趋势混杂" in body["scenario_labels"]["confounded"]


def test_regression_design():
    # 设计预览不跑回归、不依赖预计算面板
    resp = client.get("/api/regression/design", params={"step": 13})
    assert resp.status_code == 200
    body = resp.json()
    assert body["depvar"] == "FVA_share"
    assert body["panel_file"] == "panel_industry.csv"
    assert body["entity"] == "entity_id"
    assert body["cluster"] == "country"
    assert body["control_mode"] == "不加控制变量"
    assert body["price_mode"] == "名义值"
    assert body["scenario"] == "clean"
    assert body["scenario_label"] == "基准场景(clean)"
    assert body["exclude_row"] is True
    assert "排除 ROW" in body["sample_filter"]
    assert body["controls"] == []
    assert body["shock_col"] == "tariff_shock"
    assert body["treated_col"] == "treated"
    assert "treated" in body["equation"]
    assert "".join(part["text"] for part in body["equation_parts"]) == body["equation"]
    assert {part.get("meta_key") for part in body["equation_parts"]} >= {
        "depvar",
        "policy",
        "entity",
        "cluster",
    }

    ctrl = client.get(
        "/api/regression/design",
        params={"step": 13, "control_mode": "ICIO 派生控制变量"},
    )
    assert ctrl.status_code == 200
    assert ctrl.json()["controls"]
    assert "Controls_ct" in ctrl.json()["equation"]

    macro = client.get(
        "/api/regression/design",
        params={"step": 13, "control_mode": "模拟宏观控制"},
    )
    assert macro.status_code == 200
    assert "macro_log_gdp_usd" in macro.json()["controls"]

    inter = client.get(
        "/api/regression/design",
        params={"step": 13, "interaction": True},
    )
    assert inter.status_code == 200
    assert inter.json()["interaction"] is True
    assert "BaseGVC" in inter.json()["equation"]

    real = client.get(
        "/api/regression/design",
        params={"step": 13, "price_mode": "实际值(2016=1)"},
    )
    assert real.status_code == 200
    assert real.json()["price_mode"] == "实际值(2016=1)"

    ev = client.get(
        "/api/regression/design",
        params={"step": 15, "granularity": "国家级", "method": "事件研究"},
    )
    assert ev.status_code == 200
    assert ev.json()["panel_file"] == "panel_country.csv"
    assert "Σ_k" in ev.json()["equation"]

    assert client.get("/api/regression/design", params={"step": 12}).status_code == 400
    assert client.get("/api/regression/design", params={"step": 13, "method": "工具变量"}).status_code == 400
    assert client.get("/api/regression/design", params={"step": 13, "shock_type": "汇率冲击"}).status_code == 400
    sanction = client.get("/api/regression/design", params={"step": 13, "shock_type": "制裁清单"})
    assert sanction.status_code == 200
    assert sanction.json()["shock_col"] == "sanction_shock"
    assert "sanction_treated" in sanction.json()["equation"]
    assert client.get("/api/regression/design", params={"step": 13, "control_mode": "外部宏观控制"}).status_code == 400
    assert client.get("/api/regression/design", params={"step": 13, "price_mode": "购买力平价"}).status_code == 400
    assert client.get("/api/regression/design", params={"step": 13, "scenario": "magic"}).status_code == 400


def test_report_request_validation():
    resp = client.post("/api/report", json={"method": "工具变量"})
    assert resp.status_code == 400
    assert "method" in resp.json()["detail"]


def test_indicator_schema():
    resp = client.get("/api/indicators/schema")
    assert resp.status_code == 200
    body = resp.json()
    assert body["groups"][0]["key"] == "trade"
    assert body["fields"]["FVA"]["label"]
    assert body["fields"]["GVCPs"]["label"]
    assert body["fields"]["closnesscentrality"]["label"]
    assert all(meta["desc"] for meta in body["fields"].values())


def test_clean_replaces_all_non_finite_floats():
    rows = _clean([{"nan": math.nan, "pos_inf": math.inf, "neg_inf": -math.inf, "finite": 1.25}])
    assert rows == [{"nan": None, "pos_inf": None, "neg_inf": None, "finite": 1.25}]


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
    assert len(z_body["row_summaries"]) == len(z_body["rows"])
    assert all({"row", "slice_total", "out"} <= summary.keys() for summary in z_body["row_summaries"])

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
    for col in ["DVAex", "taxsub", "SVA", "3b_FGY_GVC_C", "PLv_GVC", "GVCPs", "betweenesscentrality"]:
        assert col in cols

    paged = client.get(f"/api/indicators/industry/{year}", params={"country": "CHN", "page": 1}).json()
    assert paged["total"] == 45  # ICIO 45个行业
    assert len(paged["rows"]) == 25
    assert client.get(f"/api/indicators/sector/{year}", params={"country": "CHN", "page": 1}).status_code == 404


@needs_data
def test_qc_and_network():
    year = processed_years()[-1]
    qc = client.get(f"/api/qc/{year}").json()
    assert len(qc) == 5

    net = client.get(f"/api/viz/network/{year}").json()
    assert net["nodes"] and net["edges"]
    node = net["nodes"][0]
    for key in ["gross_exports", "betweenesscentrality", "gvc_production_share"]:
        assert key in node


@needs_shock_qc
def test_shock_qc_endpoint():
    resp = client.get("/api/qc/shocks")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 5
    assert any("维度对齐" in c["name"] for c in body)


@needs_controls_qc
def test_controls_qc_endpoint():
    resp = client.get("/api/qc/controls")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 5
    assert all(c["passed"] for c in body), [(c["name"], c["detail"], c["warnings"]) for c in body]
    assert any("控制变量 schema" in c["name"] for c in body)


def test_shock_events():
    """事件时间线不依赖预计算产物。"""
    resp = client.get("/api/shocks/events")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["events"]) >= 8
    ev = body["events"][0]
    for key in [
        "name",
        "imposer",
        "targets",
        "announced",
        "effective",
        "peak_rate",
        "target_codes",
        "sector_codes",
        "all_targets",
    ]:
        assert key in ev
    assert ev["all_targets"] is True
    assert ev["target_codes"] == []
    assert ev["sector_codes"]
    names = " ".join(e["name"] for e in body["events"])
    assert "232" in names and "301" in names


def test_crosswalk_demo_endpoint():
    resp = client.get("/api/crosswalk/demo", params={"year": 2019})
    assert resp.status_code == 200
    body = resp.json()
    assert body["summary"]["n_hs_chapters"] == 97
    assert body["summary"]["n_crosswalk_rows"] >= 97
    assert len(body["checks"]) == 4
    assert all(c["passed"] for c in body["checks"])
    assert body["hs_rows"]
    assert body["mapped_rows"][0]["avg_tariff"] >= body["mapped_rows"][-1]["avg_tariff"]

    bad = client.get("/api/crosswalk/demo", params={"year": 2021})
    assert bad.status_code == 400


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
    assert rows[0]["main_imposer"]
    assert rows[0]["export_exposure"] is not None

    chn = client.get("/api/shocks/panel", params={"year": 2019, "country": "CHN", "only_hit": True}).json()
    assert chn["total"] > 10
    assert all(r["country"] == "CHN" for r in chn["rows"])

    export_control = client.get(
        "/api/shocks/panel",
        params={"year": 2020, "shock_type": "出口管制", "country": "CHN", "only_hit": True},
    ).json()
    assert export_control["total"] >= 2
    assert export_control["rows"][0]["shock_type"] == "出口管制"
    assert export_control["rows"][0]["tariff_shock"] > 0
    assert export_control["rows"][0]["main_imposer"] is None
    assert export_control["rows"][0]["export_exposure"] is None


@needs_data
def test_regression_run():
    # 默认:国家–行业级 + DID
    resp = client.post("/api/regression/run", json={"step": 13})
    assert resp.status_code == 200
    body = resp.json()
    assert body["design"]["depvar"] == "FVA_share"
    assert body["design"]["granularity"] == "国家–行业级"
    assert body["design"]["method"] == "双重差分 (DID)"
    assert body["result"]["coefs"][0]["name"] == "treated×post"
    assert "benchmark" in body
    assert body["benchmark"]["backend"] == "linearmodels.PanelOLS"
    assert "passed" not in body["benchmark"]
    assert body["benchmark"]["coef_check_passed"] is True
    assert body["benchmark"]["se_check_mode"] == "informational"
    assert any("仅针对政策系数" in n for n in body["benchmark"]["notes"])
    # 行业级个体数远多于国家数;标准误按国家聚类
    assert body["result"]["n_entities"] > 1000
    assert body["result"]["n_clusters"] < 100
    assert any("排除 ROW" in n for n in body["result"]["notes"])

    # 显式国家级粒度仍可用
    resp_c = client.post("/api/regression/run", json={"step": 13, "granularity": "国家级"})
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
def test_regression_placebo_endpoint():
    resp = client.post(
        "/api/regression/placebo",
        json={"step": 13, "granularity": "国家级", "n_draws": 8, "seed": 11},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["design"]["method"] == "双重差分 (DID)"
    assert body["placebo"]["policy_name"] == "treated×post"
    assert len(body["placebo"]["placebo_coefs"]) == 8
    assert 0 < body["placebo"]["empirical_p"] <= 1

    bad = client.post(
        "/api/regression/placebo",
        json={"step": 13, "method": "双向固定效应", "n_draws": 4},
    )
    assert bad.status_code == 400
    assert "DID" in bad.json()["detail"]


@needs_data
def test_parameterized_report_endpoint(tmp_path, monkeypatch):
    from gvcsim import report as report_mod

    monkeypatch.setattr(report_mod, "REPORTS_DIR", tmp_path)
    resp = client.post(
        "/api/report",
        json={
            "year": processed_years()[-1],
            "granularity": "国家–行业级",
            "shock_type": "出口管制",
            "method": "双向固定效应",
            "control_mode": "模拟宏观控制",
            "interaction": True,
            "price_mode": "实际值(2016=1)",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    md = body["markdown"]
    assert body["suggested_filename"] == f"experiment_report_{processed_years()[-1]}.md"
    assert "path" not in body
    assert list(tmp_path.iterdir()) == []  # HTTP 报告纯构建，不落盘
    assert "- 粒度:国家–行业级" in md
    assert "- 冲击类型:出口管制" in md
    assert "- 估计方法:双向固定效应" in md
    assert "- 控制变量:GDP规模(log, WDI风格mock)" in md
    assert "- 交互项:开启:冲击×基期GVC生产份额" in md
    assert "- 价格口径:实际值(2016=1)" in md
    assert "- 回归样本:排除 ROW" in md
    assert "export_control_shock" in md
    assert "macro_log_gdp_usd" in md
    assert "个国家×行业 ×" in md
    assert "PanelOLS 政策系数对照" in md
    assert "标准误最大差异" in md and "仅作参考" in md
    assert md.count("```gvcsim-chart") == 3
    assert "<svg" not in md

    bad = client.post(
        "/api/report",
        json={
            "year": processed_years()[-1],
            "granularity": "国家级",
            "shock_type": "出口管制",
            "method": "双向固定效应",
            "interaction": True,
        },
    )
    assert bad.status_code == 400
    assert "共线性" in bad.json()["detail"]


@needs_data
def test_regression_methods():
    # 双向固定效应(强度法):解释变量为连续冲击
    fe = client.post("/api/regression/run", json={"step": 14, "method": "双向固定效应"})
    assert fe.status_code == 200
    assert fe.json()["result"]["coefs"][0]["name"] == "tariff_shock"

    fe_export = client.post(
        "/api/regression/run",
        json={"step": 14, "method": "双向固定效应", "shock_type": "出口管制"},
    )
    assert fe_export.status_code == 200
    assert fe_export.json()["result"]["coefs"][0]["name"] == "export_control_shock"

    # 事件研究:基期 k=-1 优先省略,动态系数按个体首次冲击年 G_i 的相对时间构造
    ev = client.post("/api/regression/run", json={"step": 14, "method": "事件研究"})
    assert ev.status_code == 200
    names = [c["name"] for c in ev.json()["result"]["coefs"]]
    assert "k=0" in names and "k=-1" not in names
    assert "year-G_i" in " ".join(ev.json()["result"]["notes"])
