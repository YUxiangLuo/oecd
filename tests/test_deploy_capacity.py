from gvcsim.config import ROOT


def test_service_uses_one_worker_and_small_fixed_limits():
    service = (ROOT / "deploy" / "gvcsim-api.service").read_text()
    assert "--workers" not in service
    assert "--limit-concurrency 64" in service
    assert "ExecStartPre=/opt/gvcsim/current/.venv/bin/gvcsim preflight" in service
    assert "RuntimeDirectory=" not in service


def test_environment_has_no_evidence_rate_or_pool_tuning():
    environment = (ROOT / "deploy" / "gvcsim.env.example").read_text()
    for removed in ("EVIDENCE_SECRET", "LOGIN_MAX", "CPU_QUEUE", "CPU_CONCURRENCY", "DB_POOL"):
        assert removed not in environment
    assert "GVCSIM_TOKEN_TTL_SECONDS=28800" in environment


def test_nginx_does_not_apply_classroom_login_rate_limits():
    nginx = (ROOT / "deploy" / "nginx-gvcsim.conf").read_text()
    assert "limit_req" not in nginx
    assert "proxy_read_timeout 120s" in nginx
