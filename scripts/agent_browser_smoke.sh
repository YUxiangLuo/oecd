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


# 表头与它下面的数值必须用同一对齐锚点：左对齐比左缘、右对齐比右缘、居中比中心，
# 内部控件（width:100% 的按钮/色块）自身的对齐也必须与表头一致。偏差 > 2px 或锚点不同即失败。
# 这类缺陷对单元测试与 axe 都不可见（右对齐表头压在居中色块上、button 的 UA 居中盖掉 td 的右对齐），
# 只能实测几何。行头 th[scope=row] 在表头最后一行没有对应格，配对时先摘掉。
read -r -d '' table_align_probe <<'JS' || true
(() => {
  const textRect = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
  const expanded = (row) => {
    const out = [];
    for (const cell of row.children) {
      const span = Number(cell.getAttribute("colspan") || 1);
      for (let k = 0; k < span; k += 1) out.push(cell);
    }
    return out;
  };
  const norm = (a) => (a === "start" ? "left" : a === "end" ? "right" : a);
  const problems = [];
  document.querySelectorAll("__SELECTOR__").forEach((table, tableIndex) => {
    const headRow = table.querySelector("thead tr:last-child");
    const bodyRow = table.querySelector("tbody tr");
    if (!headRow || !bodyRow) return;
    const heads = expanded(headRow);
    let cells = expanded(bodyRow);
    if (cells.length === heads.length + 1 && cells[0].tagName === "TH") cells = cells.slice(1);
    if (heads.length !== cells.length) return;
    // body 行里有 colSpan 时逐列配对不可靠，跳过（这类表的表头锚点另行人工核对）
    if (Array.from(bodyRow.children).some((c) => Number(c.getAttribute("colspan") || 1) > 1)) return;
    heads.forEach((head, i) => {
      const cell = cells[i];
      if (!head.textContent.trim()) return;
      const inner = cell.querySelector("span, button");
      const anchor = norm(getComputedStyle(head).textAlign);
      const innerAnchor = norm(getComputedStyle(inner || cell).textAlign);
      const hr = textRect(head);
      const tr = inner ? inner.getBoundingClientRect() : textRect(cell);
      const offset = anchor === "left" ? hr.left - tr.left
        : anchor === "right" ? hr.right - tr.right
        : (hr.left + hr.right) / 2 - (tr.left + tr.right) / 2;
      const flags = [];
      if (innerAnchor !== anchor) flags.push(`内部控件自身对齐=${innerAnchor}`);
      if (Math.abs(offset) > 2) flags.push(`锚点偏差=${Math.round(offset)}px`);
      if (flags.length) problems.push(`table${tableIndex} col${i} "${head.textContent.trim().slice(0, 14)}" 表头=${anchor} ${flags.join(" ")}`);
    });
  });
  if (problems.length) throw new Error("表格对齐异常：\n" + problems.join("\n"));
  return true;
})()
JS

# 探针为空时立即失败：否则 eval "" 恒真，门禁会静默失效
[[ -n "$table_align_probe" ]] || { echo "alignment probe failed to load" >&2; exit 2; }

# 表头与数值同锚点。
#
# 只对"数值列"表断言，默认覆盖本次修过的三张（步骤 1 的 db 表、步骤 9 的热力表）；
# 不做全站通用断言：无 .data-table 的小表里 th 默认居中、标签列左对齐是既有观感
# （review 实测步骤 2/3/4 的分解表、11–15 的回归表、教师端操作列都是这种列），
# 当成失败会让门禁常年变红，反而失去信号。
assert_table_alignment() {
  local selector="${1:-table.db-table, table.heat-table-grid}"
  "${ab[@]}" eval "${table_align_probe/__SELECTOR__/$selector}" >/dev/null
}

