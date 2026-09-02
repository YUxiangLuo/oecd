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
for step in $(seq 1 15); do
  "${ab[@]}" open "$GVCSIM_BASE_URL/?step=$step"
  "${ab[@]}" wait '.step-header-mid h2'
  # 步骤标题属于同步外壳；指标表、冲击面板等会在后续 API 成功后才挂载。
  # 必须等网络安静并再跨过两帧渲染，布局断言才覆盖最终异步内容，而非空壳窗口期。
  "${ab[@]}" wait --load networkidle
  "${ab[@]}" eval '(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))()' >/dev/null
  # 100vh 固定布局下文档级永远不应出现滚动（幻影滚动会卷走顶栏与侧栏）。
  # sr-only 缺坐标、超高未裁剪元素都曾在这里突破布局，逐步断言防回归。
  "${ab[@]}" eval '(() => { const d = document.documentElement; if (d.scrollHeight > d.clientHeight + 1) throw new Error(`document scrolls: ${d.scrollHeight} > ${d.clientHeight}`); return true; })()' >/dev/null
  if [[ "$step" -eq 9 ]]; then
    # The network uses one portalled dialog instance: node activation expands it,
    # Escape closes it, and focus/selection return to the invoking SVG node.
    "${ab[@]}" wait '.network-node[aria-label^="USA "]'
    "${ab[@]}" wait --load networkidle
    "${ab[@]}" focus '.network-node[aria-label^="USA "]'
    "${ab[@]}" press Enter
    "${ab[@]}" wait '[role="dialog"][aria-modal="true"]'
    "${ab[@]}" eval '(() => { const d=document.querySelector("[role=dialog][aria-modal=true]"); if(document.querySelectorAll(".network-card").length!==1) throw new Error("network dialog duplicated the graph"); if(document.activeElement?.textContent?.trim()!=="退出大图") throw new Error("network dialog did not receive focus"); return true; })()'
    "${ab[@]}" press Escape
    "${ab[@]}" wait --fn '!document.querySelector("[role=dialog]")'
    "${ab[@]}" eval '(() => { const n=document.activeElement; if(!n?.classList.contains("network-node") || n.getAttribute("aria-pressed")!=="true") throw new Error("network dialog did not restore its node focus and selection"); return true; })()'
  fi
done

if [[ -n "$artifact_dir" ]]; then
  install -d -m 0750 "$artifact_dir"
  a11y_report="$artifact_dir/student-step15-a11y.json"
  "${ab[@]}" screenshot "$artifact_dir/student-step15.png" --full
  "${ab[@]}" network har start
  "${ab[@]}" reload
  "${ab[@]}" wait --load networkidle
  "${ab[@]}" network har stop "$artifact_dir/student-step15.har"
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

echo "student routes 1-15 rendered without browser/API errors or WCAG 2 A/AA violations"
