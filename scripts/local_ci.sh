#!/usr/bin/env bash
# Run the former GitHub Actions gates against an isolated local checkout and database.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
output_dir="$root/dogfood-output/local-ci/$run_id"
temporary_dir=
postgres_container=
api_pid=
ui_pid=

cleanup() {
  status=$?
  trap - EXIT
  for pid in "$ui_pid" "$api_pid"; do
    if [[ -n "$pid" ]]; then
      kill -TERM -- "-$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
  if [[ -n "$postgres_container" ]]; then
    docker stop "$postgres_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$temporary_dir" ]]; then
    rm -rf -- "$temporary_dir"
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "Local CI failed. Browser service logs, if started: $output_dir" >&2
    for log in "$output_dir/api.log" "$output_dir/frontend.log"; do
      if [[ -f "$log" ]]; then
        echo "--- $log ---" >&2
        tail -100 "$log" >&2 || true
      fi
    done
  fi
  exit "$status"
}
trap cleanup EXIT

for tool in git rsync docker uv bun mvn java agent-browser pdftotext curl python3 openssl setsid; do
  command -v "$tool" >/dev/null || { echo "Missing local CI dependency: $tool" >&2; exit 2; }
done
docker info >/dev/null 2>&1 || { echo "Docker daemon is unavailable" >&2; exit 2; }
agent-browser doctor >/dev/null

mkdir -p "$output_dir"
temporary_dir="$(mktemp -d)"
snapshot="$temporary_dir/repo"
mkdir -p "$snapshot"

# Copy the current working tree, including uncommitted and untracked source files.
# Git-ignored OECD data, releases, secrets, virtualenvs and build output stay out.
git -C "$root" ls-files --cached --others --exclude-standard -z \
  | rsync -a --from0 --files-from=- --ignore-missing-args "$root/" "$snapshot/"
cd "$snapshot"

echo "[local-ci] Installing Python and frontend dependencies"
uv sync --locked --group dev
(cd frontend && bun install --frozen-lockfile)

echo "[local-ci] Gephi 0.10.1 golden oracle"
scripts/gephi_golden/generate.sh --check

echo "[local-ci] Backend static checks"
uv run ruff format --check .
uv run ruff check .
uv run mypy
bash -n scripts/*.sh

echo "[local-ci] Frontend build and unit tests"
(cd frontend && bun run build && bun run test:unit && bun run test:build-modes)

echo "[local-ci] Starting temporary PostgreSQL 17"
db_password="$(openssl rand -hex 20)"
postgres_container="$(docker run --rm -d \
  -e POSTGRES_USER=gvcsim_ci -e "POSTGRES_PASSWORD=$db_password" \
  -p 127.0.0.1::5432 postgres:17)"
ready=0
for _ in $(seq 1 60); do
  # The image's initialization server accepts Unix sockets but shuts down before
  # normal startup. TCP readiness excludes that temporary server.
  if docker exec "$postgres_container" pg_isready -h 127.0.0.1 -U gvcsim_ci -d postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || { echo "Temporary PostgreSQL did not become ready" >&2; exit 1; }
docker exec "$postgres_container" createdb -U gvcsim_ci gvclab_test
docker exec "$postgres_container" createdb -U gvcsim_ci gvclab_e2e
db_port="$(docker port "$postgres_container" 5432/tcp)"
db_port="${db_port##*:}"
[[ "$db_port" =~ ^[0-9]+$ ]] || { echo "Could not determine PostgreSQL host port" >&2; exit 1; }

export CI=true GVCSIM_CI_SYNTHETIC=1
export GVCSIM_PG_DSN="postgresql://gvcsim_ci:$db_password@127.0.0.1:$db_port/gvclab_test"
export GVCSIM_PG_DSN_TEST="$GVCSIM_PG_DSN"

echo "[local-ci] Building isolated synthetic OECD release"
uv run python scripts/build_ci_synthetic_data.py

echo "[local-ci] Backend tests with coverage"
uv run python -c 'import os, psycopg; psycopg.connect(os.environ["GVCSIM_PG_DSN"]).close()'
uv run pytest --cov=gvcsim --cov-report=term-missing -q

echo "[local-ci] Desktop browser smoke"
export GVCSIM_PG_DSN="postgresql://gvcsim_ci:$db_password@127.0.0.1:$db_port/gvclab_e2e"
export GVCSIM_PG_DSN_TEST="$GVCSIM_PG_DSN"
export GVCSIM_DEMO_MODE=1
export GVCSIM_BOOTSTRAP_PASSWORD=ci-browser-private-password
export GVCSIM_AUTH_SECRET=ci-browser-auth-secret-at-least-32-bytes
uv run gvcsim classroom-init --reset
uv run gvcsim preflight

read -r api_port ui_port < <(python3 - <<'PY'
import socket

sockets = [socket.socket(), socket.socket()]
try:
    for sock in sockets:
        sock.bind(("127.0.0.1", 0))
    print(*(sock.getsockname()[1] for sock in sockets))
finally:
    for sock in sockets:
        sock.close()
PY
)
export GVCSIM_API_PROXY="http://127.0.0.1:$api_port"
setsid uv run gvcsim serve --host 127.0.0.1 --port "$api_port" --no-access-log \
  >"$output_dir/api.log" 2>&1 &
api_pid=$!
setsid bash -c 'cd "$1/frontend" && exec bun run preview -- --host 127.0.0.1 --port "$2" --strictPort' \
  bash "$snapshot" "$ui_port" >"$output_dir/frontend.log" 2>&1 &
ui_pid=$!

ready=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$api_port/health" >/dev/null 2>&1 \
    && curl -fsS "http://127.0.0.1:$ui_port/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$api_pid" 2>/dev/null || ! kill -0 "$ui_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || { echo "Browser smoke services did not become ready" >&2; exit 1; }

export GVCSIM_BASE_URL="http://127.0.0.1:$ui_port"
export GVCSIM_E2E_PASSWORD="$GVCSIM_BOOTSTRAP_PASSWORD"
export GVCSIM_E2E_NAMESPACE="gvcsim-local-ci-$run_id"

GVCSIM_E2E_USERNAME=student GVCSIM_E2E_SESSION=student \
  GVCSIM_E2E_ARTIFACT_DIR="$output_dir/student" scripts/agent_browser_smoke.sh
GVCSIM_E2E_USERNAME=student GVCSIM_E2E_TEACHER_USERNAME=teacher \
  GVCSIM_E2E_TEACHER_PASSWORD="$GVCSIM_BOOTSTRAP_PASSWORD" \
  GVCSIM_E2E_ARTIFACT_DIR="$output_dir/full-journey" scripts/agent_browser_full_journey.sh
GVCSIM_E2E_USERNAME=teacher GVCSIM_E2E_NEW_PASSWORD=ci-browser-rotated-private-password \
  GVCSIM_E2E_SESSION=teacher GVCSIM_E2E_ARTIFACT_DIR="$output_dir/teacher" \
  scripts/agent_browser_teacher_smoke.sh
curl -fsS "http://127.0.0.1:$api_port/health" >"$output_dir/health.json"

echo "[local-ci] All checks passed. Browser evidence: $output_dir"
