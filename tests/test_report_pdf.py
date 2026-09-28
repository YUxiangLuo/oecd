"""The PDF gate must inspect the summary itself, not matching later detail text."""

import pytest

from scripts.verify_report_pdf import SUMMARY_COLUMNS, SUMMARY_TITLE, validate_report_text


def test_complete_summary_with_wrapped_headers():
    text = "四项回归结果汇总\n步骤 指标 冲击 比较方式 估计对象与相对\n变化 标称 95% 近似\n区间 证据判断"
    validate_report_text(text + "\n11\n12\n13\n14\n步骤 11 · 贸易流详情")


def test_missing_interval_header_cannot_borrow_from_details():
    text = (
        "四项回归结果汇总\n"
        "步骤 指标 冲击 比较方式 估计对象与相对变化 证据判断\n"
        "步骤 11 · 贸易流详情\n标称 95% 近似区间"
    )
    with pytest.raises(ValueError, match="截断列: 标称95%近似区间"):
        validate_report_text(text)


@pytest.mark.parametrize("kicker", ["G V C S I M U L A T I O N L A B · 实验回", "GVC SIMULATION LAB · 实验回顾"])
def test_overlay_is_rejected_even_when_underlying_summary_is_complete(kicker):
    text = SUMMARY_TITLE + "\n" + " ".join(SUMMARY_COLUMNS) + "\n步骤 11 · 贸易流详情\n" + kicker
    with pytest.raises(ValueError, match="提交回执遮罩"):
        validate_report_text(text)


def test_clipped_summary_cannot_borrow_columns_from_later_sections():
    text = SUMMARY_TITLE + "\n步骤 指标 冲击 分批处理 coho\n步骤 11 · 贸易流详情\n"
    text += " ".join(SUMMARY_COLUMNS)
    with pytest.raises(ValueError, match="截断列"):
        validate_report_text(text)


@pytest.mark.parametrize("text", ["", SUMMARY_TITLE + " ".join(SUMMARY_COLUMNS)])
def test_missing_sections_are_not_a_pass(text):
    with pytest.raises(ValueError, match="缺少"):
        validate_report_text(text)
