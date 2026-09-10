import json
import re
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from gvcsim import artifacts, config, quizzes, shocks as shock_module, teaching_report
from gvcsim.data import output_quality, quality, raw_icio, regression_quality
from gvcsim.data.citations import artifact_data_sources
from gvcsim.data.raw_icio import DimensionContract, raw_dimensions_metadata

from gvcsim.session import empty_session, make_record
from gvcsim.teaching_report import (
    REFLECTION_TEXT_LIMIT,
    GATE_STEPS,
    ReportGateError,
    build,
    check_gate,
    check_material_gate,
)


REPORT_RAW_CONTRACT = DimensionContract(
    "teaching-report-release-fixture", 1, ("AAA", "BBB", "CCC", "ROW"), ("s1",), ("HFCE",)
)


@pytest.fixture(autouse=True)
def _isolated_report_release_raw_source(tmp_path, monkeypatch):
    # Report tests build a separate compact raw contract; do not misclassify
    # that unmarked temporary directory as the workflow's CI synthetic source.
    monkeypatch.delenv("GVCSIM_CI_SYNTHETIC", raising=False)
    raw_dir = tmp_path.parent / f"{tmp_path.name}-raw"
    raw_dir.mkdir()
    payload = "\n".join(
        [
            "V1,AAA_s1,BBB_s1,CCC_s1,ROW_s1,AAA_HFCE,BBB_HFCE,CCC_HFCE,ROW_HFCE,OUT",
            "AAA_s1,1,2,0,0,2,0,0,0,5",
            "BBB_s1,3,1,0,0,0,2,0,0,6",
            "CCC_s1,0,1,1,0,0,0,2,0,4",
            "ROW_s1,1,0,0,1,0,0,0,2,4",
            "TLS,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1",
            "VA,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1",
            "OUT,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1",
        ]
    )
    for year in (2018, 2019, 2020):
        (raw_dir / f"ICIO2023_{year}.csv").write_text(payload, encoding="utf-8")
    monkeypatch.setattr(config, "RAW_DATA_DIR", raw_dir)
    monkeypatch.setattr(raw_icio, "production_dimension_contract", lambda: REPORT_RAW_CONTRACT)
    monkeypatch.setattr(
        shock_module,
        "EVENTS",
        [
            shock_module.TariffEvent(
                name="fixture tariff AAA",
                imposer="BBB",
                targets=("AAA",),
                announced="2019-01-01",
                effective="2019-01-01",
                rates={"s1": {2019: 0.02}},
            ),
            shock_module.TariffEvent(
                name="fixture tariff BBB",
                imposer="AAA",
                targets=("BBB",),
                announced="2020-01-01",
                effective="2020-01-01",
                rates={"s1": {2020: 0.03}},
            ),
        ],
    )
    monkeypatch.setattr(
        shock_module,
        "ENTITY_LIST_EVENTS",
        [
            shock_module.EntityListEvent(
                name="fixture sanction BBB",
                shock_type="sanctions",
                targets=("BBB",),
                announced="2019-01-01",
                effective="2019-01-01",
                intensities={"s1": {2019: 0.02, 2020: 0.02}},
                entities=("fixture entity",),
            ),
            shock_module.EntityListEvent(
                name="fixture sanction AAA",
                shock_type="sanctions",
                targets=("AAA",),
                announced="2020-01-01",
                effective="2020-01-01",
                intensities={"s1": {2020: 0.03}},
                entities=("fixture entity",),
            ),
            shock_module.EntityListEvent(
                name="fixture export control AAA",
                shock_type="export_control",
                targets=("AAA",),
                announced="2019-01-01",
                effective="2019-01-01",
                intensities={"s1": {2019: 0.02, 2020: 0.02}},
                entities=("fixture entity",),
            ),
            shock_module.EntityListEvent(
                name="fixture export control BBB",
                shock_type="export_control",
                targets=("BBB",),
                announced="2020-01-01",
                effective="2020-01-01",
                intensities={"s1": {2020: 0.03}},
                entities=("fixture entity",),
            ),
        ],
    )
    raw_icio.clear_raw_validation_cache()
    artifacts.clear_artifact_caches()
    yield
    raw_icio.clear_raw_validation_cache()
    artifacts.clear_artifact_caches()


def _checks(scope: str) -> list[dict]:
    kinds = {
        quality.QC_SCOPE_ICIO: list(quality.QC_EXPECTED_KINDS[quality.QC_SCOPE_ICIO]),
        quality.QC_SCOPE_CONTROLS: list(quality.QC_EXPECTED_KINDS[quality.QC_SCOPE_CONTROLS]),
        quality.QC_SCOPE_SHOCKS: list(quality.QC_EXPECTED_KINDS[quality.QC_SCOPE_SHOCKS]),
    }[scope]
    return [
        {
            "name": name,
            "kind": kinds[index],
            "passed": True,
            "detail": "ok",
            "warnings": [],
            "severity": "ok",
        }
        for index, name in enumerate(quality.QC_EXPECTED_CHECKS[scope])
    ]


def _rewrite_metadata(path: Path, metadata: dict) -> None:
    payload = {
        key: value
        for key, value in metadata.items()
        if key
        not in {
            artifacts.ARTIFACT_MANIFEST_NAME,
            artifacts.METADATA_DIGEST_NAME,
            "artifact_contract_version",
        }
    }
    artifacts.write_dataset_metadata(path, payload)
    artifacts.clear_artifact_caches()


