"""API 集成测试。

依赖预计算产物(data/processed/),没跑过 `gvcsim compute` 时自动跳过,
保证测试套件在全新 clone 上也能通过。
"""

import inspect
import math
import re
from contextlib import asynccontextmanager

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from gvcsim import api as api_mod
from gvcsim import auth, data_routes, regression_routes, shocks
from gvcsim.api import app
from gvcsim.data_routes import _clean
from gvcsim.artifacts import NETWORK_ALGORITHM, manifest_id, register_artifacts
from gvcsim.classroom import db as classroom_db
from gvcsim.config import PROCESSED_DIR, RAW_DATA_DIR, processed_years

client = TestClient(app)
login_resp = client.post("/api/auth/login", json={"username": "student", "password": "gvclab2026"})
client.headers.update({"Authorization": f"Bearer {login_resp.json()['token']}"})

needs_data = pytest.mark.skipif(
    not (PROCESSED_DIR / "panel_country.csv").exists(),
    reason="缺少预计算产物,请先运行 uv run gvcsim compute",
)

needs_shocks = pytest.mark.skipif(
    not (PROCESSED_DIR / shocks.DEMO_FILE).exists(),
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


@pytest.fixture(scope="module", autouse=True)
def bind_demo_assignment_to_current_test_manifest():
    """测试库可跨本地测试运行保留，但 API 集成测试必须绑定本次产物。

    生产环境故意禁止作业静默漂移到新 manifest；这里仅在专用测试库中显式
    更新 demo assignment，避免上一次测试运行留下的内容 ID 让回归端点误报 409。
    """
    if not (PROCESSED_DIR / "panel_country.csv").exists():
        return
    scope = classroom_db.assignment_context("student")
    if scope:
        with classroom_db.conn() as connection:
            connection.execute(
                "UPDATE assignments SET manifest_id=%s WHERE id=%s",
                (manifest_id(), scope["assignment_id"]),
            )


def test_steps_metadata():
    resp = client.get("/api/steps")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["steps"]) == 16
    assert body["stages"]["2"] == "指标计算"


def test_health_is_public_and_checks_artifact_contract(monkeypatch):
    monkeypatch.setattr(api_mod, "validate_release", lambda _path, **_kwargs: {"files": 1, "sources": 0})
    monkeypatch.setattr(api_mod, "processed_years", lambda: [2019, 2020])
    monkeypatch.setattr(api_mod, "manifest_id", lambda: "manifest-test")
    monkeypatch.setattr(api_mod.app_config, "CPU_CONCURRENCY", 16)
    monkeypatch.setattr(api_mod.app_config, "CPU_QUEUE_SIZE", 128)
    monkeypatch.setattr(api_mod.app_config, "CPU_ACQUIRE_TIMEOUT_SECONDS", 30.0)
    monkeypatch.setattr(
        api_mod.concurrency,
        "_try_lock",
        lambda _path: (_ for _ in ()).throw(AssertionError("health must not acquire capacity locks")),
    )
    monkeypatch.setattr(
        classroom_db,
        "readiness",
        lambda: {"status": "ok", "schema_version": classroom_db.TEACHING_DB_VERSION},
    )
    anon = TestClient(app)
    response = anon.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "years": [2019, 2020],
        "manifest_id": "manifest-test",
        "artifact_contract": {
            "schema_version": 3,
            "network_algorithm": NETWORK_ALGORITHM,
        },
        "database": {"status": "ok", "schema_version": classroom_db.TEACHING_DB_VERSION},
        "capacity": {
            "coordination": "cross-process-flock",
            "queue_policy": "fifo",
            "cpu_permits_total": 16,
            "admission_total": 128,
            "acquire_timeout_seconds": 30.0,
        },
    }


def test_liveness_is_public_and_dependency_free(monkeypatch):
    assert inspect.iscoroutinefunction(api_mod.liveness)
    monkeypatch.setattr(
        api_mod,
        "validate_release",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("liveness must not read artifacts")),
    )
    monkeypatch.setattr(
        classroom_db,
        "readiness",
        lambda: (_ for _ in ()).throw(AssertionError("liveness must not query PostgreSQL")),
    )
    response = TestClient(app).get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_cpu_endpoints_wait_asynchronously():
    assert inspect.iscoroutinefunction(regression_routes.regression_run)
    assert inspect.iscoroutinefunction(regression_routes.regression_placebo)
    assert inspect.iscoroutinefunction(api_mod.classroom_routes.generate_report)


