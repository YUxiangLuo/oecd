import os
import subprocess
import sys

import pytest

from gvcsim import config
from gvcsim.config import ROOT


@pytest.mark.parametrize("configured,expected", [(None, 2592000), ("28800", 28800)])
def test_teaching_login_default_and_explicit_override(configured, expected):
    environment = os.environ.copy()
    environment.pop("GVCSIM_TOKEN_TTL_SECONDS", None)
    if configured is not None:
        environment["GVCSIM_TOKEN_TTL_SECONDS"] = configured
    actual = subprocess.check_output(
        [sys.executable, "-c", "from gvcsim.config import TOKEN_TTL_SECONDS; print(TOKEN_TTL_SECONDS)"],
        env=environment,
        text=True,
    )
    assert int(actual) == expected


def test_service_uses_one_worker_and_small_fixed_limits():
    service = (ROOT / "deploy" / "gvcsim-api.service").read_text()
    assert "--workers" not in service
    assert "--limit-concurrency 512" in service
    assert "ExecStartPre=/opt/gvcsim/current/.venv/bin/gvcsim preflight" in service
    assert "RuntimeDirectory=" not in service
    assert "ReadOnlyPaths=/opt/gvcsim/shared/data /opt/gvcsim/shared/OECD_ICIO" in service
    assert "ReadWritePaths=/opt/gvcsim/shared/run" not in service
    assert "shared/reports" not in service


def test_environment_has_bounded_request_rates_without_removed_evidence_or_pool_tuning():
    environment = (ROOT / "deploy" / "gvcsim.env.example").read_text()
    for removed in ("EVIDENCE_SECRET", "LOGIN_MAX", "CPU_QUEUE", "CPU_CONCURRENCY", "DB_POOL"):
        assert removed not in environment
    assert "GVCSIM_TOKEN_TTL_SECONDS=2592000" in environment
    assert "GVCSIM_LOGIN_ATTEMPTS_PER_MINUTE=10" in environment
    assert "GVCSIM_LOGIN_SOURCE_ATTEMPTS_PER_MINUTE=120" in environment
    assert "GVCSIM_REGRESSION_RUNS_PER_MINUTE=12" in environment
    assert "GVCSIM_PLACEBO_RUNS_PER_MINUTE=4" in environment
    assert "GVCSIM_BACKUP_KEEP=90" in environment
    assert "1..10000" in environment
    assert "GVCSIM_DATA_DIR=/opt/gvcsim/shared/data" in environment
    assert "GVCSIM_RAW_DATA_DIR=/opt/gvcsim/shared/OECD_ICIO" in environment
    assert "GVCSIM_PUBLICATION_LOCK_DIR" not in environment
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    assert "GVCSIM_EVIDENCE_SECRET" not in workflow
    assert "learning_evidence_events" not in workflow


def test_shipped_production_placeholders_are_rejected_case_insensitively(monkeypatch):
    environment = {
        key: value
        for line in (ROOT / "deploy" / "gvcsim.env.example").read_text().splitlines()
        if line and not line.startswith("#") and "=" in line
        for key, value in [line.split("=", 1)]
    }
    monkeypatch.setattr(config, "IS_PRODUCTION", True)
    monkeypatch.setattr(config, "DEMO_MODE", False)
    monkeypatch.setattr(config, "_data_dir_setting", environment["GVCSIM_DATA_DIR"])
    monkeypatch.setattr(config, "_raw_data_dir_setting", environment["GVCSIM_RAW_DATA_DIR"])

    monkeypatch.setattr(config, "PG_DSN", environment["GVCSIM_PG_DSN"].swapcase())
    monkeypatch.setattr(config, "AUTH_SECRET", "x" * 32)
    with pytest.raises(config.ConfigurationError, match="GVCSIM_PG_DSN") as dsn_error:
        config.validate_security_config()
    assert "change_me" not in str(dsn_error.value).casefold()

    monkeypatch.setattr(config, "PG_DSN", "postgresql://gvcsim:secret@127.0.0.1:5432/gvclab")
    monkeypatch.setattr(config, "AUTH_SECRET", environment["GVCSIM_AUTH_SECRET"].swapcase())
    with pytest.raises(config.ConfigurationError, match="GVCSIM_AUTH_SECRET") as secret_error:
        config.validate_security_config()
    assert "change_me" not in str(secret_error.value).casefold()


