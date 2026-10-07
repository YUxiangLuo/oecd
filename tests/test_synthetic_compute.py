"""轻量 synthetic compute 验收。

CI 中通常没有 66MB×多年 OECD ICIO 原始表,真实数据 API 测试会自动跳过。
这个测试用 conftest 的 2 国×2 行业小 IOSystem 跑完整 compute_year→build_panel
链路,确保预计算产物 schema、控制变量质检与面板拼接不会只在有真实数据时才被覆盖。
"""

import json

import pandas as pd
import pytest

from gvcsim import artifacts, pipeline, publication, shocks
from gvcsim.data import controls, output_quality, quality, raw_icio, regression_quality
from gvcsim.data.citations import artifact_data_sources
from gvcsim.data.quality import QcCheck
from gvcsim import config


def _install_complete_exposure_writer(monkeypatch):
    """Keep the tiny IO fixture synthetic while satisfying the production key contract."""

    def write(arr, year):
        frame = shocks.build_export_exposure(arr, year)
        shocks.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
        frame.to_csv(shocks.PROCESSED_DIR / f"export_exposure_{year}.csv", index=False)
        return frame

    monkeypatch.setattr(shocks, "write_export_exposure", write)


def _rename_fake_destination_to_usa(fake_io):
    """Make the compact two-country IO table satisfy the explicit USA contract."""
    fake_io._regions = ["AAA", "USA"]
    for name in ("Z", "A", "L"):
        frame = getattr(fake_io, name)
        frame.index = frame.index.set_levels(["AAA", "USA"], level="region")
        frame.columns = frame.columns.set_levels(["AAA", "USA"], level="region")
    for name in ("Y",):
        frame = getattr(fake_io, name)
        frame.index = frame.index.set_levels(["AAA", "USA"], level="region")
        frame.columns = frame.columns.set_levels(["AAA", "USA"], level="region")
    for value in (fake_io.x, fake_io.unit):
        value.index = value.index.set_levels(["AAA", "USA"], level="region")
    fake_io.reported_output.index = fake_io.reported_output.index.set_levels(["AAA", "USA"], level="region")
    fake_io.factor_inputs.F.columns = fake_io.factor_inputs.F.columns.set_levels(["AAA", "USA"], level="region")


def test_synthetic_compute_writes_panel_and_qc(tmp_path, fake_io, monkeypatch):
    _rename_fake_destination_to_usa(fake_io)
    processed = tmp_path / "processed"
    for module in (config, pipeline, controls, shocks):
        if hasattr(module, "PROCESSED_DIR"):
            monkeypatch.setattr(module, "PROCESSED_DIR", processed)
    monkeypatch.setattr(pipeline.loader, "load", lambda year: fake_io)
    monkeypatch.setattr(quality, "KEY_REGIONS", ["AAA", "USA"])
    _install_complete_exposure_writer(monkeypatch)

    years = list(range(2016, 2021))
    for year in years:
        pipeline.compute_year(year, verbose=False)
    panel = pipeline.build_panel()
    output_summaries = {
        year: output_quality.write_output_qc(processed, year, expected_years=years)[1] for year in years
    }
    regression_summary = regression_quality.write_regression_input_qc(processed, expected_years=years)[1]
    regression_checks = json.loads(
        (processed / regression_quality.REGRESSION_INPUT_QC_FILE).read_text(encoding="utf-8")
    )

    expected_files = [
        "indicators_country_2018.csv",
        "indicators_industry_2018.csv",
        "network_edges_2018.csv",
        "export_exposure_2018.csv",
        "tariff_exposure_lookup.csv",
        "qc_outputs_2018.json",
        "qc_regression_inputs.json",
        "controls_country.csv",
        "qc_controls.json",
        "qc_shocks.json",
        "panel_industry.csv",
        "panel_country.csv",
        "panel_teaching.csv",
    ]
    for name in expected_files:
        assert (processed / name).exists(), name

    assert not (processed / "artifact_manifest.json").exists()
    assert not (processed / "dataset.json").exists()  # success sentinel belongs to pipeline.run

    controls_df = pd.read_csv(processed / "controls_country.csv")
    assert {"country", "year", "macro_log_gdp_usd", "gdp_deflator"}.issubset(controls_df.columns)
    assert len(controls_df) == 10  # 2 countries × 5 years

    controls_qc = json.loads((processed / "qc_controls.json").read_text(encoding="utf-8"))
    assert len(controls_qc) == 5
    assert all(c["passed"] for c in controls_qc), controls_qc

    assert len(panel) == 20  # 2 countries × 2 sectors × 5 years
    assert {
        "entity_id",
        "tariff_shock",
        "treated",
        "tariff_shock_contemporaneous",
        "treated_contemporaneous",
        "macro_log_gdp_usd",
    }.issubset(panel.columns)
    # 文献指标字段与回归派生列都应进入面板。
    assert {"DVAex", "taxsub", "SVA", "PLv_GVC", "betweenesscentrality"}.issubset(panel.columns)
    assert {"gross_exports", "FVA_share", "3b_VA_GVC_C_share", "3_VA_GVC_share"}.issubset(panel.columns)
    assert all(summary["publishable"] for summary in output_summaries.values())
    assert regression_quality.summarize_regression_input_checks(regression_checks)["publishable"] is False
    assert regression_summary["publishable"] is False
    assert all(
        output_quality.recompute_output_checks(processed, year, expected_years=years)
        == json.loads((processed / f"qc_outputs_{year}.json").read_text(encoding="utf-8"))
        for year in years
    )