# 目标表必须在页面上：交互（点页签/开全屏）失败时探针会退化成"在别的表上空转通过"，
# 所以覆盖范围必须显式断言，不能只依赖探针本身。
require_table() {
  "${ab[@]}" wait --fn "Boolean(document.querySelector(${1@Q}))" || {
    echo "required table missing: $1" >&2
    exit 1
  }
}

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
    # 步骤 9 的国家网络图是视角栏里的“贸易联系”探索视角。
    "${ab[@]}" eval 'Array.from(document.querySelectorAll("main [aria-label=\"图表视角\"] button")).find(b=>b.textContent.trim()==="贸易联系")?.click()' >/dev/null
    "${ab[@]}" wait --load networkidle
    # The network uses one portalled dialog instance: node activation expands it,
    # Escape closes it, and focus/selection return to the invoking SVG node.
    "${ab[@]}" wait '.network-node[aria-label^="USA "]'
    "${ab[@]}" wait --load networkidle
    "${ab[@]}" focus '.network-node[aria-label^="USA "]'
    "${ab[@]}" press Enter
    "${ab[@]}" wait '.network-fullscreen-scrim [role="dialog"]'
    "${ab[@]}" eval '(() => { if(document.querySelectorAll(".network-card").length!==1) throw new Error("network dialog duplicated the graph"); if(document.activeElement?.textContent?.trim()!=="退出大图") throw new Error("network dialog did not receive focus"); return true; })()'
    # Escape closes the network's own fullscreen layer and returns to the view.
    "${ab[@]}" press Escape
    "${ab[@]}" wait --fn '!document.querySelector(".network-fullscreen-scrim")'
    "${ab[@]}" eval '(() => { const n=document.activeElement; if(!n?.classList.contains("network-node") || n.getAttribute("aria-pressed")!=="true") throw new Error("network dialog did not restore its node focus and selection"); return true; })()'
    "${ab[@]}" press Escape
    "${ab[@]}" wait --fn '!document.querySelector("[role=dialog]")'
  fi
done

# ---------------------------------------------------------------- 表格对齐门禁
# 覆盖本次修过的三处：步骤 1 三个页签的数值列、步骤 5 最短路径明细的行标签、
# 步骤 9 行业热力表（视角栏中的“全部指标表”视图）。
"${ab[@]}" open "$GVCSIM_BASE_URL/?step=1"
"${ab[@]}" wait --load networkidle
for table_tab in "账户项" "中间投入 Z" "最终需求 Y"; do
  "${ab[@]}" eval "(() => { Array.from(document.querySelectorAll('main button')).find(b=>b.textContent.trim()==='${table_tab}')?.click(); return true; })()" >/dev/null
  "${ab[@]}" wait --load networkidle
  require_table 'table.db-table'
  assert_table_alignment
done

"${ab[@]}" open "$GVCSIM_BASE_URL/?step=5"
"${ab[@]}" wait --load networkidle
# 小网络演示默认折叠，先展开
"${ab[@]}" eval '(() => { const d=document.querySelector("details.method-demo"); if (d) d.open = true; return true; })()' >/dev/null
"${ab[@]}" eval 'Array.from(document.querySelectorAll("main button")).find(b=>/显示接近中心性/.test(b.getAttribute("aria-label")||""))?.click()' >/dev/null
sleep 1
"${ab[@]}" eval 'document.querySelector(".net-demo-node")?.dispatchEvent(new MouseEvent("click",{bubbles:true}))' >/dev/null
sleep 1
# 最短路径明细表只在接近中心性 + 选中节点后出现，必须确认它真的渲染了
"${ab[@]}" wait --fn 'Array.from(document.querySelectorAll("main table")).some(t=>/最短路径明细/.test(t.textContent))'
assert_table_alignment

"${ab[@]}" open "$GVCSIM_BASE_URL/?step=9"
"${ab[@]}" wait --load networkidle
# 行业热力表是视角栏里的“全部指标表”视图，与主图同页切换，没有弹窗
"${ab[@]}" eval 'Array.from(document.querySelectorAll("main [role=\"group\"][aria-label=\"图表视角\"] button")).find(b=>b.textContent.trim()==="全部指标表")?.click()' >/dev/null
"${ab[@]}" wait --load networkidle
require_table 'table.heat-table-grid'
assert_table_alignment
# 收尾：回到记录材料的“历年变化”视图
"${ab[@]}" eval 'Array.from(document.querySelectorAll("main [role=\"group\"][aria-label=\"图表视角\"] button")).find(b=>b.textContent.trim()==="历年变化")?.click()' >/dev/null
"${ab[@]}" wait 'select[name="network-metric"]'

# 最终截图、HAR 与 WCAG 审计属于步骤 15；上面的几何门禁最后停在步骤 9，
# 必须显式返回报告页，不能让文件名和实际覆盖页面不一致。
"${ab[@]}" open "$GVCSIM_BASE_URL/?step=15"
"${ab[@]}" wait --load networkidle

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
