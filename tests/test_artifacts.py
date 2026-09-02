import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from gvcsim import artifacts, config, shocks as shock_module
from gvcsim.data import output_quality, quality, raw_icio, regression_quality
from gvcsim.data.citations import artifact_data_sources
from gvcsim.data.raw_icio import DimensionContract, raw_dimensions_metadata
from gvcsim.regression import panel as regression_panel


RELEASE_ID = "1" * 32
RELEASE_RAW_CONTRACT = DimensionContract(
    "artifact-release-fixture", 1, ("AAA", "BBB", "CCC", "ROW"), ("s1",), ("HFCE",)
)
RAW_CACHE_CONTRACT = DimensionContract(
    "artifact-raw-cache-fixture", 1, ("AAA", "BBB", "CCC", "ROW"), ("s1",), ("HFCE",)
)


def _write_release_raw_fixture(raw_dir: Path) -> Path:
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
    return raw_dir / "ICIO2023_2020.csv"


@pytest.fixture(autouse=True)
def _isolated_release_raw_source(tmp_path, monkeypatch):
    # This module intentionally exercises its own compact raw contract. The
    # workflow-wide synthetic flag applies only to the generated repository
    # fixture, never to arbitrary per-test raw directories without its marker.
    monkeypatch.delenv("GVCSIM_CI_SYNTHETIC", raising=False)
    raw_dir = tmp_path.parent / f"{tmp_path.name}-raw"
    _write_release_raw_fixture(raw_dir)
    monkeypatch.setattr(config, "RAW_DATA_DIR", raw_dir)
    monkeypatch.setattr(raw_icio, "production_dimension_contract", lambda: RELEASE_RAW_CONTRACT)
    # Keep the compact artifact fixture structurally viable for every configured
    # regression shock while still exercising normal catalogue regeneration.
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


def _write_raw_cache_fixture(raw_dir: Path) -> Path:
    source_dir = raw_dir.parent / "raw-cache-source"
    _write_release_raw_fixture(source_dir)
    for year in (2018, 2019, 2020):
        (raw_dir / f"ICIO2023_{year}.csv").write_bytes((source_dir / f"ICIO2023_{year}.csv").read_bytes())
    return raw_dir / "ICIO2023_2020.csv"


def _valid_checks(scope: str) -> list[dict]:
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


def _release_metadata(
    directory: Path,
    output_summary: dict[str, dict],
    regression_input_summary: dict,
    *,
    course_release: str | None = None,
) -> dict:
    annual = _valid_checks(quality.QC_SCOPE_ICIO)
    controls = _valid_checks(quality.QC_SCOPE_CONTROLS)
    shocks = _valid_checks(quality.QC_SCOPE_SHOCKS)
    metadata = {
        "release_id": RELEASE_ID,
        "years": [2018, 2019, 2020],
        "generated_at": "2026-08-13T00:00:00+00:00",
        "course_release": course_release or config.COURSE_RELEASE,
        "network_algorithm": artifacts.NETWORK_ALGORITHM,
        "data_sources": artifact_data_sources(config.RAW_DATA_DIR),
        "raw_dimensions": raw_dimensions_metadata([2018, 2019, 2020], config.RAW_DATA_DIR),
        "qc_contract": quality.qc_contract_metadata(),
        "shock_contract": shock_module.shock_contract_metadata(),
        "qc": {
            "years": {str(year): quality.summarize_serialized_checks(annual) for year in (2018, 2019, 2020)},
            "controls": quality.summarize_serialized_checks(controls),
            "shocks": quality.summarize_serialized_checks(shocks),
        },
        "output_qc_contract": output_quality.output_qc_contract_metadata(),
        "output_qc": {"years": output_summary},
        "regression_input_qc_contract": regression_quality.regression_input_qc_contract_metadata(),
        "regression_input_qc": regression_input_summary,
        "publication_policy": artifacts.publication_policy_metadata(),
    }
    metadata["integrity"] = artifacts.release_integrity_metadata(directory, metadata["years"])
    return metadata


def _rewrite_metadata(directory: Path, metadata: dict) -> None:
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
    artifacts.write_dataset_metadata(directory, payload)
    artifacts.clear_artifact_caches()


def _tamper_signed_metadata(directory: Path, mutation) -> None:
    path = directory / artifacts.DATASET_METADATA
    payload = json.loads(path.read_text(encoding="utf-8"))
    mutation(payload)
    payload[artifacts.METADATA_DIGEST_NAME] = artifacts._metadata_digest(payload)
    path.write_text(json.dumps(payload), encoding="utf-8")
    artifacts.clear_artifact_caches()