def _write_output_artifacts(path: Path, years: list[int]) -> dict[str, dict]:
    country_panels = []
    industry_panels = []
    for year in years:
        rows = []
        for country, weighted_in, weighted_out in (
            ("AAA", 3.0, 4.0),
            ("BBB", 4.0, 3.0),
            ("CCC", 2.0, 2.0),
            ("ROW", 2.0, 2.0),
        ):
            variant = country == "BBB"
            plv = 2.2 if variant else 2.0
            row = {
                "country": country,
                "year": year,
                "DVAex": 4.0,
                "DVArt": 1.0,
                "DDC": 0.0 if variant else 1.0,
                "FVA": 3.0 if variant else 2.0,
                "FDC": 1.0,
                "taxsub": 1.0,
                "EXDVA": 5.0,
                "SVA": 10.0,
                "1_VA_D": 3.0 if variant else 4.0,
                "2_VA_RT": 2.0,
                "3_VA_GVC": 5.0 if variant else 4.0,
                "3a_VA_GVC_S": 0.5 if variant else 1.0,
                "3b_VA_GVC_C": 4.5 if variant else 3.0,
                "FGY": 10.0,
                "1_FGY_D": 4.0,
                "2_FGY_RT": 2.0,
                "3_FGY_GVC": 4.0,
                "3a_FGY_GVC_S": 1.0,
                "3b_FGY_GVC_C": 3.0,
                "PLv": plv,
                "PLv_D": plv,
                "PLv_RT": plv,
                "PLv_GVC": plv,
                "PLy": 2.0,
                "PLy_D": 2.0,
                "PLy_RT": 2.0,
                "PLy_GVC": 2.0,
                "Pos_TPL": plv / 2.0,
                "GVCPs": plv / 2.0,
                "degree": 2.0,
                "indegree": 1.0,
                "outdegree": 1.0,
                "weighted degree": weighted_in + weighted_out,
                "weighted indegree": weighted_in,
                "weighted outdegree": weighted_out,
                "Eccentricity": 1.0,
                "closnesscentrality": 1.0,
                "harmonicclosnesscentrality": 1.0,
                "betweenesscentrality": 0.1 if variant else 0.0,
                "eigencentrality": 1.0,
            }
            rows.append(row)
        country = pd.DataFrame(rows)
        industry = pd.DataFrame([dict(row, industry="s1") for row in rows])
        country.to_csv(path / f"indicators_country_{year}.csv", index=False)
        industry.to_csv(path / f"indicators_industry_{year}.csv", index=False)
        pd.DataFrame(
            [
                {"year": year, "source": "AAA", "target": "BBB", "flow": 4.0},
                {"year": year, "source": "BBB", "target": "AAA", "flow": 3.0},
            ]
        ).to_csv(path / f"network_edges_{year}.csv", index=False)
        pd.DataFrame(
            [
                {
                    "country": country_code,
                    "sector": "s1",
                    "imposer": imposer,
                    "year": year,
                    "bilateral_exports": bilateral,
                    "total_exports": total,
                    "export_exposure": bilateral / total,
                }
                for country_code, total, flows in (
                    (
                        "AAA",
                        2.0,
                        {"AAA": 0.0, "BBB": 2.0, "CCC": 0.0, "ROW": 0.0, "EU": 0.0},
                    ),
                    (
                        "BBB",
                        3.0,
                        {"AAA": 3.0, "BBB": 0.0, "CCC": 0.0, "ROW": 0.0, "EU": 0.0},
                    ),
                    (
                        "CCC",
                        1.0,
                        {"AAA": 0.0, "BBB": 1.0, "CCC": 0.0, "ROW": 0.0, "EU": 0.0},
                    ),
                    (
                        "ROW",
                        1.0,
                        {"AAA": 1.0, "BBB": 0.0, "CCC": 0.0, "ROW": 0.0, "EU": 0.0},
                    ),
                )
                for imposer, bilateral in flows.items()
            ]
        ).to_csv(path / f"export_exposure_{year}.csv", index=False)
        for frame in (country, industry):
            frame["gross_exports"] = 10.0
            frame["FVA_share"] = frame["FVA"] / frame["gross_exports"]
            frame["3b_VA_GVC_C_share"] = frame["3b_VA_GVC_C"] / frame["SVA"]
            frame["3_VA_GVC_share"] = frame["3_VA_GVC"] / frame["SVA"]
            for index, column in enumerate(regression_quality.REGRESSION_CONTROL_FIELDS):
                frame[column] = float(index + 1)
        industry["entity_id"] = industry["country"] + "_" + industry["industry"]
        country_panels.append(country)
        industry_panels.append(industry)
    country_panel = pd.concat(country_panels, ignore_index=True)
    industry_panel = pd.concat(industry_panels, ignore_index=True)
    for frame in (country_panel, industry_panel):
        first_year = frame.groupby("country")["year"].transform("min")
        frame.loc[frame["year"].eq(first_year), ["gdp_proxy_growth", "exports_proxy_growth"]] = np.nan
    exposure = pd.concat(
        [pd.read_csv(path / f"export_exposure_{year}.csv") for year in years],
        ignore_index=True,
    )
    exposure.loc[exposure["imposer"].eq("EU"), list(shock_module.EXPOSURE_LOOKUP_COLUMNS)].to_csv(
        path / shock_module.EXPOSURE_LOOKUP_FILE, index=False
    )
    shock_panel = shock_module.demo_shock_panel(
        ["AAA", "BBB", "CCC", "ROW"],
        ["s1"],
        years,
        export_exposure=exposure,
        exposure_mode=shock_module.EXPOSURE_MODE_FIXED_PRETREATMENT,
    )
    shock_fields = [
        *(column for pair in shock_module.SHOCK_SPECS.values() for column in pair),
        "tariff_shock_contemporaneous",
        "treated_contemporaneous",
        "tariff_exposure_mode",
    ]
    industry_panel = industry_panel.merge(
        shock_panel[["country", "sector", "year", *shock_fields]].rename(columns={"sector": "industry"}),
        on=["country", "industry", "year"],
        how="left",
        validate="one_to_one",
    )
    country_panel = country_panel.merge(
        shock_panel[["country", "year", *shock_fields]].drop_duplicates(["country", "year"]),
        on=["country", "year"],
        how="left",
        validate="one_to_one",
    )
    country_panel.to_csv(path / "panel_country.csv", index=False)
    industry_panel.to_csv(path / "panel_industry.csv", index=False)
    country_panel[
        [
            "country",
            "year",
            *regression_quality.REGRESSION_CONTROL_FIELDS,
        ]
    ].to_csv(path / "controls_country.csv", index=False)
    shock_panel.to_csv(path / "demo_trade_war_tariffs.csv", index=False)
    return {str(year): output_quality.write_output_qc(path, year, expected_years=years)[1] for year in years}


def _artifacts(path: Path, *, disclosure: bool = False):
    annual_by_year = {year: _checks(quality.QC_SCOPE_ICIO) for year in (2018, 2019, 2020)}
    if disclosure:
        annual_by_year[2020][0].update({"warnings": ["需披露"], "severity": "disclosure"})
        factor = next(item for item in annual_by_year[2020] if item["name"] == "因子投入与派生指标定义域(VA/TLS)")
        factor.update({"passed": False, "warnings": ["需关注"], "severity": "warning"})
    controls = _checks(quality.QC_SCOPE_CONTROLS)
    shocks = _checks(quality.QC_SCOPE_SHOCKS)
    for year, checks in annual_by_year.items():
        (path / f"qc_{year}.json").write_text(json.dumps(checks, ensure_ascii=False), encoding="utf-8")
    (path / "qc_controls.json").write_text(json.dumps(controls, ensure_ascii=False), encoding="utf-8")
    (path / "qc_shocks.json").write_text(json.dumps(shocks, ensure_ascii=False), encoding="utf-8")
    output_years = _write_output_artifacts(path, [2018, 2019, 2020])
    regression_input_summary = regression_quality.write_regression_input_qc(path, expected_years=[2018, 2019, 2020])[1]
    metadata = {
        "release_id": "2" * 32,
        "years": [2018, 2019, 2020],
        "generated_at": "2026-08-13T00:00:00+00:00",
        "course_release": config.COURSE_RELEASE,
        "network_algorithm": "gephi-compatible-directed-unweighted-positive-v1",
        "data_sources": artifact_data_sources(config.RAW_DATA_DIR),
        "raw_dimensions": raw_dimensions_metadata([2018, 2019, 2020], config.RAW_DATA_DIR),
        "qc_contract": quality.qc_contract_metadata(),
        "shock_contract": shock_module.shock_contract_metadata(),
        "qc": {
            "years": {
                str(year): quality.summarize_serialized_checks(checks) for year, checks in annual_by_year.items()
            },
            "controls": quality.summarize_serialized_checks(controls),
            "shocks": quality.summarize_serialized_checks(shocks),
        },
        "output_qc_contract": output_quality.output_qc_contract_metadata(),
        "output_qc": {"years": output_years},
        "regression_input_qc_contract": regression_quality.regression_input_qc_contract_metadata(),
        "regression_input_qc": regression_input_summary,
        "publication_policy": artifacts.publication_policy_metadata(),
    }
    metadata["integrity"] = artifacts.release_integrity_metadata(path, metadata["years"])
    artifacts.write_dataset_metadata(path, metadata)
    artifacts.clear_artifact_caches()


def _sign_run(run: dict) -> dict:
    return run


def _ok_run(outcome: str, **design):
    payload = {
        "outcome": outcome,
        "equation": "y = policy + FE",
        "shock_type": "tariff",
        "method": "did",
        "depvar_label": {
            "trade": "出口中外国增加值份额",
            "production": "复杂GVC生产份额",
            "length": "前向 GVC 生产长度",
            "network": "生产网络介数中心性",
        }.get(outcome, outcome),
    }
    payload.update(design)
    result = {"status": "ok", "n_obs": 1, "coefs": [{"name": "treated×post", "coef": 0.0}]}
    return _sign_run({"design": payload, "result": result})


def _event_support(
    k0_supported: bool = True, include_thin_lead: bool = False, include_supported_lead: bool = False
) -> dict:
    def period(term: str, supported: bool, *, reference: bool = False) -> dict:
        clusters = 13 if supported else 11
        return {
            "term": term,
            "event_time": -1 if reference else int(term.removeprefix("k=")),
            "is_reference": reference,
            "estimated": not reference,
            "contributing_rows": clusters,
            "contributing_entities": clusters,
            "contributing_clusters": clusters,
            "cohorts": {"2018": clusters},
            "period_supported": supported,
            "inference_supported": supported,
            "suppress_inference": not supported,
            "reason_codes": [] if supported else ["insufficient_period_clusters"],
            "reasons": [] if supported else [f"{term} 只有 11 个贡献处理聚类，低于课程停止线 12。"],
        }

    return {
        "policy": "teaching_min_contributing_clusters_per_event_period",
        "policy_is_statistical_theorem": False,
        "cluster": "country",
        "base_k": -1,
        "reference_term": "k=-1",
        "min_contributing_clusters": 12,
        "periods": [
            period("k=-1", True, reference=True),
            period("k=0", k0_supported),
            *([period("k=-4", False)] if include_thin_lead else []),
            *([period("k=-2", True)] if include_supported_lead else []),
        ],
    }


