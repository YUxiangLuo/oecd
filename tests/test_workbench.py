"""The workbench of steps 11–14 (自己设计模型): options, spec runs over HTTP, saved models and their validation."""

import copy
import json
from types import SimpleNamespace

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from test_model_spec import _panel

from gvcsim import regression_routes
from gvcsim.api import app
from gvcsim.classroom import records
from gvcsim.classroom import routes as classroom_routes
from gvcsim.regression import workbench
from gvcsim.regression.benchmark import summarize_benchmark
from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.model import CoefStat, PreparedModel, RegressionResult
from gvcsim.regression.panel import run_design_with_benchmark
from gvcsim.regression.spec import DEFAULT_SPEC, EXCHANGE_RATE_COLUMN, ModelSpec
from gvcsim.report_saved_run import _fixed_design_matches
from gvcsim.regression_routes import _design_info
from gvcsim.session import empty_session, make_record

PANEL = _panel()


def _saved(name="结果1", *, in_report=False, spec=None, baseline="FVA_share", **changes):
    item = {
        "id": f"id-{name}",
        "name": name,
        "outcome": "trade",
        "baseline": baseline,
        "spec": (spec or ModelSpec((0,), (), ("country_industry", "year"))).canonical().to_dict(),
        "in_report": in_report,
        "saved_at": "2026-10-11T09:00:00Z",
        "snapshot": {"result": {"coefs": []}},
    }
    item.update(changes)
    return item


def test_options_list_every_choice_in_page_order_with_the_default_and_the_limits():
    options = workbench.options()
    assert options["default_spec"] == DEFAULT_SPEC.to_dict()
    assert [item["label"] for item in options["x_lags"]] == ["X", "L1.X", "L2.X"]
    assert "滞后 3 期" in options["x_lag_note"]
    assert [item["label"] for item in options["controls"]] == ["汇率变动", "增加值总额对数", "出口强度", "制造业增加值占比"]
    assert "用作 GDP 代理，并非正式 GDP" in options["controls"][1]["definition"]
    assert [item["source"] for item in options["controls"]] == [
        "课程生成",
        "按 ICIO 计算",
        "按 ICIO 计算",
        "按 ICIO 计算",
    ]
    assert [item["lag"] for item in options["control_lags"]] == [0, 1]
    effects = {item["key"]: item for item in options["fixed_effects"]}
    assert list(effects) == ["country", "industry", "country_industry", "year", "country_year"]
    assert effects["country_industry"]["includes"] == ["country", "industry"]
    assert effects["country_year"]["includes"] == ["country", "year"]
    assert "吸收所有国家层面的控制变量" in effects["country_year"]["description"]
    assert options["limits"] == {"saved": 6, "in_report": 3, "compared": 4, "name_length": 20, "runs_per_minute": 20}
    assert len(options["hints"]) == 2 and options["footnote"].startswith("注：括号内为按国家聚类的标准误。")


