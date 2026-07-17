#!/usr/bin/env bash
# 用真实的 Gephi Toolkit 0.10.1 重新生成网络指标 golden fixture 并校验。
#
#   scripts/gephi_golden/generate.sh            # 写回 fixture 并与 git 版本对比
#   scripts/gephi_golden/generate.sh --check     # 只校验：生成到临时文件再 diff，不改工作区
#
# 需要 JDK 11+、Maven、可访问 Maven Central（首次会下载 toolkit 及依赖）。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(cd "$here/../.." && pwd)/tests/fixtures/gephi_0_10_1_directed_reference.csv"

mode="${1:-write}"
if [[ "$mode" == "--check" ]]; then
  out="$(mktemp)"
  trap 'rm -f "$out"' EXIT
else
  out="$fixture"
fi

echo "[gephi-golden] 运行 Gephi Toolkit 生成器 -> $out"
mvn -q -f "$here/pom.xml" compile exec:java -Dexec.args="$out"

if [[ "$mode" == "--check" ]]; then
  if diff -u "$fixture" "$out"; then
    echo "[gephi-golden] OK：git 中的 fixture 与真实 Gephi 输出逐字节一致。"
  else
    echo "[gephi-golden] 不一致：上方为差异（git 版本 vs 新生成）。" >&2
    exit 1
  fi
else
  echo "[gephi-golden] 已写入 $fixture"
  git -C "$here" --no-pager diff --stat -- "$fixture" || true
fi
