#!/usr/bin/env bash
set -euo pipefail

: "${GVCSIM_PG_DSN:?GVCSIM_PG_DSN must be set}"

backup_dir=${GVCSIM_BACKUP_DIR:-/var/backups/gvcsim}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
umask 077
install -d -m 0700 "$backup_dir"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_python=${GVCSIM_PYTHON:-"$script_dir/../.venv/bin/python"}
if [[ ! -x "$project_python" ]]; then
  echo "cannot execute project Python: $project_python (override with GVCSIM_PYTHON)" >&2
  exit 1
fi

dump_path="$backup_dir/classroom-$timestamp.dump"
if [[ -e "$dump_path" || -e "$dump_path.sha256" ]]; then
  echo "refusing to overwrite an existing backup for $timestamp" >&2
  exit 1
fi

# Do not expose a password-bearing DSN in argv. Dump to the destination
# filesystem first, then publish atomically so a failed pg_dump never looks
# like a completed backup.
temp_dump=$(mktemp "$backup_dir/.classroom-$timestamp.XXXXXX.dump")
service_file=$(mktemp "$backup_dir/.pg-service-$timestamp.XXXXXX.conf")
cleanup() {
  rm -f -- "$temp_dump" "$service_file"
}
trap cleanup EXIT
"$project_python" - "$service_file" <<'PY'
import os
from pathlib import Path
import re
import sys

from psycopg.conninfo import conninfo_to_dict

target = Path(sys.argv[1])
params = conninfo_to_dict(os.environ["GVCSIM_PG_DSN"])
if "service" in params:
    raise SystemExit("backup requires an explicit DSN, not a nested libpq service name")
lines = ["[gvcsim_backup]"]
for key, value in sorted(params.items()):
    if not re.fullmatch(r"[a-z_]+", key) or "\n" in value or "\r" in value:
        raise SystemExit(f"unsupported connection parameter in backup DSN: {key}")
    lines.append(f"{key}={value}")
target.write_text("\n".join(lines) + "\n", encoding="utf-8")
target.chmod(0o600)
PY
PGSERVICEFILE="$service_file" PGSERVICE=gvcsim_backup \
  pg_dump --no-password --format=custom --no-owner --no-acl --file="$temp_dump"
chmod 0600 "$temp_dump"
mv -- "$temp_dump" "$dump_path"
rm -f -- "$service_file"
trap - EXIT
dump_path=$(realpath "$dump_path")
sha256sum "$dump_path" > "$dump_path.sha256"

echo "backup=$dump_path"
echo "verify=sha256sum -c $dump_path.sha256"
