from gvcsim.config import ROOT


def test_service_uses_one_worker_and_small_fixed_limits():
    service = (ROOT / "deploy" / "gvcsim-api.service").read_text()
    assert "--workers" not in service
    assert "--limit-concurrency 64" in service
    assert "ExecStartPre=/opt/gvcsim/current/.venv/bin/gvcsim preflight" in service
    assert "RuntimeDirectory=" not in service
    assert "ReadOnlyPaths=-/opt/gvcsim/shared/data/.processed-releases" in service


def test_environment_has_no_evidence_rate_or_pool_tuning():
    environment = (ROOT / "deploy" / "gvcsim.env.example").read_text()
    for removed in ("EVIDENCE_SECRET", "LOGIN_MAX", "CPU_QUEUE", "CPU_CONCURRENCY", "DB_POOL"):
        assert removed not in environment
    assert "GVCSIM_TOKEN_TTL_SECONDS=28800" in environment


def test_nginx_does_not_apply_classroom_login_rate_limits():
    nginx = (ROOT / "deploy" / "nginx-gvcsim.conf").read_text()
    assert "limit_req" not in nginx
    assert "proxy_read_timeout 120s" in nginx


def test_backup_service_is_least_privilege_and_uses_defensive_script():
    service = (ROOT / "deploy" / "gvcsim-backup.service").read_text()
    assert "Type=oneshot" in service
    assert "User=gvcsim" in service and "Group=gvcsim" in service
    assert "EnvironmentFile=/etc/gvcsim.env" in service
    assert "Environment=GVCSIM_BACKUP_DIR=/opt/gvcsim/shared/backups" in service
    assert "ExecStart=/opt/gvcsim/current/scripts/backup_classroom.sh" in service
    assert "ReadWritePaths=/opt/gvcsim/shared/backups" in service
    for hardening in (
        "NoNewPrivileges=true",
        "PrivateTmp=true",
        "PrivateDevices=true",
        "ProtectSystem=strict",
        "ProtectHome=true",
        "CapabilityBoundingSet=",
    ):
        assert hardening in service


def test_backup_timer_is_daily_persistent_and_jittered():
    timer = (ROOT / "deploy" / "gvcsim-backup.timer").read_text()
    assert "Unit=gvcsim-backup.service" in timer
    assert "OnCalendar=*-*-* 02:30:00" in timer
    assert "RandomizedDelaySec=15m" in timer
    assert "Persistent=true" in timer
    assert "WantedBy=timers.target" in timer


def test_deployment_installs_timer_and_backs_up_before_mutation():
    deployment = (ROOT / "DEPLOY.md").read_text()
    assert "install -d -o gvcsim -g gvcsim -m 0700 /opt/gvcsim/shared/backups" in deployment
    assert "systemctl enable --now gvcsim-backup.timer" in deployment
    assert "sha256sum -c" in deployment
    api_stop = deployment.index("systemctl stop gvcsim-api")
    backup = deployment.index("systemctl start gvcsim-backup.service")
    code_switch = deployment.index("rsync -a --delete")
    unit_update = deployment.index("install -m 0644 deploy/gvcsim-api.service", code_switch)
    daemon_reload = deployment.index("systemctl daemon-reload", unit_update)
    compute = deployment.index(".venv/bin/gvcsim compute", code_switch)
    assert api_stop < backup < code_switch < unit_update < daemon_reload < compute


def test_backup_policy_keeps_retention_operator_controlled():
    deployment = (ROOT / "DEPLOY.md").read_text()
    backup_script = (ROOT / "scripts" / "backup_classroom.sh").read_text()
    assert "最近 30 份每日完整备份" in deployment
    assert "加密副本" in deployment and "每月至少执行一次隔离恢复演练" in deployment
    assert "restore_classroom_drill.py" in deployment
    for destructive in ("-delete", "rm -rf", "find-delete"):
        assert destructive not in backup_script
