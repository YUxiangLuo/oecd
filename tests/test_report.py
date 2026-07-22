import json
import re
from pathlib import Path

import pandas as pd
import pytest

from gvcsim import report
from gvcsim.config import PROCESSED_DIR
from gvcsim.regression.panel import CoefStat, RegressionResult


def _stub_report_dependencies(monkeypatch):
    country = pd.DataFrame(
        [
            {
                "country": code,
                "year": 2020,
                "FVA_share": 0.1 + rank / 100,
                "GVCPs": 1.0 + rank / 10,
                "betweenesscentrality": 10.0 + rank,
            }
            for rank, code in enumerate(["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"])
        ]
    )
    regression_panel = pd.DataFrame(
        [
            {
                "country": code,
                "industry": f"D{rank:02d}",
                "year": 2020,
                "betweenesscentrality": 100.0 + rank,
            }
            for rank, code in enumerate(["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"])
        ]
    )

    def load(name: str):
        return country if name == "panel_country.csv" else regression_panel

    calls = []

    def estimate(panel, design):
        assert panel is (country if design.granularity == "country" else regression_panel)
        calls.append(design.outcome)
        result = RegressionResult(
            depvar=design.depvar,
            coefs=[
                CoefStat("k=-2", -0.1, 0.02, -5.0, 0.01, -0.15, -0.05),
                CoefStat("k=0", 0.2, 0.03, 6.0, 0.01, 0.13, 0.27),
                CoefStat("k=-2×base_gvc", -0.05, 0.01, -5.0, 0.01, -0.08, -0.02),
                CoefStat("k=0×base_gvc", 0.1, 0.02, 5.0, 0.01, 0.05, 0.15),
            ],
            n_obs=100,
            n_entities=20,
            n_times=5,
            n_clusters=10,
            r2_within=0.5,
            depvar_mean=0.2,
            depvar_std=0.1,
            diagnostics={
                "pretrend": {
                    "available": True,
                    "reason": None,
                    "terms": ["k=-2"],
                    "statistic": 6.25,
                    "df_num": 1,
                    "df_denom": 9,
                    "p": 0.034,
                    "interpretation": "检测到明显的冲击前差异，因果解释需谨慎。",
                }
            },
        )
        benchmark = {
            "coef_check_passed": True,
            "max_abs_coef_diff": 0.0,
            "max_abs_se_diff": 0.0,
        }
        return result, benchmark

    monkeypatch.setattr(report, "_load_panel_file", load)
    monkeypatch.setattr(report, "processed_years", lambda: [2020])
    monkeypatch.setattr(report, "run_design_with_benchmark", estimate)
    return calls


def test_build_is_pure_and_runs_one_joint_estimate_per_outcome(tmp_path: Path, monkeypatch):
    calls = _stub_report_dependencies(monkeypatch)
    monkeypatch.setattr(report, "REPORTS_DIR", tmp_path)

    document = report.build(2020, method="event_study", interaction=True)

    assert calls == ["trade", "production", "length", "network"]
    assert document.suggested_filename == "experiment_report_2020.md"
    assert list(tmp_path.iterdir()) == []
    assert "<svg" not in document.markdown

    blocks = re.findall(r"```gvcsim-chart\n(.*?)\n```", document.markdown, flags=re.DOTALL)
    payloads = [json.loads(block) for block in blocks]
    assert len(payloads) == 11  # 3 个 Top5 + 4 个主效应 + 4 个异质性图
    assert all(payload["version"] == 1 for payload in payloads)
    assert [payload["type"] for payload in payloads[:3]] == ["bar", "bar", "bar"]
    assert payloads[2]["x_label"] == "国家×行业节点"
    event_payloads = [payload for payload in payloads if payload["type"] == "event-study"]
    assert all(
        set(payload) == {"version", "type", "title", "x_label", "y_label", "points"} for payload in event_payloads
    )
    assert sum("主政策效应" in payload["title"] for payload in event_payloads) == 4
    assert sum("异质性" in payload["title"] for payload in event_payloads) == 4
    assert all(
        set(point) == {"label", "value", "ci_low", "ci_high"}
        for payload in event_payloads
        for point in payload["points"]
    )
    assert event_payloads[0]["points"][0] == {
        "label": "k=-2",
        "value": -0.1,
        "ci_low": -0.15,
        "ci_high": -0.05,
    }
    assert document.markdown.count("95% 置信区间") == 4
    assert "[-0.1500, -0.0500]" in document.markdown
    assert document.markdown.count("冲击前趋势联合检验") == 4
    assert "因果解释需谨慎" in document.markdown
    assert "即具备研究意义" not in document.markdown


def test_generate_keeps_cli_file_output(tmp_path: Path, monkeypatch):
    _stub_report_dependencies(monkeypatch)
    monkeypatch.setattr(report, "REPORTS_DIR", tmp_path)

    output = Path(report.generate(2020))

    assert output == tmp_path / "experiment_report_2020.md"
    assert output.read_text(encoding="utf-8").startswith("# 贸易政策冲击")


def test_country_report_skips_degenerate_network_regression(monkeypatch):
    calls = _stub_report_dependencies(monkeypatch)

    document = report.build(2020, granularity="country")

    assert calls == ["trade", "production", "length"]
    assert "网络回归因国家图退化而不运行" in document.markdown
    assert "Gephi 介数中心性恒为 0" in document.markdown
    assert "网络回归仅支持国家–行业级面板" in document.markdown
    assert "国家×行业介数中心性 Top 5" in document.markdown


@pytest.mark.skipif(
    not (PROCESSED_DIR / "panel_industry.csv").exists(),
    reason="需要 gvcsim compute 产出的面板",
)
def test_event_chart_omits_ci_when_inference_is_suppressed():
    """批处理报告不能因为“推断被抑制”而崩。

    p/ci 变成 Optional 后,_coef_table 更新了、_event_chart 漏了:
    float(None) 会让合法的 sanctions + event_study 批处理报告直接失败。
    """
    doc = report.build(shock_type="sanctions", method="event_study")
    # 制裁 + 吸收型事件研究 → invalid_design → 区间被抑制 → 图里不能出现 ci 字段
    assert '"ci_low"' not in doc.markdown
    # 关税仍有合法推断,区间照常写进图表
    assert '"ci_low"' in report.build(shock_type="tariff", method="event_study").markdown
