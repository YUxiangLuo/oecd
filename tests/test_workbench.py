"""The workbench of steps 11–14 (自己设计模型): options, spec runs over HTTP, saved models and their validation."""

import copy
import json
from types import SimpleNamespace

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from test_model_spec import _panel

from gvcsim import quizzes, regression_routes
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


def _experiment(spec=None, **changes):
    item = {
        "spec": (spec or ModelSpec((0,), (), ("country_industry", "year"))).canonical().to_dict(),
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
    assert [item["label"] for item in options["controls"]] == [
        "汇率变动",
        "GDP 对数",
        "人口增长率",
        "贸易开放度",
        "FDI 净流入占比",
        "制造业增加值占比",
        "增加值总额对数",
        "出口强度",
    ]
    assert "用作 GDP 代理，并非正式 GDP" in options["controls"][6]["definition"]
    assert [item["source"] for item in options["controls"]] == ["课程生成"] * 5 + ["按 ICIO 计算"] * 3
    assert [item["lag"] for item in options["control_lags"]] == [0, 1]
    effects = {item["key"]: item for item in options["fixed_effects"]}
    assert list(effects) == ["country", "industry", "country_industry", "year", "country_year"]
    assert effects["country_industry"]["includes"] == ["country", "industry"]
    assert effects["country_year"]["includes"] == ["country", "year"]
    assert "吸收本页全部国家层面的控制变量" in effects["country_year"]["description"]
    assert options["limits"] == {"runs_per_minute": 20}
    assert len(options["hints"]) == 2 and options["footnote"].startswith("注：括号内为按国家聚类的标准误。")
    # The preset experiments: each changes one thing of the default model, none is the default, no two alike.
    presets = options["presets"]
    assert [item["label"] for item in presets] == [
        "去掉汇率变动",
        "只放当期 X（去掉 L1.X）",
        "固定效应改为国家 + 行业 + 年份",
        "改用国家×年份固定效应",
        "去掉 GDP 对数",
        "加上人口增长率和 FDI 净流入占比",
        "加上两年前的 X（L2.X）",
    ]
    specs = [json.dumps(item["spec"], sort_keys=True) for item in presets]
    assert len(set(specs)) == len(specs) and json.dumps(DEFAULT_SPEC.to_dict(), sort_keys=True) not in specs
    assert all(item["question"].endswith("？") and ModelSpec.from_dict(item["spec"]) for item in presets)
    assert options["custom_label"] == "自定义设定"
    # The report names an experiment after its preset, else as a custom setting (the page says the same).
    assert workbench.experiment_label(ModelSpec.from_dict(presets[0]["spec"])) == "去掉汇率变动"
    assert workbench.experiment_label(ModelSpec((0,), (), ("year",))) == "自定义设定"


@pytest.fixture
def student_client(teaching_db, monkeypatch):
    from test_route_adapters import _authenticated_client

    monkeypatch.setattr(regression_routes, "read_teaching_panel", lambda: ("a" * 32, PANEL))

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


def test_run_accepts_every_offered_control_together(student_client):
    options = student_client.get("/api/regression/options").json()
    controls = [{"name": item["name"], "lag": 1} for item in options["controls"]]
    response = student_client.post(
        "/api/regression/run",
        json={
            "outcome": "trade",
            "spec": {
                "x_lags": [0, 1],
                "controls": controls,
                "fixed_effects": ["country_industry", "country_year"],
            },
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["design"]["spec"]["controls"]) == 8
    assert body["result"]["sample_flow"]["years"] == [2016, 2020]
    assert body["benchmark"]["benchmark_passed"] is True


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


def test_the_experiment_is_checked_before_the_session_is_stored():
    assert workbench.experiment_problem(_experiment()) is None
    assert workbench.experiment_problem(None) is None
    cases = [
        ([], "字段不完整"),
        ({k: v for k, v in _experiment().items() if k != "saved_at"}, "字段不完整"),
        (_experiment(name="结果1"), "字段不完整"),
        (_experiment(spec=DEFAULT_SPEC), "默认模型"),
        (
            _experiment()
            | {"spec": {"x_lags": [0, 1.0], "controls": [], "fixed_effects": ["country_industry", "year"]}},
            "滞后期",
        ),
        (
            _experiment() | {"spec": {"x_lags": [0], "controls": [{"name": ["汇率"], "lag": 0}], "fixed_effects": []}},
            "名称",
        ),
        (_experiment() | {"spec": {"x_lags": [0], "controls": [], "fixed_effects": [{"a": 1}]}}, "名称"),
        (
            _experiment()
            | {"spec": {"x_lags": [0], "controls": [{"name": "log_gdp_proxy", "lag": 1.0}], "fixed_effects": []}},
            "滞后期",
        ),
        (_experiment() | {"spec": {"x_lags": [1, 0], "controls": [], "fixed_effects": []}}, "规范形式"),
        (_experiment() | {"spec": {"x_lags": [3], "controls": [], "fixed_effects": []}}, "滞后期"),
        (_experiment(saved_at=""), "保存时间"),
        (_experiment(snapshot={"padding": "x" * 20_000}), "过大"),
        (_experiment(snapshot=[]), "快照"),
    ]
    for value, message in cases:
        problem = workbench.experiment_problem(value)
        assert problem is not None and message in problem, (value, problem)
    # As the database returns it (jsonb orders keys by length): each control as {"lag", "name"}.
    with_rate = ModelSpec((0, 1, 2), ((EXCHANGE_RATE_COLUMN, 0),), ("country_industry", "year")).to_dict()
    stored = {**with_rate, "controls": [{"lag": 0, "name": EXCHANGE_RATE_COLUMN}]}
    assert json.dumps(stored) != json.dumps(with_rate)
    assert workbench.experiment_problem(_experiment() | {"spec": stored}) is None
    assert workbench.reported_experiment(_experiment() | {"spec": stored}) == {"spec": stored}
    assert (
        workbench.reported_experiment(None) is None and workbench.reported_experiment(_experiment(saved_at="")) is None
    )


def test_put_session_keeps_a_valid_experiment_and_refuses_an_invalid_one(monkeypatch):
    persisted = []
    monkeypatch.setattr(
        classroom_routes.db, "save_session", lambda *args: persisted.append(args) or {"updated_at": "saved-at"}
    )
    monkeypatch.setattr(classroom_routes.db, "latest_report", lambda _username: None)
    session = empty_session()
    session["steps"]["11"] = make_record({"experiment": _experiment(), "custom_draft": {"anything": [1]}})
    response = classroom_routes.put_session(
        classroom_routes.SessionRequest(session=session, base_updated_at=None), {"sub": "student"}
    )
    assert "session" not in response
    assert response["updated_at"] == "saved-at"
    assert "completion" in response
    assert persisted[0][1]["steps"]["11"]["data"]["experiment"] == _experiment()
    # Removed from the report: the key says so.
    session["steps"]["11"]["data"]["experiment"] = None
    classroom_routes.put_session(
        classroom_routes.SessionRequest(session=session, base_updated_at=None), {"sub": "student"}
    )
    assert persisted[1][1]["steps"]["11"]["data"]["experiment"] is None

    session["steps"]["11"]["data"]["experiment"] = _experiment(spec=DEFAULT_SPEC)
    with pytest.raises(classroom_routes.HTTPException) as refused:
        classroom_routes.put_session(
            classroom_routes.SessionRequest(session=session, base_updated_at=None), {"sub": "student"}
        )
    assert refused.value.status_code == 422
    assert refused.value.detail == "步骤 11 放入报告的模型没有保存：默认模型就是表中第一列，不用放入报告。"
    assert len(persisted) == 2


def test_put_session_refuses_an_experiment_outside_the_regression_steps(monkeypatch):
    monkeypatch.setattr(classroom_routes.db, "save_session", lambda *args: {"updated_at": "saved-at"})
    monkeypatch.setattr(classroom_routes.db, "latest_report", lambda _username: None)
    session = empty_session()
    session["steps"]["5"] = make_record({"experiment": {"spec": {"x": 1}}})
    with pytest.raises(classroom_routes.HTTPException) as refused:
        classroom_routes.put_session(
            classroom_routes.SessionRequest(session=session, base_updated_at=None), {"sub": "student"}
        )
    assert refused.value.status_code == 422
    assert "步骤 5 没有“改模型、对比”" in refused.value.detail
    # Nor do such entries count in the fingerprint (an older record may still hold them).
    base = empty_session()
    assert records.report_fingerprint(session) == records.report_fingerprint(
        base | {"steps": {**base["steps"], "5": make_record({})}}
    )


def test_put_session_refuses_the_records_of_the_earlier_contract(monkeypatch):
    """A second saved run (``qualified_run``) and the list of named models (``custom_results``) are not carried over."""
    monkeypatch.setattr(classroom_routes.db, "save_session", lambda *args: {"updated_at": "saved-at"})
    monkeypatch.setattr(classroom_routes.db, "latest_report", lambda _username: None)
    for legacy in ("qualified_run", "custom_results"):
        session = empty_session()
        session["steps"]["12"] = make_record({legacy: []})
        with pytest.raises(classroom_routes.HTTPException) as refused:
            classroom_routes.put_session(
                classroom_routes.SessionRequest(session=session, base_updated_at=None), {"sub": "student"}
            )
        assert refused.value.status_code == 422
        assert f"步骤 12 的记录来自旧版本（{legacy}）" in refused.value.detail


def test_put_session_answers_422_not_500_for_a_tampered_experiment(monkeypatch):
    monkeypatch.setattr(classroom_routes.db, "save_session", lambda *args: {"updated_at": "saved-at"})
    monkeypatch.setattr(classroom_routes.db, "latest_report", lambda _username: None)
    for tampered in (
        ["FVA_share"],
        {"spec": {"a": 1}, "saved_at": "x", "snapshot": {}},
        _experiment() | {"spec": {"x_lags": [0], "controls": [{"name": ["汇率"], "lag": 0}], "fixed_effects": []}},
        _experiment() | {"spec": {"x_lags": [0, 1.0], "controls": [], "fixed_effects": ["country_industry", "year"]}},
    ):
        session = empty_session()
        session["steps"]["11"] = make_record({"experiment": tampered})
        with pytest.raises(classroom_routes.HTTPException) as refused:
            classroom_routes.put_session(
                classroom_routes.SessionRequest(session=session, base_updated_at=None), {"sub": "student"}
            )
        assert refused.value.status_code == 422, tampered
        assert "unhashable" not in refused.value.detail and "instance" not in refused.value.detail


def test_report_fingerprint_counts_only_what_the_report_prints_of_the_experiment():
    session = empty_session()
    session["steps"]["11"] = make_record({"quiz": {"a": 1}})
    base = records.report_fingerprint(session)

    def with_experiment(experiment="none", draft=None):
        changed = copy.deepcopy(session)
        if experiment != "none":
            changed["steps"]["11"]["data"]["experiment"] = experiment
        if draft is not None:
            changed["steps"]["11"]["data"]["custom_draft"] = draft
        return records.report_fingerprint(changed)

    # Not in the report: no experiment, one removed, or a half-filled form change nothing.
    assert with_experiment() == base
    assert with_experiment(None) == base
    assert with_experiment(None, draft={"x_lags": [0]}) == base
    # In the report: putting one in, or changing its model, does; its snapshot and time do not.
    reported = with_experiment(_experiment())
    assert reported != base
    assert with_experiment(_experiment(snapshot={"other": True}, saved_at="2026-10-12T00:00:00Z")) == reported
    other_spec = ModelSpec((0, 1), (), ("country_industry", "year"))
    assert with_experiment(_experiment(spec=other_spec)) != reported


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
    session["steps"]["11"] = make_record({"experiment": _experiment()})
    monkeypatch.setattr(classroom_routes.quiz_config, "load_bank", quizzes.default_bank)
    monkeypatch.setattr(classroom_routes, "_workspace", lambda _sub: (session, None, None))
    monkeypatch.setattr(
        classroom_routes, "charge_report_runs", lambda account, designs: charged.append((account, designs))
    )
    monkeypatch.setattr(classroom_routes.teaching_report, "build", lambda *_args, quiz_bank: "built")
    monkeypatch.setattr(classroom_routes, "check_gate", lambda _session, *, quiz_bank: [{"step": 1}])
    with pytest.raises(classroom_routes.HTTPException):
        asyncio.run(classroom_routes._prepare_report({"sub": "student", "aid": 3}))
    assert charged == []  # blocked by the gate: nothing to compute, nothing charged
    monkeypatch.setattr(classroom_routes, "check_gate", lambda _session, *, quiz_bank: [])
    with pytest.raises(classroom_routes.HTTPException):  # the row is missing in this stub
        asyncio.run(classroom_routes._prepare_report({"sub": "student", "aid": 3}))
    [(account, designs)] = charged
    assert account == 3
    assert [design.spec for design in designs] == [DEFAULT_SPEC, ModelSpec((0,), (), ("country_industry", "year"))]
