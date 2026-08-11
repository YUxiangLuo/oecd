#!/usr/bin/env python3
"""Restore a classroom backup into an explicitly disposable PostgreSQL database.

The target DSN is accepted only through ``GVCSIM_RESTORE_DSN`` so a
password-bearing connection string never appears in process arguments. The
script never creates, cleans, drops, or overwrites a database: operators must
provide a fresh empty database whose name ends in ``_restore_drill`` and repeat
that exact name in ``GVCSIM_RESTORE_DRILL_CONFIRM``.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
from psycopg.conninfo import conninfo_to_dict

from gvcsim.classroom.db import TEACHING_DB_VERSION

RECEIPT_KIND = "gvcsim-classroom-restore-drill-v1"
SERVICE_NAME = "gvcsim_restore_drill"
_TARGET_NAME = re.compile(r"^[a-z][a-z0-9_]*_restore_drill$")
_SERVICE_KEY = re.compile(r"^[a-z_]+$")


class DrillError(RuntimeError):
    """A fail-closed restore-drill rejection with a safe operator message."""


@dataclass(frozen=True)
class RestoreTarget:
    database: str
    params: dict[str, str]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="将课堂备份恢复到隔离空库并生成校验回执")
    parser.add_argument("backup", type=Path, help="backup_classroom.sh 生成的 custom-format .dump")
    parser.add_argument("--receipt", type=Path, help="可选的 JSON 回执路径；必须尚不存在")
    return parser


def _restore_target(dsn: str, confirmation: str) -> RestoreTarget:
    if not dsn:
        raise DrillError("必须通过 GVCSIM_RESTORE_DSN 提供目标库")
    try:
        raw = conninfo_to_dict(dsn)
    except psycopg.Error as error:
        raise DrillError("GVCSIM_RESTORE_DSN 不是有效的 PostgreSQL DSN") from error
    if "service" in raw:
        raise DrillError("恢复演练要求显式 DSN，不接受嵌套 libpq service")
    params = {str(key): str(value) for key, value in raw.items()}
    database = params.get("dbname", "")
    if not _TARGET_NAME.fullmatch(database):
        raise DrillError("目标数据库名必须匹配 ^[a-z][a-z0-9_]*_restore_drill$")
    if confirmation != database:
        raise DrillError("GVCSIM_RESTORE_DRILL_CONFIRM 必须与目标数据库名完全一致")
    return RestoreTarget(database=database, params=params)


def _private_regular_file(path: Path, label: str) -> Path:
    try:
        resolved = path.expanduser().resolve(strict=True)
        mode = resolved.stat().st_mode
    except OSError as error:
        raise DrillError(f"{label}不存在或不可读") from error
    if not stat.S_ISREG(mode):
        raise DrillError(f"{label}必须是普通文件")
    if mode & 0o077:
        raise DrillError(f"{label}权限过宽；请先 chmod 600")
    return resolved


def _verified_checksum(backup: Path, sidecar: Path) -> str:
    try:
        lines = [line for line in sidecar.read_text(encoding="utf-8").splitlines() if line.strip()]
    except (OSError, UnicodeError) as error:
        raise DrillError("无法读取 SHA-256 sidecar") from error
    if len(lines) != 1:
        raise DrillError("SHA-256 sidecar 必须只有一条非空记录")
    match = re.fullmatch(r"([0-9A-Fa-f]{64})\s+\*?(.*)", lines[0])
    if not match or not match.group(2):
        raise DrillError("SHA-256 sidecar 格式无效")
    expected, listed_name = match.group(1).lower(), match.group(2)
    if Path(listed_name).name != backup.name:
        raise DrillError("SHA-256 sidecar 指向的文件名与备份不一致")

    digest = hashlib.sha256()
    try:
        with backup.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise DrillError("读取备份以计算 SHA-256 失败") from error
    actual = digest.hexdigest()
    if not hmac.compare_digest(actual, expected):
        raise DrillError("备份 SHA-256 校验失败；拒绝连接目标数据库")
    return actual


def _write_service_file(path: Path, target: RestoreTarget) -> None:
    lines = [f"[{SERVICE_NAME}]"]
    for key, value in sorted(target.params.items()):
        if not _SERVICE_KEY.fullmatch(key) or "\n" in value or "\r" in value:
            raise DrillError(f"目标 DSN 包含不支持的连接参数：{key}")
        lines.append(f"{key}={value}")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def _tool_environment(service_file: Path) -> dict[str, str]:
    environment = os.environ.copy()
    for key in (
        "PGDATABASE",
        "PGHOST",
        "PGHOSTADDR",
        "PGPASSFILE",
        "PGPASSWORD",
        "PGPORT",
        "PGSERVICE",
        "PGSERVICEFILE",
        "PGUSER",
    ):
        environment.pop(key, None)
    environment["PGSERVICEFILE"] = str(service_file)
    environment["PGSERVICE"] = SERVICE_NAME
    return environment


def _run_tool(
    command: list[str], environment: dict[str, str], *, error_message: str
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=True,
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise DrillError(error_message) from error


def _required_row(row: tuple[Any, ...] | None, context: str) -> tuple[Any, ...]:
    if row is None:
        raise DrillError(f"数据库未返回预期结果：{context}")
    return row


def _assert_empty_target(dsn: str, database: str) -> None:
    try:
        with psycopg.connect(dsn, autocommit=True, application_name="gvcsim-restore-drill-check") as connection:
            current_database = _required_row(
                connection.execute("SELECT current_database()").fetchone(), "current_database"
            )[0]
            if current_database != database:
                raise DrillError("连接到的数据库与已确认目标不一致")
            collation_matches = _required_row(
                connection.execute(
                    """
                    SELECT datcollversion IS NOT DISTINCT FROM pg_database_collation_actual_version(oid)
                    FROM pg_database
                    WHERE datname = current_database()
                    """
                ).fetchone(),
                "database collation",
            )[0]
            if not collation_matches:
                raise DrillError("目标数据库的 collation 版本与操作系统不一致；先在空库刷新版本再重试")
            active_sessions = _required_row(
                connection.execute(
                    """
                    SELECT count(*)
                    FROM pg_stat_activity
                    WHERE datname = current_database() AND pid <> pg_backend_pid()
                    """
                ).fetchone(),
                "active sessions",
            )[0]
            if active_sessions:
                raise DrillError(f"目标数据库仍有 {active_sessions} 个其他连接；拒绝恢复")
            user_objects = _required_row(
                connection.execute(
                    """
                    WITH user_namespaces AS (
                        SELECT oid
                        FROM pg_namespace
                        WHERE nspname NOT IN ('pg_catalog', 'information_schema')
                          AND nspname !~ '^pg_toast'
                    )
                    SELECT
                        (SELECT count(*) FROM pg_namespace
                         WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema')
                           AND nspname !~ '^pg_toast')
                      + (SELECT count(*) FROM pg_class WHERE relnamespace IN (SELECT oid FROM user_namespaces))
                      + (SELECT count(*) FROM pg_proc WHERE pronamespace IN (SELECT oid FROM user_namespaces))
                      + (SELECT count(*) FROM pg_type
                         WHERE typnamespace IN (SELECT oid FROM user_namespaces)
                           AND typtype IN ('d', 'e', 'r'))
                    """
                ).fetchone(),
                "user objects",
            )[0]
            if user_objects:
                raise DrillError(f"目标数据库不是空库（发现 {user_objects} 个用户对象）；不会执行 clean 或覆盖")
    except DrillError:
        raise
    except psycopg.Error as error:
        raise DrillError(f"无法验证隔离目标数据库 {database}") from error


def _inventory(dsn: str) -> dict[str, Any]:
    try:
        with psycopg.connect(dsn, application_name="gvcsim-restore-drill-inventory") as connection:
            schema_row = connection.execute("SELECT version FROM schema_meta WHERE singleton IS TRUE").fetchone()
            if not schema_row or schema_row[0] != TEACHING_DB_VERSION:
                actual = schema_row[0] if schema_row else "missing"
                raise DrillError(f"恢复后的 schema 版本错误：{actual}")
            table_names = [
                row[0]
                for row in connection.execute(
                    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
                ).fetchall()
            ]
            table_counts: dict[str, int] = {}
            for table_name in table_names:
                identifier = psycopg.sql.Identifier("public", table_name)
                count_row = _required_row(
                    connection.execute(psycopg.sql.SQL("SELECT count(*) FROM {}").format(identifier)).fetchone(),
                    f"row count for {table_name}",
                )
                table_counts[table_name] = int(count_row[0])
            server_version = int(
                _required_row(connection.execute("SHOW server_version_num").fetchone(), "server version")[0]
            )
            collation_row = _required_row(
                connection.execute(
                    """
                    SELECT datlocprovider, datcollversion, pg_database_collation_actual_version(oid)
                    FROM pg_database
                    WHERE datname = current_database()
                    """
                ).fetchone(),
                "database collation inventory",
            )
    except DrillError:
        raise
    except psycopg.Error as error:
        raise DrillError("恢复后数据库清单校验失败") from error
    return {
        "schema_version": TEACHING_DB_VERSION,
        "postgresql_server_version_num": server_version,
        "database_collation": {
            "provider": collation_row[0],
            "recorded_version": collation_row[1],
            "actual_version": collation_row[2],
            "matches": collation_row[1] == collation_row[2],
        },
        "table_counts": table_counts,
        "referenced_artifacts": {},
    }


def _write_receipt(path: Path, payload: dict[str, Any]) -> Path:
    destination = path.expanduser().absolute()
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.exists():
        raise DrillError("回执路径已存在；拒绝覆盖")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, destination)
        except FileExistsError as error:
            raise DrillError("回执路径已存在；拒绝覆盖") from error
        directory_fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def _redact(text: str, dsn: str, target: RestoreTarget) -> str:
    redacted = text.replace(dsn, "<redacted-dsn>")
    password = target.params.get("password")
    return redacted.replace(password, "<redacted-password>") if password else redacted


def run(args: argparse.Namespace) -> dict[str, Any]:
    dsn = os.environ.get("GVCSIM_RESTORE_DSN", "")
    confirmation = os.environ.get("GVCSIM_RESTORE_DRILL_CONFIRM", "")
    target = _restore_target(dsn, confirmation)
    backup = _private_regular_file(args.backup, "备份文件")
    sidecar = _private_regular_file(Path(f"{backup}.sha256"), "SHA-256 sidecar")
    checksum = _verified_checksum(backup, sidecar)
    if shutil.which("pg_restore") is None:
        raise DrillError("找不到 pg_restore")

    started_at = datetime.now(UTC)
    monotonic_started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="gvcsim-restore-drill-") as temporary_dir:
        service_file = Path(temporary_dir) / "pg_service.conf"
        _write_service_file(service_file, target)
        tool_environment = _tool_environment(service_file)
        tool_version = _run_tool(
            ["pg_restore", "--version"],
            tool_environment,
            error_message="无法读取 pg_restore 版本",
        ).stdout.strip()
        archive_toc = _run_tool(
            ["pg_restore", "--list", str(backup)],
            tool_environment,
            error_message="备份不是可读取的 custom archive",
        ).stdout
        archive_versions = [
            line.removeprefix(";     ").strip()
            for line in archive_toc.splitlines()
            if line.startswith((";     Dumped from database version:", ";     Dumped by pg_dump version:"))
        ]
        _assert_empty_target(dsn, target.database)
        _run_tool(
            [
                "pg_restore",
                "--no-password",
                "--no-owner",
                "--no-acl",
                "--single-transaction",
                f"--dbname=service={SERVICE_NAME}",
                str(backup),
            ],
            tool_environment,
            error_message="pg_restore 失败；单事务已回滚，目标库保留供检查",
        )

    preflight_environment = os.environ.copy()
    preflight_environment["GVCSIM_PG_DSN"] = dsn
    preflight = _run_tool(
        [sys.executable, "-m", "gvcsim.cli", "preflight"],
        preflight_environment,
        error_message="恢复完成，但应用只读 preflight 未通过；目标库保留供检查",
    )
    inventory = _inventory(dsn)
    completed_at = datetime.now(UTC)
    payload: dict[str, Any] = {
        "kind": RECEIPT_KIND,
        "started_at": started_at.isoformat(),
        "completed_at": completed_at.isoformat(),
        "duration_seconds": round(time.monotonic() - monotonic_started, 3),
        "backup": {
            "filename": backup.name,
            "sha256": checksum,
            "size_bytes": backup.stat().st_size,
            "archive_versions": archive_versions,
        },
        "restore_tool": tool_version,
        "target_database": target.database,
        "preflight": _redact(preflight.stdout.strip(), dsn, target),
        "preflight_warnings": _redact(preflight.stderr.strip(), dsn, target),
        **inventory,
    }
    if args.receipt:
        receipt = _write_receipt(args.receipt, payload)
        payload["receipt_path"] = str(receipt)
    return payload


def main() -> None:
    args = _parser().parse_args()
    try:
        payload = run(args)
    except DrillError as error:
        print(f"恢复演练拒绝执行：{error}", file=sys.stderr)
        raise SystemExit(1) from error
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    print("目标数据库不会自动删除；核对回执后由操作员显式 dropdb。", file=sys.stderr)


if __name__ == "__main__":
    main()
