#!/usr/bin/env bash
set -euo pipefail

: "${GVCSIM_BASE_URL:?GVCSIM_BASE_URL must be set}"
: "${GVCSIM_E2E_USERNAME:?GVCSIM_E2E_USERNAME must be set}"
: "${GVCSIM_E2E_PASSWORD:?GVCSIM_E2E_PASSWORD must be set}"
: "${GVCSIM_E2E_TEACHER_USERNAME:?GVCSIM_E2E_TEACHER_USERNAME must be set}"
: "${GVCSIM_E2E_TEACHER_PASSWORD:?GVCSIM_E2E_TEACHER_PASSWORD must be set}"

browser_namespace=${GVCSIM_E2E_NAMESPACE:-gvcsim-full-journey}
artifact_dir=${GVCSIM_E2E_ARTIFACT_DIR:-}
viewport_width=${GVCSIM_E2E_VIEWPORT_WIDTH:-1440}
viewport_height=${GVCSIM_E2E_VIEWPORT_HEIGHT:-1000}
[[ "$viewport_width" =~ ^[0-9]+$ && "$viewport_height" =~ ^[0-9]+$ && "$viewport_width" -ge 1200 ]] || {
  echo "full journey requires a desktop viewport of at least 1200px" >&2
  exit 2
}

uv run python scripts/seed_full_journey.py

student=(agent-browser --namespace "$browser_namespace" --session full-student)
teacher=(agent-browser --namespace "$browser_namespace" --session full-teacher)
cleanup() {
  "${student[@]}" close >/dev/null 2>&1 || true
  "${teacher[@]}" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ -n "$artifact_dir" ]]; then
  install -d -m 0750 "$artifact_dir"
fi

"${student[@]}" open "$GVCSIM_BASE_URL/?step=16"
"${student[@]}" set viewport "$viewport_width" "$viewport_height"
"${student[@]}" fill '#login-user' "$GVCSIM_E2E_USERNAME"
"${student[@]}" fill '#login-pass' "$GVCSIM_E2E_PASSWORD"
"${student[@]}" click 'button[type="submit"]'
"${student[@]}" wait --text '课程大纲'
# 远程延迟下外壳文本（课程大纲）先于介绍遮罩渲染：必须等遮罩真正挂载再跳过，
# 否则 eval 与后续的 overlay-gone 检查都会落在遮罩未出现的窗口期而误判通过。
"${student[@]}" wait 'button[aria-label="跳过介绍"]'
"${student[@]}" click 'button[aria-label="跳过介绍"]'
"${student[@]}" wait --fn '!document.querySelector(".intro-overlay")'
"${student[@]}" wait --text '生成实验报告'
"${student[@]}" find role button click --name '根据实验记录生成报告' --exact
"${student[@]}" wait --text '草稿 · 尚未提交'
"${student[@]}" find role button click --name '提交报告给老师' --exact
"${student[@]}" wait --text '等待教师评阅'
if [[ -n "$artifact_dir" ]]; then
  "${student[@]}" screenshot "$artifact_dir/student-submitted.png" --full
fi
student_errors=$("${student[@]}" errors)
if [[ -n "$student_errors" ]]; then
  printf '%s\n' "$student_errors" >&2
  exit 1
fi
student_failed_requests=$("${student[@]}" network requests --filter '/api/' | grep -E '(^|[[:space:]])(4[0-9]{2}|5[0-9]{2})([[:space:]]|$)' || true)
if [[ -n "$student_failed_requests" ]]; then
  printf '%s\n' "$student_failed_requests" >&2
  exit 1
fi
"${student[@]}" close

"${teacher[@]}" open "$GVCSIM_BASE_URL/"
"${teacher[@]}" set viewport "$viewport_width" "$viewport_height"
"${teacher[@]}" fill '#login-user' "$GVCSIM_E2E_TEACHER_USERNAME"
"${teacher[@]}" fill '#login-pass' "$GVCSIM_E2E_TEACHER_PASSWORD"
"${teacher[@]}" click 'button[type="submit"]'
"${teacher[@]}" wait --text '教师工作台'
"${teacher[@]}" find role button click --name '报告评阅'
"${teacher[@]}" wait --text "$GVCSIM_E2E_USERNAME"
"${teacher[@]}" click '.data-table tbody tr button.primary'
"${teacher[@]}" wait --text '四项评分锚点'
"${teacher[@]}" fill 'input[type="number"]' '92'
"${teacher[@]}" fill '.grade-field textarea' '自动化完整旅程：报告生成、提交与评阅均通过。'
"${teacher[@]}" find role button click --name '提交评阅' --exact
"${teacher[@]}" wait --text '已评阅'
if [[ -n "$artifact_dir" ]]; then
  "${teacher[@]}" screenshot "$artifact_dir/teacher-graded.png" --full
fi
teacher_errors=$("${teacher[@]}" errors)
if [[ -n "$teacher_errors" ]]; then
  printf '%s\n' "$teacher_errors" >&2
  exit 1
fi
teacher_failed_requests=$("${teacher[@]}" network requests --filter '/api/' | grep -E '(^|[[:space:]])(4[0-9]{2}|5[0-9]{2})([[:space:]]|$)' || true)
if [[ -n "$teacher_failed_requests" ]]; then
  printf '%s\n' "$teacher_failed_requests" >&2
  exit 1
fi

echo "full student session, report submission, and teacher grading journey passed"
