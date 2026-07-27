"""64 核 / 100 学生部署模板的容量不变量。"""

from gvcsim.config import ROOT


def _env_example() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in (ROOT / "deploy" / "gvcsim.env.example").read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key, value = stripped.split("=", 1)
            values[key] = value
    return values


def test_capacity_template_bounds_processes_connections_and_cpu_queue():
    service = (ROOT / "deploy" / "gvcsim-api.service").read_text(encoding="utf-8")
    env = _env_example()

    assert "--workers 16" in service
    assert "--limit-concurrency 64" in service
    assert "--backlog 2048" in service
    assert "--no-access-log" in service
    assert "RuntimeDirectory=gvcsim" in service
    assert int(env["GVCSIM_DB_POOL_MAX_SIZE"]) * 16 == 64
    assert int(env["GVCSIM_CPU_CONCURRENCY"]) == 16
    assert int(env["GVCSIM_CPU_QUEUE_SIZE"]) >= 100
    assert int(env["GVCSIM_CPU_ACQUIRE_TIMEOUT_SECONDS"]) < 120
    assert env["GVCSIM_RUNTIME_DIR"] == "/run/gvcsim"
    assert all(int(env[name]) == 2 for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"))


def test_nginx_allows_classroom_nat_burst_and_reuses_backend_connections():
    nginx = (ROOT / "deploy" / "nginx-gvcsim.conf").read_text(encoding="utf-8")
    assert "rate=20r/s" in nginx
    assert "burst=120" in nginx
    assert "keepalive 64" in nginx
    assert "proxy_http_version 1.1" in nginx
    assert "location ^~ /assets/" in nginx


def test_capacity_harness_is_executable_and_documented():
    for relative in ("scripts/provision_load_test.py", "scripts/load_test_100_students.py"):
        path = ROOT / relative
        assert path.stat().st_mode & 0o111
    guide = (ROOT / "docs" / "CAPACITY_100_STUDENTS.md").read_text(encoding="utf-8")
    assert "50–100" in guide
    assert "load_test_100_students.py" in guide
    assert "gvcsim-teaching-db-v6" in guide
