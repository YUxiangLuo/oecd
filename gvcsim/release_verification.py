"""Reproducible, read-only verification bound to actual release bytes and source code.

This is a bounded release smoke check, not the full model grid, a multi-seed
coverage experiment, a raw IO recomputation or a production load test.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import platform
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from gvcsim import artifacts, config
from gvcsim.data.output_quality import recompute_output_checks
from gvcsim.data.raw_icio import validate_raw_source_bindings
from gvcsim.data.regression_quality import recompute_regression_input_checks
from gvcsim.regression.design import OUTCOMES, RegressionDesign
from gvcsim.regression.panel import run_design_with_benchmark
from gvcsim.regression.spec import DEFAULT_SPEC
from gvcsim.regression.teaching import selectable_baselines
from gvcsim.regression.workbench import PRESETS

FORMAT = "gvcsim-release-verification-v1"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_files(root: Path) -> dict[str, str]:
    """Fingerprint runtime/build inputs and shipped assets, independent of Git status."""
    paths = [*root.joinpath("gvcsim").rglob("*.py"), *root.joinpath("gvcsim").rglob("*.json")]
    paths += [p for p in root.joinpath("frontend/src").rglob("*") if p.is_file() and ".test." not in p.name]
    paths += [p for p in root.joinpath("frontend/public").rglob("*") if p.is_file()]
    paths += [
        root / name
        for name in (
            "pyproject.toml",
            "uv.lock",
            "frontend/package.json",
            "frontend/bun.lock",
            "frontend/vite.config.ts",
            "frontend/index.html",
            "frontend/tsconfig.json",
            "实验手册.pdf",
        )
    ]
    return {p.relative_to(root).as_posix(): sha256(p) for p in sorted(paths)}


def provenance(root: Path) -> dict[str, Any]:
    metadata = artifacts.dataset_metadata(root)
    files = source_files(config.ROOT)
    return {
        "release_id": metadata["release_id"],
        "artifact_contract_version": metadata["artifact_contract_version"],
        "years": metadata["years"],
        "dataset_sha256": sha256(root / "dataset.json"),
        "panel_file_sha256": sha256(root / "panel_teaching.csv"),
        "source_sha256": hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest(),
        "source_files": files,
        "python": platform.python_version(),
        "packages": {
            name: importlib.metadata.version(name)
            for name in (
                "numpy",
                "pandas",
                "scipy",
                "linearmodels",
                "statsmodels",
                "networkit",
                "pymrio",
            )
        },
    }


def _validate_inputs(root: Path) -> dict[str, Any]:
    result = artifacts.validate_release(root)
    metadata = artifacts.dataset_metadata(root)
    validate_raw_source_bindings(metadata["raw_dimensions"], metadata["years"], config.RAW_DATA_DIR)
    return result


def verify() -> dict[str, Any]:
    root = config.PROCESSED_DIR.resolve(strict=True)
    integrity = _validate_inputs(root)
    identity = provenance(root)
    years = identity["years"]
    qc = {str(year): recompute_output_checks(root, year, expected_years=years) for year in years}
    qc["regression_inputs"] = recompute_regression_input_checks(root, expected_years=years)
    panel = artifacts.read_csv_artifact(root / "panel_teaching.csv")
    models = []
    for outcome in OUTCOMES:
        for baseline in selectable_baselines(outcome):
            for preset, spec in [("default", DEFAULT_SPEC), *((p[0], p[4]) for p in PRESETS)]:
                design = RegressionDesign(outcome, teaching=True, baseline=baseline.key, spec=spec)
                result, benchmark = run_design_with_benchmark(panel, design)
                models.append(
                    {
                        "outcome": outcome,
                        "baseline": baseline.key,
                        "preset": preset,
                        "spec": spec.to_dict(),
                        "status": result.to_dict()["status"],
                        "cumulative": result.to_dict().get("cumulative"),
                        "benchmark": benchmark,
                    }
                )
    _validate_inputs(root)
    if config.PROCESSED_DIR.resolve(strict=True) != root or provenance(root) != identity:
        raise ValueError("验证期间数据或代码发生变化，请重新运行")
    checks = [check for items in qc.values() for check in items]
    passed = all(item["passed"] for item in checks) and all(
        item["benchmark"].get("benchmark_passed") is True for item in models
    )
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=config.ROOT, capture_output=True, text=True, check=False)
    return {
        "format": FORMAT,
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "git_commit_at_run": commit.stdout.strip() or None,
        "provenance": identity,
        "passed": passed,
        "scope": {
            "model_settings": "17 selectable outcomes × (default + 7 presets)",
            "full_model_grid": False,
            "multi_seed_coverage": False,
            "raw_io_recomputation": False,
            "production_capacity": False,
        },
        "summary": {
            "models": len(models),
            "benchmarks_passed": sum(item["benchmark"].get("benchmark_passed") is True for item in models),
            "qc_checks": len(checks),
            "qc_passed": sum(item["passed"] is True for item in checks),
        },
        "integrity": integrity,
        "qc": qc,
        "models": models,
    }


def check_evidence(path: Path) -> dict[str, Any]:
    """Fail closed when an old report is presented as evidence for this deployment."""
    evidence = json.loads(path.read_text(encoding="utf-8"))
    if evidence.get("format") != FORMAT or evidence.get("passed") is not True:
        raise ValueError("验证记录格式不匹配或未通过")
    root = config.PROCESSED_DIR.resolve(strict=True)
    _validate_inputs(root)
    if evidence.get("provenance") != provenance(root):
        raise ValueError("验证记录与当前 release、代码或依赖不匹配，请重新运行 verify-release")
    if config.PROCESSED_DIR.resolve(strict=True) != root:
        raise ValueError("验证期间数据入口发生变化，请重新运行")
    return evidence["summary"]
