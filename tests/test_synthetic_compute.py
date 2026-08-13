"""轻量 synthetic compute 验收。

CI 中通常没有 66MB×多年 OECD ICIO 原始表,真实数据 API 测试会自动跳过。
这个测试用 conftest 的 2 国×2 行业小 IOSystem 跑完整 compute_year→build_panel
链路,确保预计算产物 schema、控制变量质检与面板拼接不会只在有真实数据时才被覆盖。
"""

import json

import pandas as pd
import pytest

from gvcsim import pipeline, publication, shocks
from gvcsim.data import controls
from gvcsim.data.quality import QcCheck
from gvcsim import config


def test_synthetic_compute_writes_panel_and_qc(tmp_path, fake_io, monkeypatch):
    processed = tmp_path / "processed"
    for module in (config, pipeline, controls, shocks):
        if hasattr(module, "PROCESSED_DIR"):
            monkeypatch.setattr(module, "PROCESSED_DIR", processed)
    monkeypatch.setattr(pipeline.loader, "load", lambda year: fake_io)

    for year in [2018, 2019]:
        pipeline.compute_year(year, verbose=False, allow_qc_override=True)
    panel = pipeline.build_panel(allow_qc_override=True)

    expected_files = [
        "indicators_country_2018.csv",
        "indicators_industry_2018.csv",
        "network_edges_2018.csv",
        "export_exposure_2018.csv",
        "controls_country.csv",
        "qc_controls.json",
        "qc_shocks.json",
        "panel_industry.csv",
        "panel_country.csv",
    ]
    for name in expected_files:
        assert (processed / name).exists(), name

    assert not (processed / "artifact_manifest.json").exists()
    assert not (processed / "dataset.json").exists()  # success sentinel belongs to pipeline.run

    controls_df = pd.read_csv(processed / "controls_country.csv")
    assert {"country", "year", "macro_log_gdp_usd", "gdp_deflator"}.issubset(controls_df.columns)
    assert len(controls_df) == 4  # 2 countries × 2 years

    controls_qc = json.loads((processed / "qc_controls.json").read_text(encoding="utf-8"))
    assert len(controls_qc) == 5
    assert all(c["passed"] for c in controls_qc), controls_qc

    assert len(panel) == 8  # 2 countries × 2 sectors × 2 years
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


def test_fatal_qc_blocks_release_unless_override_is_explicit():
    failed = [QcCheck(name="fatal example", kind="数值", passed=False)]
    with pytest.raises(pipeline.QualityGateError, match="停止发布"):
        pipeline._gate_qc("test", failed, False)
    summary = pipeline._gate_qc("test", failed, True)
    assert summary["publishable"] is True
    assert summary["override"] is True
    assert summary["fatal"] == ["fatal example"]


def _stub_release_build(monkeypatch, calls, *, fail_year=False):
    def year(number, **_kwargs):
        calls.append(f"year:{number}")
        if fail_year:
            raise RuntimeError("synthetic build failed")
        for name in (
            f"qc_{number}.json",
            f"export_exposure_{number}.csv",
            f"indicators_country_{number}.csv",
            f"indicators_industry_{number}.csv",
            f"network_edges_{number}.csv",
        ):
            (pipeline.PROCESSED_DIR / name).write_text("[]" if name.startswith("qc_") else "x\n1\n")

    def panel(**_kwargs):
        calls.append("panel")
        for name in (
            "panel_country.csv",
            "panel_industry.csv",
            "controls_country.csv",
            "demo_trade_war_tariffs.csv",
        ):
            (pipeline.PROCESSED_DIR / name).write_text("x\n1\n")
        for name in ("qc_controls.json", "qc_shocks.json"):
            (pipeline.PROCESSED_DIR / name).write_text("[]")

    monkeypatch.setattr(pipeline, "compute_year", year)
    monkeypatch.setattr(pipeline, "build_panel", panel)
    monkeypatch.setattr(pipeline, "artifact_data_sources", lambda _path: {})


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


def test_run_builds_sentinel_switches_pointer_and_never_touches_database(tmp_path, monkeypatch):
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