def _complete():
    session = empty_session()
    session["steps"] = {str(step): make_record({"quiz": quizzes.correct_quiz(step)}) for step in GATE_STEPS}
    session["steps"]["1"]["data"]["observation"] = {
        "row": "CHN_D01T02",
        "column": "USA_D01T02",
        "value": 1.0,
    }
    for step in range(2, 10):
        session["steps"][str(step)]["data"]["compared"] = ["CHN", "USA"]
    # Step 9 additionally requires a recorded industry betweenness observation.
    session["steps"]["9"]["data"]["observations"] = [
        {
            "entity": "CHN·C26",
            "country": "CHN",
            "industry": "C26",
            "year": 2020,
            "value": 12.5,
            "metric": "betweenesscentrality",
            "scope": "country-industry",
            "source": "explicit-heat-row",
        }
    ]
    session["steps"]["10"]["data"].update(
        {
            "viewed_shock_types": ["tariff", "sanctions", "export_control"],
            "viewed_events": ["关税示例", "制裁示例", "出口管制示例"],
        }
    )
    session["steps"]["11"]["data"]["run"] = _ok_run("trade")
    session["steps"]["12"]["data"]["run"] = _ok_run("production")
    session["steps"]["13"]["data"]["run"] = _ok_run("length")
    session["steps"]["14"]["data"]["run"] = _ok_run("network")
    session["steps"]["15"] = make_record(
        {
            "research_question": "关税冲击是否改变出口中的外国增加值份额？",
            "evidence_interpretation": "我将描述性比较与保存的回归点估计、置信区间一起解读，只把它们视为当前设定下的证据而非自动的因果证明。",
            "limitations": "冲击是教学编码，平行趋势和无同期混杂未被证明，而且行业可能受到同一国家冲击与网络外溢。",
        }
    )
    return session


def test_production_share_report_copy_forbids_scale_overstatement():
    copy = teaching_report._OUTCOME_INTERPRETATIONS["production"]
    assert copy["negative"] == (
        "SVA 中复杂 GVC 增加值份额降低；这是构成占比变化，不能单凭该比例判断生产规模扩张/收缩。"
    )
    assert copy["positive"] == (
        "SVA 中复杂 GVC 增加值份额提高；这是构成占比变化，不能单凭该比例判断生产规模扩张/收缩。"
    )
    assert re.search(r"与.*(?:扩张|收缩)一致", " ".join(copy.values())) is None


def test_interaction_event_report_gate_requires_exact_diagnostic_scope_set():
    support = _event_support(include_supported_lead=True)

    def scoped(scope, terms):
        return {
            "scope": scope,
            "available": True,
            "reason": None,
            "terms": terms,
            "excluded_terms": [],
            "statistic": 1.0,
            "df_num": len(terms),
            "df_denom": 20,
            "p": 0.2,
            "interpretation": f"{scope} 诊断",
        }

    tests = {
        "main": scoped("main", ["k=-2"]),
        "interaction": scoped("interaction", ["k=-2×base_gvc"]),
        "joint": scoped("joint", ["k=-2", "k=-2×base_gvc"]),
    }
    result = {
        "status": "ok",
        "support": {"status": "ok", "suppress_inference": False},
        "coefs": [
            {"name": "k=-2", "coef": 0.0},
            {"name": "k=0", "coef": 0.1},
            {"name": "k=-2×base_gvc", "coef": 0.0},
            {"name": "k=0×base_gvc", "coef": 0.0},
        ],
        "event_support": support,
        "diagnostics": {"pretrend": tests["joint"], "pretrend_tests": tests},
    }
    design = {
        "outcome": "trade",
        "depvar_label": "课程 FVA 份额",
        "shock_type": "tariff",
        "method": "event_study",
        "interaction": True,
    }
    assert teaching_report._result_is_qualified(result, design) is True
    assert teaching_report._pretrend_period_count(result, tests["joint"], True) == 1
    passing_limit = teaching_report._passing_pretrend_limit(design, result)
    assert passing_limit is not None
    assert "仅 1 个受支持的冲击前时期" in passing_limit
    assert "不是平行趋势成立的证据" in passing_limit
    summary = "\n".join(
        teaching_report._evidence_summary([{"step": 11, "outcome": "trade", "design": design, "result": result}])
    )
    assert "最重要的设计限制：** 冲击前检验仅 1 个受支持的冲击前时期" in summary

    empty_interaction_set = json.loads(json.dumps(result))
    empty_interaction_set["coefs"] = [
        coefficient for coefficient in empty_interaction_set["coefs"] if "×base_gvc" not in coefficient["name"]
    ]
    assert teaching_report._valid_event_support(empty_interaction_set, interaction=True) is None

    coordinated_deletion = json.loads(json.dumps(result))
    for field in ("coefs", "event_support", "diagnostics"):
        coordinated_deletion.pop(field, None)
    assert teaching_report._result_is_qualified(coordinated_deletion, design) is False

    missing = json.loads(json.dumps(result))
    del missing["diagnostics"]["pretrend_tests"]["interaction"]
    assert teaching_report._result_is_qualified(missing, design) is False
    assert teaching_report._failed_pretrend(missing, design) is not None

    mismatched = json.loads(json.dumps(result))
    mismatched["diagnostics"]["pretrend"] = mismatched["diagnostics"]["pretrend_tests"]["main"]
    assert teaching_report._result_is_qualified(mismatched, design) is False

    coordinated_omission = json.loads(json.dumps(result))
    extra_period = dict(
        next(period for period in coordinated_omission["event_support"]["periods"] if period["term"] == "k=-2")
    )
    extra_period.update({"term": "k=-3", "event_time": -3})
    coordinated_omission["event_support"]["periods"].append(extra_period)
    coordinated_omission["coefs"].insert(0, {"name": "k=-3", "coef": 0.0})
    assert teaching_report._result_is_qualified(coordinated_omission, design) is False

    noninteraction = json.loads(json.dumps(result))
    noninteraction["diagnostics"] = {"pretrend": tests["main"], "pretrend_tests": {"main": tests["main"]}}
    noninteraction_design = {"method": "event_study", "interaction": False}
    assert teaching_report._result_is_qualified(noninteraction, noninteraction_design) is True
    noninteraction["diagnostics"]["pretrend_tests"]["joint"] = tests["joint"]
    assert (
        teaching_report._result_is_qualified(noninteraction, {"method": "event_study", "interaction": False}) is False
    )


def test_gate_requires_quizzes_key_operations_run_and_reflection(monkeypatch):
    monkeypatch.setattr(
        teaching_report,
        "selectable_shock_types",
        lambda **_kwargs: ("tariff", "sanctions", "export_control"),
    )
    blocked = check_gate(empty_session())
    assert set(GATE_STEPS) <= {item["step"] for item in blocked}
    assert any(item["step"] == 1 and "具体单元格" in "".join(item["missing"]) for item in blocked)
    assert all(
        any(item["step"] == step and "记录当前国家" in "".join(item["missing"]) for item in blocked)
        for step in range(2, 6)
    )
    assert all(
        any(item["step"] == step and "两个比较对象" in "".join(item["missing"]) for item in blocked)
        for step in range(6, 9)
    )
    # Step 9 requires a country comparison *and* an industry observation, so its
    # message names both actions instead of the steps 6-8 wording.
    assert any(item["step"] == 9 and "两个经济体" in "".join(item["missing"]) for item in blocked)
    assert any(item["step"] == 9 and "介数观测" in "".join(item["missing"]) for item in blocked)
    assert any(item["step"] == 6 and "两个比较对象" in "".join(item["missing"]) for item in blocked)
    assert any(item["step"] == 11 and "可报告" in "".join(item["missing"]) for item in blocked)
    assert any(item["step"] == 14 and "可报告" in "".join(item["missing"]) for item in blocked)
    assert any(item["step"] == 15 and "原创" in item["title"] for item in blocked)
    assert len(blocked) == len({item["step"] for item in blocked})
    by_step = {item["step"]: item for item in blocked}
    assert "理解检查" in "".join(by_step[1]["missing"])
    assert "具体单元格" in "".join(by_step[1]["missing"])
    assert "理解检查" in "".join(by_step[6]["missing"])
    assert "两个比较对象" in "".join(by_step[6]["missing"])
    assert "理解检查" in "".join(by_step[12]["missing"])
    assert "可报告" in "".join(by_step[12]["missing"])
    assert all(label in "".join(by_step[10]["missing"]) for label in ("关税冲击", "制裁清单", "出口管制"))
    assert check_gate(_complete()) == []
    missing_one = _complete()
    del missing_one["steps"]["14"]["data"]["run"]
    blocked_one = check_gate(missing_one)
    assert any(item["step"] == 14 and "可报告" in "".join(item["missing"]) for item in blocked_one)
    with pytest.raises(ReportGateError):
        build(empty_session(), "同学")


