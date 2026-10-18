import json

import pytest

from gvcsim import release_verification as verification


@pytest.fixture
def verification_tree(tmp_path, monkeypatch):
    for name in (
        "gvcsim/example.py",
        "frontend/src/main.tsx",
        "frontend/package.json",
        "frontend/bun.lock",
        "frontend/vite.config.ts",
        "frontend/index.html",
        "frontend/tsconfig.json",
        "frontend/public/favicon.svg",
        "frontend/public/readings/guide.pdf",
        "实验手册.pdf",
        "uv.lock",
        "pyproject.toml",
        "processed/panel_teaching.csv",
    ):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("test source\n")
    root = tmp_path / "processed"
    metadata = {"release_id": "a" * 32, "artifact_contract_version": 17, "years": [2020]}
    (root / "dataset.json").write_text(json.dumps(metadata))
    monkeypatch.setattr(verification.config, "ROOT", tmp_path)
    monkeypatch.setattr(verification.config, "PROCESSED_DIR", root)
    monkeypatch.setattr(
        verification.artifacts, "dataset_metadata", lambda p: json.loads((p / "dataset.json").read_text())
    )
    monkeypatch.setattr(verification, "_validate_inputs", lambda _: {})
    evidence = {
        "format": verification.FORMAT,
        "passed": True,
        "provenance": verification.provenance(root),
        "summary": {"models": 136},
    }
    path = tmp_path / "evidence.json"
    path.write_text(json.dumps(evidence))
    return tmp_path, path


@pytest.mark.parametrize(
    "changed",
    [
        "gvcsim/example.py",
        "frontend/src/main.tsx",
        "frontend/index.html",
        "frontend/tsconfig.json",
        "frontend/public/favicon.svg",
        "frontend/public/readings/guide.pdf",
        "实验手册.pdf",
        "uv.lock",
        "processed/panel_teaching.csv",
        "processed/dataset.json",
    ],
)
def test_evidence_rejects_changed_data_code_assets_and_build_inputs(verification_tree, changed):
    root, path = verification_tree
    assert verification.check_evidence(path) == {"models": 136}
    if changed.endswith("dataset.json"):
        value = json.loads((root / changed).read_text())
        value["release_id"] = "b" * 32
        (root / changed).write_text(json.dumps(value))
    else:
        (root / changed).write_text("changed content\n")
    with pytest.raises(ValueError, match="不匹配"):
        verification.check_evidence(path)


def test_failed_or_unversioned_evidence_is_not_a_deployment_gate(verification_tree):
    _, path = verification_tree
    value = json.loads(path.read_text())
    for replacement in ({"passed": False}, {"format": "old"}):
        path.write_text(json.dumps({**value, **replacement}))
        with pytest.raises(ValueError, match="格式不匹配或未通过"):
            verification.check_evidence(path)