def test_health_returns_503_without_complete_artifacts(monkeypatch):
    monkeypatch.setattr(api_mod, "validate_release", lambda _path, **_kwargs: {"files": 1, "sources": 0})
    monkeypatch.setattr(api_mod, "processed_years", lambda: [])
    response = TestClient(app).get("/health")
    assert response.status_code == 503
    assert response.json()["status"] == "unavailable"


def test_health_returns_503_when_database_is_unavailable_outside_demo(monkeypatch):
    monkeypatch.setattr(api_mod, "validate_release", lambda _path, **_kwargs: {"files": 1, "sources": 0})
    monkeypatch.setattr(api_mod, "processed_years", lambda: [2020])
    monkeypatch.setattr(api_mod, "manifest_id", lambda: "manifest-test")
    monkeypatch.setattr(classroom_db, "readiness", lambda: (_ for _ in ()).throw(classroom_db.Unavailable("secret")))
    monkeypatch.setattr(api_mod.app_config, "DEMO_MODE", False)
    response = TestClient(app).get("/health")
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable", "detail": "教学数据库未就绪"}


def test_health_returns_503_when_any_registered_artifact_is_tampered(tmp_path, monkeypatch):
    release = tmp_path / "processed"
    release.mkdir()
    artifact = release / "panel.csv"
    artifact.write_text("x\n1\n", encoding="utf-8")
    register_artifacts(release, [artifact.name])
    artifact.write_text("x\n9\n", encoding="utf-8")
    monkeypatch.setattr(api_mod, "PROCESSED_DIR", release)

    response = TestClient(app).get("/health")

    assert response.status_code == 503
    assert response.json()["status"] == "unavailable"
    assert "摘要不一致" in response.json()["detail"]


def test_health_returns_503_when_a_registered_source_is_tampered(tmp_path, monkeypatch):
    release = tmp_path / "processed"
    release.mkdir()
    artifact = release / "panel.csv"
    source = tmp_path / "raw.csv"
    artifact.write_text("x\n1\n", encoding="utf-8")
    source.write_text("raw\n1\n", encoding="utf-8")
    register_artifacts(release, [artifact.name], source_paths=[source])
    source.write_text("raw\n9\n", encoding="utf-8")
    monkeypatch.setattr(api_mod, "PROCESSED_DIR", release)

    response = TestClient(app).get("/health")

    assert response.status_code == 503
    assert response.json()["status"] == "unavailable"
    assert "来源" in response.json()["detail"]


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
    assert "did" in body["methods"]
    assert "icio_derived" in body["control_modes"]
    assert "macro_sim" in body["control_modes"]
    assert "real_2016" in body["price_modes"]
    assert body["scenarios"] == ["clean", "noisy", "confounded"]
    assert body["scenario_labels"]["confounded"] == "课堂挑战：加入冲击前趋势"
    assert set(body["outcomes"]) == {"trade", "production", "length", "network"}
    assert body["granularities_by_outcome"]["network"] == ["country_industry"]
    assert body["granularities_by_outcome"]["trade"] == ["country_industry", "country"]
    assert "steps" not in body


def test_regression_endpoints_require_outcome_and_reject_legacy_step():
    assert client.get("/api/regression/design").status_code == 422
    assert client.post("/api/regression/run", json={}).status_code == 422
    assert client.post("/api/regression/placebo", json={}).status_code == 422
    assert client.get("/api/regression/design", params={"step": 13}).status_code == 422
    assert client.post("/api/regression/run", json={"step": 13}).status_code == 422