def test_material_gate_is_independent_of_unfinished_quizzes():
    session = _complete()
    for step in range(1, 15):
        del session["steps"][str(step)]["data"]["quiz"]

    assert check_material_gate(session) == []
    assert {item["step"] for item in check_gate(session)} == set(range(1, 15))


def test_step_nine_requires_both_a_comparison_and_an_industry_observation():
    """Step 9 asks for a country comparison *and* an industry betweenness observation."""
    assert check_material_gate(_complete()) == []

    # A carried-over country comparison alone must no longer satisfy step 9.
    comparison_only = _complete()
    comparison_only["steps"]["9"]["data"]["observations"] = []
    blocked = [item for item in check_material_gate(comparison_only) if item["step"] == 9]
    assert len(blocked) == 1
    assert "介数观测" in "".join(blocked[0]["missing"])
    assert any(item["step"] == 9 for item in check_gate(comparison_only))

    # The comparison is still required alongside the observation.
    observation_only = _complete()
    observation_only["steps"]["9"]["data"]["compared"] = []
    message = "".join(next(item["missing"] for item in check_material_gate(observation_only) if item["step"] == 9))
    assert "两个经济体" in message


def test_report_labels_step_nine_observation_without_a_step_level_metric(tmp_path, monkeypatch):
    """The observation carries its own metric; the report must name it, not print “—”."""
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["9"]["data"].pop("metric", None)

    report = build(session, "同学")

    assert "全正边二值介数（探索性拓扑基准）" in report.markdown
    assert "记录指标：—" not in report.markdown


def test_material_gate_requires_one_viewed_event_from_each_selectable_shock_type(monkeypatch):
    monkeypatch.setattr(
        teaching_report,
        "selectable_shock_types",
        lambda **_kwargs: ("tariff", "sanctions", "export_control"),
    )
    session = _complete()
    session["steps"]["10"]["data"]["viewed_shock_types"] = ["tariff", "sanctions"]

    blocked = check_material_gate(session)

    assert len(blocked) == 1
    assert blocked[0]["step"] == 10
    assert "出口管制" in "".join(blocked[0]["missing"])


def test_material_gate_ignores_shock_types_without_selectable_events(monkeypatch):
    monkeypatch.setattr(teaching_report, "selectable_shock_types", lambda **_kwargs: ("tariff",))
    session = _complete()
    session["steps"]["10"]["data"].update(
        {
            "viewed_shock_types": ["tariff"],
            "viewed_events": ["fixture tariff AAA"],
        }
    )

    assert all(item["step"] != 10 for item in check_material_gate(session))

    session["steps"]["10"]["data"]["viewed_shock_types"] = []
    blocked = next(item for item in check_material_gate(session) if item["step"] == 10)
    message = "".join(blocked["missing"])
    assert "关税冲击" in message
    assert "制裁清单" not in message and "出口管制" not in message


