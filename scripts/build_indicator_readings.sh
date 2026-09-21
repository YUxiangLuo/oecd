#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$root/docs/indicator-readings"
output_dir="$root/frontend/public/readings"
browser=${CHROMIUM_BIN:-chromium}

command -v "$browser" >/dev/null || { echo "缺少 Chromium：$browser" >&2; exit 2; }
command -v pdftotext >/dev/null || { echo "缺少 pdftotext（poppler）" >&2; exit 2; }
command -v pdfinfo >/dev/null || { echo "缺少 pdfinfo（poppler）" >&2; exit 2; }
command -v qpdf >/dev/null || { echo "缺少 qpdf" >&2; exit 2; }
command -v jq >/dev/null || { echo "缺少 jq" >&2; exit 2; }
mkdir -p "$output_dir"

normalize_pdf() {
  local input=$1 metadata normalized
  metadata=$(mktemp)
  normalized=$(mktemp "$output_dir/.normalized.XXXXXX.pdf")
  if ! qpdf --json "$input" - | jq '
    (.qpdf[1].trailer.value["/Info"] | "obj:\(.)") as $info
    | .qpdf[1][$info].value["/CreationDate"] = "u:D:20000101000000Z"
    | .qpdf[1][$info].value["/ModDate"] = "u:D:20000101000000Z"
  ' > "$metadata"; then
    rm -f "$metadata" "$normalized"
    return 1
  fi
  if ! qpdf "$input" --update-from-json="$metadata" --deterministic-id "$normalized"; then
    rm -f "$metadata" "$normalized"
    return 1
  fi
  mv "$normalized" "$input"
  rm -f "$metadata"
}

sources=(trade production length network)
outputs=(
  trade-decomposition-guide.pdf
  production-decomposition-guide.pdf
  production-length-guide.pdf
  production-network-guide.pdf
)
required=(
  "FVA + FDC"
  "3b_FGY_GVC_C"
  "GVCPs = PLv_GVC"
  "Brandes"
)

for index in "${!sources[@]}"; do
  source="$source_dir/${sources[$index]}.html"
  output="$output_dir/${outputs[$index]}"
  "$browser" \
    --headless \
    --disable-gpu \
    --no-pdf-header-footer \
    --print-to-pdf="$output" \
    "file://$source" >/dev/null 2>&1
  normalize_pdf "$output"

  text=$(pdftotext "$output" -)
  pages=$(pdfinfo "$output" | awk -F: '/^Pages:/{gsub(/ /,"",$2); print $2}')
  [[ "$pages" == "2" ]] || { echo "$output 应为 2 页，实际为 $pages 页" >&2; exit 1; }
  grep -Fq "${required[$index]}" <<<"$text" || {
    echo "$output 缺少关键文字：${required[$index]}" >&2
    exit 1
  }
  if grep -Eq '#[[:space:]]*\(?[1-9]\)?' <<<"$text"; then
    echo "$output 含有未清理的 Word 公式编号" >&2
    exit 1
  fi
  echo "generated ${outputs[$index]} ($pages pages)"
done

source_notes=(
  source-trade-decomposition-note.pdf
  source-production-decomposition-note.pdf
  source-production-length-note.pdf
  source-production-network-note.pdf
)
for note in "${source_notes[@]}"; do
  path="$output_dir/$note"
  [[ -f "$path" ]] || { echo "缺少原始说明转换件：$note" >&2; exit 1; }
  text=$(pdftotext "$path" -)
  if grep -Eq '公式章|#[[:space:]]*\(?[1-9]\)?|\)#[[:space:]]*$' <<<"$text"; then
    echo "$note 含有未清理的 Word/MathType 公式编号" >&2
    exit 1
  fi
  echo "checked $note"
done
