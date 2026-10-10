"""Stable attribution and strict machine-readable provenance for release inputs."""

import json
import os
from pathlib import Path
from typing import Any

OECD_ICIO_DATASET_URL = "https://www.oecd.org/en/data/datasets/inter-country-input-output-tables.html"
OECD_ICIO_TERMS_URL = "https://www.oecd.org/en/about/terms-conditions.html"
OECD_ICIO_METHODOLOGY_URL = "https://doi.org/10.1787/5a5d0665-en"

OECD_ICIO_CITATION = f"OECD (2023), Inter-Country Input-Output Tables (ICIO), 2023 release, {OECD_ICIO_DATASET_URL}."
OECD_ICIO_METHODOLOGY_CITATION = (
    "Yamano et al. (2023), Development of the OECD Inter-Country Input-Output Database 2023, "
    f"OECD Science, Technology and Industry Working Papers 2023/08, {OECD_ICIO_METHODOLOGY_URL}."
)
CI_SYNTHETIC_MARKER = ".ci-only-synthetic.json"
CI_SYNTHETIC_KIND = "gvcsim-ci-only-synthetic-oecd-icio"
DATA_SOURCES_VERSION = 1
SIMULATED_MACRO_KIND = "deterministic-teaching-mock"
SIMULATED_MACRO_GENERATOR = "gvcsim.data.controls.build_controls"
SIMULATED_MACRO_GENERATOR_VERSION = "2.0.0"
SIMULATED_MACRO_SCALE = {
    "kind": "icio-derived-value-added-scale",
    "description": "Preserves ICIO SVA's economic scale: (max(SVA,0)+1) in million USD is converted to USD by 1e6, then multiplied by dimensionless country and time teaching factors. Population is simulated GDP divided by simulated USD income per person; neither series is observed macroeconomic data.",
}
SIMULATED_MACRO_DISCLOSURE = "Not WDI data and not IMF observations; these deterministic simulated regression controls must not be presented as observed macroeconomic statistics."


class DataSourcesValidationError(ValueError):
    pass


def _simulated_macro_controls() -> dict[str, Any]:
    return {
        "kind": SIMULATED_MACRO_KIND,
        "production_data": False,
        "generator": SIMULATED_MACRO_GENERATOR,
        "generator_version": SIMULATED_MACRO_GENERATOR_VERSION,
        "scale_input": dict(SIMULATED_MACRO_SCALE),
        "observations_disclosure": SIMULATED_MACRO_DISCLOSURE,
    }


def is_ci_synthetic_source(data_sources: dict[str, Any] | None) -> bool:
    return bool(data_sources and "ci_synthetic_icio" in data_sources)