@pytest.fixture
def student_client(teaching_db, monkeypatch):
    from test_route_adapters import _authenticated_client

    monkeypatch.setattr(regression_routes, "_read_csv", lambda _name: PANEL)

    async def direct_cpu(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(regression_routes.concurrency, "run_cpu_bound", direct_cpu)
    regression_routes.clear_result_cache()
    yield _authenticated_client(teaching_db)
    regression_routes.clear_result_cache()


def test_run_takes_a_spec_and_an_omitted_spec_is_the_default_model(student_client):
    default = student_client.post("/api/regression/run", json={"outcome": "trade"})
    assert default.status_code == 200
    explicit = student_client.post("/api/regression/run", json={"outcome": "trade", "spec": DEFAULT_SPEC.to_dict()})
    assert explicit.json() == default.json()
    assert default.json()["design"]["spec"] == DEFAULT_SPEC.to_dict()
    assert [item["name"] for item in default.json()["result"]["coefs"]][:2] == [
        "teaching_tariff_exposure",
        "teaching_tariff_exposure_lag1",
    ]

    # Written in another order and with a contained effect: one model, returned in canonical form.
    custom = student_client.post(
        "/api/regression/run",
        json={
            "outcome": "trade",
            "spec": {"x_lags": [1, 0], "controls": [], "fixed_effects": ["year", "country", "country_industry"]},
        },
    )
    assert custom.status_code == 200
    body = custom.json()
    assert body["design"]["spec"] == {"x_lags": [0, 1], "controls": [], "fixed_effects": ["country_industry", "year"]}
    assert body["model_snapshot"]["spec"] == body["design"]["spec"]
    assert [item["role"] for item in body["variable_catalog"]] == ["X", "X", "Y"]
    assert body["benchmark"]["benchmark_passed"] is True
    # Leaving the exchange rate out moves the cumulative relation (the confounder the data were built with).
    assert body["result"]["cumulative"]["coef"] != pytest.approx(default.json()["result"]["cumulative"]["coef"])

    # No fixed effects: a constant, and the table's statistics.
    plain = student_client.post(
        "/api/regression/run", json={"outcome": "trade", "spec": {"x_lags": [0], "controls": [], "fixed_effects": []}}
    ).json()["result"]
    assert plain["constant"]["name"] == "_constant"
    assert {"r2", "r2_adj", "f_stat", "f_df", "f_p"} <= set(plain)
    assert plain["sample_flow"]["years"] == [2016, 2020]


@pytest.mark.parametrize(
    ("spec", "status", "detail"),
    [
        ({"x_lags": [3], "controls": [], "fixed_effects": []}, 400, "滞后期"),
        ({"x_lags": [], "controls": [], "fixed_effects": []}, 400, "至少要放入一项"),
        ({"x_lags": [0], "controls": [{"name": "population", "lag": 0}], "fixed_effects": []}, 400, "不提供的控制变量"),
        ({"x_lags": [0], "controls": [], "fixed_effects": ["region"]}, 400, "不提供的固定效应"),
        ({"x_lags": [0], "controls": [{"name": EXCHANGE_RATE_COLUMN, "lag": 2}], "fixed_effects": []}, 400, "滞后期"),
        ({"x_lags": [True], "controls": [], "fixed_effects": []}, 422, None),
        ({"x_lags": ["0"], "controls": [], "fixed_effects": []}, 422, None),
        ({"x_lags": [0], "controls": [], "fixed_effects": [], "lags": 1}, 422, None),
        ({"x_lags": [0], "controls": [{"name": EXCHANGE_RATE_COLUMN}], "fixed_effects": []}, 422, None),
    ],
)
def test_run_rejects_a_spec_outside_the_whitelist(student_client, spec, status, detail):
    response = student_client.post("/api/regression/run", json={"outcome": "trade", "spec": spec})
    assert response.status_code == status
    if detail:
        assert detail in response.json()["detail"]


@pytest.mark.parametrize("field", ["controls", "fixed_effects", "baseline"])
@pytest.mark.parametrize("name", ["\ud800", "x" * 200_000], ids=["surrogate", "200kb"])
def test_unknown_names_have_bounded_safe_http_errors(student_client, field, name):
    payload = {"outcome": "trade", "spec": {"x_lags": [0], "controls": [], "fixed_effects": []}}
    if field == "baseline":
        payload[field] = name
    elif field == "controls":
        payload["spec"][field] = [{"name": name, "lag": 0}]
    else:
        payload["spec"][field] = [name]
    response = student_client.post(
        "/api/regression/run", content=json.dumps(payload), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 400
    assert len(response.content) < 200
    assert name not in response.json()["detail"]


def test_a_teacher_cannot_run_a_spec(teaching_db):
    from test_route_adapters import _authenticated_client

    teacher = _authenticated_client(teaching_db, "teacher")
    response = teacher.post("/api/regression/run", json={"outcome": "trade", "spec": DEFAULT_SPEC.to_dict()})
    assert response.status_code == 403


def test_the_report_and_the_page_share_one_computed_run(monkeypatch):
    """The report's synchronous recalculation and the endpoint read and fill the same cache."""
    regression_routes.clear_result_cache()
    calls = []
    real = regression_routes.run_design_with_benchmark
    monkeypatch.setattr(
        regression_routes,
        "run_design_with_benchmark",
        lambda panel, design: calls.append(design) or real(panel, design),
    )
    release = ["a" * 32]
    monkeypatch.setattr(regression_routes.artifacts, "release_identity", lambda: release[0])
    spec = ModelSpec((0, 1), (), ("country_year", "industry"))
    design = RegressionDesign("trade", teaching=True, spec=spec)
    first = regression_routes.cached_run(PANEL, design)
    assert regression_routes.cached_run(PANEL, RegressionDesign("trade", teaching=True, spec=spec)) is first
    assert len(calls) == 1

    async def direct_cpu(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(regression_routes, "read_teaching_panel", lambda: (release[0], PANEL))
    monkeypatch.setattr(regression_routes.concurrency, "run_cpu_bound", direct_cpu)
    import asyncio

    request = SimpleNamespace(state=SimpleNamespace(user={"role": "student", "sub": "student", "aid": 9}))
    payload = regression_routes.RegressionRequest(outcome="trade", spec=spec.to_dict())
    assert asyncio.run(regression_routes.regression_run(payload, request)) is first
    assert len(calls) == 1
    # A new DataFrame of the same release (the CSV cache read it again) still reads the cached run.
    assert regression_routes.cached_run(PANEL.copy(), design) is first
    assert len(calls) == 1
    # A new release starts empty.
    release[0] = "b" * 32
    assert regression_routes.cached_run(PANEL, design) is not first
    assert len(calls) == 2
    regression_routes.clear_result_cache()


def test_the_overview_fills_the_run_cache_so_a_default_run_is_neither_computed_nor_charged(monkeypatch):
    release = "a" * 32
    monkeypatch.setattr(regression_routes.artifacts, "release_identity", lambda: release)
    monkeypatch.setattr(regression_routes, "OUTCOMES", ("trade",))
    overview = regression_routes._estimate_overview(PANEL)
    calls = []
    monkeypatch.setattr(regression_routes, "run_design_with_benchmark", lambda *args: calls.append(args))
    for design in (
        RegressionDesign("trade", teaching=True),
        RegressionDesign("trade", teaching=True, spec=DEFAULT_SPEC),
    ):
        assert regression_routes._run_cached(regression_routes._run_key(design), release)  # admit() charges nothing
        run = regression_routes.cached_run(PANEL, design, release)
        assert run["result"]["cumulative"]["coef"] == overview["outcomes"]["trade"][0]["coef"]
    assert calls == []


def test_absorbed_controls_name_the_effect_that_absorbs_them():
    spec = ModelSpec((0, 1), ((EXCHANGE_RATE_COLUMN, 0), ("log_gdp_proxy", 1)), ("country_industry", "country_year"))
    result, benchmark = run_design_with_benchmark(PANEL, RegressionDesign("trade", teaching=True, spec=spec))
    assert benchmark["benchmark_passed"]
    by = {item["name"]: item["by"] for item in result.omitted}
    assert by == {EXCHANGE_RATE_COLUMN: "国家×年份", "log_gdp_proxy__lag1": "国家×年份"}


def test_a_spec_with_no_estimable_x_term_says_why():
    zero = PANEL.assign(teaching_tariff_exposure_lag2=0.0)
    spec = ModelSpec((2,), (), ("country_industry", "year"))
    with pytest.raises(ValueError, match="关税暴露 X 在这个设定下无法估计：所选的 X 各项在这个样本里全为 0"):
        run_design_with_benchmark(zero, RegressionDesign("trade", teaching=True, spec=spec))
    # Varying only between countries: country effects absorb it.
    country_level = PANEL.assign(
        teaching_tariff_exposure=PANEL.groupby("country")["teaching_tariff_exposure"].transform("mean")
    )
    with pytest.raises(ValueError, match="X 各项都被国家 \\+ 年份固定效应吸收"):
        run_design_with_benchmark(
            country_level, RegressionDesign("trade", teaching=True, spec=ModelSpec((0,), (), ("country", "year")))
        )


def test_the_coefficient_check_scales_with_the_coefficient():
    """A network Y without fixed effects: the solvers differ by ~1e-8 on coefficients in the thousands."""
    model = PreparedModel(pd.DataFrame(), "y", ["x"], ["x"], "entity_id", "year", "country", [])

    def result(coef: float) -> RegressionResult:
        return RegressionResult("y", [CoefStat("x", coef, 1.0, coef, 0.5, -1, 1)], 10, 2, 5, 2, None, 0.0, 1.0)

    assert summarize_benchmark(model, result(-3945.78), result(-3945.78 + 4e-8))["coef_check_passed"]
    assert not summarize_benchmark(model, result(-0.5), result(-0.5 + 4e-8))["coef_check_passed"]
    assert not summarize_benchmark(model, result(-3945.78), result(-3945.78 + 1e-5))["coef_check_passed"]


# Distinct non-default models, for lists of saved models (the same model may be saved once per Y).
_DISTINCT_SPECS = [
    ModelSpec(lags, (), ("country_industry", "year")) for lags in ((0,), (0, 1), (0, 2), (1,), (0, 1, 2), (2,), (1, 2))
]


def test_saved_models_are_checked_before_the_session_is_stored():
    good = [_saved("结果1"), _saved("结果2", in_report=True, spec=_DISTINCT_SPECS[1])]
    assert workbench.custom_results_problem(good, "trade") is None
    assert workbench.custom_results_problem([], "trade") is None
    cases = [
        ({}, "列表"),
        ([_saved(f"结果{index}") for index in range(7)], "最多保存 6 个"),
        ([_saved("结果1"), _saved("结果1", id="other")], "已有名为“结果1”"),
        ([_saved("结果1"), _saved("结果2", id="id-结果1")], "编号"),
        ([_saved("一" * 21)], "1–20 个字符"),
        ([_saved(" 结果1")], "1–20 个字符"),
        ([_saved("")], "请输入名称"),
        ([_saved("\u200b")], "请输入名称"),
        ([_saved("结果\u200b")], "不可见字符"),
        ([_saved("\u200d")], "请输入名称"),
        ([_saved("\u3164")], "请输入名称"),
        ([_saved("\u2800")], "请输入名称"),
        ([_saved("结果1"), _saved("结果１\u3164", id="other")], "已有名为"),
        ([_saved("A（班）"), _saved("a(班)", id="other")], "已有名为"),
        ([_saved("结果\u202e1")], "不可见字符"),
        ([_saved("结果\u001f")], "不可见字符"),
        # A joiner outside an emoji is an invisible mark: "结果1" + U+200D would look like "结果1".
        ([_saved("结果1\u200d")], "不可见字符"),
        ([_saved("结\u200d果")], "不可见字符"),
        ([_saved("结果\U000e0041")], "不可见字符"),
        ([_saved("🏴\U000e0067")], "不可见字符"),
        # Names that differ only in format characters or U+FE0F read the same: one name.
        ([_saved("🏳️\u200d🌈"), _saved("🏳\u200d🌈", id="other")], "已有名为"),
        ([_saved(name=["结果1"])], "请输入名称"),
        ([_saved(spec=DEFAULT_SPEC)], "默认模型"),
        ([_saved("结果1"), _saved("结果2")], "这个设定已保存为“结果1”"),
        ([_saved(baseline=["FVA_share"])], "Y 不在当前课程数据中"),
        ([_saved(outcome=["trade"])], "结果指标"),
        (
            [_saved() | {"spec": {"x_lags": [0, 1.0], "controls": [], "fixed_effects": ["country_industry", "year"]}}],
            "滞后期",
        ),
        (
            [_saved() | {"spec": {"x_lags": [0], "controls": [{"name": ["汇率"], "lag": 0}], "fixed_effects": []}}],
            "名称",
        ),
        ([_saved() | {"spec": {"x_lags": [0], "controls": [], "fixed_effects": [{"a": 1}]}}], "名称"),
        (
            [
                _saved()
                | {"spec": {"x_lags": [0], "controls": [{"name": "log_gdp_proxy", "lag": 1.0}], "fixed_effects": []}}
            ],
            "滞后期",
        ),
        ([_saved(outcome="network")], "结果指标"),
        ([_saved(baseline="PLy_GVC")], "Y 不在当前课程数据中"),
        ([_saved(spec=None) | {"spec": {"x_lags": [1, 0], "controls": [], "fixed_effects": []}}], "规范形式"),
        ([_saved() | {"spec": {"x_lags": [3], "controls": [], "fixed_effects": []}}], "滞后期"),
        (
            [_saved(f"结果{index}", in_report=True, spec=_DISTINCT_SPECS[index]) for index in range(4)],
            "最多 3 个模型放入报告",
        ),
        ([{k: v for k, v in _saved().items() if k != "saved_at"}], "字段不完整"),
        ([_saved(in_report="yes")], "是或否"),
        ([_saved(snapshot={"padding": "x" * 20_000})], "过大"),
    ]
    for value, message in cases:
        problem = workbench.custom_results_problem(value, "trade")
        assert problem is not None and message in problem, (value, problem)
    # As the database returns a saved model (jsonb orders keys by length): each control as {"lag", "name"}.
    with_rate = ModelSpec((0, 1, 2), ((EXCHANGE_RATE_COLUMN, 0),), ("country_industry", "year")).to_dict()
    stored = {**with_rate, "controls": [{"lag": 0, "name": EXCHANGE_RATE_COLUMN}]}
    assert json.dumps(stored) != json.dumps(with_rate)
    assert workbench.custom_results_problem([_saved(spec=None) | {"spec": stored}], "trade") is None
    # Emoji joined by U+200D are one visible character each, not invisible text.
    for name in (
        "家👨\u200d👩\u200d👧\u200d👦",
        "👩\u200d💻",
        "🏳️\u200d🌈",
        "👩🏽\u200d💻",
        "🏃\u200d♂️",
        "🏴\U000e0067\U000e0062\U000e0073\U000e0063\U000e0074\U000e007f",
    ):
        assert workbench.custom_results_problem([_saved(name)], "trade") is None, name
    # The same model on another Y is a different saved model.
    assert workbench.custom_results_problem([_saved("结果1"), _saved("结果2", baseline="DVAex_share")], "trade") is None


def test_put_session_refuses_an_invalid_saved_model_and_keeps_a_valid_one(monkeypatch):
    persisted = []
    monkeypatch.setattr(
        classroom_routes.db, "save_session", lambda *args: persisted.append(args) or {"updated_at": "saved-at"}
    )
    monkeypatch.setattr(classroom_routes.db, "latest_report", lambda _username: None)
    session = empty_session()
    session["steps"]["11"] = make_record({"custom_results": [_saved("结果1")], "custom_draft": {"anything": [1]}})
    response = classroom_routes.put_session(
        classroom_routes.SessionRequest(session=session, base_updated_at=None), {"sub": "student"}
    )
    assert "session" not in response
    assert response["updated_at"] == "saved-at"
    assert "completion" in response
    assert persisted[0][1]["steps"]["11"]["data"]["custom_results"] == [_saved("结果1")]

    session["steps"]["11"]["data"]["custom_results"] = [_saved("结果1"), _saved("结果1", id="x")]
    with pytest.raises(classroom_routes.HTTPException) as refused:
        classroom_routes.put_session(
            classroom_routes.SessionRequest(session=session, base_updated_at=None), {"sub": "student"}
        )
    assert refused.value.status_code == 422
    assert refused.value.detail == "步骤 11 自己设计的模型没有保存：本步已有名为“结果1”的模型。"
    assert len(persisted) == 1


def test_put_session_refuses_saved_models_outside_the_regression_steps(monkeypatch):
    monkeypatch.setattr(classroom_routes.db, "save_session", lambda *args: {"updated_at": "saved-at"})
    monkeypatch.setattr(classroom_routes.db, "latest_report", lambda _username: None)
    session = empty_session()
    session["steps"]["5"] = make_record({"custom_results": [{"in_report": True, "name": {"x": 1}}]})
    with pytest.raises(classroom_routes.HTTPException) as refused:
        classroom_routes.put_session(
            classroom_routes.SessionRequest(session=session, base_updated_at=None), {"sub": "student"}
        )
    assert refused.value.status_code == 422
    assert "步骤 5 没有“自己设计模型”" in refused.value.detail
    # Nor do such entries count in the fingerprint (an older record may still hold them).
    base = empty_session()
    assert records.report_fingerprint(session) == records.report_fingerprint(
        base | {"steps": {**base["steps"], "5": make_record({})}}
    )


def test_put_session_answers_422_not_500_for_a_tampered_saved_model(monkeypatch):
    monkeypatch.setattr(classroom_routes.db, "save_session", lambda *args: {"updated_at": "saved-at"})
    monkeypatch.setattr(classroom_routes.db, "latest_report", lambda _username: None)
    for tampered in (
        _saved(baseline=["FVA_share"]),
        _saved(baseline={"a": 1}),
        _saved() | {"spec": {"x_lags": [0], "controls": [{"name": ["汇率"], "lag": 0}], "fixed_effects": []}},
        _saved() | {"spec": {"x_lags": [0, 1.0], "controls": [], "fixed_effects": ["country_industry", "year"]}},
    ):
        session = empty_session()
        session["steps"]["11"] = make_record({"custom_results": [tampered]})
        with pytest.raises(classroom_routes.HTTPException) as refused:
            classroom_routes.put_session(
                classroom_routes.SessionRequest(session=session, base_updated_at=None), {"sub": "student"}
            )
        assert refused.value.status_code == 422, tampered
        assert "unhashable" not in refused.value.detail and "instance" not in refused.value.detail


def test_report_fingerprint_counts_only_what_the_report_prints_of_the_saved_models():
    session = empty_session()
    session["steps"]["11"] = make_record({"quiz": {"a": 1}})
    base = records.report_fingerprint(session)

    def with_models(*models, draft=None):
        changed = copy.deepcopy(session)
        changed["steps"]["11"]["data"]["custom_results"] = list(models)
        if draft is not None:
            changed["steps"]["11"]["data"]["custom_draft"] = draft
        return records.report_fingerprint(changed)

    # Not in the report: saving, deleting, a different snapshot or a half-filled form change nothing.
    assert with_models() == base
    assert with_models(_saved("结果1"), _saved("结果2")) == base
    assert with_models(_saved("结果1", snapshot={"result": {"coefs": [1]}}), draft={"x_lags": [0]}) == base
    # In the report: marking one, renaming it or changing its model does.
    reported = with_models(_saved("结果1", in_report=True))
    assert reported != base
    assert with_models(_saved("结果1", in_report=True, snapshot={"other": True}), _saved("结果2")) == reported
    assert with_models(_saved("结果A", in_report=True, id="id-结果1")) != reported
    other_spec = ModelSpec((0, 1), (), ("country_industry", "year"))
    assert with_models(_saved("结果1", in_report=True, spec=other_spec)) != reported


def test_a_saved_default_run_must_record_its_model():
    design = _design_info(RegressionDesign("trade", teaching=True))
    assert _fixed_design_matches(design)
    assert not _fixed_design_matches({**design, "spec": None})
    assert not _fixed_design_matches({k: v for k, v in design.items() if k != "spec"})
    custom = ModelSpec((0,), (), ("country_industry", "year")).to_dict()
    assert not _fixed_design_matches({**design, "spec": custom})


def test_options_endpoint_is_public_to_signed_in_users(teaching_db):
    from test_route_adapters import _authenticated_client

    response = _authenticated_client(teaching_db).get("/api/regression/options")
    assert response.status_code == 200
    assert json.loads(response.text) == workbench.options()
    assert TestClient(app).get("/api/regression/options").status_code in (401, 403)


def test_the_page_tests_use_the_options_the_server_sends():
    from gvcsim.config import ROOT

    fixture = ROOT / "frontend" / "src" / "regression-workbench-options.fixture.json"
    assert json.loads(fixture.read_text(encoding="utf-8")) == workbench.options()


def test_the_suppressed_note_fits_both_causes():
    # Inference is hidden after a failed library check (regression.panel) or for the design's treatment support
    # (estimation.within_ols); the page and the report print one note for both, so it must not name only one.
    assert "标准库" not in workbench.SUPPRESSED_NOTE and "已隐藏推断结果" in workbench.SUPPRESSED_NOTE


def test_step_ten_panel_rows_carry_last_years_x_and_the_exchange_rate(monkeypatch):
    """Step 10's year-by-year table shows X, L1.X and the exchange-rate change of the example."""
    import asyncio

    # The spec tests' panel has only the trade Y; the endpoint lists every family's Y and w, τ.
    panel = PANEL.assign(
        teaching_export_share_w=0.3,
        teaching_tariff_rate_tau=(PANEL["teaching_tariff_exposure"] > 0) * 0.25,
        teaching_y_production=0.0,
        teaching_y_length=0.0,
        teaching_y_network=0.0,
    )
    monkeypatch.setattr(regression_routes, "_read_csv", lambda _name: panel)
    body = asyncio.run(regression_routes.teaching_panel(countries="C00,C01", industry="C29", limit=60))
    assert body["rows"] and {"teaching_tariff_exposure_lag1", EXCHANGE_RATE_COLUMN} <= set(body["rows"][0])
    first = [row for row in body["rows"] if row["country"] == "C00"]
    # C00 is taxed from 2018: L1.X follows X a year later.
    by_year = {row["year"]: row for row in first}
    assert by_year[2018]["teaching_tariff_exposure"] > 0 and by_year[2018]["teaching_tariff_exposure_lag1"] == 0
    assert by_year[2019]["teaching_tariff_exposure_lag1"] == by_year[2018]["teaching_tariff_exposure"]


def test_report_generation_charges_the_reported_models_once_the_gate_passes(monkeypatch):
    import asyncio

    charged = []
    session = empty_session()
    session["steps"]["11"] = make_record({"custom_results": [_saved("结果1", in_report=True)]})
    monkeypatch.setattr(classroom_routes, "_workspace", lambda _sub: (session, None, None))
    monkeypatch.setattr(
        classroom_routes, "charge_report_runs", lambda account, designs: charged.append((account, designs))
    )
    monkeypatch.setattr(classroom_routes.teaching_report, "build", lambda *_args: "built")
    monkeypatch.setattr(classroom_routes, "check_gate", lambda _session: [{"step": 1}])
    with pytest.raises(classroom_routes.HTTPException):
        asyncio.run(classroom_routes._prepare_report({"sub": "student", "aid": 3}))
    assert charged == []  # blocked by the gate: nothing to compute, nothing charged
    monkeypatch.setattr(classroom_routes, "check_gate", lambda _session: [])
    with pytest.raises(classroom_routes.HTTPException):  # the row is missing in this stub
        asyncio.run(classroom_routes._prepare_report({"sub": "student", "aid": 3}))
    [(account, designs)] = charged
    assert account == 3
    assert [design.spec for design in designs] == [DEFAULT_SPEC, ModelSpec((0,), (), ("country_industry", "year"))]
