from gvcsim.config import ROOT


def test_deployment_docs_describe_fixed_data_and_v8():
    guide = (ROOT / "DEPLOY_101.201.151.30.md").read_text()
    assert "data/processed" in guide
    assert "dataset.json" in guide
    assert "gvcsim-teaching-db-v8" in guide
    assert "manifest_id" not in guide


def test_completion_docs_explicitly_describe_the_trusted_lan_tradeoff():
    guide = (ROOT / "docs" / "COURSE_COMPLETION.md").read_text()
    assert "不签发" in guide
    assert "重新判分" in guide
    assert "run_id" not in guide
