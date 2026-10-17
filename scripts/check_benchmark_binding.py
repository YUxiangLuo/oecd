#!/usr/bin/env python3
"""Check that the committed benchmark evidence still describes the current processed release.

The benchmark JSONs record both the release they were computed on and the release they were validated against
(``gvcsim/regression/benchmark_binding.py``). Run this after a data release or before using the benchmarks as
current evidence:

    uv run python scripts/check_benchmark_binding.py
    uv run python scripts/check_benchmark_binding.py --warn   # report but exit 0

Exit 1 when a benchmark names neither the current release nor a documented equivalent rebuild.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from gvcsim.regression import benchmark_binding

BENCHMARKS = (
    (Path("benchmarks/model_space_v13.json"), "model_space", "panel_teaching.csv", None),
    (
        Path("benchmarks/teaching_design_v13.json"),
        "teaching_design",
        "panel_industry.csv",
        "export_exposure_2016.csv",
    ),
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="processed release root (default: GVCSIM_DATA_DIR/processed or data/processed)",
    )
    parser.add_argument("--warn", action="store_true", help="report mismatches but exit 0")
    args = parser.parse_args(argv)

    failures = 0
    for path, kind, panel, exposure in BENCHMARKS:
        if not path.is_file():
            print(f"FAIL {path}: 文件不存在")
            failures += 1
            continue
        try:
            benchmark = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            print(f"FAIL {path}: 无法读取 JSON（{error}）")
            failures += 1
            continue
        metadata_problem = benchmark_binding.metadata_problem(
            benchmark, kind=kind, expected_panel=panel, expected_exposure=exposure
        )
        current = benchmark_binding.current_binding(args.root, panel_name=panel, exposure_name=exposure)
        binding_problem = metadata_problem or benchmark_binding.binding_problem(
            benchmark, current, expected_panel=panel, expected_exposure=exposure
        )
        binding = benchmark.get("binding") if isinstance(benchmark.get("binding"), dict) else {}
        computed = binding.get("computed") if isinstance(binding.get("computed"), dict) else {}
        validated = binding.get("validated") if isinstance(binding.get("validated"), dict) else {}
        now = f"{current['release']} / {current['panel']} {current['panel_sha256'][:12]}…" if current else "不可读"
        recorded = (
            f"computed {computed.get('release')} / {computed.get('panel')} {str(computed.get('panel_sha256'))[:12]}…；"
            f"validated {validated.get('release')} / {validated.get('panel')} {str(validated.get('panel_sha256'))[:12]}…"
        )
        if binding_problem:
            failures += 1
            print(f"FAIL {path}: {binding_problem}")
            print(f"     当前：{now}")
            print(f"     记录：{recorded}")
        else:
            print(f"OK   {path}: {binding.get('status')}；当前 {now}；{recorded}")

    if failures and not args.warn:
        print(f"\n{failures} 个 benchmark 与当前 release 不匹配。请重跑生成脚本，或记录新的等价重建。", file=sys.stderr)
        return 1
    if failures:
        print(f"\n{failures} 个 benchmark 与当前 release 不匹配（--warn：不阻断）。", file=sys.stderr)
    else:
        print("\n全部 benchmark 均与当前 release 或其记录的等价重建一致。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
