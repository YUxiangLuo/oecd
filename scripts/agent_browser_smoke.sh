#!/usr/bin/env bash
set -euo pipefail

: "${GVCSIM_BASE_URL:?GVCSIM_BASE_URL must be set, e.g. http://127.0.0.1:5173}"
: "${GVCSIM_E2E_USERNAME:?GVCSIM_E2E_USERNAME must be set}"
: "${GVCSIM_E2E_PASSWORD:?GVCSIM_E2E_PASSWORD must be set}"

browser_namespace=${GVCSIM_E2E_NAMESPACE:-gvcsim-e2e}
browser_session=${GVCSIM_E2E_SESSION:-"student-$(date -u +%Y%m%dT%H%M%SZ)"}
artifact_dir=${GVCSIM_E2E_ARTIFACT_DIR:-}
viewport_width=${GVCSIM_E2E_VIEWPORT_WIDTH:-1440}
viewport_height=${GVCSIM_E2E_VIEWPORT_HEIGHT:-1000}
[[ "$viewport_width" =~ ^[0-9]+$ && "$viewport_height" =~ ^[0-9]+$ && "$viewport_width" -ge 1200 ]] || {
  echo "desktop smoke requires a numeric viewport of at least 1200px width" >&2
  exit 2
}
ab=(agent-browser --namespace "$browser_namespace" --session "$browser_session")
temporary_a11y_report=

cleanup() {
  "${ab[@]}" close >/dev/null 2>&1 || true
  [[ -z "$temporary_a11y_report" ]] || rm -f "$temporary_a11y_report"
}
trap cleanup EXIT

agent-browser doctor >/dev/null
"${ab[@]}" open "$GVCSIM_BASE_URL"
"${ab[@]}" set viewport "$viewport_width" "$viewport_height"
"${ab[@]}" fill '#login-user' "$GVCSIM_E2E_USERNAME"
"${ab[@]}" fill '#login-pass' "$GVCSIM_E2E_PASSWORD"
"${ab[@]}" click 'button[type="submit"]'
"${ab[@]}" wait --text '课程大纲'

# 所有学生路由必须能在真实登录态下挂载。这里不伪造答题完成度；完整答题与
# 报告流程由人工/夜间真实数据审查执行，smoke 负责捕获白屏、路由和请求错误。
for step in $(seq 1 16); do
  "${ab[@]}" open "$GVCSIM_BASE_URL/?step=$step"
  "${ab[@]}" wait '.step-header-mid h2'
done

if [[ -n "$artifact_dir" ]]; then
  install -d -m 0750 "$artifact_dir"
  a11y_report="$artifact_dir/student-step16-a11y.json"
  "${ab[@]}" screenshot "$artifact_dir/student-step16.png" --full
  "${ab[@]}" network har start
  "${ab[@]}" reload
  "${ab[@]}" wait --load networkidle
  "${ab[@]}" network har stop "$artifact_dir/student-step16.har"
else
  temporary_a11y_report=$(mktemp)
  a11y_report=$temporary_a11y_report
fi

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

echo "student routes 1-16 rendered without browser/API errors or WCAG 2 A/AA violations"
