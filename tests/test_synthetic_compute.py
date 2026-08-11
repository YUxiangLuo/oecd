"""轻量 synthetic compute 验收。

CI 中通常没有 66MB×多年 OECD ICIO 原始表,真实数据 API 测试会自动跳过。
这个测试用 conftest 的 2 国×2 行业小 IOSystem 跑完整 compute_year→build_panel
链路,确保预计算产物 schema、控制变量质检与面板拼接不会只在有真实数据时才被覆盖。
"""

import json
import os

import pandas as pd
import pytest

from gvcsim import artifacts, pipeline, publication, shocks
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
    old_release = tmp_path / "old-release"
    old_release.mkdir()
    (old_release / "legacy.txt").write_text("old")
    current.symlink_to("old-release", target_is_directory=True)
    return current, old_release


def _valid_release(current, name="new-release"):
    release = publication.release_store(current) / name
    release.mkdir(parents=True)
    for filename in (
        "panel_country.csv",
        "panel_industry.csv",
        "controls_country.csv",
        "demo_trade_war_tariffs.csv",
        "export_exposure_2020.csv",
        "indicators_country_2020.csv",
        "indicators_industry_2020.csv",
        "network_edges_2020.csv",
    ):
        (release / filename).write_text("value\n1\n")
    for filename in ("qc_2020.json", "qc_controls.json", "qc_shocks.json"):
        (release / filename).write_text("[]")
    artifacts.write_dataset_metadata(
        release,
        [2020],
        metadata={"course_release": config.COURSE_RELEASE},
    )
    return release


def test_promote_staging_fsyncs_release_tree_before_rename(tmp_path, monkeypatch):
    staging = tmp_path / ".build-release"
    nested = staging / "nested"
    nested.mkdir(parents=True)
    (staging / "root.csv").write_text("value\n1\n")
    (nested / "payload.json").write_text("[]")
    final = tmp_path / "release"
    fsync_calls = []
    monkeypatch.setattr(publication.os, "fsync", lambda descriptor: fsync_calls.append(descriptor))

    publication.promote_staging(staging, final)

    assert final.is_dir() and (final / "nested" / "payload.json").is_file()
    assert len(fsync_calls) >= 5  # two files, two directories, then the parent after rename


def test_run_builds_sentinel_then_atomically_switches_pointer_and_resets(tmp_path, monkeypatch):
    current, old_release = _old_pointer(tmp_path)
    monkeypatch.setattr(pipeline, "PROCESSED_DIR", current)
    calls = []
    _stub_release_build(monkeypatch, calls)

    def reset():
        calls.append("reset")
        assert current.is_symlink()
        assert (current / "dataset.json").is_file()
        assert os.readlink(current) != "old-release"
        assert publication.read_journal(current).phase == "pointer_switched"

    monkeypatch.setattr("gvcsim.classroom.db.reset_learning_records", reset)
    pipeline.run([2020])

    assert calls == ["year:2020", "panel", "reset"]
    assert current.is_symlink()
    assert not os.path.isabs(os.readlink(current))
    assert old_release.is_dir() and (old_release / "legacy.txt").read_text() == "old"
    assert not publication.journal_path(current).exists()
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
        assert validation == [{"verify_integrity": True, "allow_legacy": False}]
    assert current.is_symlink() and os.readlink(current) == "old-release"
    assert not publication.journal_path(current).exists()


def test_compute_lock_rejects_concurrent_run(tmp_path, monkeypatch):
    current = tmp_path / "processed"
    monkeypatch.setattr(pipeline, "PROCESSED_DIR", current)
    with publication.compute_lock(current):
        with pytest.raises(publication.ComputeLocked, match="正在运行"):
            pipeline.run([2020])


def test_run_migrates_legacy_real_directory_and_retains_it(tmp_path, monkeypatch):
    current = tmp_path / "processed"
    current.mkdir()
    (current / "legacy.txt").write_text("old")
    monkeypatch.setattr(pipeline, "PROCESSED_DIR", current)
    calls = []
    _stub_release_build(monkeypatch, calls)
    monkeypatch.setattr("gvcsim.classroom.db.reset_learning_records", lambda: calls.append("reset"))

    pipeline.run([2020])

    assert current.is_symlink()
    store = publication.release_store(current)
    legacy = list(store.glob("legacy-*"))
    assert len(legacy) == 1
    assert (legacy[0] / "legacy.txt").read_text() == "old"
    assert (current / "dataset.json").is_file()


