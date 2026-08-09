"""64 核 / 100 学生部署模板的容量不变量。"""

import argparse
import asyncio
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

import pytest

from scripts import load_test_100_students, provision_load_test, restore_classroom_drill

from gvcsim.config import ROOT


def _env_example() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in (ROOT / "deploy" / "gvcsim.env.example").read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key, value = stripped.split("=", 1)
            values[key] = value
    return values


def _nginx_location(config: str, marker: str) -> str:
    start = config.index(marker)
    opening = config.index("{", start)
    depth = 0
    for index in range(opening, len(config)):
        if config[index] == "{":
            depth += 1
        elif config[index] == "}":
            depth -= 1
            if depth == 0:
                return config[start : index + 1]
    raise AssertionError(f"location block is not closed: {marker}")


def test_capacity_template_bounds_processes_connections_and_cpu_queue():
    service = (ROOT / "deploy" / "gvcsim-api.service").read_text(encoding="utf-8")
    env = _env_example()

    assert "--workers 16" in service
    assert "--limit-concurrency 64" in service
    assert "--backlog 2048" in service
    assert "--no-access-log" in service
    assert "Type=exec" in service
    assert "ExecStartPre=/opt/gvcsim/current/.venv/bin/gvcsim preflight" in service
    assert service.index("ExecStartPre=") < service.index("ExecStart=")
    assert "StartLimitIntervalSec=" in service
    assert "StartLimitBurst=" in service
    assert "RuntimeDirectory=gvcsim" in service
    assert int(env["GVCSIM_DB_POOL_MAX_SIZE"]) * 16 == 64
    assert int(env["GVCSIM_CPU_CONCURRENCY"]) == 16
    assert int(env["GVCSIM_CPU_QUEUE_SIZE"]) >= 100
    assert env["GVCSIM_RUNTIME_DIR"] == "/run/gvcsim"
    assert int(env["GVCSIM_LOGIN_IP_MAX_ATTEMPTS"]) >= 100
    assert all(int(env[name]) == 2 for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"))


def test_nginx_allows_classroom_nat_burst_and_reuses_backend_connections():
    nginx = (ROOT / "deploy" / "nginx-gvcsim.conf").read_text(encoding="utf-8")
    assert "rate=5r/s" in nginx
    assert "burst=120" in nginx
    assert "keepalive 64" in nginx
    assert "proxy_http_version 1.1" in nginx
    assert "location ^~ /assets/" in nginx


def test_nginx_rate_limits_public_health_probes():
    nginx = (ROOT / "deploy" / "nginx-gvcsim.conf").read_text(encoding="utf-8")
    assert "zone=gvcsim_health:1m rate=5r/s" in nginx
    for marker in ("location = /health {", "location = /health/live {"):
        location = _nginx_location(nginx, marker)
        assert "limit_req zone=gvcsim_health burst=10 nodelay;" in location


def test_proxy_timeout_covers_queue_execution_and_safety_margin():
    nginx = (ROOT / "deploy" / "nginx-gvcsim.conf").read_text(encoding="utf-8")
    api_location = _nginx_location(nginx, "location /api/")
    timeout_match = re.search(r"proxy_read_timeout\s+(\d+)s;", api_location)
    assert timeout_match is not None
    proxy_timeout = int(timeout_match.group(1))
    service = (ROOT / "deploy" / "gvcsim-api.service").read_text(encoding="utf-8")
    graceful_match = re.search(r"--graceful-timeout\s+(\d+)", service)
    stop_match = re.search(r"TimeoutStopSec=(\d+)", service)
    assert graceful_match is not None
    assert stop_match is not None
    graceful_timeout = int(graceful_match.group(1))
    stop_timeout = int(stop_match.group(1))
    queue_timeout = int(_env_example()["GVCSIM_CPU_ACQUIRE_TIMEOUT_SECONDS"])
    documented_execution_budget = 50
    safety_margin = 40

    assert proxy_timeout >= queue_timeout + documented_execution_budget + safety_margin
    assert load_test_100_students._parser().get_default("timeout") >= proxy_timeout
    assert graceful_timeout >= proxy_timeout
    assert stop_timeout > graceful_timeout


def test_asset_location_repeats_all_server_security_headers():
    nginx = (ROOT / "deploy" / "nginx-gvcsim.conf").read_text(encoding="utf-8")
    asset_location = _nginx_location(nginx, "location ^~ /assets/")
    tls_server = nginx[nginx.index("server {\n    listen 443") :]
    server_headers = {
        line.strip()
        for line in tls_server[: tls_server.index("location = /api/auth/login")].splitlines()
        if line.strip().startswith("add_header ")
    }
    asset_headers = {line.strip() for line in asset_location.splitlines() if line.strip().startswith("add_header ")}
    assert server_headers <= asset_headers
    assert 'add_header Cache-Control "public, immutable" always;' in asset_location


def test_credentials_are_private_during_write_and_atomically_replaced(tmp_path: Path, monkeypatch):
    output = tmp_path / "users.json"
    output.write_text("old credentials\n", encoding="utf-8")
    output.chmod(0o644)
    payload = {"kind": "test", "users": [{"username": "student", "password": "private-password"}]}
    real_dump = json.dump
    real_replace = os.replace
    observed: dict[str, bool] = {}

    def guarded_dump(value, handle, **kwargs):
        observed["private_during_write"] = os.fstat(handle.fileno()).st_mode & 0o777 == 0o600
        observed["old_target_intact"] = output.read_text(encoding="utf-8") == "old credentials\n"
        return real_dump(value, handle, **kwargs)

    def guarded_replace(source, destination):
        observed["temporary_is_private"] = Path(source).stat().st_mode & 0o777 == 0o600
        return real_replace(source, destination)

    monkeypatch.setattr(provision_load_test.json, "dump", guarded_dump)
    monkeypatch.setattr(provision_load_test.os, "replace", guarded_replace)
    provision_load_test._write_credentials(output, payload)

    assert observed == {
        "private_during_write": True,
        "old_target_intact": True,
        "temporary_is_private": True,
    }
    assert output.stat().st_mode & 0o777 == 0o600
    assert json.loads(output.read_text(encoding="utf-8")) == payload
    assert list(tmp_path.glob(".users.json.*.tmp")) == []


def test_credentials_write_failure_keeps_old_target_and_removes_private_temporary(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "users.json"
    output.write_text("old credentials\n", encoding="utf-8")

    def fail_during_dump(_value, handle, **_kwargs):
        assert os.fstat(handle.fileno()).st_mode & 0o777 == 0o600
        raise OSError("simulated interrupted write")

    monkeypatch.setattr(provision_load_test.json, "dump", fail_during_dump)
    with pytest.raises(OSError, match="interrupted write"):
        provision_load_test._write_credentials(output, {"users": []})

    assert output.read_text(encoding="utf-8") == "old credentials\n"
    assert list(tmp_path.glob(".users.json.*.tmp")) == []


def _load_test_args(users_file: Path, students: int):
    return load_test_100_students._parser().parse_args(
        [
            "--base-url",
            "http://127.0.0.1:1",
            "--users-file",
            str(users_file),
            "--students",
            str(students),
        ]
    )


def test_capacity_harness_rejects_fewer_credentials_than_requested(tmp_path: Path):
    users_file = tmp_path / "users.json"
    users_file.write_text(
        json.dumps(
            {
                "kind": "gvcsim-capacity-test-users-v1",
                "users": [{"username": f"student-{index}", "password": "password"} for index in range(50)],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(SystemExit, match="100"):
        asyncio.run(load_test_100_students._run(_load_test_args(users_file, 100)))


@pytest.mark.parametrize("students", [-1, 0, 49, 101])
def test_capacity_harness_rejects_requested_count_outside_acceptance_range(tmp_path: Path, students: int):
    users_file = tmp_path / "users.json"
    users_file.write_text(
        json.dumps(
            {
                "kind": "gvcsim-capacity-test-users-v1",
                "users": [{"username": f"student-{index}", "password": "password"} for index in range(100)],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(SystemExit, match="50..100"):
        asyncio.run(load_test_100_students._run(_load_test_args(users_file, students)))


def test_restore_drill_requires_disposable_exactly_confirmed_database():
    dsn = "postgresql://alice:private@127.0.0.1:5432/gvclab_release_restore_drill"

    target = restore_classroom_drill._restore_target(dsn, "gvclab_release_restore_drill")

    assert target.database == "gvclab_release_restore_drill"
    assert target.params["password"] == "private"
    with pytest.raises(restore_classroom_drill.DrillError, match="完全一致"):
        restore_classroom_drill._restore_target(dsn, "gvclab")
    with pytest.raises(restore_classroom_drill.DrillError, match="必须匹配"):
        restore_classroom_drill._restore_target("postgresql://alice:private@127.0.0.1:5432/gvclab", "gvclab")
    with pytest.raises(restore_classroom_drill.DrillError, match="不接受"):
        restore_classroom_drill._restore_target("service=production", "gvclab_release_restore_drill")


def test_restore_drill_verifies_private_backup_and_bound_checksum(tmp_path: Path):
    backup = tmp_path / "classroom.dump"
    backup.write_bytes(b"custom archive fixture")
    backup.chmod(0o600)
    checksum = hashlib.sha256(backup.read_bytes()).hexdigest()
    sidecar = tmp_path / "classroom.dump.sha256"
    sidecar.write_text(f"{checksum}  {backup.name}\n", encoding="utf-8")
    sidecar.chmod(0o600)

    assert restore_classroom_drill._private_regular_file(backup, "backup") == backup
    assert restore_classroom_drill._verified_checksum(backup, sidecar) == checksum

    sidecar.write_text(f"{checksum}  another.dump\n", encoding="utf-8")
    with pytest.raises(restore_classroom_drill.DrillError, match="文件名"):
        restore_classroom_drill._verified_checksum(backup, sidecar)
    sidecar.write_text(f"{checksum}  {backup.name}\n", encoding="utf-8")
    backup.write_bytes(b"tampered archive fixture")
    with pytest.raises(restore_classroom_drill.DrillError, match="校验失败"):
        restore_classroom_drill._verified_checksum(backup, sidecar)
    backup.chmod(0o644)
    with pytest.raises(restore_classroom_drill.DrillError, match="权限过宽"):
        restore_classroom_drill._private_regular_file(backup, "backup")


def test_restore_drill_service_file_is_private_and_receipt_never_overwrites(tmp_path: Path):
    target = restore_classroom_drill._restore_target(
        "postgresql://alice:private@127.0.0.1:5432/gvclab_release_restore_drill",
        "gvclab_release_restore_drill",
    )
    service = tmp_path / "pg_service.conf"
    restore_classroom_drill._write_service_file(service, target)
    assert service.stat().st_mode & 0o777 == 0o600
    assert "password=private" in service.read_text(encoding="utf-8")
    redacted = restore_classroom_drill._redact(
        "failed for postgresql://alice:private@127.0.0.1/db with private",
        "postgresql://alice:private@127.0.0.1/db",
        target,
    )
    assert "private" not in redacted
    assert "<redacted-dsn>" in redacted

    receipt = tmp_path / "evidence" / "receipt.json"
    payload = {"kind": restore_classroom_drill.RECEIPT_KIND, "target_database": target.database}
    restore_classroom_drill._write_receipt(receipt, payload)
    assert receipt.stat().st_mode & 0o777 == 0o600
    assert json.loads(receipt.read_text(encoding="utf-8")) == payload
    with pytest.raises(restore_classroom_drill.DrillError, match="拒绝覆盖"):
        restore_classroom_drill._write_receipt(receipt, payload)
    assert not list(receipt.parent.glob(".*.tmp"))


def test_restore_drill_never_passes_password_dsn_or_destructive_flags_to_pg_restore(tmp_path: Path, monkeypatch):
    backup = tmp_path / "classroom.dump"
    backup.write_bytes(b"archive")
    backup.chmod(0o600)
    checksum = hashlib.sha256(backup.read_bytes()).hexdigest()
    sidecar = tmp_path / "classroom.dump.sha256"
    sidecar.write_text(f"{checksum}  {backup.name}\n", encoding="utf-8")
    sidecar.chmod(0o600)
    dsn = "postgresql://alice:private@127.0.0.1:5432/gvclab_release_restore_drill"
    monkeypatch.setenv("GVCSIM_RESTORE_DSN", dsn)
    monkeypatch.setenv("GVCSIM_RESTORE_DRILL_CONFIRM", "gvclab_release_restore_drill")
    monkeypatch.setattr(restore_classroom_drill.shutil, "which", lambda _name: "/usr/bin/pg_restore")
    monkeypatch.setattr(restore_classroom_drill, "_assert_empty_target", lambda *_args: None)
    monkeypatch.setattr(
        restore_classroom_drill,
        "_inventory",
        lambda _dsn: {
            "schema_version": "gvcsim-teaching-db-v6",
            "postgresql_server_version_num": 180004,
            "table_counts": {},
            "referenced_artifacts": {},
        },
    )
    commands: list[list[str]] = []

    def fake_run(command, _environment, *, error_message):
        del error_message
        commands.append(command)
        stdout = "preflight ok" if command[0] != "pg_restore" else ""
        return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")

    monkeypatch.setattr(restore_classroom_drill, "_run_tool", fake_run)

    payload = restore_classroom_drill.run(argparse.Namespace(backup=backup, receipt=None))

    restore_command = next(command for command in commands if "--single-transaction" in command)
    rendered = " ".join(restore_command)
    assert dsn not in rendered
    assert "private" not in rendered
    assert "--clean" not in restore_command
    assert "--create" not in restore_command
    assert "--single-transaction" in restore_command
    assert "--dbname=service=gvcsim_restore_drill" in restore_command
    assert payload["target_database"] == "gvclab_release_restore_drill"


def test_capacity_harness_is_executable_and_documented():
    for relative in (
        "scripts/provision_load_test.py",
        "scripts/load_test_100_students.py",
        "scripts/restore_classroom_drill.py",
    ):
        path = ROOT / relative
        assert path.stat().st_mode & 0o111
    guide = (ROOT / "docs" / "CAPACITY_100_STUDENTS.md").read_text(encoding="utf-8")
    assert "50–100" in guide
    assert "load_test_100_students.py" in guide
    assert "gvcsim-teaching-db-v6" in guide
    assert "BACKUP_RESTORE.md" in guide

    backup_script = (ROOT / "scripts" / "backup_classroom.sh").read_text(encoding="utf-8")
    assert backup_script.index('pg_restore --list "$temp_dump"') < backup_script.index(
        'ln -- "$temp_dump" "$dump_path"'
    )
    assert 'chmod 0600 "$temp_checksum"' in backup_script
    restore_guide = (ROOT / "docs" / "BACKUP_RESTORE.md").read_text(encoding="utf-8")
    assert "_restore_drill" in restore_guide
    assert "--single-transaction" in restore_guide
    assert "不会自动删除" in restore_guide
