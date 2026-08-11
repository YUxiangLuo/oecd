"""Safety contracts for the current demo-server runbooks."""

import re

from gvcsim.config import ROOT


MAIN_GUIDE = ROOT / "DEPLOY_101.201.151.30.md"
FULL_GUIDE = ROOT / "docs" / "DEMO_FULL_RELEASE.md"
STUDENT_BROWSER_SMOKE = ROOT / "scripts" / "agent_browser_smoke.sh"
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"


def _bash_blocks(markdown: str) -> str:
    return "\n".join(re.findall(r"```bash\n(.*?)\n```", markdown, flags=re.DOTALL))


def test_demo_deploy_guide_keeps_routine_frontend_path_short_and_non_disruptive():
    guide = MAIN_GUIDE.read_text(encoding="utf-8")
    assert len(guide.splitlines()) < 300
    assert "[完整发布](docs/DEMO_FULL_RELEASE.md)" in guide
    assert 'cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256"' in guide
    assert 'sha256sum -c "$dump.sha256"' not in guide
    assert 'stat -c \'%a %u %g\' "$app" > "$backup/app-root-stat"' in guide
    assert 'chmod 0600 "$backup/app-root-stat"' in guide
    assert "MANIFEST_ID=-" not in guide

    frontend_section = guide.split("## 4. 前端-only：上传与切换", 1)[1].split("## 5. 验收", 1)[0]
    commands = _bash_blocks(frontend_section)
    for forbidden in ("systemctl stop", "uv sync", "gvcsim classroom-init", "data/processed"):
        assert forbidden not in commands
    assert 'git archive --format=tar "$COMMIT" frontend' in commands
    assert "rsync -a --delete --exclude='/dist/' --exclude='/node_modules/'" in commands
    assert "rsync -a --exclude='/index.html'" in commands
    assert commands.index("rsync -a --exclude='/index.html'") < commands.index('mv -Tf "$next_index"')


def test_frontend_ci_enforces_the_dependency_audit():
    workflow = CI_WORKFLOW.read_text(encoding="utf-8")
    frontend_job = workflow.split("  frontend:", 1)[1].split("  browser-e2e:", 1)[0]
    assert "bun install --frozen-lockfile" in frontend_job
    assert "bun audit" in frontend_job


def test_student_browser_smoke_audits_every_rendered_step_and_the_network_dialog():
    script = STUDENT_BROWSER_SMOKE.read_text(encoding="utf-8")
    loop = script.split("for step in $(seq 1 16); do", 1)[1].split('\nif [[ -n "$artifact_dir"', 1)[0]
    assert "student route mismatch" in loop
    assert 'assert_a11y "$a11y_dir/student-step${step}-a11y.json"' in loop
    assert 'assert_a11y "$a11y_dir/student-step10-modal-a11y.json"' in loop
    assert "student-step11-tariff" in loop
    assert "'sanctions:制裁清单'" in loop
    assert "'export_control:出口管制'" in loop
    assert "student-step11-${shock_type}" in loop
    assert 'data-shock-type=\\"$shock_type\\"' in loop
    assert "student-step16-a11y.json" not in script


def test_full_demo_release_remains_fail_closed_and_auditable():
    guide = FULL_GUIDE.read_text(encoding="utf-8")
    commands = _bash_blocks(guide)
    assert "git archive --format=tar" in commands
    assert "systemctl stop gvcsim-api.service" in commands
    assert ".venv/bin/gvcsim classroom-init\n" in commands
    assert ".venv/bin/gvcsim classroom-init --reset" not in commands
    assert "validate_release(target, validate_sources=True)" in commands
    assert "read -r app_mode app_uid app_gid < <(stat -c '%a %u %g' \"$app\")" in commands
    assert 'read -r app_mode app_uid app_gid < "$backup/app-root-stat"' in commands
    assert commands.count('chown "$app_uid:$app_gid" "$app"') == 2
    assert commands.count('chmod "$app_mode" "$app"') == 2
    assert "POST /api/classroom/assignments" in guide
    assert "这不是普通发布步骤" in guide
