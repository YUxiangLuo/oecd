"""轻量 synthetic compute 验收。

CI 中通常没有 66MB×多年 OECD ICIO 原始表,真实数据 API 测试会自动跳过。
这个测试用 conftest 的 2 国×2 行业小 IOSystem 跑完整 compute_year→build_panel
链路,确保预计算产物 schema、控制变量质检与面板拼接不会只在有真实数据时才被覆盖。
"""

import json
import stat

import pandas as pd
import pytest

from gvcsim import pipeline, shocks
from gvcsim.data import controls
from gvcsim.data.quality import QcCheck
from gvcsim import config


def test_synthetic_compute_writes_panel_and_qc(tmp_path, fake_io, monkeypatch):
    processed = tmp_path / "processed"
    shock_dir = tmp_path / "shocks"
    for module in (config, pipeline, controls, shocks):
        if hasattr(module, "PROCESSED_DIR"):
            monkeypatch.setattr(module, "PROCESSED_DIR", processed)
    monkeypatch.setattr(shocks, "SHOCKS_DIR", shock_dir)
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
        "artifact_manifest.json",
    ]
    for name in expected_files:
        assert (processed / name).exists(), name

    manifest = json.loads((processed / "artifact_manifest.json").read_text(encoding="utf-8"))
    required_sources = {
        "gvcsim/pipeline.py",
        "gvcsim/artifacts.py",
        "gvcsim/data/loader.py",
        "gvcsim/data/quality.py",
        "gvcsim/data/controls.py",
        "gvcsim/indicators/core.py",
        "gvcsim/indicators/tradeflow.py",
        "gvcsim/indicators/production.py",
        "gvcsim/indicators/length.py",
        "gvcsim/indicators/network.py",
        "gvcsim/regression/design.py",
        "gvcsim/regression/panel.py",
    }
    assert required_sources.issubset(manifest["sources"])
    assert manifest["build"]["source_count"] == len(manifest["sources"])
    assert len(manifest["build"]["source_tree_sha256"]) == 64
    assert manifest["build"]["git_dirty"] in {True, False, None}
    assert manifest["build"]["runtime"]["python"]
    assert {"numpy", "pandas", "pymrio", "networkit", "scipy", "linearmodels"}.issubset(
        manifest["build"]["runtime"]["packages"]
    )

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


def test_staged_release_switches_current_atomically_and_preserves_legacy(tmp_path):
    current = tmp_path / "processed"
    current.mkdir()
    (current / "legacy.txt").write_text("old", encoding="utf-8")
    staging = tmp_path / "staging"
    staging.mkdir()
    artifact = staging / "panel.csv"
    artifact.write_text("x\n1\n", encoding="utf-8")
    pipeline.register_artifacts(staging, [artifact.name])

    release_id, release = pipeline._publish_staged_release(staging, current)
    assert current.is_symlink()
    assert current.resolve() == release.resolve()
    assert (current / "panel.csv").is_file()
    assert release.name == release_id
    assert stat.S_IMODE(release.stat().st_mode) == 0o750
    assert stat.S_IMODE((release / "panel.csv").stat().st_mode) == 0o640
    assert stat.S_IMODE((release / "manifest_history").stat().st_mode) == 0o750
    assert stat.S_IMODE(next((release / "manifest_history").glob("*.json")).stat().st_mode) == 0o640
    legacy_dirs = [path for path in (tmp_path / "artifacts").glob("legacy-*")]
    assert len(legacy_dirs) == 1
    assert (legacy_dirs[0] / "legacy.txt").read_text(encoding="utf-8") == "old"


def test_publish_refuses_to_reuse_a_corrupted_existing_release(tmp_path):
    current = tmp_path / "processed"
    first_staging = tmp_path / "first-staging"
    first_staging.mkdir()
    (first_staging / "panel.csv").write_text("x\n1\n", encoding="utf-8")
    pipeline.register_artifacts(first_staging, ["panel.csv"])
    _, release = pipeline._publish_staged_release(first_staging, current)
    release_manifest = (release / "artifact_manifest.json").read_text(encoding="utf-8")

    second_staging = tmp_path / "second-staging"
    second_staging.mkdir()
    (second_staging / "panel.csv").write_text("x\n1\n", encoding="utf-8")
    pipeline.register_artifacts(second_staging, ["panel.csv"])
    assert (second_staging / "artifact_manifest.json").read_text(encoding="utf-8") == release_manifest

    (release / "panel.csv").chmod(0o640)
    (release / "panel.csv").write_text("x\n9\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="摘要不一致"):
        pipeline._publish_staged_release(second_staging, current)
    assert second_staging.exists()
