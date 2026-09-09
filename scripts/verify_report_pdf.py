"""Check that the printed report keeps every column of its four-outcome summary.

Uses Poppler's independent PDF text extraction, not the HTML/CSS under test.
Run after agent-browser pdf. This guards clipping; it is not a full visual audit.
"""

import argparse
import re
import subprocess
from pathlib import Path

SUMMARY_TITLE = "四类指标并读（预先指定结果族）"
SUMMARY_COLUMNS = ("步骤", "指标", "冲击", "比较方式", "估计对象与相对变化", "95%区间", "证据判断")


def validate_report_text(text: str) -> None:
    # Raw PDF extraction preserves cell order but wraps text within narrow cells.
    normalized = re.sub(r"\s+", "", text)
    if SUMMARY_TITLE not in normalized:
        raise ValueError("PDF 缺少四类指标并读表")
    summary = normalized.split(SUMMARY_TITLE, 1)[1]
    if "步骤11·" not in summary:
        raise ValueError("PDF 缺少对照表后的步骤11详情")
    summary = summary.split("步骤11·", 1)[0]
    missing = [column for column in SUMMARY_COLUMNS if column not in summary]
    if missing:
        raise ValueError("PDF 对照表缺失或截断列: " + "、".join(missing))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    args = parser.parse_args()
    try:
        result = subprocess.run(
            ["pdftotext", "-raw", str(args.pdf), "-"], check=True, capture_output=True, text=True, timeout=30
        )
        validate_report_text(result.stdout)
    except FileNotFoundError as error:
        raise SystemExit("PDF 验收需要安装 Poppler 的 pdftotext（Debian/Ubuntu: poppler-utils）") from error
    except (ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from error
    print("PDF 四类指标对照表全部七列均保留")


if __name__ == "__main__":
    main()
