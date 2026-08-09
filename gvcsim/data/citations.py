"""Stable attribution and machine-readable provenance for data used by reports."""

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


def is_ci_synthetic_source(data_sources: dict[str, Any] | None) -> bool:
    return bool(data_sources and "ci_synthetic_icio" in data_sources)


def report_source_label(data_sources: dict[str, Any] | None) -> str:
    if is_ci_synthetic_source(data_sources):
        return "CI-only 确定性合成 ICIO-shaped 测试数据（不含 OECD 观测值）"
    if not data_sources or "oecd_icio" in data_sources:
        # Empty metadata is the legacy manifest shape used only by pre-attribution OECD releases.
        return "OECD ICIO"
    return "manifest 中未识别的数据源"


def report_source_disclosures(data_sources: dict[str, Any] | None) -> list[str]:
    if is_ci_synthetic_source(data_sources):
        source = data_sources.get("ci_synthetic_icio") if data_sources else None
        citation = (
            source.get("citation", "CI-only synthetic fixture")
            if isinstance(source, dict)
            else "CI-only synthetic fixture"
        )
        return [
            f"- 数据集：{citation}",
            "- 许可提示：该合成表只用于 CI，不得冒充 OECD 数据或用于现实政策结论。",
        ]
    if data_sources and "oecd_icio" not in data_sources:
        return [
            "- 数据集：manifest 中的数据源类型无法识别。",
            "- 许可提示：拒绝推断其权利状态；补齐来源、引用和条款前不得对外发布。",
        ]
    return [
        f"- 数据集：{OECD_ICIO_CITATION}",
        f"- 方法文档：{OECD_ICIO_METHODOLOGY_CITATION}",
        f"- OECD 使用条款：{OECD_ICIO_TERMS_URL}",
        "- 本报告是教学系统生成的衍生结果，不代表 OECD 审核、参与或背书；再分发前应复核下载时适用的元数据和条款。",
    ]


def artifact_data_sources(raw_data_dir: Path) -> dict[str, dict[str, Any]]:
    """Describe real OECD input or the guarded CI-only synthetic substitute.

    Merely dropping a marker file is not enough to relabel data: both explicit CI
    environment gates must be present, and the marker contract must validate.
    """
    marker = raw_data_dir / CI_SYNTHETIC_MARKER
    synthetic_enabled = os.environ.get("GVCSIM_CI_SYNTHETIC") == "1"
    ci_enabled = os.environ.get("CI", "").strip().lower() in {"1", "true", "yes"}
    if marker.exists() or synthetic_enabled:
        if not (marker.is_file() and synthetic_enabled and ci_enabled):
            raise RuntimeError("CI synthetic data requires CI=true, GVCSIM_CI_SYNTHETIC=1, and a valid marker")
        try:
            payload = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError("CI synthetic data marker cannot be parsed") from error
        if payload.get("kind") != CI_SYNTHETIC_KIND or payload.get("production_data") is not False:
            raise RuntimeError("CI synthetic data marker contract is invalid")
        return {
            "ci_synthetic_icio": {
                "production_data": False,
                "kind": CI_SYNTHETIC_KIND,
                "generator": "scripts/build_ci_synthetic_data.py",
                "citation": "Deterministic CI-only OECD-shaped synthetic fixture; contains no OECD observations.",
            }
        }
    return {
        "oecd_icio": {
            "release": "2023",
            "citation": OECD_ICIO_CITATION,
            "dataset_url": OECD_ICIO_DATASET_URL,
            "methodology_citation": OECD_ICIO_METHODOLOGY_CITATION,
            "methodology_url": OECD_ICIO_METHODOLOGY_URL,
            "terms_url": OECD_ICIO_TERMS_URL,
        }
    }
