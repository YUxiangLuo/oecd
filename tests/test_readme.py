from gvcsim.config import ROOT


def test_readme_contains_the_single_documentation_contract():
    readme = (ROOT / "README.md").read_text()
    assert "course-quiz-v6" in readme
    assert "experiment-session-simple-v2" in readme
    assert "gvcsim-teaching-db-v10" in readme
    assert "不提供班级、公告" in readme
    assert "OECD Terms & Conditions" in readme
    assert "pg_dump --format=custom" in readme
    assert "bun install --frozen-lockfile" in readme
    assert "普通代码/数据部署不得清空教学库" in readme
    assert "只有已备份且明确的新学期清场才允许 `classroom-init --reset`" in readme


def test_removed_gephi_document_has_no_dead_reference():
    project = ROOT / "scripts" / "gephi_golden"
    assert not (project / "README.md").exists()
    pom = (project / "pom.xml").read_text()
    assert "README 的“升级基准”" not in pom


def test_ci_executes_the_independent_gephi_oracle():
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    assert "actions/setup-java@v6" in workflow
    assert "scripts/gephi_golden/generate.sh --check" in workflow


def test_ci_executes_the_full_report_and_grading_journey():
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    assert "scripts/agent_browser_full_journey.sh" in workflow
    assert "GVCSIM_E2E_TEACHER_PASSWORD" in workflow


def test_browser_scroll_guard_waits_for_async_content_and_rendering():
    smoke = (ROOT / "scripts" / "agent_browser_smoke.sh").read_text()
    step_loop = smoke.split("for step in $(seq 1 16); do", 1)[1].split("done", 1)[0]
    shell_ready = step_loop.index("wait '.step-header-mid h2'")
    network_ready = step_loop.index("wait --load networkidle")
    render_ready = step_loop.index("requestAnimationFrame")
    scroll_guard = step_loop.index("document scrolls")
    assert shell_ready < network_ready < render_ready < scroll_guard


def test_wwz_teaching_prompts_keep_tls_as_an_extension():
    step3 = (ROOT / "frontend" / "src" / "labs" / "steps" / "indicator" / "trade.tsx").read_text()
    step7 = (ROOT / "frontend" / "src" / "labs" / "steps" / "viz" / "trade.tsx").read_text()
    assert "读它各行业算出来的六项" not in step3
    assert "比较六项构成" not in step7
