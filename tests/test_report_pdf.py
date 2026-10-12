"""The PDF gate must inspect the summary itself, not matching later detail text."""

import pytest

from scripts.verify_report_pdf import SUMMARY_COLUMNS, SUMMARY_TITLE, validate_report_text


def test_complete_summary_with_wrapped_headers():
    text = "四项回归结果汇总\n步骤 指标 X 每高 1 个百分点，Y 两年\n累计平均相差 95%\n区间 方向"
    validate_report_text(text + "\n11\n12\n13\n14\n步骤 11 · 贸易流详情")


def test_missing_interval_header_cannot_borrow_from_details():
    text = "四项回归结果汇总\n步骤 指标 X 每高 1 个百分点，Y 两年累计平均相差 方向\n步骤 11 · 贸易流详情\n95% 区间"
    with pytest.raises(ValueError, match="截断列: 95%区间"):
        validate_report_text(text)


@pytest.mark.parametrize("kicker", ["G V C S I M U L A T I O N L A B · 实验回", "GVC SIMULATION LAB · 实验回顾"])
def test_overlay_is_rejected_even_when_underlying_summary_is_complete(kicker):
    text = SUMMARY_TITLE + "\n" + " ".join(SUMMARY_COLUMNS) + "\n步骤 11 · 贸易流详情\n" + kicker
    with pytest.raises(ValueError, match="提交回执遮罩"):
        validate_report_text(text)


def test_clipped_summary_cannot_borrow_columns_from_later_sections():
    text = SUMMARY_TITLE + "\n步骤 指标 X 每增加\n步骤 11 · 贸易流详情\n"
    text += " ".join(SUMMARY_COLUMNS)
    with pytest.raises(ValueError, match="截断列"):
        validate_report_text(text)


@pytest.mark.parametrize("text", ["", SUMMARY_TITLE + " ".join(SUMMARY_COLUMNS)])
def test_missing_sections_are_not_a_pass(text):
    with pytest.raises(ValueError, match="缺少"):
        validate_report_text(text)


def test_a_generated_report_passes_the_gate(tmp_path, monkeypatch):
    """The gate reads the report's own summary header: renaming a column fails here, not first in browser CI."""
    from test_teaching_report import _artifacts, _complete

    from gvcsim import config, report_build, report_saved_run
    from gvcsim.teaching_report import build

    _artifacts(tmp_path)
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    # This is a rendering gate, not an estimator test: use authoritative
    # server-result fixtures for the miniature release with zero taxable X.
    monkeypatch.setattr(
        report_build, "server_runs", lambda session, _panel, _release: report_saved_run._saved_runs(session)
    )
    validate_report_text(build(_complete(), "同学").markdown)
