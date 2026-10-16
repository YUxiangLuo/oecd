import json

import pytest

from gvcsim.data.citations import (
    CI_SYNTHETIC_KIND,
    CI_SYNTHETIC_MARKER,
    OECD_ICIO_DATASET_URL,
    artifact_data_sources,
    report_source_disclosures,
    report_source_label,
    validate_data_sources,
    DataSourcesValidationError,
)


def _clear_ci_gates(monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.delenv("GVCSIM_CI_SYNTHETIC", raising=False)


def test_real_release_metadata_carries_oecd_attribution(tmp_path, monkeypatch):
    _clear_ci_gates(monkeypatch)

    metadata = artifact_data_sources(tmp_path)

    assert set(metadata) == {"version", "oecd_icio", "simulated_macro_controls"}
    assert metadata["version"] == 1
    assert metadata["oecd_icio"]["release"] == "2023"
    assert metadata["oecd_icio"]["dataset_url"] == OECD_ICIO_DATASET_URL
    assert "Inter-Country Input-Output Tables" in metadata["oecd_icio"]["citation"]
    controls = metadata["simulated_macro_controls"]
    assert controls["kind"] == "deterministic-teaching-mock"
    assert controls["production_data"] is False
    assert "million USD" in controls["scale_input"]["description"]
    assert controls["generator_version"] == "2.0.0"
    assert "Not WDI data" in controls["observations_disclosure"]
    validate_data_sources(metadata)
    # Students read the disclosure under the report's references: no module path, version or data-package column.
    disclosure = "\n".join(report_source_disclosures(metadata))
    assert "课程按固定规则生成的教学数据" in disclosure and "不能当作真实宏观数据引用" in disclosure
    for internal in ("gvcsim.", controls["generator_version"], "生成器", "占位列"):
        assert internal not in disclosure


def test_ci_synthetic_release_is_never_attributed_as_oecd_observations(tmp_path, monkeypatch):
    monkeypatch.setenv("CI", "true")
    monkeypatch.setenv("GVCSIM_CI_SYNTHETIC", "1")
    (tmp_path / CI_SYNTHETIC_MARKER).write_text(
        json.dumps({"kind": CI_SYNTHETIC_KIND, "production_data": False}),
        encoding="utf-8",
    )

    metadata = artifact_data_sources(tmp_path)

    assert set(metadata) == {"version", "ci_synthetic_icio", "simulated_macro_controls"}
    assert metadata["ci_synthetic_icio"]["production_data"] is False
    assert "contains no OECD observations" in metadata["ci_synthetic_icio"]["citation"]
    assert report_source_label(metadata).startswith("CI-only")
    disclosure = "\n".join(report_source_disclosures(metadata))
    assert "不得冒充 OECD 数据" in disclosure
    assert OECD_ICIO_DATASET_URL not in disclosure


@pytest.mark.parametrize(
    ("ci", "synthetic"),
    [(None, None), ("true", None), (None, "1")],
)
def test_synthetic_marker_requires_both_environment_gates(tmp_path, monkeypatch, ci, synthetic):
    _clear_ci_gates(monkeypatch)
    if ci is not None:
        monkeypatch.setenv("CI", ci)
    if synthetic is not None:
        monkeypatch.setenv("GVCSIM_CI_SYNTHETIC", synthetic)
    (tmp_path / CI_SYNTHETIC_MARKER).write_text(
        json.dumps({"kind": CI_SYNTHETIC_KIND, "production_data": False}),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="requires CI=true"):
        artifact_data_sources(tmp_path)


def test_unknown_or_tampered_source_fails_closed(tmp_path, monkeypatch):
    with pytest.raises(DataSourcesValidationError, match="version"):
        report_source_label({"future_source": {"citation": "unknown"}})

    _clear_ci_gates(monkeypatch)
    metadata = artifact_data_sources(tmp_path)
    metadata["simulated_macro_controls"]["production_data"] = True
    with pytest.raises(DataSourcesValidationError, match="simulated_macro_controls"):
        report_source_disclosures(metadata)


def test_synthetic_flag_without_a_valid_marker_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setenv("CI", "true")
    monkeypatch.setenv("GVCSIM_CI_SYNTHETIC", "1")

    with pytest.raises(RuntimeError, match="valid marker"):
        artifact_data_sources(tmp_path)