def test_degenerate_synthetic_staged_release_discloses_regression_design_findings(tmp_path, fake_io, monkeypatch):
    _rename_fake_destination_to_usa(fake_io)
    # This per-test compact raw contract is independent of the repository-wide
    # CI fixture and deliberately has no .ci-only-synthetic.json marker.
    monkeypatch.delenv("GVCSIM_CI_SYNTHETIC", raising=False)
    staging = tmp_path / "staging"
    staging.mkdir()
    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()
    contract = raw_icio.DimensionContract("synthetic-staged-release", 1, ("AAA", "USA"), ("s1", "s2"), ("HFCE",))
    header = ["V1", *contract.industry_labels, *contract.final_demand_labels, "OUT"]
    rows = []
    for index, label in enumerate(contract.industry_labels):
        rows.append(
            [
                label,
                *fake_io.Z.iloc[index].tolist(),
                *fake_io.Y.iloc[index].tolist(),
                float(fake_io.x.iloc[index, 0]),
            ]
        )
    rows.extend([[account, *([0.1] * (len(header) - 1))] for account in ("TLS", "VA", "OUT")])
    for year in range(2016, 2021):
        pd.DataFrame(rows, columns=header).to_csv(raw_dir / f"ICIO2023_{year}.csv", index=False)

    monkeypatch.setattr(pipeline, "RAW_DATA_DIR", raw_dir)
    monkeypatch.setattr(config, "RAW_DATA_DIR", raw_dir)
    monkeypatch.setattr(raw_icio, "production_dimension_contract", lambda: contract)
    raw_icio.clear_raw_validation_cache()
    monkeypatch.setattr(pipeline.loader, "load", lambda _year: fake_io)
    monkeypatch.setattr(quality, "KEY_REGIONS", ["AAA", "USA"])
    _install_complete_exposure_writer(monkeypatch)

    pipeline._build_staged_release(staging, list(range(2016, 2021)), release_id="3" * 32)

    assert (staging / "qc_outputs_2020.json").is_file()
    assert (staging / regression_quality.REGRESSION_INPUT_QC_FILE).is_file()
    metadata = artifacts.dataset_metadata(staging)
    assert metadata["integrity"]["status"] == "passed"
    assert metadata["regression_input_qc"]["publishable"] is False
    assert "configured_outcomes" in metadata["regression_input_qc"]["fatal"]


def test_integrity_gate_blocks_structure_but_not_economic_diagnostics():
    diagnostics = [
        QcCheck(name="structure ok", kind="结构", passed=True),
        QcCheck(name="economic finding", kind="经济含义", passed=False),
    ]
    blocking = artifacts.publication_policy_metadata()["blocking_kinds"]["icio"]
    summary = pipeline._gate_integrity("test", diagnostics, blocking)
    assert summary["passed"] is True
    failed = [QcCheck(name="structure failed", kind="结构", passed=False)]
    with pytest.raises(pipeline.QualityGateError, match="停止发布"):
        pipeline._gate_integrity("test", failed, blocking)


def _contract_checks(scope: str) -> list[dict]:
    return [
        {
            "name": name,
            "kind": quality.QC_EXPECTED_KINDS[scope][index],
            "passed": True,
            "detail": "ok",
            "warnings": [],
            "severity": "ok",
        }
        for index, name in enumerate(quality.QC_EXPECTED_CHECKS[scope])
    ]