def test_regression_design():
    # 设计预览不跑回归、不依赖预计算面板
    resp = client.get("/api/regression/design", params={"outcome": "trade"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["depvar"] == "FVA_share"
    assert body["panel_file"] == "panel_industry.csv"
    assert body["entity"] == "entity_id"
    assert body["cluster"] == "country"
    assert body["control_mode"] == "none"
    assert body["price_mode"] == "nominal"
    assert body["scenario"] == "clean"
    assert body["scenario_label"] == "基准教学场景"
    assert body["exclude_row"] is True
    assert "排除“世界其他地区”（ROW）" in body["sample_filter"]
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

    network_country = client.get(
        "/api/regression/design",
        params={"outcome": "network", "granularity": "country"},
    )
    assert network_country.status_code == 400
    assert "介数中心性恒为 0" in network_country.json()["detail"]

    ctrl = client.get(
        "/api/regression/design",
        params={"outcome": "trade", "control_mode": "icio_derived"},
    )
    assert ctrl.status_code == 200
    assert ctrl.json()["controls"]
    assert "Controls_ct" in ctrl.json()["equation"]

    macro = client.get(
        "/api/regression/design",
        params={"outcome": "trade", "control_mode": "macro_sim"},
    )
    assert macro.status_code == 200
    assert "macro_log_gdp_usd" in macro.json()["controls"]

    inter = client.get(
        "/api/regression/design",
        params={"outcome": "trade", "interaction": True},
    )
    assert inter.status_code == 200
    assert inter.json()["interaction"] is True
    assert "BaseGVC" in inter.json()["equation"]

    real = client.get(
        "/api/regression/design",
        params={"outcome": "trade", "price_mode": "real_2016"},
    )
    assert real.status_code == 200
    assert real.json()["price_mode"] == "real_2016"

    ev = client.get(
        "/api/regression/design",
        params={"outcome": "length", "granularity": "country", "method": "event_study"},
    )
    assert ev.status_code == 200
    assert ev.json()["panel_file"] == "panel_country.csv"
    assert "Σ_k" in ev.json()["equation"]

    assert client.get("/api/regression/design", params={"step": 12}).status_code == 422
    assert client.get("/api/regression/design", params={"outcome": "trade", "method": "工具变量"}).status_code == 400
    assert (
        client.get("/api/regression/design", params={"outcome": "trade", "shock_type": "汇率冲击"}).status_code == 400
    )
    sanction = client.get("/api/regression/design", params={"outcome": "trade", "shock_type": "sanctions"})
    assert sanction.status_code == 200
    assert sanction.json()["shock_col"] == "sanction_shock"
    assert "sanction_treated" in sanction.json()["equation"]
    assert (
        client.get("/api/regression/design", params={"outcome": "trade", "control_mode": "外部宏观控制"}).status_code
        == 400
    )
    assert (
        client.get("/api/regression/design", params={"outcome": "trade", "price_mode": "购买力平价"}).status_code == 400
    )
    assert client.get("/api/regression/design", params={"outcome": "trade", "scenario": "magic"}).status_code == 400


def test_all_outcomes_reach_design_and_run_contract(monkeypatch: pytest.MonkeyPatch):
    expected = {
        "trade": "FVA_share",
        "production": "3b_VA_GVC_C_share",
        "length": "PLv_GVC",
        "network": "betweenesscentrality",
    }
    calls: list[str] = []

    class StubResult:
        def __init__(self, outcome: str) -> None:
            self.outcome = outcome

        def to_dict(self) -> dict[str, str]:
            return {"outcome": self.outcome}

    monkeypatch.setattr(regression_routes, "_read_csv", lambda _name: object())

    def estimate(_panel, design):
        calls.append(design.outcome)
        return StubResult(design.outcome), {"backend": "stub"}

    monkeypatch.setattr(regression_routes, "run_design_with_benchmark", estimate)
    monkeypatch.setattr(regression_routes, "manifest_id", lambda: "manifest-test")

    def evidence_event(_username, step, kind, manifest_id, *_args, **_kwargs):
        return {
            "event_id": "00000000-0000-0000-0000-000000000001",
            "account_id": 1,
            "assignment_id": 1,
            "attempt_id": 1,
            "step": step,
            "kind": kind,
            "manifest_id": manifest_id,
            "issued_at": "2026-07-19T00:00:00+00:00",
        }

    monkeypatch.setattr(api_mod.classroom_db, "record_evidence_event", evidence_event)

    for outcome, depvar in expected.items():
        preview = client.get("/api/regression/design", params={"outcome": outcome})
        assert preview.status_code == 200
        assert preview.json()["depvar"] == depvar

        run = client.post("/api/regression/run", json={"outcome": outcome})
        assert run.status_code == 200
        assert run.json()["design"]["outcome"] == outcome
        assert run.json()["result"] == {"outcome": outcome}

    assert calls == list(expected)


def test_legacy_report_http_endpoints_are_absent():
    assert client.post("/api/report", json={"method": "工具变量"}).status_code == 404
    assert client.get("/api/report/2020").status_code == 404


def test_indicator_schema():
    resp = client.get("/api/indicators/schema")
    assert resp.status_code == 200
    body = resp.json()
    assert body["groups"][0]["key"] == "trade"
    assert body["fields"]["FVA"]["label"]
    assert body["fields"]["GVCPs"]["label"]
    assert body["fields"]["closnesscentrality"]["label"]
    assert all(meta["desc"] for meta in body["fields"].values())


def test_country_degenerate_flag_marks_only_unweighted_network_fields():
    """国家级贸易图是完全图 → 无权中心性恒为常数,须被标记以便前端在国家级隐藏。

    加权度(=贸易量)与非网络指标不应被标记;标记字段的 desc 要带常数说明。
    """
    body = client.get("/api/indicators/schema").json()
    fields = body["fields"]

    degenerate = {
        "degree",
        "indegree",
        "outdegree",
        "Eccentricity",
        "closnesscentrality",
        "harmonicclosnesscentrality",
        "betweenesscentrality",
        "eigencentrality",
    }
    meaningful = {"weighted degree", "weighted indegree", "weighted outdegree", "FVA", "PLv"}

    flagged = {name for name, meta in fields.items() if meta.get("country_degenerate")}
    assert flagged == degenerate
    assert not (flagged & meaningful)
    for name in degenerate:
        assert "恒为常数" in fields[name]["desc"]


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
def test_meta_and_indicators(ci_synthetic_contract):
    meta = client.get("/api/meta").json()
    assert meta["years"]
    assert meta["artifact_contract"]["network_algorithm"] == NETWORK_ALGORITHM
    year = meta["years"][-1]
    assert "CHN" in meta["countries"]

    if ci_synthetic_contract is None:
        assert len(meta["sectors"]) == 45
    else:
        assert meta["countries"] == sorted(ci_synthetic_contract["countries"])
        assert meta["sectors"] == sorted(ci_synthetic_contract["sectors"])

    rows = client.get(f"/api/indicators/country/{year}").json()
    if ci_synthetic_contract is None:
        assert len(rows) > 50
    else:
        assert len(rows) == ci_synthetic_contract["n_countries"]
    cols = rows[0].keys()
    for col in ["DVAex", "taxsub", "SVA", "3b_FGY_GVC_C", "PLv_GVC", "GVCPs", "betweenesscentrality"]:
        assert col in cols

    paged = client.get(f"/api/indicators/industry/{year}", params={"country": "CHN", "page": 1}).json()
    if ci_synthetic_contract is None:
        assert paged["total"] == 45  # 真实 ICIO 固定为 45 个行业
        assert len(paged["rows"]) == 25
    else:
        assert paged["total"] == ci_synthetic_contract["n_sectors"]
        assert len(paged["rows"]) == min(25, ci_synthetic_contract["n_sectors"])
    assert client.get(f"/api/indicators/sector/{year}", params={"country": "CHN", "page": 1}).status_code == 404


@needs_data
def test_qc_and_network():
    year = processed_years()[-1]
    qc = client.get(f"/api/qc/{year}").json()
    assert len(qc) == 7
    assert any(check["name"].startswith("因子投入") for check in qc)
    assert any(check["name"].startswith("投入侧恒等式") for check in qc)

    net = client.get(f"/api/viz/network/{year}").json()
    assert net["nodes"] and net["edges"]
    node = net["nodes"][0]
    for key in ["gross_exports", "weighted degree", "betweenesscentrality", "gvc_production_share"]:
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


def test_shock_events(monkeypatch):
    """当前面板有对应行的事件保留完整教学元数据。"""
    monkeypatch.setattr(api_mod.artifacts, "validate_source", lambda _path: None)
    metadata = shocks.events_metadata()
    note_columns = {
        "tariff": "note",
        "sanctions": "sanction_note",
        "export_control": "export_control_note",
    }
    panel_rows = []
    for event in metadata:
        row = {column: "" for column in note_columns.values()}
        row[note_columns[event["shock_type"]]] = event["name"]
        panel_rows.append(row)
    monkeypatch.setattr(data_routes, "_read_shocks", lambda: pd.DataFrame(panel_rows))
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
    rusal = next(event for event in body["events"] if "RUSAL" in event["name"])
    assert rusal["removal"] == "2019-01-27"


def test_shock_events_hide_definitions_absent_from_current_panel(monkeypatch):
    """UI 不展示一个在右侧面板中没有对应数据行的事件。"""
    monkeypatch.setattr(api_mod.artifacts, "validate_source", lambda _path: None)
    visible = {
        "tariff": "美国232钢铝关税",
        "sanctions": "OFAC SDN 风格:俄铝 RUSAL 制裁",
        "export_control": "BIS 实体清单:华为及关联公司",
    }
    monkeypatch.setattr(
        data_routes,
        "_read_shocks",
        lambda: pd.DataFrame(
            {
                "note": [visible["tariff"]],
                "sanction_note": [visible["sanctions"]],
                "export_control_note": [visible["export_control"]],
            }
        ),
    )

    response = client.get("/api/shocks/events")

    assert response.status_code == 200
    names = {event["name"] for event in response.json()["events"]}
    assert names == set(visible.values())
    assert "墨西哥对美反制关税" not in names


def test_crosswalk_demo_endpoint(monkeypatch):
    """纯映射演示不借用本地 release；source 漂移由 artifact/health 契约测试覆盖。"""
    monkeypatch.setattr(api_mod.artifacts, "validate_source", lambda _path: None)
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
def test_shock_summary_and_panel(ci_synthetic_contract):
    summary = client.get("/api/shocks/summary").json()
    if ci_synthetic_contract is None:
        assert summary["n_countries"] == 77
        assert summary["n_sectors"] == 45
    else:
        assert summary["n_countries"] == ci_synthetic_contract["n_countries"]
        assert summary["n_sectors"] == ci_synthetic_contract["n_sectors"]
    y2019 = next(r for r in summary["years"] if r["year"] == 2019)
    # 232 覆盖全球:2019 年绝大多数经济体受处理
    if ci_synthetic_contract is None:
        assert y2019["treated_countries"] > 70
    else:
        assert y2019["treated_countries"] >= ci_synthetic_contract["expected_regression_countries"]
    assert y2019["max_shock"] > 0.05

    panel = client.get("/api/shocks/panel", params={"year": 2019}).json()
    if ci_synthetic_contract is None:
        assert panel["total"] > 100
    else:
        assert panel["total"] > ci_synthetic_contract["n_sectors"]
    rows = panel["rows"]
    # 默认按冲击强度降序
    assert rows[0]["tariff_shock"] >= rows[-1]["tariff_shock"]
    assert rows[0]["note"]
    assert rows[0]["main_imposer"]
    assert rows[0]["export_exposure"] is not None

    chn = client.get("/api/shocks/panel", params={"year": 2019, "country": "CHN", "only_hit": True}).json()
    assert chn["total"] > (10 if ci_synthetic_contract is None else 0)
    assert all(r["country"] == "CHN" for r in chn["rows"])

    export_control = client.get(
        "/api/shocks/panel",
        params={"year": 2020, "shock_type": "export_control", "country": "CHN", "only_hit": True},
    ).json()
    assert export_control["total"] >= 2
    assert export_control["rows"][0]["shock_type"] == "export_control"
    assert export_control["rows"][0]["tariff_shock"] > 0
    assert export_control["rows"][0]["main_imposer"] is None
    assert export_control["rows"][0]["export_exposure"] is None


@needs_data
def test_regression_run(ci_synthetic_contract):
    # 默认:国家–行业级 + DID
    resp = client.post("/api/regression/run", json={"outcome": "trade"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["run_id"]
    assert body["design"]["depvar"] == "FVA_share"
    assert body["design"]["granularity"] == "country_industry"
    assert body["design"]["method"] == "did"
    policy = body["result"]["coefs"][0]
    assert policy["name"] == "treated×post"
    assert policy["ci_low"] < policy["coef"] < policy["ci_high"]
    assert isinstance(body["result"]["depvar_mean"], float)
    assert body["result"]["depvar_std"] > 0
    assert "benchmark" in body
    assert body["benchmark"]["backend"] == "linearmodels.PanelOLS"
    assert "passed" not in body["benchmark"]
    assert body["benchmark"]["coef_check_passed"] is True
    assert body["benchmark"]["se_check_mode"] == "informational"
    assert any("仅针对政策系数" in n for n in body["benchmark"]["notes"])
    # 行业级个体数远多于国家数;标准误按国家聚类
    if ci_synthetic_contract is None:
        assert body["result"]["n_entities"] > 1000
        assert body["result"]["n_clusters"] < 100
    else:
        assert body["result"]["n_entities"] == (
            ci_synthetic_contract["expected_regression_countries"] * ci_synthetic_contract["n_sectors"]
        )
        assert body["result"]["n_clusters"] == ci_synthetic_contract["expected_regression_countries"]
    assert any("排除“世界其他地区”（ROW）" in n for n in body["result"]["notes"])

    # 显式国家级粒度仍可用
    resp_c = client.post("/api/regression/run", json={"outcome": "trade", "granularity": "country"})
    assert resp_c.status_code == 200
    if ci_synthetic_contract is None:
        assert resp_c.json()["result"]["n_entities"] < 100
    else:
        assert resp_c.json()["result"]["n_entities"] == ci_synthetic_contract["expected_regression_countries"]

    # 非法粒度/方法报 400
    bad = client.post("/api/regression/run", json={"outcome": "trade", "granularity": "城市级"})
    assert bad.status_code == 400
    bad = client.post("/api/regression/run", json={"outcome": "trade", "method": "工具变量"})
    assert bad.status_code == 400

    ctrl = client.post(
        "/api/regression/run",
        json={"outcome": "trade", "granularity": "country", "control_mode": "icio_derived"},
    )
    assert ctrl.status_code == 200
    assert ctrl.json()["design"]["controls"]
    names = [c["name"] for c in ctrl.json()["result"]["coefs"]]
    assert "treated×post" in names


def test_regression_capacity_saturation_returns_retryable_429(monkeypatch):
    monkeypatch.setattr(regression_routes, "_read_csv", lambda _name: object())

    @asynccontextmanager
    async def saturated(*_args, **_kwargs):
        raise api_mod.concurrency.CapacityExceeded("regression", "queue_full", 4)
        yield

    monkeypatch.setattr(api_mod.concurrency, "async_cpu_workload", saturated)
    response = client.post("/api/regression/run", json={"outcome": "trade"})
    assert response.status_code == 429
    assert response.headers["retry-after"] == "4"
    assert response.json()["code"] == "capacity_queue_full"
    assert "regression" in response.json()["detail"]


@needs_data
def test_regression_placebo_endpoint():
    resp = client.post(
        "/api/regression/placebo",
        json={"outcome": "trade", "granularity": "country", "n_draws": 10, "seed": 11},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "placebo_run_id" not in body
    assert body["design"]["method"] == "did"
    assert body["placebo"]["policy_name"] == "treated×post"
    assert len(body["placebo"]["placebo_coefs"]) == 10
    assert 0 < body["placebo"]["empirical_p"] <= 1

    bad = client.post(
        "/api/regression/placebo",
        json={"outcome": "trade", "method": "twfe_intensity", "n_draws": 10},
    )
    assert bad.status_code == 400
    assert "DID" in bad.json()["detail"]


@pytest.mark.parametrize(
    "field,value",
    [("n_draws", 9), ("n_draws", 201), ("seed", -1), ("seed", 2_147_483_648)],
)
def test_regression_placebo_rejects_cpu_abuse_bounds(field, value):
    response = client.post("/api/regression/placebo", json={"outcome": "trade", field: value})
    assert response.status_code == 422


def test_teacher_cannot_mint_student_regression_evidence():
    token, _ = auth.issue_token({"username": "teacher-test", "name": "教师", "role": "teacher", "demo": True})
    teacher = TestClient(app, headers={"Authorization": f"Bearer {token}"})
    assert teacher.post("/api/regression/run", json={"outcome": "trade"}).status_code == 403
    assert teacher.post("/api/regression/placebo", json={"outcome": "trade"}).status_code == 403


@needs_data
def test_regression_weight_mode_and_interaction_marginal_effect_contract():
    fixed = client.post(
        "/api/regression/run",
        json={"outcome": "production", "granularity": "country", "interaction": True},
    )
    assert fixed.status_code == 200
    assert fixed.json()["design"]["weight_mode"] == "fixed_pretreatment"
    effects = fixed.json()["result"]["marginal_effects"]
    assert [item["level"] for item in effects] == ["low", "mean", "high"]
    assert all(
        {
            "policy_term",
            "interaction_term",
            "label",
            "baseline_gvc_centered",
            "effect",
            "se",
            "ci_low",
            "ci_high",
        }
        <= item.keys()
        for item in effects
    )

    robustness = client.post(
        "/api/regression/run",
        json={"outcome": "production", "granularity": "country", "weight_mode": "contemporaneous"},
    )
    assert robustness.status_code == 200
    assert robustness.json()["design"]["weight_mode"] == "contemporaneous"
    assert any(check["code"] == "treatment_weighting" for check in robustness.json()["preflight"]["checks"])

    unsupported = client.post(
        "/api/regression/run",
        json={"outcome": "production", "shock_type": "sanctions", "weight_mode": "contemporaneous"},
    )
    assert unsupported.status_code == 400


@needs_data
def test_regression_methods():
    # 双向固定效应(强度法):解释变量为连续冲击
    fe = client.post("/api/regression/run", json={"outcome": "production", "method": "twfe_intensity"})
    assert fe.status_code == 200
    assert fe.json()["result"]["coefs"][0]["name"] == "tariff_shock"

    fe_export = client.post(
        "/api/regression/run",
        json={"outcome": "production", "method": "twfe_intensity", "shock_type": "export_control"},
    )
    assert fe_export.status_code == 200
    assert fe_export.json()["result"]["coefs"][0]["name"] == "export_control_shock"

    # 事件研究:基期 k=-1 优先省略,动态系数按个体首次冲击年 G_i 的相对时间构造
    ev = client.post("/api/regression/run", json={"outcome": "production", "method": "event_study"})
    assert ev.status_code == 200
    names = [c["name"] for c in ev.json()["result"]["coefs"]]
    assert "k=0" in names and "k=-1" not in names
    assert "year-G_i" in " ".join(ev.json()["result"]["notes"])


def test_regression_options_serve_stable_keys_with_separate_labels():
    """枚举值必须是稳定英文键,中文只作为配对的展示文案下发。

    HEAD 把界面文字直接当枚举值("双重差分 (DID)"),于是改标点、翻译或
    缩短标签都会变成破坏性 API 变更。这条守住契约层与展示层的分离。
    """
    body = client.get("/api/regression/options").json()
    for keys_field, labels_field in [
        ("granularities", "granularity_labels"),
        ("shock_types", "shock_type_labels"),
        ("methods", "method_labels"),
        ("control_modes", "control_mode_labels"),
        ("price_modes", "price_mode_labels"),
        ("scenarios", "scenario_labels"),
    ]:
        keys = body[keys_field]
        # 键只允许 ASCII 小写标识符——任何中文出现在键里都是契约层被污染。
        assert all(re.fullmatch(r"[a-z0-9_]+", k) for k in keys), (keys_field, keys)
        # 每个键都要有配对文案,界面才不必自备一份映射。
        assert set(body[labels_field]) >= set(keys), (labels_field, keys)

    assert body["shock_types"] == ["tariff", "sanctions", "export_control"]
    assert body["methods"] == ["did", "twfe_intensity", "event_study"]
    assert body["shock_type_labels"]["tariff"] == "关税冲击"


@needs_data
def test_regression_run_accepts_stable_keys_only():
    ok = client.post("/api/regression/run", json={"outcome": "trade", "shock_type": "export_control", "method": "did"})
    assert ok.status_code == 200, ok.text
    # 旧的中文枚举不再被接受:契约已经改了,不做历史兼容。
    legacy = client.post("/api/regression/run", json={"outcome": "trade", "shock_type": "出口管制"})
    assert legacy.status_code == 400
