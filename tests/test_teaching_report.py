import copy
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from gvcsim import (
    artifacts,
    config,
    quizzes,
    report_observed,
    report_saved_run,
    shocks as shock_module,
    teaching_report,
)
from gvcsim.data import output_quality, quality, raw_icio, regression_quality
from gvcsim.data.citations import artifact_data_sources
from gvcsim.data.raw_icio import DimensionContract, raw_dimensions_metadata
from gvcsim.regression import teaching
from gvcsim.regression.teaching import VERSION as TEACHING_VERSION
from gvcsim.regression.teaching import X_COLUMN, model_snapshot, variable_catalog
from gvcsim.report_common import _number

from gvcsim.session import empty_session, make_record
from gvcsim.teaching_report import (
    REFLECTION_TEXT_LIMIT,
    GATE_STEPS,
    ReportGateError,
    build,
    check_gate,
    check_material_gate,
)


@pytest.mark.parametrize(
    ("outcome", "coef", "low", "high", "effect", "interval"),
    [
        ("length", 0.0305694, -0.04700555, 0.10814435, "+0.00031 个长度单位", "[-0.00047, +0.001] 个长度单位"),
        ("trade", 0.37101, -0.00428547, 0.746307, "+0.37 个百分点", "[-0.0043, +0.75] 个百分点"),
        ("production", 0, -0.01, 0.01, "+0.00 个百分点", "[-0.01, +0.01] 个百分点"),
    ],
)
def test_report_small_effects_match_card_precision(outcome, coef, low, high, effect, interval):
    _, rendered_effect, rendered_interval = teaching_report._natural_effect(
        outcome,
        {"method": "twfe_intensity"},
        {"status": "ok"},
        {"name": "tariff_shock", "coef": coef, "ci_low": low, "ci_high": high},
    )
    assert rendered_effect == effect
    assert rendered_interval == interval


def test_report_tiny_nonzero_numbers_and_standardized_effect_preserve_sign():
    assert float(teaching_report._signed(1e-30, 3)) > 0
    assert float(teaching_report._signed(-1e-30, 3)) < 0
    _, effect, _ = teaching_report._natural_effect(
        "network",
        {"method": "twfe_intensity"},
        {"status": "ok", "depvar_std": 2000},
        {"name": "tariff_shock", "coef": -690.746, "ci_low": -15099, "ci_high": 13718},
    )
    assert "约 -0.0035 个样本标准差" in effect


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (2.7231068455073544e-24, "<0.0001"),
        (0, "<0.0001"),
        (0.00009999, "<0.0001"),
        (0.0001, "0.0001"),
        (0.0256, "0.0256"),
        (1, "1"),
        (None, "—"),
    ],
)
def test_report_p_value_precision_matches_table_and_tooltip(value, expected):
    assert _number(value, p_value=True) == expected
    # Formatting a p value must not alter ordinary numeric zeroes in the report.
    assert _number(0) == "0"


REPORT_RAW_CONTRACT = DimensionContract(
    "teaching-report-release-fixture", 1, ("AAA", "BBB", "USA", "ROW"), ("s1",), ("HFCE",)
)
REPORT_YEARS = list(range(2016, 2021))


