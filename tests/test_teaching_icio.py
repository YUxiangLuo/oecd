"""步骤 2--4 微型 ICIO 接口；期望金额独立来自账户定义。"""

import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from gvcsim import api as api_module
from gvcsim.api import app


@pytest.fixture
def authenticated_client(monkeypatch):
    monkeypatch.setattr(api_module.auth, "verify_token", lambda _token: {"sub": "student"})
    client = TestClient(app)
    client.headers["Authorization"] = "Bearer test-token"
    return client


def _payload(client):
    response = client.get("/api/teaching/icio")
    assert response.status_code == 200, response.text
    return {scenario["id"]: scenario for scenario in response.json()["scenarios"]}


def _node(scenario, name):
    return scenario["nodes"].index(name)


def test_teaching_icio_requires_existing_bearer_authentication():
    assert TestClient(app).get("/api/teaching/icio").status_code == 401


def test_teaching_icio_account_shapes_and_balances(authenticated_client):
    scenarios = _payload(authenticated_client)
    assert list(scenarios) == ["direct", "domestic", "final-export", "simple-gvc", "complex-gvc", "return-home"]

    for scenario in scenarios.values():
        assert scenario["regions"] == ["甲国", "乙国", "丙国"]
        assert scenario["nodes"] == [
            f"{country}·{sector}" for country in scenario["regions"] for sector in ("初级品", "加工品")
        ]
        z, y = np.array(scenario["Z"]), np.array(scenario["Y"])
        x, va, a = map(np.array, (scenario["x"], scenario["va"], scenario["A"]))
        assert z.shape == (6, 6) and y.shape == (6, 3)
        assert np.all(z >= 0) and np.all(y >= 0) and np.all(va >= 0)
        assert np.allclose(x, z.sum(axis=1) + y.sum(axis=1))
        assert np.allclose(x, z.sum(axis=0) + va)
        assert np.allclose(a, np.divide(z, x, out=np.zeros_like(z), where=x > 0))
        assert all(row["taxsub"] == pytest.approx(0) for row in scenario["trade"])
        assert all(row["gross_exports"] is not None for row in scenario["trade"])


def test_teaching_icio_independent_chain_expectations(authenticated_client):
    scenarios = _payload(authenticated_client)
    domestic, final_export = scenarios["domestic"], scenarios["final-export"]
    simple, complex_, returned = scenarios["simple-gvc"], scenarios["complex-gvc"], scenarios["return-home"]

    # 最终品出口不经过中间品跨境，60 加工增加值属于传统贸易。
    a_processing = _node(final_export, "甲国·加工品")
    assert final_export["production"][a_processing]["2_VA_RT"] == pytest.approx(60)
    assert final_export["production"][a_processing]["3_VA_GVC"] == pytest.approx(0)
    assert final_export["trade"][a_processing]["gross_exports"] == pytest.approx(100)
    assert all(row["gross_exports"] == pytest.approx(0) for row in domestic["trade"])

    # 一次跨境的40中间品在进口国消费；第二次跨境则被正式算法分入复杂 GVC。
    a_primary = _node(simple, "甲国·初级品")
    assert simple["production"][a_primary]["3a_VA_GVC_S"] == pytest.approx(40)
    assert simple["production"][a_primary]["3b_VA_GVC_C"] == pytest.approx(0)
    assert complex_["production"][a_primary]["3a_VA_GVC_S"] == pytest.approx(0)
    assert complex_["production"][a_primary]["3b_VA_GVC_C"] == pytest.approx(40)
    assert complex_["trade"][_node(complex_, "乙国·加工品")]["FVA"] == pytest.approx(40)
    assert returned["trade"][a_primary]["DVArt"] == pytest.approx(40)

    # 长度是累计产出/增加值，不是跨境次数：该两阶段无循环链的前向长度为2。
    assert simple["length"][a_primary]["PLv"] == pytest.approx(2)
    assert complex_["length"][a_primary]["PLv"] == pytest.approx(2)
    assert domestic["length"][a_primary]["PLv"] == pytest.approx(2)
    assert scenarios["direct"]["length"][a_processing]["PLy"] == pytest.approx(1)
    assert domestic["length"][a_processing]["PLy"] == pytest.approx(1.4)
    assert complex_["length"][_node(complex_, "乙国·加工品")]["PLy"] == pytest.approx(1.4)


def test_teaching_icio_inactive_nodes_use_json_null_for_undefined_lengths(authenticated_client):
    scenarios = _payload(authenticated_client)
    inactive = _node(scenarios["domestic"], "丙国·加工品")
    assert scenarios["domestic"]["x"][inactive] == 0
    assert all(value is None for value in scenarios["domestic"]["length"][inactive].values())

    # 响应必须是严格 JSON 数值域，不泄漏 NaN/Infinity。
    def finite(value):
        if isinstance(value, dict):
            return all(finite(item) for item in value.values())
        if isinstance(value, list):
            return all(finite(item) for item in value)
        return not isinstance(value, float) or math.isfinite(value)

    assert finite(scenarios)