def _stub_release_build(monkeypatch, calls, *, fail_year=False):
    def year(number, **_kwargs):
        calls.append(f"year:{number}")
        if fail_year:
            raise RuntimeError("synthetic build failed")
        (pipeline.PROCESSED_DIR / f"qc_{number}.json").write_text(
            json.dumps(_contract_checks(quality.QC_SCOPE_ICIO), ensure_ascii=False)
        )
        exposure_name = f"export_exposure_{number}.csv"
        (pipeline.PROCESSED_DIR / exposure_name).write_text(
            f"country,imposer,year,bilateral_exports,total_exports,export_exposure\nAAA,AAA,{number},0,0,0\n"
        )
        for name in (
            f"indicators_country_{number}.csv",
            f"indicators_industry_{number}.csv",
            f"network_edges_{number}.csv",
        ):
            (pipeline.PROCESSED_DIR / name).write_text("x\n1\n")

    def panel(**_kwargs):
        calls.append("panel")
        for name in ("controls_country.csv", "demo_trade_war_tariffs.csv", "tariff_exposure_lookup.csv"):
            (pipeline.PROCESSED_DIR / name).write_text("x\n1\n")
        (pipeline.PROCESSED_DIR / "panel_country.csv").write_text("country,year\nAAA,2020\n")
        (pipeline.PROCESSED_DIR / "panel_industry.csv").write_text(
            "country,industry,entity_id,year\nAAA,s1,AAA_s1,2020\n"
        )
        (pipeline.PROCESSED_DIR / "panel_teaching.csv").write_text(
            "country,industry,entity_id,year\nAAA,s1,AAA_s1,2020\n"
        )
        (pipeline.PROCESSED_DIR / "qc_controls.json").write_text(
            json.dumps(_contract_checks(quality.QC_SCOPE_CONTROLS), ensure_ascii=False)
        )
        (pipeline.PROCESSED_DIR / "qc_shocks.json").write_text(
            json.dumps(_contract_checks(quality.QC_SCOPE_SHOCKS), ensure_ascii=False)
        )

    def output_qc(directory, number, *, expected_years):
        del expected_years
        checks = [
            {
                "name": spec.name,
                "kind": spec.kind,
                "passed": True,
                "detail": "stubbed publication-order fixture",
                "severity": "ok",
            }
            for spec in output_quality.OUTPUT_CHECK_SPECS
        ]
        (directory / f"qc_outputs_{number}.json").write_text(json.dumps(checks), encoding="utf-8")
        return checks, output_quality.summarize_output_checks(checks)

    def regression_input_qc(directory, *, expected_years):
        del expected_years
        checks = [
            {
                "name": spec.name,
                "kind": spec.kind,
                "passed": True,
                "detail": "stubbed publication-order fixture",
                "severity": "ok",
            }
            for spec in regression_quality.REGRESSION_INPUT_CHECK_SPECS
        ]
        (directory / regression_quality.REGRESSION_INPUT_QC_FILE).write_text(json.dumps(checks), encoding="utf-8")
        return checks, regression_quality.summarize_regression_input_checks(checks)

    monkeypatch.setattr(pipeline, "compute_year", year)
    monkeypatch.setattr(pipeline, "build_panel", panel)
    monkeypatch.setattr(pipeline.output_quality, "write_output_qc", output_qc)
    monkeypatch.setattr(pipeline.regression_quality, "write_regression_input_qc", regression_input_qc)
    monkeypatch.setattr(artifacts, "_validate_release_output_qc", lambda *_args: None)
    monkeypatch.setattr(artifacts, "_validate_release_regression_input_qc", lambda *_args: None)
    monkeypatch.setattr(pipeline, "artifact_data_sources", lambda _path: artifact_data_sources(config.RAW_DATA_DIR))


def test_release_metadata_rejects_empty_qc_before_publication(tmp_path):
    (tmp_path / "qc_2020.json").write_text("[]", encoding="utf-8")
    (tmp_path / "qc_controls.json").write_text(
        json.dumps(_contract_checks(quality.QC_SCOPE_CONTROLS), ensure_ascii=False),
        encoding="utf-8",
    )
    (tmp_path / "qc_shocks.json").write_text(
        json.dumps(_contract_checks(quality.QC_SCOPE_SHOCKS), ensure_ascii=False),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="非空"):
        pipeline._release_qc_metadata(tmp_path, [2020])

    (tmp_path / "qc_2020.json").write_text(
        json.dumps(_contract_checks(quality.QC_SCOPE_ICIO), ensure_ascii=False),
        encoding="utf-8",
    )
    summary = pipeline._release_qc_metadata(tmp_path, [2020])
    assert summary["years"]["2020"]["override"] is False


def _old_pointer(tmp_path):
    current = tmp_path / "processed"
    store = publication.release_store(current)
    store.mkdir()
    old_release = store / ("0" * 32)
    old_release.mkdir()
    (old_release / "legacy.txt").write_text("old")
    current.symlink_to(__import__("os").path.relpath(old_release, current.parent), target_is_directory=True)
    return current, old_release


