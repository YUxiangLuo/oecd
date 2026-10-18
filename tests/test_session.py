import json
import sys

import pytest
from scipy import stats

from gvcsim.classroom import routes as classroom_routes
from gvcsim.config import ROOT
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.service import design_info
from gvcsim.regression.teaching import model_snapshot, variable_catalog
from gvcsim.regression.workbench import MAX_SNAPSHOT_BYTES
from gvcsim.report_common import REFLECTION_TEXT_LIMIT
from gvcsim.session import (
    MAX_SESSION_BYTES,
    SESSION_VERSION,
    SessionError,
    empty_session,
    make_record,
    validate_session,
)


def test_minimal_session_contract():
    assert empty_session() == {"version": SESSION_VERSION, "steps": {}, "shared": {}}
    payload = empty_session()
    payload["steps"]["1"] = make_record({"quiz": {"answers": {"q": "a"}}})
    payload["shared"]["regression_settings"] = {"trade": {"method": "did"}}
    assert validate_session(payload) == payload


def test_session_fits_all_four_maximum_industry_rankings_and_analysis():
    """The five-country/all-45-industry selections that failed in browser dogfood."""
    payload = empty_session()
    countries = ["CHN", "USA", "DEU", "JPN", "GBR"]
    release = "a" * 32
    for step, metric, unit in [
        (6, "gross_exports", "百万美元"),
        (7, "SVA", "百万美元"),
        (8, "PLv_GVC", "长度单位"),
        (9, "betweenesscentrality", "未归一化介数"),
    ]:
        observations = []
        for country in countries:
            for index in range(45):
                industry = f"C{index:02d}"
                row = {
                    "country": country,
                    "industry": industry,
                    "entity": f"{country}·{industry}",
                    "year": 2020,
                    "metric": metric,
                    "unit": unit,
                    "value": 573166.9331286182,
                    "release": release,
                    "scope": "country-industry",
                    "source": "explicit-network-ranking" if step == 9 else "explicit-indicator-comparison",
                }
                if step == 9:
                    row.update(
                        generation=0,
                        request_key=f"{release}:network-trend:{','.join(countries)}:2016,2017,2018,2019,2020",
                    )
                observations.append(row)
        payload["steps"][str(step)] = make_record(
            {"compared": countries, "observations": observations, "material_chosen": True}
        )
    payload["steps"]["15"] = make_record(
        {key: "🧪" * REFLECTION_TEXT_LIMIT for key in ["research_question", "evidence_interpretation", "limitations"]}
    )
    size = len(json.dumps(payload, ensure_ascii=False).encode())
    assert size > 300_000
    assert validate_session(payload) == payload
    # Budget for four default runs, four maximum-size optional snapshots, and the remaining steps/quizzes.
    assert size + 4 * (12_000 + MAX_SNAPSHOT_BYTES) + 40_000 < MAX_SESSION_BYTES


def test_session_byte_limit_counts_utf8_and_still_rejects_oversized_payloads():
    payload = empty_session()
    payload["steps"]["15"] = make_record({"text": ""})
    remaining = MAX_SESSION_BYTES - len(json.dumps(payload, ensure_ascii=False).encode())
    payload["steps"]["15"]["data"]["text"] = "🧪" * (remaining // 4) + "x" * (remaining % 4)
    assert len(json.dumps(payload, ensure_ascii=False).encode()) == MAX_SESSION_BYTES
    assert validate_session(payload) == payload
    payload["steps"]["15"]["data"]["text"] += "x"
    with pytest.raises(SessionError, match="会话过大"):
        validate_session(payload)


@pytest.mark.parametrize("value", [10**400, -(10**400), float("inf"), -float("inf"), float("nan")])
@pytest.mark.parametrize("section", ["steps", "shared"])
def test_session_rejects_numbers_outside_finite_float_range(value, section):
    payload = empty_session()
    if section == "steps":
        payload["steps"]["10"] = make_record({"nested": [{"value": value}]})
    else:
        payload["shared"]["regression_settings"] = {"nested": [{"value": value}]}
    with pytest.raises(SessionError, match="数值"):
        validate_session(payload)


def test_session_preserves_finite_float_and_integer_boundaries():
    payload = empty_session()
    maximum = sys.float_info.max
    payload["steps"]["10"] = make_record({"values": [maximum, -maximum, int(maximum), -int(maximum), True]})
    assert validate_session(payload) == payload


def test_frontend_and_backend_use_the_same_session_version():
    frontend_types = (ROOT / "frontend" / "src" / "types.ts").read_text()
    assert f'export const SESSION_VERSION = "{SESSION_VERSION}";' in frontend_types


def _estimate(name: str, coef: float, se: float = 0.1) -> dict:
    critical = stats.t.ppf(0.975, 3)
    return {
        "name": name,
        "coef": coef,
        "se": se,
        "t": coef / se,
        "p": float(2 * stats.t.sf(abs(coef / se), 3)),
        "ci_low": float(coef - critical * se),
        "ci_high": float(coef + critical * se),
    }


def test_put_session_acknowledges_without_echoing_the_saved_snapshot(monkeypatch):
    outcome = "production"
    run = {
        "design": design_info(RegressionDesign(outcome, teaching=True)),
        "result": {
            "status": "ok",
            "n_obs": 20,
            "n_entities": 4,
            "n_times": 5,
            "n_clusters": 4,
            "support": {"status": "ok", "suppress_inference": False, "reasons": []},
            "diagnostics": {"study_contract": "economics-v2"},
            # The course model (data v10): X, L1.X and the exchange rate; the X terms' sum is the headline.
            "coefs": [
                _estimate("teaching_tariff_exposure", -0.3),
                _estimate("teaching_tariff_exposure_lag1", -0.2),
                _estimate("teaching_exchange_rate_change", 0.05),
                _estimate("teaching_log_gdp", 0.03),
                _estimate("teaching_trade_openness", 0.001),
            ],
            "cumulative": _estimate("cumulative", -0.5),
        },
        "model_snapshot": json.loads(json.dumps(model_snapshot(outcome))),
        "variable_catalog": variable_catalog(outcome),
    }
    requested = empty_session()
    requested["steps"]["12"] = make_record({"run": run})
    persisted = []
    monkeypatch.setattr(
        classroom_routes.db,
        "save_session",
        lambda username, session, expected: (
            persisted.append((username, session, expected)) or {"updated_at": "saved-at"}
        ),
    )
    monkeypatch.setattr(classroom_routes.db, "latest_report", lambda _username: None)

    response = classroom_routes.put_session(
        classroom_routes.SessionRequest(session=requested, base_updated_at=None),
        {"sub": "student"},
    )

    assert "session" not in response
    assert requested == persisted[0][1]
    assert persisted[0][0] == "student"
    assert persisted[0][2] is None
    assert persisted[0][1]["steps"]["12"]["data"]["run"] == run
    assert response["updated_at"] == "saved-at"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"version": SESSION_VERSION, "steps": {"17": {"data": {}}}, "shared": {}},
        {"version": SESSION_VERSION, "steps": {}, "shared": {"regression_history": {}}},
        {"version": SESSION_VERSION, "steps": {"1": {"data": {}, "updated_at": "old"}}, "shared": {}},
    ],
)
def test_rejects_old_or_unknown_session_shapes(payload):
    with pytest.raises(SessionError):
        validate_session(payload)
