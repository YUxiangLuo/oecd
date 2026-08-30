from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from gvcsim.config import ROOT

BACKUP_SCRIPT = ROOT / "scripts" / "backup_classroom.sh"


def _executable(path: Path, source: str) -> None:
    path.write_text(source, encoding="utf-8")
    path.chmod(0o755)


def _fake_backup_environment(tmp_path: Path) -> tuple[dict[str, str], Path]:
    binary_dir = tmp_path / "bin"
    binary_dir.mkdir()
    _executable(
        binary_dir / "date",
        "#!/usr/bin/env bash\nprintf '20260830T120000Z\\n'\n",
    )
    _executable(
        binary_dir / "pg_dump",
        """#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  printf 'pg_dump (fake) 1.0\\n'
  exit 0
fi
output=
for argument in "$@"; do
  if [[ "$argument" == --file=* ]]; then output=${argument#--file=}; fi
done
[[ -n "$output" ]]
printf 'fake custom-format dump\\n' >"$output"
""",
    )
    _executable(binary_dir / "pg_restore", "#!/usr/bin/env bash\nexit 0\n")
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    environment = {
        **os.environ,
        "PATH": f"{binary_dir}{os.pathsep}{os.environ['PATH']}",
        "GVCSIM_PG_DSN": "postgresql://example:private@127.0.0.1/example",
        "GVCSIM_PYTHON": sys.executable,
        "GVCSIM_BACKUP_DIR": str(backup_dir),
    }
    return environment, backup_dir


def _write_pair(directory: Path, timestamp: str) -> None:
    (directory / f"classroom-{timestamp}.dump").write_text("dump", encoding="utf-8")
    (directory / f"classroom-{timestamp}.dump.sha256").write_text("checksum", encoding="utf-8")


def test_backup_retention_rejects_counts_that_would_overflow_bash(tmp_path):
    environment, backup_dir = _fake_backup_environment(tmp_path)
    environment["GVCSIM_BACKUP_KEEP"] = "18446744073709551616"

    result = subprocess.run(
        [str(BACKUP_SCRIPT)],
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert "1..10000" in result.stderr
    assert not list(backup_dir.iterdir())


def test_backup_retention_counts_only_complete_pairs_before_slicing(tmp_path):
    environment, backup_dir = _fake_backup_environment(tmp_path)
    environment["GVCSIM_BACKUP_KEEP"] = "2"
    _write_pair(backup_dir, "20000101T000000Z")
    _write_pair(backup_dir, "20010101T000000Z")
    orphan = backup_dir / "classroom-99991231T235959Z.dump.sha256"
    orphan.write_text("orphan", encoding="utf-8")

    result = subprocess.run(
        [str(BACKUP_SCRIPT)],
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "retention_keep=2 retention_removed=1" in result.stdout
    assert orphan.is_file()
    assert not (backup_dir / "classroom-20000101T000000Z.dump").exists()
    assert not (backup_dir / "classroom-20000101T000000Z.dump.sha256").exists()
    assert (backup_dir / "classroom-20010101T000000Z.dump").is_file()
    assert (backup_dir / "classroom-20010101T000000Z.dump.sha256").is_file()
    assert (backup_dir / "classroom-20260830T120000Z.dump").is_file()
    assert (backup_dir / "classroom-20260830T120000Z.dump.sha256").is_file()