def test_promote_staging_renames_complete_tree(tmp_path):
    staging = tmp_path / ".build-release"
    nested = staging / "nested"
    nested.mkdir(parents=True)
    (staging / "root.csv").write_text("value\n1\n")
    (nested / "payload.json").write_text("[]")
    final = tmp_path / "release"
    publication.promote_staging(staging, final)

    assert final.is_dir() and (final / "nested" / "payload.json").is_file()


def test_run_builds_sentinel_switches_pointer_and_never_touches_database(tmp_path, monkeypatch, capsys):
    current, _old_release = _old_pointer(tmp_path)
    monkeypatch.setattr(pipeline, "PROCESSED_DIR", current)
    calls = []
    _stub_release_build(monkeypatch, calls)

    monkeypatch.setattr("gvcsim.classroom.db.reset_learning_records", lambda: pytest.fail("compute must not touch DB"))
    pipeline.run([2020])

    assert calls == ["year:2020", "panel"]
    assert current.is_symlink()
    assert not __import__("os").path.isabs(__import__("os").readlink(current))
    releases = {path.resolve() for path in publication.release_store(current).iterdir()}
    assert releases == {current.resolve(), _old_release.resolve()}
    metadata = json.loads((current / "dataset.json").read_text())
    assert metadata["years"] == [2020]
    assert metadata["course_release"] == config.COURSE_RELEASE
    assert set(metadata["qc"]) == {"years", "controls", "shocks"}
    assert metadata["qc_contract"] == quality.qc_contract_metadata()
    assert metadata["shock_contract"] == shocks.shock_contract_metadata()
    assert metadata["artifact_contract_version"] == 16
    assert metadata["publication_policy"] == artifacts.publication_policy_metadata()
    assert metadata["integrity"]["status"] == "passed"
    assert metadata["output_qc_contract"] == output_quality.output_qc_contract_metadata()
    assert set(metadata["output_qc"]["years"]) == {"2020"}
    assert metadata["regression_input_qc_contract"] == regression_quality.regression_input_qc_contract_metadata()
    assert metadata["regression_input_qc"]["publishable"] is True
    output = capsys.readouterr().out
    assert "[release] 构建跨年面板、控制变量与冲击面板" in output
    assert "[release] 执行逐年输出语义 QC" in output
    assert "[release] 执行回归输入 QC" in output
    assert "[release] 校验完整 release 的哈希、结构与 QC contract" in output
    assert "[release] 暂存 release 已通过全部发布门禁" in output


@pytest.mark.parametrize("failure", ["build", "validation"])
def test_build_or_validation_failure_preserves_old_release(tmp_path, monkeypatch, failure):
    current, _old_release = _old_pointer(tmp_path)
    monkeypatch.setattr(pipeline, "PROCESSED_DIR", current)
    calls = []
    _stub_release_build(monkeypatch, calls, fail_year=failure == "build")
    validation = []
    if failure == "validation":

        def reject_validation(_path, **kwargs):
            validation.append(kwargs)
            raise RuntimeError("validation failed")

        monkeypatch.setattr(pipeline, "validate_release", reject_validation)

    with pytest.raises(RuntimeError, match="failed"):
        pipeline.run([2020])

    if failure == "validation":
        assert validation == [{}]
    assert current.is_symlink() and current.resolve() == _old_release.resolve()


def test_compute_lock_rejects_concurrent_run(tmp_path, monkeypatch):
    current = tmp_path / "processed"
    monkeypatch.setattr(pipeline, "PROCESSED_DIR", current)
    with publication.compute_lock(current):
        with pytest.raises(publication.ComputeLocked, match="正在运行"):
            pipeline.run([2020])


def test_run_rejects_non_symlink_fixed_directory(tmp_path, monkeypatch):
    current = tmp_path / "processed"
    current.mkdir()
    (current / "legacy.txt").write_text("old")
    monkeypatch.setattr(pipeline, "PROCESSED_DIR", current)
    calls = []
    _stub_release_build(monkeypatch, calls)
    with pytest.raises(publication.PublicationError, match="符号链接"):
        pipeline.run([2020])
    assert current.is_dir() and not current.is_symlink()
    assert (current / "legacy.txt").read_text() == "old"


def test_existing_pointer_is_preserved_if_pointer_switch_fails(tmp_path, monkeypatch):
    current, old_release = _old_pointer(tmp_path)
    staging, final = publication.create_staging_release(current)
    (staging / "new.txt").write_text("new")
    publication.promote_staging(staging, final)
    monkeypatch.setattr(publication.os, "replace", lambda *_args: (_ for _ in ()).throw(OSError("switch failed")))

    with pytest.raises(OSError, match="switch failed"):
        publication.publish_release(current, final)

    assert current.is_symlink()
    assert current.resolve() == old_release.resolve()
