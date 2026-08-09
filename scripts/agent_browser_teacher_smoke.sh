#!/usr/bin/env bash
set -euo pipefail

: "${GVCSIM_BASE_URL:?GVCSIM_BASE_URL must be set, e.g. http://127.0.0.1:5173}"
: "${GVCSIM_E2E_USERNAME:?GVCSIM_E2E_USERNAME must be set}"
: "${GVCSIM_E2E_PASSWORD:?GVCSIM_E2E_PASSWORD must be set}"
: "${GVCSIM_E2E_NEW_PASSWORD:?GVCSIM_E2E_NEW_PASSWORD must be set}"

if [[ "$GVCSIM_E2E_PASSWORD" == "$GVCSIM_E2E_NEW_PASSWORD" || ${#GVCSIM_E2E_NEW_PASSWORD} -lt 12 ]]; then
  echo "teacher smoke requires a distinct new password of at least 12 characters" >&2
  exit 2
fi

browser_namespace=${GVCSIM_E2E_NAMESPACE:-gvcsim-e2e}
browser_session=${GVCSIM_E2E_SESSION:-"teacher-$(date -u +%Y%m%dT%H%M%SZ)"}
artifact_dir=${GVCSIM_E2E_ARTIFACT_DIR:-}
viewport_width=${GVCSIM_E2E_VIEWPORT_WIDTH:-1440}
viewport_height=${GVCSIM_E2E_VIEWPORT_HEIGHT:-1000}
[[ "$viewport_width" =~ ^[0-9]+$ && "$viewport_height" =~ ^[0-9]+$ && "$viewport_width" -ge 1200 ]] || {
  echo "desktop smoke requires a numeric viewport of at least 1200px width" >&2
  exit 2
}

ab=(agent-browser --namespace "$browser_namespace" --session "$browser_session")
temporary_a11y_report=
har_started=0

cleanup() {
  if [[ "$har_started" -eq 1 && -n "$artifact_dir" ]]; then
    "${ab[@]}" network har stop "$artifact_dir/teacher-password-flow.har" >/dev/null 2>&1 || true
  fi
  "${ab[@]}" close >/dev/null 2>&1 || true
  [[ -z "$temporary_a11y_report" ]] || rm -f "$temporary_a11y_report"
}
trap cleanup EXIT

agent-browser doctor >/dev/null
if [[ -n "$artifact_dir" ]]; then
  install -d -m 0750 "$artifact_dir"
  a11y_report="$artifact_dir/teacher-password-a11y.json"
else
  temporary_a11y_report=$(mktemp)
  a11y_report=$temporary_a11y_report
fi

"${ab[@]}" open "$GVCSIM_BASE_URL"
"${ab[@]}" set viewport "$viewport_width" "$viewport_height"
"${ab[@]}" fill '#login-user' "$GVCSIM_E2E_USERNAME"
"${ab[@]}" fill '#login-pass' "$GVCSIM_E2E_PASSWORD"
"${ab[@]}" click 'button[type="submit"]'
"${ab[@]}" wait --text '教师工作台'

if [[ -n "$artifact_dir" ]]; then
  "${ab[@]}" network har start
  har_started=1
fi

"${ab[@]}" find role button click --name '修改密码' --exact
"${ab[@]}" wait --text '修改登录密码'
"${ab[@]}" a11y --tags wcag2a,wcag2aa --json >"$a11y_report"
a11y_violations=$(python3 - "$a11y_report" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
if payload.get("success") is not True:
    raise SystemExit("agent-browser accessibility audit did not complete")
print(len((payload.get("data") or {}).get("violations") or []))
PY
)
if [[ "$a11y_violations" -ne 0 ]]; then
  cat "$a11y_report" >&2
  exit 1
fi

"${ab[@]}" fill '#account-current-password' "$GVCSIM_E2E_PASSWORD"
"${ab[@]}" fill '#account-new-password' "$GVCSIM_E2E_NEW_PASSWORD"
"${ab[@]}" fill '#account-confirm-password' "$GVCSIM_E2E_NEW_PASSWORD"
if [[ -n "$artifact_dir" ]]; then
  "${ab[@]}" screenshot "$artifact_dir/teacher-password-dialog.png"
fi
"${ab[@]}" find role button click --name '修改并重新登录' --exact
"${ab[@]}" wait --text '密码已修改，所有旧会话均已撤销。请使用新密码重新登录。'
if [[ -n "$artifact_dir" ]]; then
  "${ab[@]}" screenshot "$artifact_dir/teacher-password-changed.png"
fi

# The old credential must fail. Its expected 401 (and the revoked-token logout request)
# are cleared before the final unexpected-request gate.
"${ab[@]}" fill '#login-user' "$GVCSIM_E2E_USERNAME"
"${ab[@]}" fill '#login-pass' "$GVCSIM_E2E_PASSWORD"
"${ab[@]}" click 'button[type="submit"]'
"${ab[@]}" wait --text '用户名或密码错误'
"${ab[@]}" network requests --clear >/dev/null

"${ab[@]}" fill '#login-pass' "$GVCSIM_E2E_NEW_PASSWORD"
"${ab[@]}" click 'button[type="submit"]'
"${ab[@]}" wait --text '教师工作台'
if [[ -n "$artifact_dir" ]]; then
  "${ab[@]}" screenshot "$artifact_dir/teacher-password-relogin.png" --full
  "${ab[@]}" network har stop "$artifact_dir/teacher-password-flow.har"
  har_started=0
fi

page_errors=$("${ab[@]}" errors)
if [[ -n "$page_errors" ]]; then
  printf '%s\n' "$page_errors" >&2
  exit 1
fi

failed_requests=$("${ab[@]}" network requests --filter '/api/' | grep -E '(^|[[:space:]])(4[0-9]{2}|5[0-9]{2})([[:space:]]|$)' || true)
if [[ -n "$failed_requests" ]]; then
  printf '%s\n' "$failed_requests" >&2
  exit 1
fi

echo "teacher password rotation and relogin passed without browser/API errors or WCAG 2 A/AA violations"