def test_report_uses_saved_result_without_calling_estimator(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["11"]["data"]["run"] = {
        "settings": {"method": "did"},
        "design": {"outcome": "trade", "equation": "y = policy + FE"},
        "result": {
            "status": "ok",
            "n_obs": 42,
            "coefs": [{"name": "policy", "coef": 1.2, "se": 0.3, "p": 0.01, "ci_low": 0.6, "ci_high": 1.8}],
        },
    }
    _sign_run(session["steps"]["11"]["data"]["run"])
    report = build(session, "同学")
    assert report.provenance["years"] == [2018, 2019, 2020]
    assert report.provenance["release_id"] == "2" * 32
    assert report.provenance["quiz_version"] == quizzes.QUIZ_VERSION
    assert report.provenance["course_release"] == config.COURSE_RELEASE
    assert report.provenance["runs"][0]["step"] == 11
    assert report.provenance["runs"][0]["result"]["coefs"][0]["coef"] == 1.2
    assert "1.2" in report.markdown and "不在报告生成时复算" in report.markdown
    assert "[0.6, 1.8]" in report.markdown
    assert "## 关键证据摘要" in report.markdown
    assert "处理后相对变化" in report.markdown
    assert "+120.00 个百分点" in report.markdown
    assert "## 技术附录：保存的回归结果" in report.markdown
    assert "| 政策处理项 | 1.2 | 0.3 | [0.6, 1.8] | 0.01 |" in report.markdown
    assert "政策冲击为基于公开事件手工编码的拟真教学面板" in report.markdown
    assert "有向无权网络" in report.markdown
    assert report.provenance["network_algorithm"] == "gephi-compatible-directed-unweighted-positive-v1"
    assert report.provenance["indicator_data_source"]["kind"] == "observed-indicator-input"
    assert report.provenance["simulated_macro_controls"]["kind"] == "deterministic-teaching-mock"
    assert "模型标签：模拟宏观控制" in report.markdown
    assert "Not WDI data and not IMF observations" in report.markdown


def test_report_preserves_the_full_accepted_research_question(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    question = "问" * (REFLECTION_TEXT_LIMIT - 1) + "终"
    session["steps"]["15"]["data"]["research_question"] = question

    report = build(session, "同学")

    assert question in report.markdown
    frontend = (config.ROOT / "frontend" / "src" / "labs" / "steps" / "report-lab.tsx").read_text()
    assert f"export const REFLECTION_MAX_LENGTH = {REFLECTION_TEXT_LIMIT};" in frontend


def test_report_preserves_reflection_paragraphs_and_markdown_characters(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    evidence_text = "第一段引用 `treated×post` | 置信区间。\n\n第二段保留学生自己的段落结构与标点。"
    session["steps"]["15"]["data"]["evidence_interpretation"] = evidence_text

    report = build(session, "同学")

    assert evidence_text in report.markdown


def test_reflection_over_the_advertised_limit_blocks_report():
    session = _complete()
    session["steps"]["15"]["data"]["research_question"] = "问" * (REFLECTION_TEXT_LIMIT + 1)

    blocked = check_gate(session)

    assert any(item["step"] == 15 and "不能超过" in "".join(item["missing"]) for item in blocked)


def test_malformed_only_saved_run_blocks_report(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["11"]["data"]["run"] = {"design": {"outcome": "trade"}, "result": "forged"}
    blocked = check_gate(session)
    assert any(item["step"] == 11 and "可报告" in "".join(item["missing"]) for item in blocked)
    with pytest.raises(ReportGateError):
        build(session, "同学")


@pytest.mark.parametrize("status", ["insufficient", "invalid_design", []])
def test_non_inferential_saved_run_does_not_satisfy_valid_regression_gate(status):
    session = _complete()
    session["steps"]["11"]["data"]["run"]["result"].update(
        {
            "status": status,
            "support": {"status": status, "suppress_inference": True},
        }
    )

    blocked = check_gate(session)

    assert any(item["step"] == 11 and "可报告" in "".join(item["missing"]) for item in blocked)


def test_qualified_run_on_same_step_still_satisfies_gate_after_insufficient_latest(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["11"]["data"]["qualified_run"] = session["steps"]["11"]["data"]["run"]
    session["steps"]["11"]["data"]["run"] = {
        "design": {"outcome": "trade", "equation": "y = policy + FE", "shock_type": "export_control"},
        "result": {
            "status": "insufficient",
            "support": {"status": "insufficient", "suppress_inference": True, "treated_clusters": 1},
            "n_obs": 10,
            "coefs": [{"name": "export_control_treated×post", "coef": -0.01}],
        },
    }

    assert check_gate(session) == []
    report = build(session, "同学")
    assert "四类指标并读" in report.markdown
    assert "这四步分别估计" in report.markdown
    assert "统计推断已抑制" in report.markdown or "处理支持度不足" in report.markdown
    assert "cohort-time ATT" in report.markdown or "treated×post" in report.markdown or "政策处理项" in report.markdown


def test_exact_run_identity_prevents_unsigned_latest_from_shadowing_distinct_qualified_run(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    qualified = _ok_run("trade")
    qualified["result"]["notes"] = ["QUALIFIED_COLLISION_FIXTURE"]
    latest = json.loads(json.dumps(qualified))
    latest["result"]["status"] = "insufficient"
    latest["result"]["support"] = {"status": "insufficient", "suppress_inference": True}
    latest["result"]["notes"] = ["LATEST_COLLISION_FIXTURE"]
    session["steps"]["11"]["data"].update({"run": latest, "qualified_run": qualified})

    step_runs = [run for run in teaching_report._saved_runs(session) if run["step"] == 11]
    qualified_runs = [run for run in teaching_report._gate_qualified_runs(session) if run["step"] == 11]
    markdown = build(session, "同学").markdown

    assert len(step_runs) == 2
    assert len(qualified_runs) == 1
    assert qualified_runs[0]["result"]["notes"] == ["QUALIFIED_COLLISION_FIXTURE"]
    assert "LATEST_COLLISION_FIXTURE" in markdown
    assert "QUALIFIED_COLLISION_FIXTURE" in markdown

    identical = _complete()
    identical_run = identical["steps"]["12"]["data"]["run"]
    identical["steps"]["12"]["data"]["qualified_run"] = identical_run
    assert len([run for run in teaching_report._saved_runs(identical) if run["step"] == 11]) == 1


def test_comparison_table_flags_mixed_shocks_and_keeps_estimand_label(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["12"]["data"]["run"] = _ok_run("production", shock_type="sanctions")

    markdown = build(session, "同学").markdown

    assert "读表注意" in markdown
    assert "处理后相对变化：+0.00 个百分点" in markdown


def test_report_carries_release_qc_disclosures(tmp_path, monkeypatch):
    _artifacts(tmp_path, disclosure=True)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    report = build(_complete(), "同学")
    assert report.provenance["qc"]["years"]["2020"]["requires_disclosure"] is True
    assert "## 数据完整性与诊断披露" in report.markdown
    assert "警告：因子投入与派生指标定义域(VA/TLS)" in report.markdown
    assert "补充披露：维度一致性与索引对齐(Z/Y/A/L/x/OUT)" in report.markdown


def test_report_discloses_output_economic_warnings_without_blocking_publication(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    # A valid signed ratio can lie outside [0, 1]. Exercise the real check and
    # summary serializer before persisting the warning into a signed release.
    frame = pd.DataFrame({"FVA_share": [-0.02]})
    warning = output_quality._panel_share_economic_domains(
        {"panel_country_year": frame, "panel_industry_year": frame}, 2020
    )
    path = tmp_path / "qc_outputs_2020.json"
    checks = json.loads(path.read_text())
    checks = [warning if check["name"] == warning["name"] else check for check in checks]
    path.write_text(json.dumps(checks), encoding="utf-8")
    output_summary = output_quality.summarize_output_checks(checks)
    metadata["output_qc"]["years"]["2020"] = output_summary
    metadata["integrity"] = artifacts.release_integrity_metadata(tmp_path, metadata["years"])
    _rewrite_metadata(tmp_path, metadata)

    assert output_summary["publishable"] is True
    summary = teaching_report._qc_release_summary({"outputs": metadata["output_qc"]})
    assert summary["requires_disclosure"] is True
    assert summary["warning"] == [warning["name"]]
    report = build(_complete(), "同学")
    assert "警告：panel_share_economic_domains" in report.markdown
    assert report.provenance["output_qc"]["years"]["2020"]["warnings"] == [warning["name"]]


def test_report_merges_singular_and_plural_warnings_once():
    summary = teaching_report._qc_release_summary(
        {
            "inputs": {"warning": ["shared", "input"]},
            "outputs": {"years": {"2020": {"warnings": ["shared", "output"]}}},
        }
    )
    assert summary["warning"] == ["shared", "input", "output"]
    assert summary["requires_disclosure"] is True
    assert teaching_report._qc_release_summary({"warnings": []})["requires_disclosure"] is False


def test_report_rejects_missing_or_unsupported_qc_contract(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata.pop("qc_contract")
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(ReportGateError) as missing:
        build(_complete(), "同学")
    assert "质检 contract" in "".join(missing.value.missing[0]["missing"])

    _artifacts(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["qc_contract"]["version"] = 99
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(ReportGateError) as unsupported:
        build(_complete(), "同学")
    assert "质检 contract" in "".join(unsupported.value.missing[0]["missing"])


def test_report_includes_saved_experiment_snapshots_and_event_scope(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["1"]["data"].update(
        {
            "slice": {"year": 2020, "table": "z", "row_country": "CHN", "col_country": "USA"},
            "observation": {"row": "CHN_D01T02", "column": "USA_D01T02", "value": 228.0672},
        }
    )
    session["steps"]["7"]["data"].update(
        {
            "year": 2020,
            "chart": "quadrant",
            "compared": ["CHN", "USA"],
            "metric": "FVA_share",
            "observations": [
                {"entity": "CHN", "year": 2020, "value": 0.12},
                {"entity": "USA", "year": 2020, "value": 0.08},
            ],
        }
    )
    session["steps"]["10"]["data"].update(
        {
            "viewed_shock_types": ["tariff", "sanctions", "export_control"],
            "viewed_events": ["示例事件"],
            "selected_event_key": "示例事件::2018-07-06",
        }
    )

    report = build(session, "同学")

    assert "CHN_D01T02(行·供给方) → USA_D01T02(列·使用方) = 228.1" in report.markdown
    assert "×" not in report.markdown.split("记录的单元格")[1].split("\n")[0]
    assert "年份=2020" in report.markdown
    assert "表=z" in report.markdown
    assert "主动比较：CHN、USA" in report.markdown
    assert "| CHN | 2020 | 0.12 |" in report.markdown
    assert "仅用于探索定位，不限定下游回归样本" in report.markdown
    assert "按所选冲击类型汇总该类型全部已编码事件" in report.markdown
    assert "当前目录无法确认来源状态" in report.markdown
    assert "不是政策机关发布的权威处理标记" in report.markdown
    assert "## 一页结论：我的问题、证据与局限" in report.markdown
    assert "关税冲击是否改变出口中的外国增加值份额" in report.markdown


def test_report_carries_catalogue_event_source_status_and_urls(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    disclosure = "事件事实与课程数值映射必须分开。"
    monkeypatch.setattr(
        teaching_report,
        "events_metadata",
        lambda: [
            {
                "name": "美国232钢铝关税",
                "source_status": "official_event_source_complete",
                "source_disclosure": disclosure,
                "source_urls": ["https://www.federalregister.gov/api/v1/documents/2018-05477.json"],
            },
            {
                "name": "中方对美反制关税",
                "source_status": "teaching_encoding_no_event_source",
                "source_disclosure": disclosure,
                "source_urls": [],
            },
        ],
    )
    session = _complete()
    session["steps"]["10"]["data"].update(
        {
            "viewed_events": ["美国232钢铝关税", "中方对美反制关税"],
            "selected_event_key": "美国232钢铝关税::2018-03-23",
        }
    )

    report = build(session, "同学")

    assert "美国232钢铝关税：官方事件/日期来源完整" in report.markdown
    assert "https://www.federalregister.gov/api/v1/documents/2018-05477.json" in report.markdown
    assert "中方对美反制关税：没有逐项事件 URL 的教学编码" in report.markdown
    sources = report.provenance["viewed_shock_event_sources"]
    assert [item["name"] for item in sources] == ["美国232钢铝关税", "中方对美反制关税"]


def test_did_cohort_weight_rows_count_each_available_post_cell():
    design = {"method": "did"}
    result = {
        "coefs": [{"name": "treated×post", "coef": 0.1}],
        "diagnostics": {
            "cohort_time_cells": [
                {"cohort": 2018, "term": "treated×post", "treated_entities": 10},
                {"cohort": 2018, "term": "treated×post", "treated_entities": 10},
                {"cohort": 2019, "term": "treated×post", "treated_entities": 5},
                {"cohort": 2019, "term": "other", "treated_entities": 500},
            ]
        },
    }

    assert teaching_report._did_cohort_weight_rows(design, result) == [
        {"cohort": 2018, "cell_count": 2, "treated_entity_periods": 20, "share": 0.8},
        {"cohort": 2019, "cell_count": 1, "treated_entity_periods": 5, "share": 0.2},
    ]


def test_report_binds_step1_cell_to_the_slice_it_was_captured_from(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["1"]["data"].update(
        {
            "slice": {"year": 2019, "table": "y", "row_country": "USA", "col_country": "CHN"},
            "observation": {
                "row": "CHN_D01T02",
                "column": "USA_D01T02",
                "value": 228.0672,
                "year": 2020,
                "table": "z",
                "row_country": "CHN",
                "col_country": "USA",
            },
        }
    )

    markdown = build(session, "同学").markdown

    assert "年份=2020" in markdown
    assert "表=z" in markdown
    assert "表=y" not in markdown.split("### 步骤 1")[1].split("###")[0]
    assert "年份=2019" not in markdown.split("### 步骤 1")[1].split("###")[0]


def test_report_observation_reading_states_supply_direction_per_table():
    z_obs = {"row": "CHN_D01T02", "column": "USA_C10T12", "value": 1.5, "table": "z"}
    y_obs = {"row": "CHN_D01T02", "column": "USA_HFCE", "value": 1.5, "table": "y"}
    accounts_obs = {"row": "CHN_D01T02", "column": "VA", "value": 1.5, "table": "accounts"}
    legacy_obs = {"row": "CHN_D01T02", "column": "USA_C10T12", "value": 1.5}
    assert teaching_report._observation_reading(z_obs) == "CHN_D01T02(行·供给方) → USA_C10T12(列·使用方) = 1.5"
    assert teaching_report._observation_reading(y_obs) == "CHN_D01T02(行·供给方) → USA_HFCE(列·最终需求) = 1.5"
    assert teaching_report._observation_reading(accounts_obs) == "CHN_D01T02 的 VA = 1.5"
    # 旧会话里没有 table 字段时按中间投入 Z 的读法兜底。
    assert teaching_report._observation_reading(legacy_obs) == "CHN_D01T02(行·供给方) → USA_C10T12(列·使用方) = 1.5"


def test_report_marks_suppressed_inference_and_reasons(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["11"]["data"]["qualified_run"] = session["steps"]["11"]["data"]["run"]
    session["steps"]["11"]["data"]["run"] = {
        "design": {"outcome": "trade", "depvar_label": "FVA 份额", "equation": "y = policy + FE"},
        "result": {
            "status": "insufficient",
            "status_reasons": ["处理聚类不足"],
            "support": {"status": "insufficient", "suppress_inference": True, "treated_clusters": 1},
            "n_obs": 20,
            "coefs": [{"name": "policy", "coef": -0.2, "se": 0.1, "p": None, "ci_low": None, "ci_high": None}],
        },
    }

    report = build(session, "同学")

    assert "统计推断已抑制" in report.markdown
    assert "处理聚类不足" in report.markdown
    assert "| 政策处理项 | -0.2 | 0.1 | 已抑制 | 已抑制 |" in report.markdown


def test_report_translates_settings_controls_and_rounds_display_values(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["11"]["data"]["run"] = {
        "design": {
            "outcome": "trade",
            "depvar_label": "FVA 份额",
            "equation": "FVA_share_ijt = treated×post + controls",
            "granularity": "country_industry",
            "shock_type": "tariff",
            "method": "did",
            "control_mode": "icio_derived",
            "price_mode": "nominal",
            "scenario": "clean",
            "controls": ["log_gdp_proxy"],
        },
        "result": {
            "status": "warning",
            "n_obs": 16348,
            "coefs": [
                {
                    "name": "treated×post",
                    "coef": 0.0013729825631389496,
                    "se": 0.001556326861714243,
                    "p": 0.38049053387270826,
                    "ci_low": -0.0017273795304135428,
                    "ci_high": 0.0044733446566914414,
                },
                {"name": "log_gdp_proxy", "coef": -0.028947058783405005, "se": 0.014101910976155195},
            ],
        },
    }
    _sign_run(session["steps"]["11"]["data"]["run"])

    markdown = build(session, "同学").markdown

    assert "关税冲击 · 分批处理 cohort-time ATT · 国家–行业级 · 同期 ICIO 派生量（公开回归禁用）" in markdown
    assert "+0.14 个百分点" in markdown
    assert "[-0.17, +0.45] 个百分点" in markdown
    assert "证据不足，无法判断方向" in markdown
    assert "处理后相对变化（处理组 × 处理后）" in markdown
    assert "总增加值规模(log, ICIO GVA proxy)" in markdown
    assert "0.0013729825631389496" not in markdown
    assert "country_industry" not in markdown
    assert "icio_derived" not in markdown


def test_report_summary_prioritizes_failed_pretrend_and_names_scenario(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["11"]["data"]["run"] = {
        "design": {
            "outcome": "trade",
            "depvar_label": "FVA 份额",
            "granularity": "country_industry",
            "shock_type": "tariff",
            "method": "event_study",
            "control_mode": "none",
            "scenario": "confounded",
            "controls": [],
            "equation": "y = event time + FE",
        },
        "result": {
            "status": "warning",
            "status_reasons": ["没有完全未处理的对照聚类"],
            "support": {
                "status": "warning",
                "suppress_inference": False,
                "treated_clusters": 76,
                "untreated_clusters": 0,
                "untreated_entities": 3075,
                "reasons": ["没有完全未处理的对照聚类"],
            },
            "n_obs": 16348,
            "coefs": [
                {"name": "k=-2", "coef": 0.0, "se": 0.01, "p": 1.0, "ci_low": -0.02, "ci_high": 0.02},
                {
                    "name": "k=0",
                    "coef": 0.02,
                    "se": 0.004,
                    "p": 0.001,
                    "ci_low": 0.012,
                    "ci_high": 0.028,
                },
            ],
            "event_support": _event_support(include_supported_lead=True),
            "diagnostics": {
                "pretrend": {
                    "scope": "main",
                    "available": True,
                    "reason": None,
                    "terms": ["k=-2"],
                    "excluded_terms": [],
                    "statistic": 8.0,
                    "df_num": 1,
                    "df_denom": 50,
                    "p": 0.00001,
                    "interpretation": "检测到明显的冲击前差异，因果解释需谨慎。",
                }
            },
        },
    }
    _sign_run(session["steps"]["11"]["data"]["run"])

    markdown = build(session, "同学").markdown

    assert "前趋势混杂教学面板" in markdown
    assert "冲击前趋势存在明显差异" in markdown
    assert "只能描述该数值，不能把它解释为冲击后的方向性变化证据" in markdown
    assert "最重要的设计限制：** 冲击前趋势联合检验 p=<0.0001" in markdown
    assert "发现正向变化证据" not in markdown


def test_reg01_report_keeps_supported_k0_with_thin_remote_lead_and_labels_local_suppression(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["11"]["data"]["run"] = {
        "design": {
            "outcome": "trade",
            "depvar_label": "FVA 份额",
            "method": "event_study",
            "shock_type": "tariff",
            "controls": [],
            "equation": "y = event time + FE",
        },
        "result": {
            "status": "ok",
            "support": {"status": "ok", "suppress_inference": False},
            "n_obs": 100,
            "coefs": [
                {"name": "k=-4", "coef": -0.03, "se": 0.02, "p": None, "ci_low": None, "ci_high": None},
                {"name": "k=0", "coef": -0.02, "se": 0.005, "p": 0.01, "ci_low": -0.03, "ci_high": -0.01},
            ],
            "event_support": _event_support(include_thin_lead=True),
            "diagnostics": {
                "pretrend": {
                    "scope": "main",
                    "available": False,
                    "reason": "no_supported_pre_terms",
                    "terms": [],
                    "excluded_terms": [{"term": "k=-4", "reasons": ["支持不足"]}],
                    "statistic": None,
                    "df_num": 0,
                    "df_denom": 5,
                    "p": None,
                    "interpretation": "所有可估计的冲击前系数都因逐期处理聚类支持不足而被排除；冲击前趋势不可评估。",
                }
            },
        },
    }
    _sign_run(session["steps"]["11"]["data"]["run"])

    assert check_gate(session) == []
    markdown = build(session, "同学").markdown
    assert "发现负向变化证据" in markdown
    assert "逐期支持不足/未知，已抑制" in markdown
    assert "所有可估计的冲击前系数都因逐期处理聚类支持不足而被排除" in markdown


def test_reg01_report_gate_and_rendering_fail_closed_for_thin_or_legacy_primary_period(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    event_run = {
        "design": {
            "outcome": "trade",
            "depvar_label": "FVA 份额",
            "method": "event_study",
            "shock_type": "tariff",
            "controls": [],
            "equation": "y = event time + FE",
        },
        "result": {
            "status": "ok",
            "support": {"status": "ok", "suppress_inference": False},
            "n_obs": 100,
            "coefs": [{"name": "k=0", "coef": 0.02, "se": 0.004, "p": 0.001, "ci_low": 0.012, "ci_high": 0.028}],
            "event_support": _event_support(k0_supported=False),
            "diagnostics": {"pretrend": {"available": True, "statistic": 9, "p": 0.001, "interpretation": "旧诊断"}},
        },
    }
    _sign_run(event_run)
    session["steps"]["11"]["data"]["run"] = event_run
    assert any(item["step"] == 11 for item in check_gate(session))

    # A prior non-event qualified snapshot lets the report render the later legacy exploration,
    # whose old CI/pretrend values must still fail closed.
    session["steps"]["11"]["data"]["qualified_run"] = _ok_run("trade")
    del event_run["result"]["event_support"]
    markdown = build(session, "同学").markdown
    assert "逐事件期处理支持度未知" in markdown
    assert "| 相对处理时期 k=0 | 0.02 |" in markdown
    assert "[0.012, 0.028]" not in markdown
    assert "发现正向变化证据" not in markdown
    assert "F=9" not in markdown

    partial_contract = _event_support()
    partial_contract["periods"] = [period for period in partial_contract["periods"] if period["is_reference"]]
    for malformed in ({}, {"periods": "forged"}, partial_contract):
        event_run["result"]["event_support"] = malformed
        malformed_markdown = build(session, "同学").markdown
        assert "逐事件期处理支持度未知" in malformed_markdown
        assert "[0.012, 0.028]" not in malformed_markdown
        assert "F=9" not in malformed_markdown

    event_run["result"]["event_support"] = _event_support()
    event_run["result"]["diagnostics"] = {}
    assert teaching_report._result_is_qualified(event_run["result"], event_run["design"]) is False
    stripped_markdown = build(session, "同学").markdown
    assert "冲击前诊断未知/已抑制" in stripped_markdown
    assert "方向性推断已关闭" in stripped_markdown
    assert "[0.012, 0.028]" not in stripped_markdown
    assert "发现正向变化证据" not in stripped_markdown


def test_reg01_report_rejects_semantically_forged_support_and_unsupported_pretrend(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    event_run = {
        "design": {
            "outcome": "trade",
            "depvar_label": "FVA 份额",
            "method": "event_study",
            "shock_type": "tariff",
            "controls": [],
            "equation": "y = event time + FE",
        },
        "result": {
            "status": "ok",
            "support": {"status": "ok", "suppress_inference": False},
            "n_obs": 100,
            "coefs": [{"name": "k=0", "coef": 0.02, "se": 0.004, "p": 0.001, "ci_low": 0.012, "ci_high": 0.028}],
            "event_support": _event_support(),
            "diagnostics": {},
        },
    }
    _sign_run(event_run)
    session["steps"]["11"]["data"]["run"] = event_run
    session["steps"]["11"]["data"]["qualified_run"] = _ok_run("trade")

    malformed_contracts = []
    missing_base = _event_support()
    del missing_base["base_k"]
    malformed_contracts.append(missing_base)
    mismatched_base = _event_support()
    mismatched_base["base_k"] = -2
    malformed_contracts.append(mismatched_base)
    wrong_threshold = _event_support()
    wrong_threshold["min_contributing_clusters"] = 4
    malformed_contracts.append(wrong_threshold)
    noninteger_threshold = _event_support()
    noninteger_threshold["min_contributing_clusters"] = 5.0
    malformed_contracts.append(noninteger_threshold)

    forged_thin = _event_support(k0_supported=False)
    k0 = next(period for period in forged_thin["periods"] if period["term"] == "k=0")
    k0["inference_supported"] = True
    k0["suppress_inference"] = False
    malformed_contracts.append(forged_thin)

    bad_reference = _event_support()
    reference = next(period for period in bad_reference["periods"] if period["is_reference"])
    reference["period_supported"] = False
    malformed_contracts.append(bad_reference)

    duplicate_reference = _event_support()
    duplicate_reference["periods"][1] = dict(duplicate_reference["periods"][0])
    malformed_contracts.append(duplicate_reference)

    impossible_cardinality = _event_support()
    impossible_k0 = next(period for period in impossible_cardinality["periods"] if period["term"] == "k=0")
    impossible_k0.update(
        {
            "contributing_rows": 0,
            "contributing_entities": 0,
            "contributing_clusters": 5,
            "cohorts": {},
            "period_supported": True,
            "inference_supported": True,
            "suppress_inference": False,
        }
    )
    malformed_contracts.append(impossible_cardinality)

    bad_cohort_total = _event_support()
    next(period for period in bad_cohort_total["periods"] if period["term"] == "k=0")["cohorts"] = {"2018": 5}
    malformed_contracts.append(bad_cohort_total)

    noncanonical_term = _event_support()
    next(period for period in noncanonical_term["periods"] if period["term"] == "k=0")["term"] = "k=00"
    malformed_contracts.append(noncanonical_term)

    for malformed in malformed_contracts:
        event_run["result"]["event_support"] = malformed
        _sign_run(event_run)
        markdown = build(session, "同学").markdown
        assert "逐事件期处理支持度未知" in markdown
        assert "[0.012, 0.028]" not in markdown
        assert "发现正向变化证据" not in markdown

    event_run["result"]["event_support"] = _event_support(include_thin_lead=True)
    event_run["result"]["diagnostics"] = {
        "pretrend": {
            "available": True,
            "reason": None,
            "terms": ["k=-4"],
            "statistic": 9.0,
            "df_num": 1,
            "df_denom": 20,
            "p": 0.001,
            "interpretation": "不安全的旧 pretrend 解释",
        }
    }
    _sign_run(event_run)
    markdown = build(session, "同学").markdown
    assert "支持不足期被错误纳入" in markdown
    assert "不安全的旧 pretrend 解释" not in markdown
    assert "F=9" not in markdown

    event_run["result"]["event_support"] = _event_support(include_supported_lead=True)
    event_run["result"]["coefs"].insert(
        0, {"name": "k=-2", "coef": 0.0, "se": 0.01, "p": 1.0, "ci_low": -0.02, "ci_high": 0.02}
    )
    valid_pretrend = {
        "scope": "main",
        "available": True,
        "reason": None,
        "terms": ["k=-2"],
        "excluded_terms": [],
        "statistic": 1.5,
        "df_num": 1,
        "df_denom": 20,
        "p": 0.25,
        "interpretation": "有效支持期诊断",
    }
    event_run["result"]["diagnostics"] = {"pretrend": valid_pretrend}
    _sign_run(event_run)
    assert "有效支持期诊断" in build(session, "同学").markdown

    unavailable_df = {
        **valid_pretrend,
        "available": False,
        "reason": "insufficient_cluster_df",
        "statistic": None,
        "p": None,
        "df_denom": 0,
        "interpretation": "限制数超过聚类自由度。",
    }
    assert teaching_report._event_pretrend_is_safe(event_run["result"], unavailable_df)
    assert not teaching_report._event_pretrend_is_safe(event_run["result"], {**unavailable_df, "df_denom": 1})
    assert teaching_report._event_pretrend_is_safe(
        event_run["result"], {**unavailable_df, "reason": "singular_covariance", "df_denom": 1}
    )

    malformed_pretrends = [
        {**valid_pretrend, "terms": ["k=-2", "k=-2"], "df_num": 2},
        {**valid_pretrend, "df_num": 2},
        {**valid_pretrend, "statistic": -0.1},
        {**valid_pretrend, "p": 1.1},
        {**valid_pretrend, "df_denom": 0},
    ]
    for malformed_pretrend in malformed_pretrends:
        event_run["result"]["diagnostics"] = {"pretrend": malformed_pretrend}
        _sign_run(event_run)
        malformed_markdown = build(session, "同学").markdown
        assert "诊断契约已损坏" in malformed_markdown
        assert "有效支持期诊断" not in malformed_markdown

    malformed_unavailable_pretrends = [
        {
            **valid_pretrend,
            "available": False,
            "reason": "no_supported_pre_terms",
            "terms": [],
            "statistic": None,
            "df_num": 99,
            "p": None,
            "interpretation": "错误自由度的不可用诊断",
        },
        {
            **valid_pretrend,
            "available": False,
            "reason": "no_pre_terms",
            "statistic": None,
            "p": None,
            "interpretation": "错误 reason/terms 组合",
        },
    ]
    for malformed_pretrend in malformed_unavailable_pretrends:
        event_run["result"]["diagnostics"] = {"pretrend": malformed_pretrend}
        _sign_run(event_run)
        malformed_markdown = build(session, "同学").markdown
        assert "诊断契约已损坏" in malformed_markdown
        assert malformed_pretrend["interpretation"] not in malformed_markdown

    # A contradictory global-suppression reason is damaged/unknown, never factual gate copy.
    forged_global_pretrend = {
        **valid_pretrend,
        "available": False,
        "reason": "global_inference_suppressed",
        "support_status": "ok",
        "terms": [],
        "excluded_terms": [{"term": "k=-2", "reasons": ["声称整体抑制"]}],
        "statistic": None,
        "df_num": 0,
        "p": None,
        "interpretation": "错误整体门禁状态声称显著冲击前差异，p=0.001",
    }
    assert not teaching_report._event_pretrend_is_safe(event_run["result"], forged_global_pretrend)
    event_run["result"]["diagnostics"] = {"pretrend": forged_global_pretrend}
    _sign_run(event_run)
    forged_global_markdown = build(session, "同学").markdown
    assert teaching_report._result_is_qualified(event_run["result"], event_run["design"]) is False
    assert "诊断已损坏或状态未知" in forged_global_markdown
    assert "整体设计门禁已抑制统计推断，因此未执行冲击前联合检验" not in forged_global_markdown
    assert forged_global_pretrend["interpretation"] not in forged_global_markdown
    assert "p=0.001" not in forged_global_markdown


def test_report_rendering_hides_stale_inference_when_whole_run_is_suppressed(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["11"]["data"]["qualified_run"] = _ok_run("trade")
    session["steps"]["11"]["data"]["run"] = {
        "design": {
            "outcome": "trade",
            "depvar_label": "FVA 份额",
            "method": "event_study",
            "shock_type": "tariff",
            "controls": [],
            "interaction": True,
            "equation": "y = event time + FE",
        },
        "result": {
            "status": "invalid_design",
            "support": {"status": "invalid_design", "suppress_inference": True},
            "n_obs": 100,
            "coefs": [{"name": "k=0", "coef": 0.02, "se": 0.004, "p": 0.0123, "ci_low": 0.1234, "ci_high": 0.2345}],
            "marginal_effects": [
                {
                    "policy_term": "k=0",
                    "label": "均值",
                    "effect": 0.02,
                    "p": 0.0123,
                    "ci_low": 0.1234,
                    "ci_high": 0.2345,
                }
            ],
            "event_support": _event_support(include_supported_lead=True),
            "diagnostics": {
                "pretrend": {
                    "available": True,
                    "reason": None,
                    "terms": ["k=-2"],
                    "statistic": 9.0,
                    "df_num": 1,
                    "df_denom": 20,
                    "p": 0.0007,
                    "interpretation": "整体门禁下不应显示的 pretrend 解释",
                }
            },
        },
    }
    _sign_run(session["steps"]["11"]["data"]["run"])

    markdown = build(session, "同学").markdown
    assert "统计推断已抑制" in markdown
    assert "[0.1234, 0.2345]" not in markdown
    assert "[+12.34, +23.45]" not in markdown
    assert "0.0123" not in markdown
    assert "F=9" not in markdown
    assert "0.0007" not in markdown
    assert "整体门禁下不应显示的 pretrend 解释" not in markdown

    result = session["steps"]["11"]["data"]["run"]["result"]
    result["diagnostics"]["pretrend"] = {
        "available": False,
        "reason": "global_inference_suppressed",
        "support_status": "invalid_design",
        "support_reasons": ["处理路径不相容"],
        "terms": [],
        "excluded_terms": [{"term": "k=-2", "reasons": ["整体设计门禁"]}],
        "statistic": None,
        "df_num": 0,
        "df_denom": 20,
        "p": None,
        "interpretation": "检测到显著冲击前差异，F=9，p=0.001。",
    }
    _sign_run(session["steps"]["11"]["data"]["run"])
    generated_markdown = build(session, "同学").markdown
    trusted_copy = "整体设计门禁已抑制统计推断，因此未执行冲击前联合检验；不能据此判断冲击前趋势。"
    assert trusted_copy in generated_markdown
    assert "检测到显著冲击前差异" not in generated_markdown
    assert "F=9" not in generated_markdown
    assert "p=0.001" not in generated_markdown

    # A forged global reason on an actually-ok result is never accepted by a safe qualification validator.
    result["status"] = "ok"
    result["support"] = {"status": "ok", "suppress_inference": False}
    _sign_run(session["steps"]["11"]["data"]["run"])
    reason_only_markdown = build(session, "同学").markdown
    assert teaching_report._result_is_qualified(result, session["steps"]["11"]["data"]["run"]["design"]) is False
    assert "诊断已损坏或状态未知" in reason_only_markdown
    assert trusted_copy not in reason_only_markdown
    assert "检测到显著冲击前差异" not in reason_only_markdown

    # Each persisted whole-run source independently fails closed, even when the others say ok.
    variants = [
        ("invalid_design", "ok", False),
        ("ok", "invalid_design", False),
        ("ok", "ok", True),
    ]
    for result_status, support_status, suppress_flag in variants:
        result["status"] = result_status
        result["support"] = {"status": support_status, "suppress_inference": suppress_flag}
        variant_markdown = build(session, "同学").markdown
        assert "统计推断已抑制" in variant_markdown
        assert "[0.1234, 0.2345]" not in variant_markdown
        assert "0.0123" not in variant_markdown


@pytest.mark.parametrize("status", ["insufficient", "invalid_design"])
def test_complete_stopped_diagnosis_satisfies_report_gate_without_hiding_it(tmp_path, monkeypatch, status):
    from copy import deepcopy

    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    data = session["steps"]["11"]["data"]
    data["qualified_run"] = deepcopy(data["run"])
    result = data["run"]["result"]
    result["status"] = status
    result["status_reasons"] = ["实际配对支持不足或处理路径不相容"]
    result["support"] = {"status": status, "suppress_inference": True, "reasons": result["status_reasons"]}
    result["diagnostics"] = {"study_contract": "economics-v2"}
    for coefficient in result["coefs"]:
        coefficient.update(p=None, ci_low=None, ci_high=None, stars="")
    assert check_gate(session) == []
    report = build(session, "诊断学习者")
    row = next(line for line in report.markdown.splitlines() if line.startswith("| 11 |"))
    assert "无法" in row or "不可" in row
    assert "实际配对支持不足或处理路径不相容" in report.markdown
    # A forged inferential field cannot turn a stopped result into acceptable evidence.
    data.pop("qualified_run")
    result["coefs"][0]["p"] = 0.001
    assert any(item["step"] == 11 for item in check_gate(session))
