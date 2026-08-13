from gvcsim.config import ROOT


def test_readme_contains_the_single_documentation_contract():
    readme = (ROOT / "README.md").read_text()
    assert "course-quiz-v4" in readme
    assert "experiment-session-simple-v2" in readme
    assert "gvcsim-teaching-db-v10" in readme
    assert "不提供班级、公告" in readme
    assert "OECD Terms & Conditions" in readme
    assert "pg_dump --format=custom" in readme
    assert "bun install --frozen-lockfile" in readme


def test_removed_gephi_document_has_no_dead_reference():
    project = ROOT / "scripts" / "gephi_golden"
    assert not (project / "README.md").exists()
    pom = (project / "pom.xml").read_text()
    assert "README 的“升级基准”" not in pom


def test_wwz_teaching_prompts_keep_tls_as_an_extension():
    step3 = (ROOT / "frontend" / "src" / "labs" / "steps" / "ind" / "step4.tsx").read_text()
    step7 = (ROOT / "frontend" / "src" / "labs" / "steps" / "viz" / "step8.tsx").read_text()
    assert "读它各行业算出来的六项" not in step3
    assert "比较六项构成" not in step7