def _require_exact_object(value: object, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        actual = sorted(value) if isinstance(value, dict) else type(value).__name__
        raise DataSourcesValidationError(f"{label} must contain exactly {sorted(keys)}; got {actual}")
    return value


def validate_data_sources(value: object) -> dict[str, Any]:
    """Validate the complete versioned source contract; no legacy/unknown fallback."""
    if not isinstance(value, dict):
        raise DataSourcesValidationError("data_sources must be an object")
    if value.get("version") != DATA_SOURCES_VERSION or type(value.get("version")) is not int:
        raise DataSourcesValidationError(f"data_sources version must be {DATA_SOURCES_VERSION}")
    primary = {key for key in ("oecd_icio", "ci_synthetic_icio") if key in value}
    if len(primary) != 1:
        raise DataSourcesValidationError("data_sources must contain exactly one ICIO input source")
    expected_top = {"version", "simulated_macro_controls", *primary}
    if set(value) != expected_top:
        raise DataSourcesValidationError(
            f"data_sources has unknown or missing fields: {sorted(set(value) ^ expected_top)}"
        )

    simulated = _require_exact_object(
        value["simulated_macro_controls"],
        {"kind", "production_data", "generator", "generator_version", "scale_input", "observations_disclosure"},
        "simulated_macro_controls",
    )
    expected_simulated = _simulated_macro_controls()
    if simulated != expected_simulated:
        raise DataSourcesValidationError("simulated_macro_controls contract is invalid")

    if "oecd_icio" in primary:
        source = _require_exact_object(
            value["oecd_icio"],
            {
                "kind",
                "production_data",
                "release",
                "citation",
                "dataset_url",
                "methodology_citation",
                "methodology_url",
                "terms_url",
            },
            "oecd_icio",
        )
        expected_source = {
            "kind": "observed-indicator-input",
            "production_data": True,
            "release": "2023",
            "citation": OECD_ICIO_CITATION,
            "dataset_url": OECD_ICIO_DATASET_URL,
            "methodology_citation": OECD_ICIO_METHODOLOGY_CITATION,
            "methodology_url": OECD_ICIO_METHODOLOGY_URL,
            "terms_url": OECD_ICIO_TERMS_URL,
        }
        if source != expected_source:
            raise DataSourcesValidationError("oecd_icio source contract is invalid")
    else:
        source = _require_exact_object(
            value["ci_synthetic_icio"],
            {"production_data", "kind", "generator", "generator_version", "citation"},
            "ci_synthetic_icio",
        )
        if (
            source.get("production_data") is not False
            or source.get("kind") != CI_SYNTHETIC_KIND
            or source.get("generator") != "scripts/build_ci_synthetic_data.py"
            or source.get("generator_version") != "1.0.0"
            or source.get("citation")
            != "Deterministic CI-only OECD-shaped synthetic fixture; contains no OECD observations."
        ):
            raise DataSourcesValidationError("ci_synthetic_icio source contract is invalid")
    return value


def report_source_label(data_sources: dict[str, Any] | None) -> str:
    sources = validate_data_sources(data_sources)
    if is_ci_synthetic_source(sources):
        return "CI-only 确定性合成 ICIO-shaped 测试数据（不含 OECD 观测值）"
    return "OECD ICIO 指标输入及其派生结果"


def report_source_disclosures(data_sources: dict[str, Any] | None) -> list[str]:
    sources = validate_data_sources(data_sources)
    lines: list[str]
    if is_ci_synthetic_source(sources):
        source = sources["ci_synthetic_icio"]
        lines = [
            f"- 指标输入数据集：{source['citation']}",
            "- 指标输入许可提示：该合成表只用于 CI，不得冒充 OECD 数据或用于现实政策结论。",
        ]
    else:
        lines = [
            f"- 指标输入数据集：{OECD_ICIO_CITATION}",
            f"- 指标输入方法文档：{OECD_ICIO_METHODOLOGY_CITATION}",
            f"- OECD 使用条款：{OECD_ICIO_TERMS_URL}",
            "- OECD ICIO 声明只覆盖本系统的指标输入与其派生结果；不覆盖课程生成的关税情景。",
            "- 本报告是教学系统生成的衍生结果，不代表 OECD 审核、参与或背书；再分发前应复核下载时适用的元数据和条款。",
        ]
    controls = sources["simulated_macro_controls"]
    lines.extend(
        [
            "- 宏观控制变量：按固定规则生成的教学数据，不是 WDI 或 IMF 的观测数据，不得当作真实宏观统计；"
            f"本实验的回归没有使用它们（生成器 {controls['generator']}@{controls['generator_version']}）。",
        ]
    )
    return lines


def artifact_data_sources(raw_data_dir: Path) -> dict[str, Any]:
    """Describe real OECD indicator input or the guarded CI-only substitute."""
    marker = raw_data_dir / CI_SYNTHETIC_MARKER
    synthetic_enabled = os.environ.get("GVCSIM_CI_SYNTHETIC") == "1"
    ci_enabled = os.environ.get("CI", "").strip().lower() in {"1", "true", "yes"}
    sources: dict[str, Any] = {
        "version": DATA_SOURCES_VERSION,
        "simulated_macro_controls": _simulated_macro_controls(),
    }
    if marker.exists() or synthetic_enabled:
        if not (marker.is_file() and synthetic_enabled and ci_enabled):
            raise RuntimeError("CI synthetic data requires CI=true, GVCSIM_CI_SYNTHETIC=1, and a valid marker")
        try:
            payload = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError("CI synthetic data marker cannot be parsed") from error
        if payload.get("kind") != CI_SYNTHETIC_KIND or payload.get("production_data") is not False:
            raise RuntimeError("CI synthetic data marker contract is invalid")
        sources["ci_synthetic_icio"] = {
            "production_data": False,
            "kind": CI_SYNTHETIC_KIND,
            "generator": "scripts/build_ci_synthetic_data.py",
            "generator_version": "1.0.0",
            "citation": "Deterministic CI-only OECD-shaped synthetic fixture; contains no OECD observations.",
        }
    else:
        sources["oecd_icio"] = {
            "kind": "observed-indicator-input",
            "production_data": True,
            "release": "2023",
            "citation": OECD_ICIO_CITATION,
            "dataset_url": OECD_ICIO_DATASET_URL,
            "methodology_citation": OECD_ICIO_METHODOLOGY_CITATION,
            "methodology_url": OECD_ICIO_METHODOLOGY_URL,
            "terms_url": OECD_ICIO_TERMS_URL,
        }
    return validate_data_sources(sources)