def _indicator_rows(year: int) -> tuple[list[dict], list[dict]]:
    rows = []
    for country, weighted_in, weighted_out in (
        ("AAA", 3.0, 4.0),
        ("BBB", 4.0, 3.0),
        ("CCC", 2.0, 2.0),
        ("ROW", 2.0, 2.0),
    ):
        variant = country == "BBB"
        plv = 2.2 if variant else 2.0
        rows.append(
            {
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
        )
    industry = [dict(row, industry="s1") for row in rows]
    return rows, industry


def _write_semantic_outputs(directory: Path, year: int = 2020) -> dict[str, dict]:
    years = [2018, 2019, 2020]
    country_rows, industry_rows = _indicator_rows(year)
    for artifact_year in years:
        annual_country, annual_industry = _indicator_rows(artifact_year)
        pd.DataFrame(annual_country).to_csv(directory / f"indicators_country_{artifact_year}.csv", index=False)
        pd.DataFrame(annual_industry).to_csv(directory / f"indicators_industry_{artifact_year}.csv", index=False)
    pd.DataFrame(
        [
            {"year": year, "source": "AAA", "target": "BBB", "flow": 4.0},
            {"year": year, "source": "BBB", "target": "AAA", "flow": 3.0},
        ]
    ).to_csv(directory / f"network_edges_{year}.csv", index=False)
    pd.DataFrame(
        [
            {
                "country": country,
                "sector": "s1",
                "imposer": imposer,
                "year": year,
                "bilateral_exports": bilateral,
                "total_exports": total,
                "export_exposure": bilateral / total,
            }
            for country, total, flows in (
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
    ).to_csv(directory / f"export_exposure_{year}.csv", index=False)
    for artifact_year in years[:-1]:
        pd.read_csv(directory / f"network_edges_{year}.csv").assign(year=artifact_year).to_csv(
            directory / f"network_edges_{artifact_year}.csv", index=False
        )
        pd.read_csv(directory / f"export_exposure_{year}.csv").assign(year=artifact_year).to_csv(
            directory / f"export_exposure_{artifact_year}.csv", index=False
        )

    panel_country = pd.concat(
        [pd.DataFrame(_indicator_rows(artifact_year)[0]) for artifact_year in years], ignore_index=True
    )
    panel_industry = pd.concat(
        [pd.DataFrame(_indicator_rows(artifact_year)[1]) for artifact_year in years], ignore_index=True
    )
    for frame in (panel_country, panel_industry):
        frame["gross_exports"] = 10.0
        frame["FVA_share"] = frame["FVA"] / frame["gross_exports"]
        frame["3b_VA_GVC_C_share"] = frame["3b_VA_GVC_C"] / frame["SVA"]
        frame["3_VA_GVC_share"] = frame["3_VA_GVC"] / frame["SVA"]
    panel_industry["entity_id"] = panel_industry["country"] + "_" + panel_industry["industry"]
    for frame in (panel_country, panel_industry):
        for index, column in enumerate(regression_quality.REGRESSION_CONTROL_FIELDS):
            frame[column] = float(index + 1)
        first_year = frame.groupby("country")["year"].transform("min")
        frame.loc[frame["year"].eq(first_year), ["gdp_proxy_growth", "exports_proxy_growth"]] = np.nan

    exposure = pd.concat(
        [pd.read_csv(directory / f"export_exposure_{artifact_year}.csv") for artifact_year in years],
        ignore_index=True,
    )
    exposure.loc[exposure["imposer"].eq("EU"), list(shock_module.EXPOSURE_LOOKUP_COLUMNS)].to_csv(
        directory / shock_module.EXPOSURE_LOOKUP_FILE, index=False
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
    industry_shocks = shock_panel[["country", "sector", "year", *shock_fields]].rename(columns={"sector": "industry"})
    panel_industry = panel_industry.merge(
        industry_shocks,
        on=["country", "industry", "year"],
        how="left",
        validate="one_to_one",
    )
    country_shocks = shock_panel[["country", "year", *shock_fields]].drop_duplicates(["country", "year"])
    panel_country = panel_country.merge(
        country_shocks,
        on=["country", "year"],
        how="left",
        validate="one_to_one",
    )
    panel_country.to_csv(directory / "panel_country.csv", index=False)
    panel_industry.to_csv(directory / "panel_industry.csv", index=False)
    controls_frame = pd.DataFrame(
        [
            {"country": country, "year": artifact_year}
            for artifact_year in years
            for country in ("AAA", "BBB", "CCC", "ROW")
        ]
    )
    for index, column in enumerate(regression_quality.REGRESSION_CONTROL_FIELDS):
        controls_frame[column] = float(index + 1)
    first_control_year = controls_frame.groupby("country")["year"].transform("min")
    controls_frame.loc[controls_frame["year"].eq(first_control_year), ["gdp_proxy_growth", "exports_proxy_growth"]] = (
        np.nan
    )
    controls_frame.to_csv(directory / "controls_country.csv", index=False)
    shock_panel.to_csv(directory / "demo_trade_war_tariffs.csv", index=False)
    output_summary = {
        str(artifact_year): output_quality.write_output_qc(directory, artifact_year, expected_years=years)[1]
        for artifact_year in years
    }
    regression_summary = regression_quality.write_regression_input_qc(directory, expected_years=years)[1]
    return output_summary, regression_summary


def _release(directory: Path, *, course_release: str | None = None) -> None:
    year = 2020
    output_summary, regression_input_summary = _write_semantic_outputs(directory, year)
    payloads = {
        **{f"qc_{artifact_year}.json": _valid_checks(quality.QC_SCOPE_ICIO) for artifact_year in (2018, 2019, 2020)},
        "qc_controls.json": _valid_checks(quality.QC_SCOPE_CONTROLS),
        "qc_shocks.json": _valid_checks(quality.QC_SCOPE_SHOCKS),
    }
    for name, payload in payloads.items():
        (directory / name).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    artifacts.write_dataset_metadata(
        directory,
        _release_metadata(
            directory,
            output_summary,
            regression_input_summary,
            course_release=course_release,
        ),
    )


def test_v11_release_requires_integrity_regression_shock_output_qc_manifest_and_identity(tmp_path):
    _release(tmp_path)

    result = artifacts.validate_release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)

    assert result == {"release_id": RELEASE_ID, "files": 26, "years": 3}
    assert artifacts.release_identity(tmp_path) == RELEASE_ID
    assert metadata["artifact_contract_version"] == 11
    assert metadata["publication_policy"] == artifacts.publication_policy_metadata()
    assert metadata["integrity"]["status"] == "passed"
    assert "冲击数值字段完整性(*_shock有限且treated为0/1)" in metadata["integrity"]["scopes"]["shocks"]["checked"]
    assert metadata["regression_input_qc_contract"]["version"] == 4
    sample_scope = metadata["regression_input_qc_contract"]["sample_scope"]
    assert sample_scope["runtime_default"] == "exclude_row"
    assert sample_scope["excluded_country_values"] == ["ROW"]
    assert "interaction_timing_and_complete_case_slices" in sample_scope["applies_before"]
    regression_contract = metadata["regression_input_qc_contract"]
    release_scope = regression_contract["release_certification_scope"]
    assert release_scope["certified"]["baseline_outcomes"] == {
        "controls": "none",
        "interaction": False,
        "sample": "runtime_default_exclude_country_ROW",
        "coverage": "each_supported_granularity_outcome",
    }
    assert release_scope["certified"]["interaction_designs"]["shock_types"] == ["tariff"]
    assert release_scope["certified"]["interaction_designs"]["methods"] == ["did", "twfe_intensity"]
    assert release_scope["optional_runtime_validated"]["shock_types"] == ["export_control", "sanctions"]
    assert release_scope["optional_runtime_validated"]["unavailability_release_fatal"] is False
    assert release_scope["certifies_every_cross_product"] is False
    assert release_scope["certifies_causal_identification"] is False
    assert release_scope["certifies_statistical_power"] is False
    interaction_scope = regression_contract["requirements"]["outcome_structural_slices"]["interaction"]
    assert interaction_scope.startswith("canonical_tariff_only;")
    assert "drop_all_rows_for_entities_without_finite_derived_baseline" in interaction_scope
    assert (
        "availability_not_release_fatal"
        in regression_contract["requirements"]["outcome_structural_slices"]["optional_runtime_validated_designs"]
    )
    assert "does not certify every design cross-product" in regression_contract["certification_limit"]
    assert "causal identification" in regression_contract["certification_limit"]
    assert metadata["raw_dimensions"]["countries"] == 4
    assert metadata["data_sources"]["simulated_macro_controls"]["production_data"] is False
    assert len(metadata["artifact_manifest"]) == 26
    assert artifacts.current_artifact_years(tmp_path) == [2018, 2019, 2020]


def test_release_rejects_data_source_and_raw_dimension_metadata_tampering(tmp_path):
    _release(tmp_path)
    _tamper_signed_metadata(
        tmp_path,
        lambda metadata: metadata["data_sources"]["simulated_macro_controls"].__setitem__("production_data", True),
    )
    with pytest.raises(artifacts.ArtifactContractError, match="provenance"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    _tamper_signed_metadata(
        tmp_path,
        lambda metadata: metadata["raw_dimensions"].__setitem__("years", {}),
    )
    with pytest.raises(artifacts.ArtifactContractError, match="raw_dimensions years"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    _tamper_signed_metadata(
        tmp_path,
        lambda metadata: metadata["raw_dimensions"]["years"]["2020"].__setitem__("source_sha256", "bad"),
    )
    with pytest.raises(artifacts.ArtifactContractError, match="source SHA-256"):
        artifacts.validate_release(tmp_path)


@pytest.mark.parametrize(
    "mutation",
    ["empty", "missing", "duplicate", "unknown", "malformed", "contradictory", "downgrade"],
)
def test_release_qc_payload_must_match_exact_contract(tmp_path, mutation):
    _release(tmp_path)
    path = tmp_path / "qc_2020.json"
    checks = json.loads(path.read_text(encoding="utf-8"))
    if mutation == "empty":
        checks = []
    elif mutation == "missing":
        checks.pop()
    elif mutation == "duplicate":
        checks.append(dict(checks[0]))
    elif mutation == "unknown":
        checks[0]["name"] = "未知检查"
    elif mutation == "malformed":
        checks[0].pop("kind")
    elif mutation == "contradictory":
        checks[0]["severity"] = "fatal"
    else:
        checks[0].update({"passed": False, "severity": "warning"})
    path.write_text(json.dumps(checks, ensure_ascii=False), encoding="utf-8")
    _rewrite_metadata(tmp_path, artifacts.dataset_metadata(tmp_path))

    with pytest.raises(artifacts.ArtifactContractError, match="QC"):
        artifacts.validate_release(tmp_path)


def test_release_rejects_qc_contract_version_and_summary_mismatch(tmp_path):
    _release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata.pop("qc_contract")
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(artifacts.ArtifactContractError, match="missing qc_contract"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["qc_contract"]["version"] = 1
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(artifacts.ArtifactContractError, match="QC contract"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["qc"]["years"]["2020"]["passed"] = []
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(artifacts.ArtifactContractError, match="summary does not match"):
        artifacts.validate_release(tmp_path)


def test_release_rejects_missing_or_modified_shock_contract(tmp_path):
    _release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata.pop("shock_contract")
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(artifacts.ArtifactContractError, match="missing shock_contract"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["shock_contract"]["treated_threshold"] = 0.0009
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(artifacts.ArtifactContractError, match="shock contract"):
        artifacts.validate_release(tmp_path)


def test_release_shock_generation_schema_includes_all_release_fields(tmp_path):
    _release(tmp_path)
    frame = pd.read_csv(tmp_path / "demo_trade_war_tariffs.csv", keep_default_na=False)

    assert list(frame.columns) == list(
        shock_module.demo_shock_panel(
            ["AAA", "BBB", "CCC", "ROW"],
            ["s1"],
            [2018, 2019, 2020],
            export_exposure=pd.concat(
                [pd.read_csv(tmp_path / f"export_exposure_{year}.csv") for year in (2018, 2019, 2020)],
                ignore_index=True,
            ),
            exposure_mode=shock_module.EXPOSURE_MODE_FIXED_PRETREATMENT,
        ).columns
    )
    assert {"tariff_shock_contemporaneous", "treated_contemporaneous", "shock_type"} <= set(frame.columns)


def _mutate_csv(directory: Path, filename: str, mutation) -> None:
    path = directory / filename
    frame = pd.read_csv(path)
    mutation(frame)
    frame.to_csv(path, index=False)
    _rewrite_metadata(directory, artifacts.dataset_metadata(directory))


def _append_panel_year_row(directory: Path, filename: str, year: object, *, duplicate: bool = False) -> None:
    path = directory / filename
    frame = pd.read_csv(path)
    row = frame.iloc[[0]].copy()
    if not duplicate:
        row["country"] = "EXTRA"
        if filename == "panel_industry.csv":
            row["entity_id"] = "EXTRA_s1"
    row["year"] = year
    pd.concat([frame, row], ignore_index=True).to_csv(path, index=False)


@pytest.mark.parametrize("filename", ["panel_country.csv", "panel_industry.csv"])
def test_panel_duplicate_numeric_year_fails_existing_entity_year_qc(tmp_path, filename):
    _release(tmp_path)
    _append_panel_year_row(tmp_path, filename, "2020.0", duplicate=True)

    checks = output_quality.recompute_output_checks(tmp_path, 2020, expected_years=[2020])
    coverage = next(check for check in checks if check["name"] == "row_keys_and_coverage")
    assert coverage["passed"] is False
    assert "null_or_duplicate_keys" in coverage["detail"]


def test_panel_missing_declared_year_fails_semantic_qc_after_recompute_and_manifest_rebuild(tmp_path):
    _release(tmp_path)
    path = tmp_path / "panel_country.csv"
    pd.read_csv(path).iloc[0:0].to_csv(path, index=False)

    checks = output_quality.recompute_output_checks(tmp_path, 2020, expected_years=[2020])
    coverage = next(check for check in checks if check["name"] == "row_keys_and_coverage")
    assert coverage["passed"] is False
    assert "missing_years=[2020]" in coverage["detail"]


@pytest.mark.parametrize("mutation", ["missing", "empty", "duplicate", "unknown", "severity"])
def test_output_qc_file_requires_exact_nonempty_check_set(tmp_path, mutation):
    _release(tmp_path)
    path = tmp_path / "qc_outputs_2020.json"
    checks = json.loads(path.read_text(encoding="utf-8"))
    if mutation == "missing":
        checks.pop()
    elif mutation == "empty":
        checks = []
    elif mutation == "duplicate":
        checks.append(dict(checks[0]))
    elif mutation == "unknown":
        checks[0]["name"] = "unknown_output_check"
    else:
        checks[0]["severity"] = "fatal"
    path.write_text(json.dumps(checks), encoding="utf-8")
    _rewrite_metadata(tmp_path, artifacts.dataset_metadata(tmp_path))

    with pytest.raises(artifacts.ArtifactContractError, match="output QC"):
        artifacts.validate_release(tmp_path)


def test_output_qc_contract_version_tamper_fails(tmp_path):
    _release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["output_qc_contract"]["version"] = 99
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(artifacts.ArtifactContractError, match="output QC contract"):
        artifacts.validate_release(tmp_path)


@pytest.mark.parametrize("mutation", ["missing", "unknown", "duplicate", "malformed", "severity"])
def test_regression_input_qc_requires_exact_nonempty_check_set(tmp_path, mutation):
    _release(tmp_path)
    path = tmp_path / regression_quality.REGRESSION_INPUT_QC_FILE
    checks = json.loads(path.read_text(encoding="utf-8"))
    if mutation == "missing":
        checks.pop()
    elif mutation == "unknown":
        checks[0]["name"] = "unknown_regression_check"
    elif mutation == "duplicate":
        checks.append(dict(checks[0]))
    elif mutation == "malformed":
        checks[0].pop("kind")
    else:
        checks[0]["severity"] = "fatal"
    path.write_text(json.dumps(checks), encoding="utf-8")
    _rewrite_metadata(tmp_path, artifacts.dataset_metadata(tmp_path))

    with pytest.raises(artifacts.ArtifactContractError, match="regression input QC"):
        artifacts.validate_release(tmp_path)


def test_regression_input_numeric_validation_rejects_string_and_infinity_without_coercion():
    values, invalid = regression_quality._finite_numeric(  # noqa: SLF001 - focused semantic boundary test
        pd.Series([0.2, "0.3", float("inf"), None]),
        allow_null=True,
    )

    assert values[:3].tolist() == [0.2, 0.3, float("inf")]
    assert invalid == 2


def _regression_qc_frame(*, granularity: str, treated_country: str = "BBB") -> pd.DataFrame:
    rows = []
    years = [2017, 2018, 2019, 2020]
    for country_index, country in enumerate(("AAA", "BBB", "CCC", "ROW")):
        for year_index, year in enumerate(years):
            treated = int(country == treated_country and year >= 2019)
            row = {
                "country": country,
                "year": year,
                "3_VA_GVC_share": 0.2 + 0.15 * country_index + 0.01 * year_index,
                "FVA_share": 0.1 + 0.03 * country_index + 0.01 * year_index,
                "3b_VA_GVC_C_share": 0.2 + 0.02 * country_index + 0.015 * year_index,
                "PLv_GVC": 1.0 + 0.1 * country_index + 0.02 * year_index,
                "betweenesscentrality": 0.05 * country_index + 0.01 * year_index,
            }
            for shock, treatment in shock_module.SHOCK_SPECS.values():
                row[shock] = 0.02 * treated
                row[treatment] = treated
            if granularity == "country_industry":
                row["industry"] = "s1"
                row["entity_id"] = f"{country}_s1"
            rows.append(row)
    return pd.DataFrame(rows)


def test_regression_input_outcome_claims_apply_row_filter_before_metrics():
    frames = {
        "country": _regression_qc_frame(granularity="country", treated_country="ROW"),
        "country_industry": _regression_qc_frame(granularity="country_industry", treated_country="ROW"),
    }
    # ROW still supplies every treatment timeline before filtering, but one treated
    # entity cannot supply a full-rank interaction policy pair under the joint gate.
    unfiltered = regression_quality._outcome_check(frames)  # noqa: SLF001
    sampled, excluded = regression_quality._runtime_default_sample_frames(frames)  # noqa: SLF001
    filtered = regression_quality._outcome_check(sampled, excluded_rows=excluded)  # noqa: SLF001

    assert unfiltered["passed"] is False
    assert "joint_rank': 1" in unfiltered["detail"]
    assert filtered["passed"] is False
    assert "sample_filter=exclude_country_ROW" in filtered["detail"]
    assert "sample_excluded_rows=[country=4,country_industry=4]" in filtered["detail"]
    assert "timing_error" in filtered["detail"]


def test_regression_input_interaction_drops_treated_entity_whose_only_pre_baseline_is_null():
    frame = _regression_qc_frame(granularity="country").loc[lambda data: data["country"].ne("ROW")].copy()
    pre_treated = frame["country"].eq("BBB") & frame["year"].lt(2019)
    frame.loc[pre_treated, "3_VA_GVC_share"] = float("nan")

    metrics, valid = regression_quality._interaction_slice_metrics(  # noqa: SLF001
        frame,
        outcome="FVA_share",
        shock="tariff_shock",
        treated="treated",
        entity="country",
        cluster="country",
    )

    assert valid is False
    assert metrics["retained_treated_entities"] == 0
    assert metrics["baseline_derived_missing_entities"] == ["BBB"]
    assert metrics["baseline_derived_dropped_entities"] == 1
    assert metrics["baseline_derived_dropped_rows"] == 4
    assert metrics["complete_case_rows_before_derived_baseline"] == 12
    assert metrics["complete_case_rows"] == 8
    assert metrics["did_centered_baseline_interaction"]["joint_rank"] == 0

    industry = frame.assign(industry="s1", entity_id=frame["country"] + "_s1")
    check = regression_quality._outcome_check(  # noqa: SLF001 - canonical release gate
        {"country": frame, "country_industry": industry}
    )
    assert check["passed"] is False
    assert "tariff:interaction" in check["detail"]
    assert "baseline_derived_dropped_entities': 1" in check["detail"]


def test_regression_input_interaction_accepts_historical_khm_c26_c27_missing_pre_outcomes():
    frame = _regression_qc_frame(granularity="country_industry").loc[lambda data: data["country"].ne("ROW")].copy()
    # Keep two moderator-distinct treated entities in the complete-case history so
    # the runtime joint policy design remains identified independently of KHM rows.
    aaa_post = frame["country"].eq("AAA") & frame["year"].ge(2019)
    frame.loc[aaa_post, "treated"] = 1
    frame.loc[aaa_post, "tariff_shock"] = 0.02
    khm_rows = []
    for industry, offset in (("C26", 0.04), ("C27", 0.09)):
        entity_rows = frame.loc[frame["country"].eq("BBB")].copy()
        entity_rows["country"] = "KHM"
        entity_rows["industry"] = industry
        entity_rows["entity_id"] = f"KHM_{industry}"
        entity_rows["3_VA_GVC_share"] += offset
        entity_rows.loc[entity_rows["year"].lt(2019), "FVA_share"] = float("nan")
        entity_rows.loc[entity_rows["year"].eq(2020), "3_VA_GVC_share"] = float("nan")
        khm_rows.append(entity_rows)
    frame = pd.concat([frame, *khm_rows], ignore_index=True)

    metrics, valid = regression_quality._interaction_slice_metrics(  # noqa: SLF001
        frame,
        outcome="FVA_share",
        shock="tariff_shock",
        treated="treated",
        entity="entity_id",
        cluster="country",
    )

    assert valid is True
    assert metrics["complete_case_rows"] == 16
    assert metrics["baseline_source_structural_null_rows"] == 2
    assert metrics["structural"]["baseline_all_entities_finite"] is True
    assert "3_VA_GVC_share" not in metrics["complete_case_required"]


def test_regression_input_interaction_uses_runtime_selected_entity_baseline_not_raw_variation():
    frame = _regression_qc_frame(granularity="country").loc[lambda data: data["country"].ne("ROW")].copy()
    # Every runtime-selected baseline row has 0.5. Raw post/later rows vary, so a
    # raw-row variance check would pass even though centering collapses the interaction.
    selected = frame["year"].isin([2017, 2018])
    frame.loc[selected, "3_VA_GVC_share"] = 0.5
    frame.loc[frame["year"].eq(2019), "3_VA_GVC_share"] = [0.1, 0.5, 0.9]
    frame.loc[frame["year"].eq(2020), "3_VA_GVC_share"] = [0.2, 0.8, 1.0]

    metrics, valid = regression_quality._interaction_slice_metrics(  # noqa: SLF001
        frame,
        outcome="FVA_share",
        shock="tariff_shock",
        treated="treated",
        entity="country",
        cluster="country",
    )

    assert frame["3_VA_GVC_share"].var() > 0
    assert valid is False
    assert metrics["structural"]["baseline_scope"] == "derived_entity_equal_centered"
    assert metrics["structural"]["baseline_range"] == 0.0
    assert metrics["did_centered_baseline_interaction"]["fully_absorbed"] is True
    assert metrics["intensity_centered_baseline_interaction"]["fully_absorbed"] is True


def _joint_interaction_qc_frame(moderators: dict[str, float]) -> pd.DataFrame:
    frame = _regression_qc_frame(granularity="country").loc[lambda data: data["country"].ne("ROW")].copy()
    treated_post = frame["country"].isin(["AAA", "BBB"]) & frame["year"].ge(2019)
    frame["treated"] = treated_post.astype(int)
    frame["tariff_shock"] = treated_post.astype(float) * 0.02
    frame["3_VA_GVC_share"] = frame["country"].map(moderators)
    return frame


def test_regression_input_interaction_rejects_proportional_joint_policy_columns():
    # Exact former false negative: the moderator varies globally, but all treated
    # entities share it, so both interaction norms are nonzero while each interaction
    # is proportional to its main policy column after entity/time demeaning.
    frame = _joint_interaction_qc_frame({"AAA": 0.4, "BBB": 0.4, "CCC": 0.8})

    metrics, valid = regression_quality._interaction_slice_metrics(  # noqa: SLF001
        frame,
        outcome="FVA_share",
        shock="tariff_shock",
        treated="treated",
        entity="country",
        cluster="country",
    )

    assert frame["3_VA_GVC_share"].nunique() > 1
    assert metrics["structural"]["baseline_range"] > 0
    centered = frame["country"].map({"AAA": -0.4 / 3, "BBB": -0.4 / 3, "CCC": 0.8 / 3})
    treated_post = frame["country"].isin(["AAA", "BBB"]) & frame["year"].ge(2019)
    policy = pd.DataFrame(
        {
            "treated×post": treated_post.astype(float),
            "treated×post×centered_base": treated_post.astype(float) * centered,
        }
    )
    within = regression_panel._twoway_demean(  # noqa: SLF001 - assert exact runtime rejection
        policy.to_numpy(), frame["country"].to_numpy(), frame["year"].to_numpy()
    )
    with pytest.raises(ValueError, match="核心解释变量之间存在完全共线性"):
        regression_panel._drop_collinear_columns(  # noqa: SLF001 - assert exact runtime rejection
            within, list(policy.columns), set(policy.columns)
        )

    for method in ("did", "intensity"):
        design = metrics[f"{method}_centered_baseline_interaction"]
        assert design["within_norm"] > regression_quality.WITHIN_ABSORPTION_TOLERANCE
        assert all(design["nonzero_policy_columns"].values())
        assert design["joint_rank"] == 1
        assert design["full_column_rank"] is False
        assert design["method"] == method
        assert design["shock"] == "tariff_shock"
        assert design["outcome"] == "FVA_share"
    assert valid is False

    industry = frame.assign(industry="s1", entity_id=frame["country"] + "_s1")
    check = regression_quality._outcome_check(  # noqa: SLF001 - release-QC integration assertion
        {"country": frame, "country_industry": industry}
    )
    assert check["passed"] is False
    assert (
        "country:FVA_share:tariff:scope=certified:method=did:shock=tariff_shock:outcome=FVA_share:joint_rank=1/2"
    ) in check["detail"]


def test_regression_input_interaction_accepts_noncollinear_joint_policy_columns():
    frame = _joint_interaction_qc_frame({"AAA": 0.2, "BBB": 0.5, "CCC": 0.8})

    metrics, valid = regression_quality._interaction_slice_metrics(  # noqa: SLF001
        frame,
        outcome="FVA_share",
        shock="tariff_shock",
        treated="treated",
        entity="country",
        cluster="country",
    )

    assert valid is True
    for method in ("did", "intensity"):
        design = metrics[f"{method}_centered_baseline_interaction"]
        assert design["finite_matrix"] is True
        assert all(design["nonzero_policy_columns"].values())
        assert design["joint_rank"] == design["required_rank"] == 2
        assert design["full_column_rank"] is True


def test_regression_input_interaction_drops_all_null_historical_entity_and_tests_retained_design():
    frame = _joint_interaction_qc_frame({"AAA": 0.2, "BBB": 0.5, "CCC": 0.8})
    historical = frame.loc[frame["country"].eq("CCC")].copy()
    historical["country"] = "DDD"
    historical["3_VA_GVC_share"] = float("nan")
    frame = pd.concat([frame, historical], ignore_index=True)

    metrics, valid = regression_quality._interaction_slice_metrics(  # noqa: SLF001
        frame,
        outcome="betweenesscentrality",
        shock="tariff_shock",
        treated="treated",
        entity="country",
        cluster="country",
    )

    assert valid is True
    assert metrics["baseline_derived_missing_entities"] == ["DDD"]
    assert metrics["baseline_derived_dropped_entities"] == 1
    assert metrics["baseline_derived_dropped_rows"] == 4
    assert metrics["complete_case_rows_before_derived_baseline"] == 16
    assert metrics["complete_case_rows"] == 12
    assert metrics["did_centered_baseline_interaction"]["joint_rank"] == 2
    assert metrics["intensity_centered_baseline_interaction"]["joint_rank"] == 2


def test_regression_input_optional_rank_one_design_does_not_block_canonical_tariff_certification():
    frame = _joint_interaction_qc_frame({"AAA": 0.2, "BBB": 0.5, "CCC": 0.8})
    industry = frame.assign(industry="s1", entity_id=frame["country"] + "_s1")

    check = regression_quality._outcome_check(  # noqa: SLF001 - bounded release-QC contract
        {"country": frame, "country_industry": industry}
    )

    assert check["passed"] is True
    assert "certified_interaction_slices=7" in check["detail"]
    assert "optional_runtime_interaction_slices=14" in check["detail"]
    assert "optional_runtime_unavailable=14" in check["detail"]
    assert "country:FVA_share:export_control" in check["detail"]
    assert "optional_design_unavailability_release_fatal=false" in check["detail"]
    assert "every_cross_product_certified=false" in check["detail"]


def test_regression_input_qc_allows_sparse_null_interaction_baseline_with_viable_slice(tmp_path):
    _release(tmp_path)
    for filename in ("panel_country.csv", "panel_industry.csv"):
        path = tmp_path / filename
        panel = pd.read_csv(path)
        panel.loc[panel["country"].eq("CCC") & panel["year"].eq(2019), "3_VA_GVC_share"] = float("nan")
        panel.to_csv(path, index=False)

    checks = regression_quality.recompute_regression_input_checks(tmp_path, expected_years=[2018, 2019, 2020])
    outcome = next(item for item in checks if item["name"] == "configured_outcomes")
    numeric = next(item for item in checks if item["name"] == "shock_control_fields")

    assert outcome["passed"] is True
    assert "interaction=canonical_tariff_runtime_timing_and_baseline_freeze_before_complete_case" in outcome["detail"]
    assert "country:FVA_share=1" in outcome["detail"]
    assert numeric["passed"] is True
    assert "interaction_baseline_structural_null_rows=[country=1,country_industry=1]" in numeric["detail"]


@pytest.mark.parametrize("bad_value", [float("inf"), "not-a-number"])
def test_regression_input_qc_rejects_nonfinite_or_malformed_nonnull_baseline(tmp_path, bad_value):
    _release(tmp_path)
    path = tmp_path / "panel_industry.csv"
    panel = pd.read_csv(path)
    if isinstance(bad_value, str):
        panel["3_VA_GVC_share"] = panel["3_VA_GVC_share"].astype(object)
    panel.loc[0, "3_VA_GVC_share"] = bad_value
    panel.to_csv(path, index=False)

    checks = regression_quality.recompute_regression_input_checks(tmp_path, expected_years=[2018, 2019, 2020])
    numeric = next(item for item in checks if item["name"] == "shock_control_fields")

    assert numeric["passed"] is False
    assert "country_industry:3_VA_GVC_share_invalid=" in numeric["detail"]


@pytest.mark.parametrize("collapse", ["null", "constant"])
def test_regression_input_qc_discloses_interaction_baseline_design_collapse(tmp_path, collapse):
    _release(tmp_path)
    for filename in ("panel_country.csv", "panel_industry.csv"):
        path = tmp_path / filename
        panel = pd.read_csv(path)
        if collapse == "null":
            panel.loc[panel["country"].ne("AAA"), "3_VA_GVC_share"] = float("nan")
        else:
            panel["3_VA_GVC_share"] = 0.4
        panel.to_csv(path, index=False)

    checks = regression_quality.recompute_regression_input_checks(tmp_path, expected_years=[2018, 2019, 2020])
    outcome = next(item for item in checks if item["name"] == "configured_outcomes")
    numeric = next(item for item in checks if item["name"] == "shock_control_fields")

    assert outcome["passed"] is False
    assert ":interaction:" in outcome["detail"]
    if collapse == "null":
        assert "baseline_derived_dropped_entities" in outcome["detail"]
        assert "'joint_rank': 0" in outcome["detail"]
        assert "baseline_error" not in outcome["detail"]
        assert numeric["passed"] is True
    else:
        assert "'baseline_range': 0.0" in outcome["detail"]

    _, summary = regression_quality.write_regression_input_qc(tmp_path, expected_years=[2018, 2019, 2020])
    assert summary["publishable"] is False
    assert "configured_outcomes" in summary["fatal"]


def test_regression_input_qc_rejects_fixed_weight_release_without_pretreatment_year(tmp_path):
    _release(tmp_path)
    for filename in ("panel_country.csv", "panel_industry.csv", "controls_country.csv", "demo_trade_war_tariffs.csv"):
        path = tmp_path / filename
        panel = pd.read_csv(path)
        panel = panel.loc[panel["year"].eq(2020)].copy()
        if filename.startswith("panel_"):
            panel.loc[panel.index[0], ["treated", "tariff_shock"]] = [1, 0.1]
        panel.to_csv(path, index=False)

    checks = regression_quality.recompute_regression_input_checks(tmp_path, expected_years=[2020])
    fixed = next(item for item in checks if item["name"] == "fixed_pretreatment_availability")
    timeline = next(item for item in checks if item["name"] == "treatment_timeline_preperiod")
    assert fixed["passed"] is False
    assert "no_release_year_before_first_treatment=2020" in fixed["detail"]
    assert timeline["passed"] is False
    structure = next(item for item in checks if item["name"] == "panel_keys_years_clusters")
    outcome = next(item for item in checks if item["name"] == "configured_outcomes")
    assert structure["passed"] is True
    assert outcome["passed"] is False


@pytest.mark.parametrize("collapse", ["constant_outcome", "one_time", "one_cluster", "insufficient_residual"])
def test_regression_input_qc_rejects_outcome_specific_structural_collapse(tmp_path, collapse):
    _release(tmp_path)
    path = tmp_path / "panel_country.csv"
    panel = pd.read_csv(path)
    if collapse == "constant_outcome":
        panel["FVA_share"] = 0.2
    elif collapse == "one_time":
        panel.loc[panel["year"].ne(2020), "FVA_share"] = float("nan")
    elif collapse == "one_cluster":
        panel.loc[panel["country"].ne("AAA"), "FVA_share"] = float("nan")
    else:
        panel.loc[panel["year"].eq(2018), "FVA_share"] = float("nan")
    panel.to_csv(path, index=False)

    checks = regression_quality.recompute_regression_input_checks(tmp_path, expected_years=[2018, 2019, 2020])
    outcome = next(item for item in checks if item["name"] == "configured_outcomes")
    assert outcome["passed"] is False
    assert "country:FVA_share" in outcome["detail"]


def test_regression_input_qc_missing_contract_file_and_summary_tamper_fail(tmp_path):
    _release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["regression_input_qc_contract"]["version"] = 99
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(artifacts.ArtifactContractError, match="regression input QC contract"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    (tmp_path / regression_quality.REGRESSION_INPUT_QC_FILE).unlink()
    _rewrite_metadata(tmp_path, artifacts.dataset_metadata(tmp_path))
    with pytest.raises(artifacts.ArtifactContractError, match="missing required artifacts"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["regression_input_qc"]["passed"] = []
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(artifacts.ArtifactContractError, match="regression input QC summary"):
        artifacts.validate_release(tmp_path)


def test_artifact_v10_is_rejected_and_v11_is_required(tmp_path):
    _release(tmp_path)
    _tamper_signed_metadata(tmp_path, lambda metadata: metadata.__setitem__("artifact_contract_version", 10))
    with pytest.raises(artifacts.ArtifactContractError, match="expected 11, got 10"):
        artifacts.validate_release(tmp_path)


def test_artifact_qc_boundary_requires_dataset_contract():
    payload = _valid_checks(quality.QC_SCOPE_ICIO)
    with pytest.raises(artifacts.ArtifactContractError, match="QC contract"):
        artifacts.validate_qc_payload(payload, scope=quality.QC_SCOPE_ICIO, contract=None)


def test_publication_policy_matches_every_contract_blocking_kind():
    blocking = artifacts.publication_policy_metadata()["blocking_kinds"]
    qc_contract = quality.qc_contract_metadata()["scopes"]
    for policy_scope, contract_scope in (("icio", "icio"), ("controls", "controls"), ("shocks", "shocks")):
        expected = {item["kind"] for item in qc_contract[contract_scope] if item["publication_blocking"]}
        assert set(blocking[policy_scope]) == expected

    output_contract = output_quality.output_qc_contract_metadata()["checks"]
    regression_contract = regression_quality.regression_input_qc_contract_metadata()["checks"]
    assert set(blocking["outputs"]) == {item["kind"] for item in output_contract if item["publication_blocking"]}
    assert set(blocking["regression_inputs"]) == {
        item["kind"] for item in regression_contract if item["publication_blocking"]
    }


def test_release_keeps_numeric_fatal_as_disclosure_but_forbids_override(tmp_path):
    _release(tmp_path)
    path = tmp_path / "qc_2020.json"
    checks = json.loads(path.read_text(encoding="utf-8"))
    numeric = next(check for check in checks if check["kind"] == "数值")
    numeric["passed"] = False
    numeric["severity"] = "fatal"
    path.write_text(json.dumps(checks, ensure_ascii=False), encoding="utf-8")
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["qc"]["years"]["2020"] = quality.summarize_serialized_checks(checks, override=False)
    metadata["integrity"] = artifacts.release_integrity_metadata(tmp_path, metadata["years"])
    _rewrite_metadata(tmp_path, metadata)
    assert artifacts.validate_release(tmp_path)["release_id"] == RELEASE_ID

    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["qc"]["years"]["2020"] = quality.summarize_serialized_checks(checks, override=True)
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(artifacts.ArtifactContractError, match="override is forbidden"):
        artifacts.validate_release(tmp_path)


def test_release_rejects_publication_policy_integrity_and_structural_tampering(tmp_path):
    _release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["publication_policy"]["mode"] = "forged"
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(artifacts.ArtifactContractError, match="publication policy"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["integrity"]["status"] = "failed"
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(artifacts.ArtifactContractError, match="integrity decision"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    path = tmp_path / "qc_2020.json"
    checks = json.loads(path.read_text(encoding="utf-8"))
    structural = next(check for check in checks if check["kind"] == "结构")
    structural.update({"passed": False, "severity": "fatal"})
    path.write_text(json.dumps(checks, ensure_ascii=False), encoding="utf-8")
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["qc"]["years"]["2020"] = quality.summarize_serialized_checks(checks)
    metadata["integrity"] = artifacts.release_integrity_metadata(tmp_path, metadata["years"])
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(artifacts.ArtifactContractError, match="integrity checks failed"):
        artifacts.validate_release(tmp_path)


def test_diagnostic_writers_block_structure_and_integrity_but_not_semantic_findings(tmp_path, monkeypatch):
    output_checks = [
        {
            "name": spec.name,
            "kind": spec.kind,
            "passed": spec.kind in {"structure", "integrity"},
            "detail": "fixture",
            "severity": "ok" if spec.kind in {"structure", "integrity"} else "fatal",
        }
        for spec in output_quality.OUTPUT_CHECK_SPECS
    ]
    monkeypatch.setattr(output_quality, "recompute_output_checks", lambda *_args, **_kwargs: output_checks)
    _, output_summary = output_quality.write_output_qc(tmp_path, 2020, expected_years=[2020])
    assert output_summary["publishable"] is False

    output_checks[0].update({"passed": False, "severity": "fatal"})
    with pytest.raises(output_quality.OutputQualityError, match="integrity checks failed"):
        output_quality.write_output_qc(tmp_path, 2020, expected_years=[2020])

    regression_checks = [
        {
            "name": spec.name,
            "kind": spec.kind,
            "passed": spec.kind in {"structure", "integrity"},
            "detail": "fixture",
            "severity": "ok" if spec.kind in {"structure", "integrity"} else "fatal",
        }
        for spec in regression_quality.REGRESSION_INPUT_CHECK_SPECS
    ]
    monkeypatch.setattr(
        regression_quality,
        "recompute_regression_input_checks",
        lambda *_args, **_kwargs: regression_checks,
    )
    _, regression_summary = regression_quality.write_regression_input_qc(tmp_path, expected_years=[2020])
    assert regression_summary["publishable"] is False

    regression_checks[0].update({"passed": False, "severity": "fatal"})
    with pytest.raises(regression_quality.RegressionInputQualityError, match="integrity checks failed"):
        regression_quality.write_regression_input_qc(tmp_path, expected_years=[2020])


@pytest.mark.parametrize("mutation", ["missing", "nonfinite"])
def test_output_runtime_numeric_integrity_blocks_malformed_required_fields(tmp_path, mutation):
    _release(tmp_path)
    path = tmp_path / "indicators_country_2020.csv"
    frame = pd.read_csv(path)
    if mutation == "missing":
        frame = frame.drop(columns="DVAex")
    else:
        frame.loc[frame.index[0], "DVAex"] = float("inf")
    frame.to_csv(path, index=False)

    checks = output_quality.recompute_output_checks(tmp_path, 2020, expected_years=[2018, 2019, 2020])
    integrity = next(check for check in checks if check["name"] == "required_numeric_fields")
    assert integrity["kind"] == "integrity" and integrity["passed"] is False
    assert "country:DVAex_" in integrity["detail"] or "country:missing=['DVAex']" in integrity["detail"]
    with pytest.raises(output_quality.OutputQualityError, match="required_numeric_fields"):
        output_quality.write_output_qc(tmp_path, 2020, expected_years=[2018, 2019, 2020])
    persisted = json.loads((tmp_path / "qc_outputs_2020.json").read_text(encoding="utf-8"))
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["output_qc"]["years"]["2020"] = output_quality.summarize_output_checks(persisted)
    metadata["integrity"] = artifacts.release_integrity_metadata(tmp_path, metadata["years"])
    _rewrite_metadata(tmp_path, metadata)
    with pytest.raises(artifacts.ArtifactContractError, match="integrity checks failed"):
        artifacts.validate_release(tmp_path)


def test_output_finite_identity_finding_remains_nonblocking(tmp_path):
    _release(tmp_path)
    path = tmp_path / "indicators_country_2020.csv"
    frame = pd.read_csv(path)
    frame.loc[frame.index[0], "DVAex"] += 0.25
    frame.to_csv(path, index=False)

    checks, summary = output_quality.write_output_qc(tmp_path, 2020, expected_years=[2018, 2019, 2020])
    integrity = next(check for check in checks if check["name"] == "required_numeric_fields")
    trade = next(check for check in checks if check["name"] == "trade_identities")
    assert integrity["passed"] is True
    assert trade["passed"] is False and trade["kind"] == "numeric"
    assert summary["publishable"] is False


@pytest.mark.parametrize("mutation", ["missing_shock", "nonfinite_control"])
def test_regression_runtime_field_integrity_blocks_malformed_inputs(tmp_path, mutation):
    _release(tmp_path)
    path = tmp_path / "panel_country.csv"
    frame = pd.read_csv(path)
    if mutation == "missing_shock":
        frame = frame.drop(columns="tariff_shock")
    else:
        frame.loc[frame.index[0], "macro_log_gdp_usd"] = float("inf")
    frame.to_csv(path, index=False)

    checks = regression_quality.recompute_regression_input_checks(tmp_path, expected_years=[2018, 2019, 2020])
    integrity = next(check for check in checks if check["name"] == "required_runtime_fields")
    assert integrity["kind"] == "integrity" and integrity["passed"] is False
    with pytest.raises(regression_quality.RegressionInputQualityError, match="required_runtime_fields"):
        regression_quality.write_regression_input_qc(tmp_path, expected_years=[2018, 2019, 2020])


def test_release_rejects_persisted_fatal_shock_override_claim(tmp_path):
    _release(tmp_path)
    path = tmp_path / "qc_shocks.json"
    checks = json.loads(path.read_text(encoding="utf-8"))
    checks[0].update({"passed": False, "severity": "fatal"})
    path.write_text(json.dumps(checks, ensure_ascii=False), encoding="utf-8")
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata["qc"]["shocks"] = quality.summarize_serialized_checks(checks, override=True)
    _rewrite_metadata(tmp_path, metadata)

    with pytest.raises(artifacts.ArtifactContractError, match="override is forbidden"):
        artifacts.validate_release(tmp_path)


def test_missing_or_unregistered_file_fails(tmp_path):
    _release(tmp_path)
    (tmp_path / "demo_trade_war_tariffs.csv").unlink()
    with pytest.raises(artifacts.ArtifactContractError, match="manifest mismatch"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    (tmp_path / "unregistered.csv").write_text("value\n1\n", encoding="utf-8")
    with pytest.raises(artifacts.ArtifactContractError, match="manifest mismatch"):
        artifacts.validate_release(tmp_path)


def test_same_size_tamper_and_truncation_fail_integrity(tmp_path):
    _release(tmp_path)
    target = tmp_path / "panel_country.csv"
    original_bytes = target.read_bytes()
    target.write_bytes(original_bytes.replace(b"AAA", b"AAB", 1))
    assert target.stat().st_size == len(original_bytes)
    with pytest.raises(artifacts.ArtifactContractError, match="checksum mismatch"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    target.write_text("value\n", encoding="utf-8")
    with pytest.raises(artifacts.ArtifactContractError, match="byte count mismatch"):
        artifacts.validate_release(tmp_path)


def test_manifest_format_must_match_artifact_extension(tmp_path):
    _release(tmp_path)
    metadata_path = tmp_path / artifacts.DATASET_METADATA
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    entry = next(item for item in metadata[artifacts.ARTIFACT_MANIFEST_NAME] if item["path"] == "panel_country.csv")
    entry["format"] = "binary"
    metadata[artifacts.METADATA_DIGEST_NAME] = artifacts._metadata_digest(metadata)
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    artifacts.clear_artifact_caches()

    with pytest.raises(artifacts.ArtifactContractError, match="format does not match"):
        artifacts.validate_release(tmp_path)


def test_wrong_course_missing_manifest_and_invalid_release_id_fail(tmp_path):
    _release(tmp_path, course_release="old")
    with pytest.raises(artifacts.ArtifactContractError, match="course_release mismatch"):
        artifacts.validate_release(tmp_path)

    _release(tmp_path)
    metadata = artifacts.dataset_metadata(tmp_path)
    metadata.pop("artifact_manifest")
    (tmp_path / artifacts.DATASET_METADATA).write_text(json.dumps(metadata), encoding="utf-8")
    artifacts.clear_artifact_caches()
    with pytest.raises(artifacts.ArtifactContractError, match="metadata checksum mismatch"):
        artifacts.validate_release(tmp_path, verify_integrity=False)

    metadata["artifact_manifest"] = []
    metadata["release_id"] = "legacy"
    (tmp_path / artifacts.DATASET_METADATA).write_text(json.dumps(metadata), encoding="utf-8")
    artifacts.clear_artifact_caches()
    with pytest.raises(artifacts.ArtifactContractError, match="release_id"):
        artifacts.validate_release(tmp_path)


def test_artifact_tree_rejects_symlinks(tmp_path):
    _release(tmp_path)
    target = tmp_path / "panel_country.csv"
    target.unlink()
    target.symlink_to("panel_industry.csv")
    with pytest.raises(artifacts.ArtifactContractError, match="symlink"):
        artifacts.validate_release(tmp_path)