@pytest.fixture(autouse=True)
def _isolated_report_release_raw_source(tmp_path, monkeypatch):
    # Report tests build a separate compact raw contract; do not misclassify
    # that unmarked temporary directory as the workflow's CI synthetic source.
    monkeypatch.delenv("GVCSIM_CI_SYNTHETIC", raising=False)
    raw_dir = tmp_path.parent / f"{tmp_path.name}-raw"
    raw_dir.mkdir()
    payload = "\n".join(
        [
            "V1,AAA_s1,BBB_s1,USA_s1,ROW_s1,AAA_HFCE,BBB_HFCE,USA_HFCE,ROW_HFCE,OUT",
            "AAA_s1,1,2,0,0,2,0,0,0,5",
            "BBB_s1,3,1,0,0,0,2,0,0,6",
            "USA_s1,0,1,1,0,0,0,2,0,4",
            "ROW_s1,1,0,0,1,0,0,0,2,4",
            "TLS,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1",
            "VA,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1",
            "OUT,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1",
        ]
    )
    for year in REPORT_YEARS:
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
            ("USA", 2.0, 2.0),
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
                        {"AAA": 0.0, "BBB": 2.0, "USA": 0.0, "ROW": 0.0, "EU": 0.0},
                    ),
                    (
                        "BBB",
                        3.0,
                        {"AAA": 3.0, "BBB": 0.0, "USA": 0.0, "ROW": 0.0, "EU": 0.0},
                    ),
                    (
                        "USA",
                        1.0,
                        {"AAA": 0.0, "BBB": 1.0, "USA": 0.0, "ROW": 0.0, "EU": 0.0},
                    ),
                    (
                        "ROW",
                        1.0,
                        {"AAA": 1.0, "BBB": 0.0, "USA": 0.0, "ROW": 0.0, "EU": 0.0},
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
        ["AAA", "BBB", "USA", "ROW"],
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
    teaching.build_teaching_panel(industry_panel, exposure).to_csv(path / "panel_teaching.csv", index=False)
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
    annual_by_year = {year: _checks(quality.QC_SCOPE_ICIO) for year in REPORT_YEARS}
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
    output_years = _write_output_artifacts(path, REPORT_YEARS)
    regression_input_summary = regression_quality.write_regression_input_qc(path, expected_years=REPORT_YEARS)[1]
    source_panel = pd.read_csv(path / "panel_industry.csv")
    teaching_panel = pd.read_csv(path / "panel_teaching.csv")
    baseline = source_panel.loc[source_panel.year.eq(REPORT_YEARS[0]) & source_panel.country.ne("ROW")]

    def digest(filename: str) -> str:
        import hashlib

        return hashlib.sha256((path / filename).read_bytes()).hexdigest()

    metadata = {
        "release_id": "2" * 32,
        "years": REPORT_YEARS,
        "generated_at": "2026-08-13T00:00:00+00:00",
        "course_release": config.COURSE_RELEASE,
        "network_algorithm": "gephi-compatible-directed-unweighted-positive-v1",
        "data_sources": artifact_data_sources(config.RAW_DATA_DIR),
        "raw_dimensions": raw_dimensions_metadata(REPORT_YEARS, config.RAW_DATA_DIR),
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
        "simulation_contract": {
            "version": teaching.VERSION,
            "seed": teaching.SEED,
            "parameters": {
                "market": teaching.MARKET,
                "tariff_path": list(teaching.TARIFF_PATH),
                "betas": teaching.BETAS,
                "calibration": teaching.CALIBRATION,
                "baselines": teaching.baseline_parameters(),
            },
            "model_snapshots": {name: teaching.model_snapshot(name) for name in teaching.BETAS},
            "variable_catalogs": {name: teaching.variable_catalog(name) for name in teaching.BETAS},
            "baseline_model_snapshots": teaching.baseline_snapshots(teaching.model_snapshot),
            "baseline_variable_catalogs": teaching.baseline_snapshots(teaching.variable_catalog),
            "source_bindings": {
                "release_panel": {"path": "panel_industry.csv", "sha256": digest("panel_industry.csv")},
                "exposure_files": [
                    {"path": f"export_exposure_{year}.csv", "sha256": digest(f"export_exposure_{year}.csv")}
                    for year in REPORT_YEARS
                ],
                "exposure_selection": "first release year; imposer=USA",
            },
            "source_filter_disclosure": {
                "source_baseline_rows": len(baseline),
                "published_entities": teaching_panel.entity_id.nunique(),
                "excluded_source_baseline_rows": len(baseline) - teaching_panel.entity_id.nunique(),
            },
            "disclaimer": teaching.DISCLAIMER,
        },
        "publication_policy": artifacts.publication_policy_metadata(),
    }
    metadata["integrity"] = artifacts.release_integrity_metadata(path, metadata["years"])
    artifacts.write_dataset_metadata(path, metadata)
    artifacts.clear_artifact_caches()


def _sign_run(run: dict) -> dict:
    """Migrate report fixtures to the current fixed teaching-model envelope.

    Individual tests may still vary result statuses and extra coefficients to exercise
    report rendering, but every persisted run must be a genuine current-course snapshot.
    """
    from scipy import stats
    from gvcsim.regression.design import RegressionDesign
    from gvcsim.regression_routes import _design_info

    outcome = run["design"]["outcome"]
    baseline = run["design"].get("baseline")
    run["design"] = _design_info(RegressionDesign(outcome, teaching=True, baseline=baseline))
    run["model_snapshot"] = model_snapshot(outcome, baseline)
    run["variable_catalog"] = variable_catalog(outcome, baseline)
    coefs = run.get("result", {}).get("coefs")
    if (
        isinstance(coefs, list)
        and coefs
        and not any(isinstance(item, dict) and item.get("name") == X_COLUMN for item in coefs)
    ):
        # Preserve each test's numerical/report payload while giving it the actual
        # fixed model's sole estimand name instead of an obsolete DID term.
        coefs[0]["name"] = X_COLUMN
    if isinstance(coefs, list):
        run["result"]["coefs"] = [item for item in coefs if isinstance(item, dict) and item.get("name") == X_COLUMN]
        for coefficient in run["result"]["coefs"]:
            coefficient.setdefault("se", 0.1)
            coefficient.setdefault("t", float(coefficient["coef"]) / float(coefficient["se"]))
    result = run["result"]
    result.setdefault("n_entities", 2)
    result.setdefault("n_times", result["n_obs"])
    result.setdefault("n_clusters", 2)
    status = result.setdefault("status", "ok")
    stopped = status in {"insufficient", "invalid_design"}
    reasons = result.setdefault("status_reasons", ["测试诊断"] if stopped else [])
    support = result.setdefault(
        "support",
        {"status": status, "suppress_inference": stopped, "reasons": list(reasons)},
    )
    support.setdefault("status", status)
    support.setdefault("suppress_inference", stopped)
    support.setdefault("reasons", list(reasons))
    diagnostics = result.setdefault("diagnostics", {})
    diagnostics.setdefault("study_contract", "economics-v2")
    for coefficient in result.get("coefs", []):
        if stopped:
            coefficient.update(p=None, ci_low=None, ci_high=None)
        else:
            beta, se = coefficient["coef"], coefficient["se"]
            critical = stats.t.ppf(0.975, result["n_clusters"] - 1)
            coefficient.update(
                t=beta / se,
                p=float(2 * stats.t.sf(abs(beta / se), result["n_clusters"] - 1)),
                ci_low=float(beta - critical * se),
                ci_high=float(beta + critical * se),
            )
    return run


def _ok_run(outcome: str, **design):
    payload = {
        "outcome": outcome,
        "equation": "y = policy + FE",
        "shock_type": "tariff",
        "method": "twfe_intensity",
        "depvar_label": {
            "trade": "出口中外国增加值份额",
            "production": "复杂GVC生产份额",
            "length": "前向 GVC 生产长度",
            "network": "生产网络介数中心性",
        }.get(outcome, outcome),
    }
    payload.update(design)
    result = {"status": "ok", "n_obs": 4, "coefs": [{"name": X_COLUMN, "coef": 0.0}]}
    return _sign_run({"design": payload, "result": result})


def _complete():
    session = empty_session()
    session["steps"] = {str(step): make_record({"quiz": quizzes.correct_quiz(step)}) for step in GATE_STEPS}
    session["steps"]["1"]["data"]["observation"] = {
        "row": "CHN_D01T02",
        "column": "USA_D01T02",
        "value": 1.0,
        "year": 2020,
        "table": "intermediate",
    }
    for step in range(2, 10):
        session["steps"][str(step)]["data"]["compared"] = ["CHN", "USA"]
    for step, metric, unit in (
        (2, "FVA_share", "%"),
        (3, "3b_VA_GVC_C_share", "%"),
        (4, "GVCPs", "长度"),
        (5, "weighted degree", "加权流量"),
    ):
        session["steps"][str(step)]["data"].update(
            {
                "metric": metric,
                "observations": [
                    {
                        "entity": country,
                        "country": country,
                        "industry": "",
                        "year": 2020,
                        "value": value,
                        "metric": metric,
                        "unit": unit,
                        "release": "ICIO-2023",
                        "scope": "country",
                        "source": "explicit-indicator-table-comparison",
                    }
                    for country, value in (("CHN", 0.2), ("USA", 0.1))
                ],
            }
        )
    for step, metric in ((6, "FVA_share"), (7, "3b_VA_GVC_C_share"), (8, "GVCPs")):
        session["steps"][str(step)]["data"]["observations"] = [
            {
                "entity": country,
                "country": country,
                "year": 2020,
                "value": value,
                "metric": metric,
                "unit": "比例",
                "release": "ICIO-2023",
                "scope": "country",
                "source": "explicit-indicator-comparison",
            }
            for country, value in (("CHN", 0.2), ("USA", 0.1))
        ]
    # Step 9 requires an explicitly saved two-country chart comparison.
    session["steps"]["9"]["data"]["observations"] = [
        {
            "entity": f"{country}·C26",
            "country": country,
            "industry": "C26",
            "year": 2020,
            "value": 12.5,
            "metric": "betweenesscentrality",
            "unit": "未归一化介数",
            "release": "ICIO-2023",
            "scope": "country-industry",
            "source": "explicit-network-ranking",
        }
        for country in ("CHN", "USA")
    ]
    session["steps"]["10"]["data"].update(
        {
            "teaching_country": "CHN",
            "teaching_year": 2019,
            "viewed_teaching_panel": True,
            "teaching_panel_version": TEACHING_VERSION,
            "teaching_observation": {
                "country": "CHN",
                "industry": "s1",
                "year": 2019,
                "teaching_export_share_w": 0.2,
                "teaching_tariff_rate_tau": 0.1,
                "teaching_tariff_exposure": 0.02,
                "version": TEACHING_VERSION,
            },
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
    assert copy["negative"].startswith("模拟 Y 的数值下降")
    assert copy["positive"].startswith("模拟 Y 的数值上升")
    assert "若真实同定义指标" in copy["negative"]
    assert "不能单凭该比例判断生产规模" in copy["negative"]
    assert re.search(r"与.*(?:扩张|收缩)一致", " ".join(copy.values())) is None


def test_gate_requires_quizzes_key_operations_run_and_reflection(monkeypatch):
    blocked = check_gate(empty_session())
    assert set(GATE_STEPS) <= {item["step"] for item in blocked}
    assert any(item["step"] == 1 and "自动记录一个单元格" in "".join(item["missing"]) for item in blocked)
    # Steps 2–5 record automatically from the country being viewed; no save button is named.
    assert all(
        any(item["step"] == step and "自动记录" in "".join(item["missing"]) for item in blocked) for step in range(2, 6)
    )
    assert not any("保存两国同年比较" in "".join(item["missing"]) for item in blocked)
    assert all(
        any(item["step"] == step and "读数完整的图表" in "".join(item["missing"]) for item in blocked)
        for step in range(6, 9)
    )
    # Step 9 requires a country comparison *and* an industry observation, so its
    # message names both actions instead of the steps 6-8 wording.
    assert any(item["step"] == 9 and "行业历年变化或行业排名" in "".join(item["missing"]) for item in blocked)
    assert any(item["step"] == 9 and "自动记录" in "".join(item["missing"]) for item in blocked)
    assert any(item["step"] == 6 and "对比国家" in "".join(item["missing"]) for item in blocked)
    assert any(item["step"] == 11 and "运行回归" in "".join(item["missing"]) for item in blocked)
    assert any(item["step"] == 14 and "运行回归" in "".join(item["missing"]) for item in blocked)
    assert any(item["step"] == 15 and "原创" in item["title"] for item in blocked)
    assert len(blocked) == len({item["step"] for item in blocked})
    by_step = {item["step"]: item for item in blocked}
    assert "理解检查" in "".join(by_step[1]["missing"])
    assert "自动记录一个单元格" in "".join(by_step[1]["missing"])
    assert "理解检查" in "".join(by_step[6]["missing"])
    assert "对比国家" in "".join(by_step[6]["missing"])
    assert "理解检查" in "".join(by_step[12]["missing"])
    assert "运行回归" in "".join(by_step[12]["missing"])
    assert "模拟关税面板" in "".join(by_step[10]["missing"])
    assert check_gate(_complete()) == []
    missing_one = _complete()
    del missing_one["steps"]["14"]["data"]["run"]
    blocked_one = check_gate(missing_one)
    assert any(item["step"] == 14 and "运行回归" in "".join(item["missing"]) for item in blocked_one)
    with pytest.raises(ReportGateError):
        build(empty_session(), "同学")


def _economy_readings(
    countries, *, metric="FVA_share", years=(2020,), industry="", source="explicit-indicator-comparison"
):
    return [
        {
            "entity": f"{country}·{industry}" if industry else country,
            "country": country,
            **({"industry": industry} if industry else {}),
            "year": year,
            "value": 0.1 * (index + 1) + (year - 2019) / 100,
            "metric": metric,
            "unit": "%",
            "release": "ICIO-2023",
            "scope": "country-industry" if industry else "country",
            "source": source,
        }
        for index, country in enumerate(countries)
        for year in years
    ]


@pytest.mark.parametrize("countries", [["CHN"], ["CHN", "USA", "DEU"], ["CHN", "USA", "DEU", "JPN", "KOR"]])
def test_steps_six_to_eight_accept_one_to_five_economies(countries):
    """Material is one reproducible chart: a single economy with the global reference, or up to five."""
    session = _complete()
    data = session["steps"]["6"]["data"]
    data["compared"] = countries
    data["observations"] = _economy_readings(countries)
    assert not any(item["step"] == 6 for item in check_material_gate(session))
    data["observations"] = _economy_readings(countries, years=(2019, 2020), source="explicit-indicator-trend")
    assert not any(item["step"] == 6 for item in check_material_gate(session))
    # Every economy must carry the same years: dropping one year for the last economy breaks the chart.
    data["observations"] = [
        item for item in data["observations"] if not (item["country"] == countries[-1] and item["year"] == 2019)
    ]
    assert any(item["step"] == 6 for item in check_material_gate(session))


@pytest.mark.parametrize(
    "countries",
    [[], ["CHN", "CHN"], ["CHN", "ROW"], ["CHN", "USA", "DEU", "JPN", "KOR", "FRA"]],
)
def test_steps_six_to_eight_reject_invalid_entity_lists(countries):
    session = _complete()
    data = session["steps"]["6"]["data"]
    data["compared"] = countries
    data["observations"] = _economy_readings(list(dict.fromkeys(countries)))
    assert any(item["step"] == 6 for item in check_material_gate(session))


def test_single_economy_material_needs_the_global_reference():
    """One economy alone is only a chart when the global reference exists, i.e. at country scope."""
    session = _complete()
    data = session["steps"]["6"]["data"]
    data["compared"] = ["CHN"]
    data["observations"] = _economy_readings(["CHN"], industry="C26")
    assert any(item["step"] == 6 for item in check_material_gate(session))
    data["compared"] = ["CHN", "USA"]
    data["observations"] = _economy_readings(["CHN", "USA"], industry="C26")
    assert not any(item["step"] == 6 for item in check_material_gate(session))


@pytest.mark.parametrize("countries", [["CHN"], ["CHN", "USA", "DEU"]])
def test_step_nine_accepts_one_to_five_economies(countries):
    session = _complete()
    data = session["steps"]["9"]["data"]
    data["compared"] = countries
    data["observations"] = [
        dict(item, country=country, entity=f"{country}·C26", value=float(index + 1))
        for index, country in enumerate(countries)
        for item in data["observations"][:1]
    ]
    assert not any(item["step"] == 9 for item in check_material_gate(session))
    text = "\n".join(teaching_report._experiment_sections(session))
    section = text.split("### 步骤 9", 1)[1]
    assert all(f"{country}·C26" in section for country in countries)


def test_report_draws_one_series_per_saved_economy():
    session = _complete()
    data = session["steps"]["6"]["data"]
    data["compared"] = ["CHN", "USA", "DEU"]
    data["observations"] = _economy_readings(
        ["CHN", "USA", "DEU"], years=(2019, 2020), source="explicit-indicator-trend"
    )
    from gvcsim import report_observed

    text = "\n".join(report_observed._observed_evidence_section(session))
    section = text.split("### 步骤 6", 1)[1].split("### 步骤 7", 1)[0]
    chart = json.loads(section.split("```gvcsim-chart\n", 1)[1].split("\n```", 1)[0])
    assert [series["label"] for series in chart["series"] if not series.get("reference")] == [
        "CHN 中国",
        "USA 美国",
        "DEU 德国",
    ]
    assert "两国" not in section
    assert "比较对象：CHN、USA、DEU" in "\n".join(teaching_report._experiment_sections(session))
    data["compared"] = ["CHN"]
    data["observations"] = _economy_readings(["CHN"], years=(2019, 2020), source="explicit-indicator-trend")
    text = "\n".join(teaching_report._experiment_sections(session))
    assert "所看国家：CHN" in text


def test_step_seven_accepts_the_backward_composition_set():
    """Step 7 reads the four production activities from the SVA side or the FGY side."""
    from gvcsim import report_observed

    session = _complete()
    data = session["steps"]["7"]["data"]
    parts = {"1_FGY_D": 40, "2_FGY_RT": 30, "3a_FGY_GVC_S": 20, "3b_FGY_GVC_C": 10, "FGY": 100}
    data["observations"] = [
        {
            "entity": country,
            "country": country,
            "year": 2020,
            "value": float(value) * (index + 1),
            "metric": metric,
            "unit": "百万美元",
            "release": "ICIO-2023",
            "scope": "country",
            "source": "explicit-indicator-composition",
        }
        for index, country in enumerate(("CHN", "USA"))
        for metric, value in parts.items()
    ]
    assert not any(item["step"] == 7 for item in check_material_gate(session))
    section = "\n".join(report_observed._observed_evidence_section(session)).split("### 步骤 7", 1)[1]
    assert "最终品生产构成" in section
    # Mixing the two sides is not a composition the page can draw.
    data["observations"][0]["metric"] = "1_VA_D"
    assert any(item["step"] == 7 for item in check_material_gate(session))


def test_steps_six_to_eight_require_explicit_complete_material():
    session = _complete()
    for source in (None, "automatic-representative"):
        session["steps"]["6"]["data"]["observations"][0]["source"] = source
        assert any(item["step"] == 6 for item in check_material_gate(session))


@pytest.mark.parametrize(
    "corrupt",
    [
        lambda observations: observations[1].update(year=2019),
        lambda observations: observations[1].pop("unit"),
        lambda observations: observations[1].update(value=float("nan")),
        lambda observations: observations[1].update(source="legacy-two-click"),
    ],
)
def test_steps_two_to_five_require_one_complete_same_year_pair(corrupt):
    session = _complete()
    observations = session["steps"]["2"]["data"]["observations"]
    corrupt(observations)

    assert any(item["step"] == 2 for item in check_material_gate(session))


def test_indicator_report_formats_percentages_without_changing_saved_values():
    session = _complete()
    data = session["steps"]["6"]["data"]
    data.update(year=1999, chart="unrelated-browse", drill="DEU", metric="wrong-level-metric")
    for item in data["observations"]:
        item.update(metric="FVA_share", unit="%", value=0.237)
    text = "\n".join(teaching_report._experiment_sections(session))
    section = text.split("### 步骤 6", 1)[1].split("### 步骤 7", 1)[0]
    assert "| 外国增加值项占比 | % | 23.7 |" in section
    assert "wrong-level-metric" not in section
    assert "unrelated-browse" not in section
    assert "1999" not in section
    assert data["observations"][0]["value"] == 0.237


def test_table_comparison_report_formats_saved_ratio_as_a_percentage():
    session = _complete()

    text = "\n".join(teaching_report._experiment_sections(session))
    section = text.split("### 步骤 2", 1)[1].split("### 步骤 3", 1)[0]

    assert "| CHN | 2020 | 外国增加值项占比 | % | 20 |" in section
    assert "| USA | 2020 | 外国增加值项占比 | % | 10 |" in section
    assert "| % | 0.2 |" not in section


def test_indicator_trend_requires_two_common_years_per_metric():
    session = _complete()
    data = session["steps"]["6"]["data"]
    data["observations"] = [
        dict(item, source="explicit-indicator-trend", year=year, value=float(year))
        for item in data["observations"]
        for year in (2019, 2020)
    ]
    assert not any(item["step"] == 6 for item in check_material_gate(session))
    data["observations"] = [
        item for item in data["observations"] if not (item["country"] == "USA" and item["year"] == 2019)
    ]
    assert any(item["step"] == 6 for item in check_material_gate(session))


def test_composition_requires_all_trade_components_and_reports_each_reading():
    session = _complete()
    data = session["steps"]["6"]["data"]
    base = data["observations"]
    components = {"DVAex": 50, "DVArt": 5, "DDC": 3, "FVA": 20, "FDC": 4, "taxsub": -2, "gross_exports": 80}
    data["observations"] = [
        dict(item, metric=metric, value=value, unit="百万美元", source="explicit-indicator-composition")
        for item in base
        for metric, value in components.items()
    ]
    assert not any(item["step"] == 6 for item in check_material_gate(session))
    text = "\n".join(teaching_report._experiment_sections(session))
    assert "| 出口中的税收减补贴 | 百万美元 | -2 |" in text
    chart = teaching_report._observed_chart(data, 6, data["observations"])
    # Global-median bars are added when country data is available; the saved countries' bars are fixed.
    # Median bars are flagged as references so the report draws them grey, not as a third country.
    assert any(item.get("reference") for item in chart["items"])
    assert all(bool(item.get("reference")) == item["group"].startswith("全球中位数") for item in chart["items"])
    chart = {**chart, "items": [item for item in chart["items"] if not item.get("reference")]}
    assert len(chart["items"]) == 12
    # Like the page, the single-year composition shows each part as a share of gross exports.
    assert {(item["group"], item["label"]) for item in chart["items"]} == {
        (label, teaching_report._STUDENT_METRIC_LABELS[metric])
        for label in ("CHN 中国", "USA 美国")
        for metric in components
        if metric != "gross_exports"
    }
    assert {item["value"] for item in chart["items"]} == {
        value / 80 * 100 for metric, value in components.items() if metric != "gross_exports"
    }
    assert chart["y_label"] == "占总出口的百分比（%）"
    assert "总出口构成（各项占比）" in chart["title"]
    # Omitting the same component for both countries is paired, but incomplete.
    data["observations"] = [item for item in data["observations"] if item["metric"] != "taxsub"]
    assert any(item["step"] == 6 for item in check_material_gate(session))


def test_composition_evolution_generates_each_component_as_a_two_country_trend():
    session = _complete()
    data = session["steps"]["6"]["data"]
    components = {"DVAex": 50, "DVArt": 5, "DDC": 3, "FVA": 20, "FDC": 4, "taxsub": -2, "gross_exports": 80}
    data["indicator_selection"] = {"view": "evolution", "metric": "FVA_share"}
    data["observations"] = [
        dict(
            item,
            metric=metric,
            value=value + year - 2019,
            year=year,
            unit="百万美元",
            source="explicit-indicator-trend",
        )
        for item in data["observations"]
        for year in (2019, 2020)
        for metric, value in components.items()
    ]

    charts = teaching_report._observed_charts(data, 6, data["observations"])

    # One chart per part (total excluded); lines are that part's share of gross exports, as on the page.
    assert len(charts) == 6
    countries = [[series for series in chart["series"] if not series.get("reference")] for chart in charts]
    assert all(chart["type"] == "line" for chart in charts)
    assert all(
        {series["label"] for series in chart_countries} == {"CHN 中国", "USA 美国"} for chart_countries in countries
    )
    assert all("构成演变" in chart["title"] and chart["y_label"] == "占总出口的百分比（%）" for chart in charts)
    fva = next(chart for chart in charts if "出口中的外国增加值占总出口比重" in chart["title"])
    assert fva["series"][0]["points"] == [
        {"label": "2019", "value": 20 / 80 * 100},
        {"label": "2020", "value": 21 / 81 * 100},
    ]


@pytest.mark.parametrize("step", [6, 9])
def test_report_ranking_extrema_use_all_saved_industries(step):
    session = _complete()
    data = session["steps"][str(step)]["data"]
    data["observations"] = [
        dict(
            item,
            industry=f"S{industry}",
            entity=f"{item['country']}·S{industry}",
            scope="country-industry",
            value=0 if industry == 8 else (0.99 if industry == 7 and item["country"] == "USA" else 0.2),
            unit="%",
        )
        for industry in range(9)
        for item in data["observations"]
    ]
    assert not any(item["step"] == step for item in check_material_gate(session))
    section = "\n".join(report_observed._observed_evidence_section(session)).split(f"### 步骤 {step}", 1)[1]
    section = section.split("### 步骤", 1)[0]
    assert "最高为 USA 美国 · S7（99%）" in section
    assert "最低为 CHN 中国 · S8、USA 美国 · S8（0%）" in section
    # All 18 readings fit; bars are coloured by country and grouped under one industry label.
    assert "条读数" not in section.split("```gvcsim-chart", 1)[0]
    chart = json.loads(section.split("```gvcsim-chart\n", 1)[1].split("\n```", 1)[0])
    assert len(chart["items"]) == 18
    assert {item["group"] for item in chart["items"]} == {"CHN 中国", "USA 美国"}
    # The 定位行业 view is a ranking ordered by country A, not a two-country comparison.
    assert "行业排名（按 CHN 中国 降序）" in chart["title"]


def test_report_directions_retains_both_length_metrics_and_their_readouts():
    session = _complete()
    data = session["steps"]["8"]["data"]
    data["indicator_selection"] = {"view": "directions", "metric": "PLv_GVC"}
    data["observations"] = [
        dict(
            item,
            metric=metric,
            value=value + (year - 2016) / 10,
            year=year,
            unit="生产阶段（账户比值）",
            source="explicit-indicator-trend",
        )
        for item in data["observations"]
        for year in range(2016, 2021)
        for metric, value in (("PLv_GVC", 4), ("PLy_GVC", 5))
    ]
    assert not any(item["step"] == 8 for item in check_material_gate(session))
    charts = teaching_report._observed_charts(data, 8, data["observations"])
    assert len(charts) == 2
    # Country series only; a global-median series is added when country data is available.
    assert (
        sum(len(series["points"]) for chart in charts for series in chart["series"] if not series.get("reference"))
        == 20
    )
    section = "\n".join(report_observed._observed_evidence_section(session)).split("### 步骤 8", 1)[1]
    section = section.split("### 步骤 9", 1)[0]
    assert "前向 GVC 段长度" in section and "后向 GVC 段长度" in section
    assert "前后向" in section and "构成演变" not in section
    assert section.count("自动读图") == 2
    assert "2016 年 5 变为 2020 年 5.4" in section


def test_material_gate_is_independent_of_unfinished_quizzes():
    session = _complete()
    for step in range(1, 15):
        del session["steps"][str(step)]["data"]["quiz"]

    assert check_material_gate(session) == []
    assert {item["step"] for item in check_gate(session)} == set(range(1, 15))


def test_steps_two_to_five_accept_automatic_comparisons():
    """Steps 2–5 record the two-country comparison automatically from the country being viewed."""
    from gvcsim.report_render import _experiment_sections

    session = _complete()
    for step in (2, 3, 4, 5):
        for item in session["steps"][str(step)]["data"]["observations"]:
            item["source"] = "auto-indicator-comparison"
    assert check_material_gate(session) == []

    # The report states honestly that the comparison was recorded by the system.
    snapshot = "\n".join(_experiment_sections(session))
    assert "系统自动记录的比较：CHN、USA" in snapshot

    # Material the student recorded on request after submitting is their choice, not an automatic record;
    # the same holds for the chart material of steps 6-8.
    for step in (3, 6):
        session["steps"][str(step)]["data"]["material_chosen"] = True
    sections = "\n".join(_experiment_sections(session)).split("### 步骤 ")
    step_three = next(part for part in sections if part.startswith("3 "))
    assert "学生选定的比较：CHN、USA" in step_three and "系统自动记录" not in step_three
    step_six = next(part for part in sections if part.startswith("6 "))
    assert "记录的图表材料（学生选定的完整图表" in step_six and "自动记录" not in step_six
    step_seven = next(part for part in sections if part.startswith("7 "))
    assert "系统按学生最后查看的完整图表自动记录" in step_seven

    missing = _complete()
    missing["steps"]["2"]["data"]["observations"] = []
    message = "".join(next(item["missing"] for item in check_material_gate(missing) if item["step"] == 2))
    assert "动手拆解" in message
    assert "保存两国同年比较" not in message

    # ROW is the rest-of-world remainder, not an economy: a comparison with it is not material.
    with_row = _complete()
    data = with_row["steps"]["5"]["data"]
    data["compared"] = ["ROW", data["compared"][1]]
    data["observations"][0].update(entity="ROW", country="ROW")
    assert [item["step"] for item in check_material_gate(with_row)] == [5]


def test_step_nine_requires_both_a_comparison_and_an_industry_observation():
    """Step 9 asks for a country comparison *and* an industry betweenness observation."""
    assert check_material_gate(_complete()) == []

    # A carried-over country comparison alone must no longer satisfy step 9.
    comparison_only = _complete()
    comparison_only["steps"]["9"]["data"]["observations"] = []
    blocked = [item for item in check_material_gate(comparison_only) if item["step"] == 9]
    assert len(blocked) == 1
    # The message must describe what the student actually does (no save button any more).
    assert "自动记录" in "".join(blocked[0]["missing"])
    assert any(item["step"] == 9 for item in check_gate(comparison_only))

    # The comparison is still required alongside the observation.
    observation_only = _complete()
    observation_only["steps"]["9"]["data"]["compared"] = []
    message = "".join(next(item["missing"] for item in check_material_gate(observation_only) if item["step"] == 9))
    assert "自动记录" in message
    assert "历年变化或行业排名" in message
    assert "网络图中的节点" not in message


@pytest.mark.parametrize("source", [None, "explicit-heat-row"])
def test_step_nine_rejects_old_material(source):
    session = _complete()
    for item in session["steps"]["9"]["data"]["observations"]:
        item["source"] = source
    assert any(item["step"] == 9 for item in check_material_gate(session))
    assert "### 步骤 9" not in "\n".join(teaching_report._experiment_sections(session))


def test_report_labels_step_nine_observation_without_a_step_level_metric(tmp_path, monkeypatch):
    """The observation carries its own metric; the report must name it, not print “—”."""
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["9"]["data"].pop("metric", None)

    report = build(session, "同学")

    assert "全正边二值介数（探索性拓扑基准）" in report.markdown
    assert "记录的代表指标：—" not in report.markdown


@pytest.mark.parametrize(
    ("metric", "unit", "label"),
    [
        ("betweenesscentrality", "未归一化介数", "全正边二值介数"),
        ("weighted indegree", "百万美元", "加权入度"),
        ("closnesscentrality", "无量纲", "接近中心性"),
    ],
)
def test_report_preserves_two_country_industry_trend_years(tmp_path, monkeypatch, metric, unit, label):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    data = session["steps"]["9"]["data"]
    data["compared"] = ["CHN", "USA"]
    data.update(year=2019, chart="network", drill="DEU")
    data["metric"] = metric
    data["observations"] = [
        {
            "entity": f"{country}·C26",
            "country": country,
            "industry": "C26",
            "year": year,
            "value": value,
            "metric": metric,
            "unit": unit,
            "release": "ICIO-2023",
            "scope": "country-industry",
            "source": "explicit-network-trend",
        }
        for country, year, value in [("CHN", 2016, 31), ("CHN", 2020, 44), ("USA", 2016, 9), ("USA", 2020, 7)]
    ]
    assert check_material_gate(session) == []
    markdown = build(session, "同学").markdown
    section = markdown.split("### 步骤 9", 1)[1].split("### 步骤 10", 1)[0]
    assert "保存的视图" not in section
    assert "DEU" not in section
    assert f"记录的代表指标：{label}" in markdown
    assert f"记录方式：历年趋势；单位：{unit}" in markdown
    assert '"type":"line"' in markdown
    assert '"label":"CHN 中国","points":[{"label":"2016","value":31.0},{"label":"2020","value":44.0}]' in markdown
    assert "C26 计算机电子光学" in section
    change = "+13 百万美元" if unit == "百万美元" else "+13.00"
    assert f"CHN 中国 从 2016 年 31 变为 2020 年 44（{change}）" in markdown
    for expected in (
        f"| CHN·C26 | 2016 | {label}",
        f"| CHN·C26 | 2020 | {label}",
        f"| USA·C26 | 2016 | {label}",
        f"| USA·C26 | 2020 | {label}",
    ):
        assert expected in markdown


def test_report_labels_step_five_network_metric_like_the_step_does(tmp_path, monkeypatch):
    """Step 5's metric must use its taught label, not the raw field key."""
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()

    report = build(session, "同学")

    assert "加权总度(入+出；自环双计)" in report.markdown
    assert "记录的代表指标：weighted degree" not in report.markdown


def test_material_gate_requires_complete_current_teaching_panel_snapshot():
    session = _complete()
    session["steps"]["10"]["data"]["viewed_teaching_panel"] = False

    blocked = check_material_gate(session)

    assert len(blocked) == 1
    assert blocked[0]["step"] == 10
    assert "模拟关税面板" in "".join(blocked[0]["missing"])


def test_material_gate_rejects_legacy_teaching_panel_version():
    session = _complete()
    session["steps"]["10"]["data"]["teaching_panel_version"] = "legacy-shock-catalog"
    blocked = next(item for item in check_material_gate(session) if item["step"] == 10)
    message = "".join(blocked["missing"])
    # Reopening the step re-records the current version; the student never sees the version id.
    assert "模拟关税面板" in message and TEACHING_VERSION not in message


def test_material_gate_rejects_an_unverifiable_teaching_exposure():
    session = _complete()
    session["steps"]["10"]["data"]["teaching_observation"]["teaching_tariff_exposure"] = 0.99

    blocked = check_material_gate(session)

    assert any(item["step"] == 10 for item in blocked)


def test_report_prints_automatically_saved_teaching_row(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)

    markdown = build(_complete(), "同学").markdown

    assert "自动保存的代表行：CHN 中国 · s1 · 2019" in markdown
    assert "w=20%；τ=10%；X=w×τ=2 个百分点" in markdown
    assert markdown.index("## 真实指标比较") < markdown.index("## 关键证据摘要")
    charts = [json.loads(block.split("\n```", 1)[0]) for block in markdown.split("```gvcsim-chart\n")[1:]]
    assert [chart["type"] for chart in charts].count("coefficient") == 4
    assert len(charts) == 8
    # Each regression step gets the page's coefficient plot: one row, per 1-pp increase in X, with its interval.
    summary = markdown.split("## 关键证据摘要", 1)[1].split("## 理解检查摘要", 1)[0]
    assert summary.count('"type":"coefficient"') == 4
    for chart in charts:
        if chart["type"] == "coefficient":
            assert chart["title"].endswith("X 每增加 1 个百分点时 Y 的平均变化")
            (item,) = chart["items"]
            assert item["ci_low"] <= item["value"] <= item["ci_high"]


def test_report_uses_saved_result_without_calling_estimator(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["11"]["data"]["run"] = {
        "settings": {"method": "twfe_intensity"},
        "design": {"outcome": "trade", "equation": "y = policy + FE"},
        "result": {
            "status": "ok",
            "n_obs": 42,
            "n_entities": 21,
            "n_times": 2,
            "n_clusters": 20,
            "coefs": [{"name": "policy", "coef": 1.2, "se": 0.3, "p": 0.01, "ci_low": 0.6, "ci_high": 1.8}],
        },
    }
    _sign_run(session["steps"]["11"]["data"]["run"])
    report = build(session, "同学")
    assert report.provenance["years"] == REPORT_YEARS
    assert report.provenance["release_id"] == "2" * 32
    assert report.provenance["quiz_version"] == quizzes.QUIZ_VERSION
    assert report.provenance["quiz_versions"] == {
        str(step): "course-quiz-v9" if step == 11 else "course-quiz-v8" for step in range(1, 15)
    }
    assert report.provenance["course_release"] == config.COURSE_RELEASE
    assert report.provenance["runs"][0]["step"] == 11
    assert report.provenance["runs"][0]["result"]["coefs"][0]["coef"] == 1.2
    assert "1.2" in report.markdown and "不在报告生成时复算" in report.markdown
    assert "[0.5721, 1.828]" in report.markdown
    assert "## 关键证据摘要" in report.markdown
    assert X_COLUMN in report.markdown
    assert "+1.20 个百分点" in report.markdown
    assert "## 技术附录：保存的回归结果" in report.markdown
    assert "| 模拟关税暴露强度 | 1.2 | 0.3 | [0.5721, 1.828] | 0.0007662 |" in report.markdown
    assert report.provenance["runs"][0]["model_snapshot"] == model_snapshot("trade")
    assert report.provenance["runs"][0]["variable_catalog"] == variable_catalog("trade")
    assert "模拟教学部分（步骤 10–14）" in report.markdown
    disclosure = report.provenance["simulation_contract"]["source_filter_disclosure"]
    assert f"{disclosure['source_baseline_rows']} 个候选国家×行业单元" in report.markdown
    assert f"剔除 {disclosure['excluded_source_baseline_rows']} 个" in report.markdown
    assert f"保留 {disclosure['published_entities']} 个供四项回归共同使用" in report.markdown
    assert "预设 -0.55 个百分点；估计 +1.20 个百分点；差值（估计 − 预设）+1.75 个百分点" in report.markdown
    assert "模拟 Y 的数值上升" in report.markdown
    assert "本实验没有生成冲击后的投入产出表或网络" in report.markdown
    assert "标称 95% 的近似聚类区间" in report.markdown
    assert "实际覆盖率可能低于 95%" in report.markdown
    assert "国家数量多也不保证达到标称覆盖率" in report.markdown
    assert "Goodman-Bacon" not in report.markdown

    assert "有向无权网络" in report.markdown
    assert report.provenance["network_algorithm"] == "gephi-compatible-directed-unweighted-positive-v1"
    assert report.provenance["indicator_data_source"]["kind"] == "observed-indicator-input"
    assert report.provenance["simulated_macro_controls"]["kind"] == "deterministic-teaching-mock"
    assert "模拟宏观控制：按固定规则生成的教学数据" in report.markdown
    assert "不是 WDI 或 IMF 的观测数据" in report.markdown
    assert "Not WDI data" not in report.markdown


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


@pytest.mark.parametrize("prose", ["说明\n\n~~~\n未闭合", "说明\n```\n代码", "``````\n\n# 标题\n```\n"])
def test_reflection_preserves_text_inside_an_unbreakable_literal_block(prose):
    block = report_observed._reflection_value(prose)
    opening, body = block.split("\n", 1)
    fence = opening.removesuffix("gvcsim-reflection")
    assert set(fence) == {"`"} and len(fence) >= 3
    assert body == prose + "\n" + fence
    assert fence not in prose


def test_malformed_only_saved_run_blocks_report(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["11"]["data"]["run"] = {"design": {"outcome": "trade"}, "result": "forged"}
    blocked = check_gate(session)
    assert any(item["step"] == 11 and "运行回归" in "".join(item["missing"]) for item in blocked)
    with pytest.raises(ReportGateError):
        build(session, "同学")


@pytest.mark.parametrize(
    "mutation",
    [
        lambda coefficient: coefficient.update(name="wrong_x"),
        lambda coefficient: coefficient.update(coef=float("nan")),
        lambda coefficient: coefficient.pop("p"),
        lambda coefficient: coefficient.update(ci_low=0.3, ci_high=0.2),
        lambda coefficient: coefficient.update(se=0.0),
    ],
    ids=["wrong-x", "nan-coef", "missing-p", "reversed-ci", "zero-se"],
)
def test_saved_run_parser_rejects_malformed_fixed_twfe_inference(mutation):
    run = _ok_run("trade")
    mutation(run["result"]["coefs"][0])

    assert report_saved_run._parse_saved_run(run, "trade") is None


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

    assert any(item["step"] == 11 and "运行回归" in "".join(item["missing"]) for item in blocked)


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
    _sign_run(session["steps"]["11"]["data"]["run"])

    assert check_gate(session) == []
    report = build(session, "同学")
    assert "四项回归结果汇总" in report.markdown
    assert "这四步分别估计" in report.markdown
    assert "统计推断已抑制" in report.markdown or "处理支持度不足" in report.markdown
    assert X_COLUMN in report.markdown


def test_exact_run_identity_prevents_unsigned_latest_from_shadowing_distinct_qualified_run(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    qualified = _ok_run("trade")
    qualified["result"]["notes"] = ["QUALIFIED_COLLISION_FIXTURE"]
    latest = json.loads(json.dumps(qualified))
    latest["result"]["status"] = "insufficient"
    latest["result"]["status_reasons"] = ["测试诊断"]
    latest["result"]["support"] = {
        "status": "insufficient",
        "suppress_inference": True,
        "reasons": ["测试诊断"],
    }
    latest["result"]["coefs"][0].update(p=None, ci_low=None, ci_high=None)
    latest["result"]["notes"] = ["LATEST_COLLISION_FIXTURE"]
    session["steps"]["11"]["data"].update({"run": latest, "qualified_run": qualified})

    step_runs = [run for run in teaching_report._saved_runs(session) if run["step"] == 11]
    gate_runs = [run for run in teaching_report._gate_qualified_runs(session) if run["step"] == 11]
    qualified_runs = [run for run in step_runs if report_saved_run._result_is_qualified(run["result"], run["design"])]
    markdown = build(session, "同学").markdown

    assert len(step_runs) == 2
    assert gate_runs == step_runs
    assert len(qualified_runs) == 1
    assert qualified_runs[0]["result"]["notes"] == ["QUALIFIED_COLLISION_FIXTURE"]
    assert "LATEST_COLLISION_FIXTURE" in markdown
    assert "QUALIFIED_COLLISION_FIXTURE" in markdown

    identical = _complete()
    identical_run = identical["steps"]["12"]["data"]["run"]
    identical["steps"]["12"]["data"]["qualified_run"] = identical_run
    assert len([run for run in teaching_report._saved_runs(identical) if run["step"] == 12]) == 1


def test_comparison_table_keeps_fixed_shock_and_estimand_label(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    session["steps"]["12"]["data"]["run"] = _ok_run("production")

    markdown = build(session, "同学").markdown

    assert X_COLUMN in markdown
    assert "连续强度双向固定效应（TWFE）" in markdown


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
            "observation": {
                "row": "CHN_D01T02",
                "column": "USA_D01T02",
                "value": 228.0672,
                "year": 2020,
                "table": "z",
            },
        }
    )
    session["steps"]["7"]["data"].update(
        {
            "year": 2020,
            "chart": "quadrant",
            "compared": ["CHN", "USA"],
            "metric": "3b_VA_GVC_C_share",
            "observations": [
                {
                    "entity": country,
                    "country": country,
                    "year": 2020,
                    "value": value,
                    "metric": "3b_VA_GVC_C_share",
                    "unit": "比例",
                    "release": "ICIO-2023",
                    "scope": "country",
                    "source": "explicit-indicator-comparison",
                }
                for country, value in (("CHN", 0.12), ("USA", 0.08))
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
    assert "比较对象：CHN、USA" in report.markdown
    assert "| CHN | 2020 | 复杂 GVC 生产份额 | 比例 | 0.12 |" in report.markdown
    assert "仅用于探索定位，不限定下游回归样本" in report.markdown
    assert "按所选冲击类型汇总该类型全部已编码事件" in report.markdown
    assert "当前目录无法确认来源状态" in report.markdown
    assert "不是政策机关发布的权威处理标记" in report.markdown
    assert "## 结论" in report.markdown
    assert "关税冲击是否改变出口中的外国增加值份额" in report.markdown


def test_report_carries_catalogue_event_source_status_and_urls(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    disclosure = "事件事实与课程数值映射必须分开。"
    monkeypatch.setattr(
        report_observed,
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


def test_report_says_when_the_step1_cell_was_recorded_by_default(tmp_path, monkeypatch):
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    observation = {
        "row": "CHN_D01T02",
        "column": "USA_D01T02",
        "value": 228.0672,
        "year": 2020,
        "table": "z",
        "row_country": "CHN",
        "col_country": "USA",
    }
    session["steps"]["1"]["data"]["observation"] = {**observation, "auto": True}
    step1 = build(session, "同学").markdown
    assert "- 记录的单元格（系统默认记录，学生未另选）：CHN_D01T02(行·供给方)" in step1
    assert all(item["step"] != 1 for item in check_material_gate(session))

    session["steps"]["1"]["data"]["observation"] = observation
    step1 = build(session, "同学").markdown
    assert "- 记录的单元格：CHN_D01T02(行·供给方)" in step1
    assert "系统默认记录" not in step1


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
    _sign_run(session["steps"]["11"]["data"]["run"])

    report = build(session, "同学")

    assert "统计推断已抑制" in report.markdown
    assert "处理聚类不足" in report.markdown
    assert "| 模拟关税暴露强度 | -0.2 | 0.1 | 已抑制 | 已抑制 |" in report.markdown


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
            "n_entities": 4000,
            "n_times": 5,
            "n_clusters": 76,
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

    assert "连续强度 TWFE（描述性）" in markdown
    assert "+0.0014 个百分点" in markdown
    assert "[-0.0017, +0.0045] 个百分点" in markdown
    assert "证据不足，无法判断方向" in markdown
    assert "模拟关税暴露" in markdown
    assert "总增加值规模(log, ICIO GVA proxy)" not in markdown
    assert "0.0013729825631389496" not in markdown
    assert "国家×行业层面的连续强度双向固定效应（TWFE），不加控制变量和交互项" in markdown
    assert "twfe_intensity ×" not in markdown
    assert "icio_derived" not in markdown


@pytest.mark.parametrize("status", ["insufficient", "invalid_design"])
@pytest.mark.parametrize("has_older_qualified_run", [False, True])
def test_complete_stopped_diagnosis_satisfies_report_gate_without_hiding_it(
    tmp_path, monkeypatch, status, has_older_qualified_run
):
    from copy import deepcopy

    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    data = session["steps"]["11"]["data"]
    if has_older_qualified_run:
        data["qualified_run"] = deepcopy(data["run"])
    else:
        assert "qualified_run" not in data
    result = data["run"]["result"]
    result["status"] = status
    result["status_reasons"] = ["实际配对支持不足或处理路径不相容"]
    result["support"] = {"status": status, "suppress_inference": True, "reasons": result["status_reasons"]}
    result["diagnostics"] = {"study_contract": "economics-v2"}
    for coefficient in result["coefs"]:
        coefficient.update(p=None, ci_low=None, ci_high=None, stars="")
    assert check_gate(session) == []
    report = build(session, "诊断学习者")
    assert "统计推断已抑制" in report.markdown
    assert "实际配对支持不足或处理路径不相容" in report.markdown
    # A forged inferential field cannot turn a stopped result into acceptable evidence.
    data.pop("qualified_run", None)
    result["coefs"][0]["p"] = 0.001
    assert any(item["step"] == 11 for item in check_gate(session))


def _country_reference_csvs(path: Path, values: dict[str, float]) -> None:
    """Country CSVs where PLv_GVC rises by 0.1 a year from the given 2016 values."""
    for year in range(2016, 2021):
        pd.DataFrame(
            {"country": list(values), "PLv_GVC": [value + (year - 2016) / 10 for value in values.values()]}
        ).to_csv(path / f"indicators_country_{year}.csv", index=False)


def test_country_reference_matches_the_page_rule(tmp_path, monkeypatch):
    from gvcsim.report_reference import country_reference

    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    _country_reference_csvs(tmp_path, {"CHN": 1.0, "USA": 2.0, "DEU": 2.0, "JPN": 4.0, "KOR": 5.0, "ROW": 9.0})
    reference = country_reference("PLv_GVC", 2016)
    assert reference is not None
    # ROW excluded; linear quartiles as pandas/numpy; ties share the better rank.
    assert reference["n"] == 5
    assert reference["median"] == pytest.approx(2.0)
    assert reference["p25"] == pytest.approx(2.0)
    assert reference["p75"] == pytest.approx(4.0)
    assert reference["ranks"] == {"KOR": 1, "JPN": 2, "USA": 3, "DEU": 3, "CHN": 5}
    assert country_reference("PLv_GVC", 2030) is None
    assert country_reference("no_such_metric", 2016) is None
    # Integer-typed columns (numpy ints) are read like floats rather than silently dropped.
    pd.DataFrame({"country": ["CHN", "USA", "DEU"], "degree": [3, 1, 2]}).to_csv(
        tmp_path / "indicators_country_2016.csv", index=False
    )
    counts = country_reference("degree", 2016)
    assert counts is not None and counts["median"] == 2 and counts["ranks"] == {"CHN": 1, "DEU": 2, "USA": 3}


def test_country_level_trend_and_same_year_charts_show_the_global_median(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    _country_reference_csvs(tmp_path, {"CHN": 4.0, "USA": 5.0, "DEU": 3.0, "JPN": 3.5, "KOR": 6.0})
    session = _complete()
    data = session["steps"]["8"]["data"]
    data["compared"] = ["CHN", "USA"]
    data["indicator_selection"] = {"view": "trend", "metric": "PLv_GVC"}
    data["observations"] = [
        dict(
            item,
            metric="PLv_GVC",
            value=value + (year - 2016) / 10,
            year=year,
            unit="生产阶段（账户比值）",
            source="explicit-indicator-trend",
        )
        for item, value in zip(data["observations"], (4.0, 5.0))
        for year in range(2016, 2021)
    ]
    (chart,) = teaching_report._observed_charts(data, 8, data["observations"])
    median = next(series for series in chart["series"] if series.get("reference"))
    assert median["label"] == "全球中位数（5 个经济体）"
    assert [point["value"] for point in median["points"]] == pytest.approx([4.0, 4.1, 4.2, 4.3, 4.4])
    assert "两国" not in chart["title"] and "全球中位数" in chart["title"]
    section = "\n".join(report_observed._observed_evidence_section(session)).split("### 步骤 8", 1)[1]
    section = section.split("### 步骤 9", 1)[0]
    assert "在 5 个经济体中（从高到低），CHN 中国从第 3 位变为第 3 位；USA 美国从第 2 位变为第 2 位" in section
    assert '"_context"' not in section and '"reference":true' in section

    # Same-year comparison: the two countries plus a median bar, read with their ranks.
    data["indicator_selection"] = {"view": "comparison", "metric": "PLv_GVC"}
    data["observations"] = [
        dict(item, year=2020, source="explicit-indicator-comparison")
        for item in data["observations"]
        if item["year"] == 2016
    ]
    (bar,) = teaching_report._observed_charts(data, 8, data["observations"])
    assert [item["label"] for item in bar["items"]][-1] == "全球中位数（5 个经济体）"
    assert bar["items"][-1]["value"] == pytest.approx(4.4)
    assert bar["items"][-1]["reference"] is True and not any(item.get("reference") for item in bar["items"][:-1])
    section = "\n".join(report_observed._observed_evidence_section(session)).split("### 步骤 8", 1)[1]
    assert "全球中位数 4.4" in section and "CHN 中国第 3 位" in section


def test_step9_report_reads_the_industry_against_the_same_industry_worldwide(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    for year in (2016, 2020):
        pd.DataFrame(
            [
                (country, industry, value + (year - 2016) + (0 if industry == "C26" else 100))
                for country, value in (("CHN", 50.0), ("USA", 40.0), ("DEU", 30.0), ("JPN", 10.0), ("ROW", 999.0))
                for industry in ("C26", "C27")
            ],
            columns=["country", "industry", "betweenesscentrality"],
        ).to_csv(tmp_path / f"indicators_industry_{year}.csv", index=False)
    session = _complete()
    data = session["steps"]["9"]["data"]
    data["compared"] = ["CHN", "USA"]
    base = {
        "metric": "betweenesscentrality",
        "unit": "未归一化介数",
        "release": "ICIO-2023",
        "scope": "country-industry",
    }
    data["observations"] = [
        {
            **base,
            "entity": f"{country}·C26",
            "country": country,
            "industry": "C26",
            "year": year,
            "value": value + (year - 2016),
            "source": "explicit-network-trend",
        }
        for country, value in (("CHN", 50.0), ("USA", 40.0))
        for year in (2016, 2020)
    ]
    (trend,) = teaching_report._observed_charts(data, 9, data["observations"])
    median = next(series for series in trend["series"] if series.get("reference"))
    assert median["label"] == "全球中位数（同行业，4 个经济体）"
    assert [point["value"] for point in median["points"]] == pytest.approx([35.0, 39.0])
    assert "全球中位数" in trend["title"]
    section = "\n".join(report_observed._observed_evidence_section(session)).split("### 步骤 9", 1)[1]
    assert (
        "在 4 个经济体的同一行业中（从高到低），CHN 中国从第 1 位变为第 1 位；USA 美国从第 2 位变为第 2 位" in section
    )

    # Ranking: each industry's pair of bars is followed by that industry's global median.
    data["observations"] = [
        {
            **base,
            "entity": f"{country}·{industry}",
            "country": country,
            "industry": industry,
            "year": 2020,
            "value": value,
            "source": "explicit-network-ranking",
        }
        for industry, values in (("C27", (154.0, 144.0)), ("C26", (54.0, 44.0)))
        for country, value in zip(("CHN", "USA"), values)
    ]
    (ranking,) = teaching_report._observed_charts(data, 9, data["observations"])
    assert [(item["label"], item.get("group")) for item in ranking["items"]] == [
        ("C27 电气设备", "CHN 中国"),
        ("C27 电气设备", "USA 美国"),
        ("C27 电气设备", "全球中位数（同行业，4 个经济体）"),
        ("C26 计算机电子光学", "CHN 中国"),
        ("C26 计算机电子光学", "USA 美国"),
        ("C26 计算机电子光学", "全球中位数（同行业，4 个经济体）"),
    ]
    assert ranking["items"][2]["value"] == pytest.approx(139.0)
    assert [bool(item.get("reference")) for item in ranking["items"]] == [False, False, True] * 2
    section = "\n".join(report_observed._observed_evidence_section(session)).split("### 步骤 9", 1)[1]
    # Extremes are read among the saved countries only, never the median bars.
    assert (
        "最高为 CHN 中国 · C27 电气设备（154）" in section and "最低为 USA 美国 · C26 计算机电子光学（44）" in section
    )


def test_step9_long_ranking_is_cut_at_an_industry_and_counts_only_saved_readings(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    industries = [f"S{index:02d}" for index in range(15)]
    pd.DataFrame(
        [
            (country, industry, value)
            for country, value in (("CHN", 9.0), ("USA", 5.0), ("DEU", 3.0))
            for industry in industries
        ],
        columns=["country", "industry", "betweenesscentrality"],
    ).to_csv(tmp_path / "indicators_industry_2020.csv", index=False)
    session = _complete()
    data = session["steps"]["9"]["data"]
    data["compared"] = ["CHN", "USA"]
    data["observations"] = [
        {
            "entity": f"{country}·{industry}",
            "country": country,
            "industry": industry,
            "year": 2020,
            "value": value - index / 100,
            "metric": "betweenesscentrality",
            "unit": "未归一化介数",
            "release": "ICIO-2023",
            "scope": "country-industry",
            "source": "explicit-network-ranking",
        }
        for index, industry in enumerate(industries)
        for country, value in (("CHN", 9.0), ("USA", 5.0))
    ]
    section = "\n".join(report_observed._observed_evidence_section(session)).split("### 步骤 9", 1)[1]
    chart = json.loads(section.split("```gvcsim-chart\n", 1)[1].split("\n```", 1)[0])
    # 15 industries x (2 countries + median) = 45 bars; cut after 13 whole industries.
    assert len(chart["items"]) == 39
    assert chart["items"][-1]["group"].startswith("全球中位数")
    assert "前 26 / 30 条读数" in section


def test_rank_reading_marks_ties_and_skips_a_ranking_everyone_shares():
    def ref(ranks, ties, n=76):
        return {"n": n, "ranks": ranks, "ties": ties}

    tied = {"references": {"2016": ref({"CHN": 21}, {"CHN": 56}), "2020": ref({"CHN": 11}, {"CHN": 66})}}
    assert (
        report_observed._rank_reading(tied, ["CHN"])
        == "在 76 个经济体中（从高到低），CHN 中国从并列第 21 位变为并列第 11 位"
    )
    plain = {"references": {"2020": ref({"CHN": 54}, {"CHN": 1})}}
    assert report_observed._rank_reading(plain, ["CHN"]) == "在 76 个经济体中（从高到低），CHN 中国第 54 位"
    everyone = {
        "references": {"2016": ref({"CHN": 1}, {"CHN": 76}), "2020": ref({"CHN": 1}, {"CHN": 76})},
        "scope": "的同一行业",
    }
    assert report_observed._rank_reading(everyone, ["CHN"]) == "全部 76 个经济体的同一行业数值相同，排名不作比较"
    one_end = {"references": {"2016": ref({"CHN": 1}, {"CHN": 76}), "2020": ref({"CHN": 3}, {"CHN": 1})}}
    assert report_observed._rank_reading(one_end, ["CHN"]) == (
        "在 76 个经济体中（从高到低），CHN 中国从不分名次变为第 3 位（不分名次：该年全部经济体数值相同）"
    )


def test_view_only_keys_never_change_the_experiment_sections():
    """Keys excluded from the report fingerprint must not reach the printed report either.

    Otherwise browsing could change the report text while step 15 still shows it as current.
    """
    from gvcsim.classroom import records

    session = _complete()
    before = teaching_report._experiment_sections(session)
    browsed = copy.deepcopy(session)
    browsed["steps"]["1"]["data"]["slice"] = {"year": 2016, "table": "y", "row_country": "DEU", "col_country": "FRA"}
    browsed["steps"]["2"]["data"].update(year=2017, country="KOR")
    browsed["steps"]["6"]["data"].update(year=1999, chart="unrelated-browse")
    browsed["steps"]["9"]["data"].update(chart="network", drill="DEU", heat_sort="betweenness", heat_coverage="all")
    assert records.report_fingerprint(browsed) == records.report_fingerprint(session)
    assert teaching_report._experiment_sections(browsed) == before
    # A step 1 record without its capture context prints the cell but never the browsed slice.
    partial = copy.deepcopy(session)
    partial["steps"]["1"]["data"]["observation"] = {"row": "CHN_D01T02", "column": "USA_D01T02", "value": 228.0672}
    partial["steps"]["1"]["data"]["slice"] = {"year": 2016, "table": "y"}
    text = "\n".join(teaching_report._experiment_sections(partial))
    assert "保存的切片" not in text
    assert "记录的单元格" in text


def test_report_draws_the_binned_scatter_behind_each_saved_estimate(tmp_path, monkeypatch):
    """Steps 11–14 carry the binned scatter after the coefficient plot, in display units."""
    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    run = session["steps"]["11"]["data"]["run"]
    run["result"]["coefs"][0]["coef"] = -0.55
    run["result"]["binscatter"] = {
        "bins": [{"x": -0.02, "y": 0.011, "n": 10}, {"x": 0.0, "y": 0.0, "n": 10}, {"x": 0.02, "y": -0.011, "n": 10}],
        "slope": -0.55,
        "transform": "twoway_demeaned",
    }
    _sign_run(run)

    def charts_of(markdown: str) -> list[dict]:
        pattern = "```gvcsim-chart" + chr(10) + "(.*?)" + chr(10) + "```"
        return [json.loads(block) for block in re.findall(pattern, markdown, re.S)]

    markdown = build(session, "同学").markdown
    charts = charts_of(markdown)
    binscatters = [chart for chart in charts if chart["type"] == "binscatter"]
    assert len(binscatters) == 1
    chart = binscatters[0]
    assert chart["title"].startswith("步骤 11")
    # X in percentage points, Y of a share outcome in percentage points; slope per 1 pp of X.
    assert [point["x"] for point in chart["points"]] == [-2.0, 0.0, 2.0]
    assert [point["y"] for point in chart["points"]] == [1.1, 0.0, -1.1]
    assert chart["slope"] == pytest.approx(-0.55)
    # The scatter follows the coefficient chart of the same step.
    assert markdown.index('"type":"coefficient"') < markdown.index('"type":"binscatter"')
    # A malformed scatter is left out rather than breaking the report.
    run["result"]["binscatter"] = {"bins": "no", "slope": 1}
    _sign_run(run)
    assert not [chart for chart in charts_of(build(session, "同学").markdown) if chart["type"] == "binscatter"]
    # Suppressed inference draws no scatter either (the evidence section is rendered directly here,
    # because a run without inference is not a complete material for the report gate).
    from gvcsim.report_render import _evidence_summary

    run["result"]["binscatter"] = {
        "bins": [{"x": -0.02, "y": 0.011, "n": 10}, {"x": 0.02, "y": -0.011, "n": 10}],
        "slope": -0.55,
    }
    run["result"]["support"] = {"status": "ok", "suppress_inference": True, "reasons": ["测试诊断"]}
    _sign_run(run)
    evidence = [{"step": 11, "outcome": "trade", "design": run["design"], "result": run["result"]}]
    assert not [
        chart for chart in charts_of(chr(10).join(_evidence_summary(evidence))) if chart["type"] == "binscatter"
    ]
    run["result"]["support"]["suppress_inference"] = False
    assert [chart for chart in charts_of(chr(10).join(_evidence_summary(evidence))) if chart["type"] == "binscatter"]


def test_report_keeps_a_same_family_baseline_run_with_its_own_label_and_reading(tmp_path, monkeypatch):
    """A step that was run with another indicator of its family reports that indicator, not the default."""
    from gvcsim.report_saved_run import _parse_saved_run, _saved_runs

    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    session = _complete()
    run = session["steps"]["13"]["data"]["run"]
    run["design"]["baseline"] = "GVCPs"
    run["result"]["coefs"][0]["coef"] = -0.4
    run["result"]["coefs"][0]["se"] = 0.01  # two clusters: a wide t(1) interval would otherwise cross 0
    run["result"]["binscatter"] = {
        "bins": [{"x": -0.02, "y": 0.008, "n": 10}, {"x": 0.02, "y": -0.008, "n": 10}],
        "slope": -0.4,
        "transform": "twoway_demeaned",
    }
    _sign_run(run)
    assert run["design"]["depvar"] == "teaching_y_length_GVCPs"
    assert run["model_snapshot"]["baseline"] == "GVCPs"
    assert _parse_saved_run(run, "length") is not None
    assert [item["outcome"] for item in _saved_runs(session) if item["step"] == 13] == ["length"]

    markdown = build(session, "同学").markdown
    assert "教学模拟：GVC 位置指数" in markdown
    assert "个位置指数单位" in markdown
    assert "相对更靠下游" in markdown
    charts = [
        json.loads(block)
        for block in re.findall("```gvcsim-chart" + chr(10) + "(.*?)" + chr(10) + "```", markdown, re.S)
    ]
    coefficient = next(
        chart for chart in charts if chart["type"] == "coefficient" and chart["title"].startswith("步骤 13")
    )
    assert coefficient["items"][0]["label"] == "GVC 位置指数" and coefficient["x_label"] == "位置指数单位"
    assert coefficient["items"][0]["value"] == pytest.approx(-0.004)
    scatter = next(chart for chart in charts if chart["type"] == "binscatter" and chart["title"].startswith("步骤 13"))
    assert scatter["y_label"] == "GVC 位置指数（位置指数单位）"
    assert [point["y"] for point in scatter["points"]] == [0.008, -0.008]
    assert scatter["slope"] == pytest.approx(-0.004)

    # A baseline from another family, or one the snapshot does not match, is not a reportable run.
    forged = copy.deepcopy(run)
    forged["design"]["baseline"] = "FVA_share"
    assert _parse_saved_run(forged, "length") is None
    stale = copy.deepcopy(run)
    stale["model_snapshot"]["baseline"] = "PLv_GVC"
    assert _parse_saved_run(stale, "length") is None
