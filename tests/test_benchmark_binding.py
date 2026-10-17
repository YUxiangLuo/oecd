"""Committed benchmark evidence must name the release and panel it was computed on."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from gvcsim import config
from gvcsim.regression import benchmark_binding as binding

RELEASE = "8565f226719d4179967f6372dbc7c49e"
OTHER_RELEASE = "88063fb4cbf24ce2b4657d6f3c679a66"
PANEL_SHA = "520c93423e76c353d8a5a56c51736e98198001e84ba1ffeff23bbe53cee058c3"
OTHER_PANEL_SHA = "02f1ce87ab5a4c60af469e1807e94377bc3901053324d59c80cdb3dd413eccd4"
EXPOSURE_SHA = "05abf328b1af27b119a8a3e20746235bcdebb84717c28821518528845c4455d3"


def _block(release: str, panel: str, panel_sha: str, exposure_sha: str | None = None) -> dict:
    block = {"release": release, "panel": panel, "panel_sha256": panel_sha}
    if exposure_sha is not None:
        block.update({"exposure": "export_exposure_2016.csv", "exposure_sha256": exposure_sha})
    return block


def _benchmark(kind: str = "model_space", *, computed=None, validated=None, status=binding.STATUS_EQUIVALENT) -> dict:
    computed = computed or _block(RELEASE, "panel_teaching.csv", PANEL_SHA)
    validated = validated or _block(OTHER_RELEASE, "panel_teaching.csv", OTHER_PANEL_SHA)
    return {
        "release": computed["release"],
        "fits": 20111,
        "source_panel_sha256": computed["panel_sha256"],
        "source_exposure": {"sha256": EXPOSURE_SHA},
        "binding": {
            "kind": binding.KIND,
            "version": binding.VERSION,
            "computed": computed,
            "validated": validated,
            "status": status,
            "note": "documented equivalent rebuild",
        },
    }


def test_current_binding_reads_release_panel_and_exposure(tmp_path):
    (tmp_path / "dataset.json").write_text(json.dumps({"release_id": RELEASE}), encoding="utf-8")
    (tmp_path / "panel_teaching.csv").write_bytes(b"teaching")
    (tmp_path / "export_exposure_2016.csv").write_bytes(b"exposure")
    current = binding.current_binding(tmp_path, exposure_name="export_exposure_2016.csv")
    assert current is not None
    assert current["release"] == RELEASE
    assert current["panel"] == "panel_teaching.csv"
    assert current["panel_sha256"] == binding.file_sha256(tmp_path / "panel_teaching.csv")
    assert current["exposure"] == "export_exposure_2016.csv"
    assert current["exposure_sha256"] == binding.file_sha256(tmp_path / "export_exposure_2016.csv")


def test_current_binding_returns_none_for_unreadable_or_invalid_metadata(tmp_path):
    assert binding.current_binding(tmp_path) is None
    (tmp_path / "panel_teaching.csv").write_bytes(b"teaching")
    (tmp_path / "dataset.json").write_text("{}", encoding="utf-8")
    assert binding.current_binding(tmp_path) is None
    (tmp_path / "dataset.json").write_text(json.dumps({"release_id": "not-a-release"}), encoding="utf-8")
    assert binding.current_binding(tmp_path) is None


def test_binding_from_current_is_computed_and_validated_on_the_same_release():
    current = {"release": RELEASE, "panel": "panel_teaching.csv", "panel_sha256": PANEL_SHA}
    block = binding.binding_from_current(current, note="fresh run")
    assert block is not None
    assert block["computed"] == block["validated"] == current
    assert block["status"] == binding.STATUS_COMPUTED
    assert binding.binding_from_current(None, note="x") is None


def test_current_matching_computed_or_validated_is_accepted():
    benchmark = _benchmark()
    current_computed = benchmark["binding"]["computed"]
    current_validated = benchmark["binding"]["validated"]
    assert binding.binding_problem(benchmark, current_computed, expected_panel="panel_teaching.csv") is None
    assert binding.binding_problem(benchmark, current_validated, expected_panel="panel_teaching.csv") is None


def test_another_release_is_refused_with_both_recorded_hashes():
    benchmark = _benchmark()
    current = {"release": "a" * 32, "panel": "panel_teaching.csv", "panel_sha256": "b" * 64}
    problem = binding.binding_problem(benchmark, current, expected_panel="panel_teaching.csv")
    assert problem is not None
    assert "既不是 computed" in problem and RELEASE in problem and OTHER_RELEASE in problem


def test_missing_or_malformed_binding_is_refused():
    assert "缺少 binding" in (binding.binding_problem({}, None, expected_panel="panel_teaching.csv") or "")
    bad = _benchmark()
    bad["binding"]["status"] = "trust-me"
    assert "status" in (
        binding.binding_problem(bad, bad["binding"]["computed"], expected_panel="panel_teaching.csv") or ""
    )
    bad = _benchmark()
    bad["binding"]["note"] = " "
    assert "note" in (
        binding.binding_problem(bad, bad["binding"]["computed"], expected_panel="panel_teaching.csv") or ""
    )
    bad = _benchmark()
    bad["binding"]["computed"]["panel"] = "panel_industry.csv"
    assert "panel" in (
        binding.binding_problem(bad, bad["binding"]["computed"], expected_panel="panel_teaching.csv") or ""
    )


def test_exposure_is_part_of_the_binding():
    computed = _block(RELEASE, "panel_industry.csv", PANEL_SHA, EXPOSURE_SHA)
    validated = _block(OTHER_RELEASE, "panel_industry.csv", OTHER_PANEL_SHA, EXPOSURE_SHA)
    benchmark = _benchmark("teaching_design", computed=computed, validated=validated)
    current = {
        "release": RELEASE,
        "panel": "panel_industry.csv",
        "panel_sha256": PANEL_SHA,
        "exposure": "export_exposure_2016.csv",
        "exposure_sha256": "c" * 64,
    }
    problem = binding.binding_problem(
        benchmark, current, expected_panel="panel_industry.csv", expected_exposure="export_exposure_2016.csv"
    )
    assert problem is not None and "既不是 computed" in problem


def test_metadata_must_agree_with_the_binding():
    model_space = _benchmark()
    assert binding.metadata_problem(model_space, kind="model_space", expected_panel="panel_teaching.csv") is None
    model_space["release"] = OTHER_RELEASE
    assert "release" in (
        binding.metadata_problem(model_space, kind="model_space", expected_panel="panel_teaching.csv") or ""
    )

    computed = _block(RELEASE, "panel_industry.csv", PANEL_SHA, EXPOSURE_SHA)
    validated = _block(OTHER_RELEASE, "panel_industry.csv", OTHER_PANEL_SHA, EXPOSURE_SHA)
    teaching = _benchmark("teaching_design", computed=computed, validated=validated)
    assert (
        binding.metadata_problem(
            teaching,
            kind="teaching_design",
            expected_panel="panel_industry.csv",
            expected_exposure="export_exposure_2016.csv",
        )
        is None
    )
    teaching["source_panel_sha256"] = "d" * 64
    assert "source_panel_sha256" in (
        binding.metadata_problem(
            teaching,
            kind="teaching_design",
            expected_panel="panel_industry.csv",
            expected_exposure="export_exposure_2016.csv",
        )
        or ""
    )


@pytest.mark.skipif(
    os.environ.get("GVCSIM_CI_SYNTHETIC") == "1" or not (config.PROCESSED_DIR / "dataset.json").is_file(),
    reason="needs the real processed release, not a synthetic CI fixture",
)
def test_committed_benchmarks_are_bound_to_the_current_release():
    root = config.PROCESSED_DIR
    for path, kind, panel, exposure in (
        (config.ROOT / "benchmarks/model_space_v13.json", "model_space", "panel_teaching.csv", None),
        (
            Path("benchmarks/teaching_design_v13.json"),
            "teaching_design",
            "panel_industry.csv",
            "export_exposure_2016.csv",
        ),
    ):
        benchmark = json.loads(path.read_text(encoding="utf-8"))
        current = binding.current_binding(root, panel_name=panel, exposure_name=exposure)
        assert (
            binding.metadata_problem(benchmark, kind=kind, expected_panel=panel, expected_exposure=exposure) is None
        ), path
        assert binding.binding_problem(benchmark, current, expected_panel=panel, expected_exposure=exposure) is None, (
            path
        )
