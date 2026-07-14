import json
import re
from pathlib import Path

import pandas as pd

from gvcsim import report
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
    regression_panel = pd.DataFrame({"placeholder": [1]})

    def load(name: str):
        return country if name == "panel_country.csv" else regression_panel

    calls = []

    def estimate(panel, design):
        assert panel is regression_panel
        calls.append(design.step)
        result = RegressionResult(
            depvar=design.depvar,
            coefs=[
                CoefStat("k=-2", -0.1, 0.02, -5.0, 0.01),
                CoefStat("k=0", 0.2, 0.03, 6.0, 0.01),
                CoefStat("k=-2×base_gvc", -0.05, 0.01, -5.0, 0.01),
                CoefStat("k=0×base_gvc", 0.1, 0.02, 5.0, 0.01),
            ],
            n_obs=100,
            n_entities=20,
            n_times=5,
            n_clusters=10,
            r2_within=0.5,
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


def test_build_is_pure_and_runs_one_joint_estimate_per_step(tmp_path: Path, monkeypatch):
    calls = _stub_report_dependencies(monkeypatch)
    monkeypatch.setattr(report, "REPORTS_DIR", tmp_path)

    document = report.build(2020, method="事件研究", interaction=True)

    assert calls == [13, 14, 15, 16]
    assert document.suggested_filename == "experiment_report_2020.md"
    assert list(tmp_path.iterdir()) == []
    assert "<svg" not in document.markdown

    blocks = re.findall(r"```gvcsim-chart\n(.*?)\n```", document.markdown, flags=re.DOTALL)
    payloads = [json.loads(block) for block in blocks]
    assert len(payloads) == 11  # 3 个 Top5 + 4 个主效应 + 4 个异质性图
    assert all(payload["version"] == 1 for payload in payloads)
    assert [payload["type"] for payload in payloads[:3]] == ["bar", "bar", "bar"]
    event_payloads = [payload for payload in payloads if payload["type"] == "event-study"]
    assert all(
        set(payload) == {"version", "type", "title", "x_label", "y_label", "points"} for payload in event_payloads
    )
    assert sum("主政策效应" in payload["title"] for payload in event_payloads) == 4
    assert sum("异质性" in payload["title"] for payload in event_payloads) == 4


def test_generate_keeps_cli_file_output(tmp_path: Path, monkeypatch):
    _stub_report_dependencies(monkeypatch)
    monkeypatch.setattr(report, "REPORTS_DIR", tmp_path)

    output = Path(report.generate(2020))

    assert output == tmp_path / "experiment_report_2020.md"
    assert output.read_text(encoding="utf-8").startswith("# 贸易政策冲击")