def test_reset_failure_rolls_back_pointer_and_recovery_finishes_pending_release(tmp_path, monkeypatch):
    current, _old_release = _old_pointer(tmp_path)
    monkeypatch.setattr(pipeline, "PROCESSED_DIR", current)
    calls = []
    _stub_release_build(monkeypatch, calls)

    def fail_reset():
        calls.append("reset-failed")
        raise RuntimeError("database reset failed")

    monkeypatch.setattr("gvcsim.classroom.db.reset_learning_records", fail_reset)
    with pytest.raises(RuntimeError, match="database reset failed"):
        pipeline.run([2020])

    assert current.is_symlink() and os.readlink(current) == "old-release"
    assert publication.journal_path(current).is_file()
    pending = publication.read_journal(current)
    assert pending.phase == "reset_failed_rolled_back"

    monkeypatch.setattr("gvcsim.classroom.db.reset_learning_records", lambda: calls.append("reset-recovered"))
    pipeline.recover_pending()

    assert current.is_symlink() and os.readlink(current) == pending.new_target
    assert (current / "dataset.json").is_file()
    assert not publication.journal_path(current).exists()
    assert calls[-2:] == ["reset-failed", "reset-recovered"]


@pytest.mark.parametrize("phase", ["prepared", "legacy_migrated", "pointer_switched"])
def test_recovery_finishes_each_persisted_phase(tmp_path, monkeypatch, phase):
    current, _old_release = _old_pointer(tmp_path)
    monkeypatch.setattr(pipeline, "PROCESSED_DIR", current)
    release = _valid_release(current)
    new_target = publication.relative_target(current, release, new_release=True)
    if phase == "pointer_switched":
        publication.publish_pointer(current, new_target, new_release=True)
    publication.write_journal(
        current,
        publication.PublicationJournal(1, "old-release", new_target, phase),
    )
    resets = []
    monkeypatch.setattr("gvcsim.classroom.db.reset_learning_records", lambda: resets.append(True))

    pipeline.recover_pending()

    assert os.readlink(current) == new_target
    assert resets == [True]
    assert not publication.journal_path(current).exists()


def test_recovery_prepared_phase_migrates_legacy_real_directory(tmp_path, monkeypatch):
    current = tmp_path / "processed"
    current.mkdir()
    (current / "legacy.txt").write_text("old")
    monkeypatch.setattr(pipeline, "PROCESSED_DIR", current)
    release = _valid_release(current)
    new_target = publication.relative_target(current, release, new_release=True)
    old_target = publication.relative_target(current, publication.release_store(current) / "legacy-retained")
    publication.write_journal(current, publication.PublicationJournal(1, old_target, new_target, "prepared"))
    monkeypatch.setattr("gvcsim.classroom.db.reset_learning_records", lambda: None)

    pipeline.recover_pending()

    assert current.is_symlink() and os.readlink(current) == new_target
    assert (publication.release_store(current) / "legacy-retained" / "legacy.txt").read_text() == "old"


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ("not json", "损坏"),
        ({"version": 99, "old_target": None, "new_target": ".processed-releases/new", "phase": "prepared"}, "版本"),
        ({"version": 1, "old_target": None, "new_target": "processed", "phase": "prepared"}, "不能指向自身"),
        ({"version": 1, "old_target": None, "new_target": "../escape", "phase": "prepared"}, "越出"),
        (
            {"version": 1, "old_target": "../escape", "new_target": ".processed-releases/new", "phase": "prepared"},
            "越出",
        ),
    ],
)
def test_journal_rejects_corrupt_unsupported_and_unsafe_targets(tmp_path, payload, message):
    current = tmp_path / "processed"
    _valid_release(current, "new")
    path = publication.journal_path(current)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload if isinstance(payload, str) else json.dumps(payload))

    with pytest.raises(publication.PublicationError, match=message):
        publication.read_journal(current)


def test_journal_rejects_new_release_symlink_alias(tmp_path):
    current = tmp_path / "processed"
    release = _valid_release(current, "real")
    alias = publication.release_store(current) / "alias"
    alias.symlink_to(release.name, target_is_directory=True)
    publication.write_journal(
        current,
        publication.PublicationJournal(1, None, publication.relative_target(current, alias), "prepared"),
    )

    with pytest.raises(publication.PublicationError, match="符号链接别名"):
        publication.read_journal(current)


def test_recovery_validation_failure_preserves_pointer_and_journal(tmp_path, monkeypatch):
    current, _old_release = _old_pointer(tmp_path)
    monkeypatch.setattr(pipeline, "PROCESSED_DIR", current)
    release = _valid_release(current)
    new_target = publication.relative_target(current, release, new_release=True)
    publication.write_journal(current, publication.PublicationJournal(1, "old-release", new_target, "prepared"))
    validation = []

    def reject_validation(_path, **kwargs):
        validation.append(kwargs)
        raise RuntimeError("release invalid")

    monkeypatch.setattr(pipeline, "validate_release", reject_validation)

    with pytest.raises(RuntimeError, match="release invalid"):
        pipeline.recover_pending()

    assert validation == [{"verify_integrity": True, "allow_legacy": False}]
    assert os.readlink(current) == "old-release"
    assert publication.journal_path(current).is_file()


def test_recovery_rejects_lock_contention(tmp_path, monkeypatch):
    current = tmp_path / "processed"
    monkeypatch.setattr(pipeline, "PROCESSED_DIR", current)
    with publication.compute_lock(current):
        with pytest.raises(publication.ComputeLocked, match="正在运行"):
            pipeline.recover_pending()
