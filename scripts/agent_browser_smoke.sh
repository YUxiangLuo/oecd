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
har_sanitizer="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sanitize_har.py"
temporary_artifact_dir=
student_har=

cleanup() {
  "${ab[@]}" close >/dev/null 2>&1 || true
  if [[ -n "$student_har" && -f "$student_har" ]]; then
    python3 "$har_sanitizer" "$student_har" >/dev/null 2>&1 || rm -f "$student_har"
  fi
  [[ -z "$temporary_artifact_dir" ]] || rm -rf "$temporary_artifact_dir"
}
trap cleanup EXIT

if [[ -n "$artifact_dir" ]]; then
  install -d -m 0750 "$artifact_dir"
  a11y_dir=$artifact_dir
else
  temporary_artifact_dir=$(mktemp -d)
  chmod 0700 "$temporary_artifact_dir"
  a11y_dir=$temporary_artifact_dir
fi

assert_a11y() {
  local report=$1
  "${ab[@]}" a11y --tags wcag2a,wcag2aa --json >"$report"
  local violations
  violations=$(python3 - "$report" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
if payload.get("success") is not True:
    raise SystemExit("agent-browser accessibility audit did not complete")
print(len((payload.get("data") or {}).get("violations") or []))
PY
)
  if [[ "$violations" -ne 0 ]]; then
    cat "$report" >&2
    return 1
  fi
}

agent-browser doctor >/dev/null
"${ab[@]}" open "$GVCSIM_BASE_URL"
"${ab[@]}" set viewport "$viewport_width" "$viewport_height"
"${ab[@]}" fill '#login-user' "$GVCSIM_E2E_USERNAME"
"${ab[@]}" fill '#login-pass' "$GVCSIM_E2E_PASSWORD"
"${ab[@]}" click 'button[type="submit"]'
"${ab[@]}" wait --text '课程大纲'

# 所有学生路由必须能在真实登录态下挂载。这里不伪造答题完成度；完整答题与
# 报告流程由人工/夜间真实数据审查执行。每一步都等待异步数据稳定、核对实际
# 路由并单独执行 axe，避免“只审计循环最后一页”给出假绿灯。
for step in $(seq 1 16); do
  "${ab[@]}" open "$GVCSIM_BASE_URL/?step=$step"
  "${ab[@]}" wait '.step-header-mid h2'
  "${ab[@]}" wait --load networkidle
  "${ab[@]}" eval "(() => { const actual=document.querySelector('.step-count')?.textContent?.trim(); const expected='第 $step / 16 步'; if(actual!==expected) throw new Error(\`student route mismatch: expected \${expected}, got \${actual}\`); return true; })()"
  if [[ "$step" -eq 10 ]]; then
    # The network uses one portalled dialog instance: node activation expands it,
    # Escape closes it, and focus/selection return to the invoking SVG node.
    "${ab[@]}" wait '.network-node[aria-label^="USA "]'
    "${ab[@]}" focus '.network-node[aria-label^="USA "]'
    "${ab[@]}" press Enter
    "${ab[@]}" wait '[role="dialog"][aria-modal="true"]'
    "${ab[@]}" eval '(() => { const d=document.querySelector("[role=dialog][aria-modal=true]"); if(document.querySelectorAll(".network-card").length!==1) throw new Error("network dialog duplicated the graph"); if(document.activeElement?.textContent?.trim()!=="退出大图") throw new Error("network dialog did not receive focus"); return true; })()'
    assert_a11y "$a11y_dir/student-step10-modal-a11y.json"
    "${ab[@]}" press Escape
    "${ab[@]}" wait --fn '() => !document.querySelector("[role=dialog]")'
    "${ab[@]}" eval '(() => { const n=document.activeElement; if(!n?.classList.contains("network-node") || n.getAttribute("aria-pressed")!=="true") throw new Error("network dialog did not restore its node focus and selection"); return true; })()'
  fi
  if [[ "$step" -eq 11 ]]; then
    # Step 11 uses different small-text colors after selecting each shock family.
    # Audit all three states; the default tariff-only audit previously missed an
    # inaccessible export-control label.
    assert_a11y "$a11y_dir/student-step11-tariff-a11y.json"
    for spec in 'sanctions:制裁清单' 'export_control:出口管制'; do
      shock_type=${spec%%:*}
      shock_label=${spec#*:}
      selector="button.shock-event-item[data-shock-type=\"$shock_type\"]:nth-of-type(1)"
      "${ab[@]}" wait "$selector"
      "${ab[@]}" click "$selector"
      "${ab[@]}" wait --fn "() => document.querySelector('.shock-linkbar-tag')?.textContent?.trim() === '$shock_label' && document.querySelector('.shock-panel-body')?.getAttribute('aria-busy') === 'false'"
      assert_a11y "$a11y_dir/student-step11-${shock_type}-a11y.json"
    done
  else
    assert_a11y "$a11y_dir/student-step${step}-a11y.json"
  fi
done

if [[ -n "$artifact_dir" ]]; then
  student_har="$artifact_dir/student-step16.har"
  "${ab[@]}" screenshot "$artifact_dir/student-step16.png" --full
  "${ab[@]}" network har start
  "${ab[@]}" reload
  "${ab[@]}" wait --load networkidle
  "${ab[@]}" network har stop "$student_har"
  python3 "$har_sanitizer" "$student_har"
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