def test_production_requires_explicit_shared_data_paths(monkeypatch):
    monkeypatch.setattr(config, "IS_PRODUCTION", True)
    monkeypatch.setattr(config, "DEMO_MODE", False)
    monkeypatch.setattr(config, "AUTH_SECRET", "x" * 32)
    monkeypatch.setattr(config, "_data_dir_setting", "")
    monkeypatch.setattr(config, "_raw_data_dir_setting", "")

    with pytest.raises(config.ConfigurationError, match="GVCSIM_DATA_DIR"):
        config.validate_security_config()

    monkeypatch.setattr(config, "_data_dir_setting", "data")
    monkeypatch.setattr(config, "_raw_data_dir_setting", "/srv/gvcsim/raw")
    with pytest.raises(config.ConfigurationError, match="绝对路径"):
        config.validate_security_config()


def test_nginx_keeps_transport_limits_while_application_owns_identity_rates():
    nginx = (ROOT / "deploy" / "nginx-gvcsim.conf").read_text()
    assert "limit_req" not in nginx
    assert "proxy_read_timeout 120s" in nginx
    assert "keepalive 8;" in nginx and "keepalive_timeout 2s;" in nginx
    assert "gzip on;" in nginx
    assert "gzip_vary on;" in nginx
    assert "application/javascript" in nginx and "application/json" in nginx


def test_capacity_configuration_rejects_nonpositive_request_limits(monkeypatch):
    monkeypatch.setattr(config, "PLACEBO_RUNS_PER_MINUTE", 0)
    with pytest.raises(config.ConfigurationError, match="GVCSIM_PLACEBO_RUNS_PER_MINUTE"):
        config.validate_capacity_config()


def test_deployment_documents_bootstrap_and_separate_lifecycles():
    deployment = (ROOT / "DEPLOY.md").read_text()
    assert "一次性主机 bootstrap" in deployment
    assert "useradd --system" in deployment
    assert "createuser --pwprompt gvcsim" in deployment
    assert "必须登录到**实际数据库主机**执行" in deployment
    assert "不能在另一台 API 主机上照抄" in deployment
    assert "nginx -t" in deployment and "TLS" in deployment
    assert "bun install --frozen-lockfile" in deployment
    assert "gvcsim compute" in deployment and "gvcsim preflight" in deployment
    assert "classroom-init --reset" in deployment
    assert "--teacher-username teacher" in deployment
    assert "GVCSIM_INITIAL_TEACHER_PASSWORD" in deployment
    assert 'test "${#GVCSIM_INITIAL_TEACHER_PASSWORD}" -ge 12' in deployment
    assert "runuser -u gvcsim" in deployment

    ordinary = deployment.split("## 普通代码部署", 1)[1].split("## 数据发布", 1)[0]
    data_release = deployment.split("## 数据发布或 artifact contract 升级", 1)[1].split("## 明确的新学期", 1)[0]
    semester_reset = deployment.split("## 明确的新学期重置", 1)[1].split("## 数据 release 回滚", 1)[0]
    assert ".venv/bin/gvcsim classroom-init --reset" not in ordinary and ".venv/bin/gvcsim compute" not in ordinary
    assert ".venv/bin/gvcsim compute" in data_release
    assert ".venv/bin/gvcsim classroom-init --reset" not in data_release
    assert ".venv/bin/gvcsim classroom-init --reset" in semester_reset
    assert ".venv/bin/gvcsim compute" not in semester_reset
    assert "benchmark_shock_panel_v9.py" in data_release
    assert "GVCSIM_PUBLICATION_LOCK_DIR" not in deployment
    assert "gvcsim-teaching-db-v11" in deployment
    assert "不兼容 v10 会话与报告" in deployment
    assert "后续普通升级仍不得用重置代替迁移" in deployment
    assert "pg_dump" in deployment and "pg_restore" in deployment
    assert "createdb --maintenance-db=postgres" in deployment
    assert "export PGHOST=" in deployment and "export PGPASSWORD" in deployment
    assert "gvcsim-backup.timer" in deployment
    timer = (ROOT / "deploy" / "gvcsim-backup.timer").read_text()
    service = (ROOT / "deploy" / "gvcsim-backup.service").read_text()
    assert "Persistent=true" in timer
    assert "backup_classroom.sh" in service
    assert "EnvironmentFile=/etc/gvcsim.env" in service
    assert "Environment=GVCSIM_BACKUP_KEEP" not in service
    backup_script = (ROOT / "scripts" / "backup_classroom.sh").read_text()
    assert "checksum_candidates" in backup_script
    assert "completed_checksums" in backup_script
    assert "retention_removed" in backup_script
    assert '"$backup_dir" != /* || "$backup_dir" == / || -L "$backup_dir"' in backup_script
    assert '! -L "$old_checksum"' in backup_script and '! -L "$old_dump"' in backup_script
    assert "1..10000" in deployment
    assert "它们不占用保留名额" in deployment
    assert "本机保留不等于灾难备份" in deployment
