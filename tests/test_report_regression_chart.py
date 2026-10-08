"""The report's regression bar charts (steps 11–14 and the summary) agree with the step tables and the pages."""

import json
import re

import pytest

from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.panel import run_design_with_benchmark
from gvcsim.regression.teaching import BASELINES, X_COLUMN, build_teaching_panel, model_snapshot, variable_catalog
from gvcsim.regression_routes import _design_info, _estimate_overview
from gvcsim.report_common import _natural_effect, standardized_digits, _signed
from gvcsim.report_regression_chart import family_chart, summary_chart
from gvcsim.report_render import _evidence_summary
from gvcsim.report_saved_run import _saved_runs
from gvcsim.session import empty_session

# The synthetic source panel of the regression tests (30 countries, every alternative baseline present).
from test_teaching_regression import _exposure, _full_source

STEPS = {11: "trade", 12: "production", 13: "length", 14: "network"}
CHART = re.compile("```gvcsim-chart\n(.*?)\n```", re.S)


@pytest.fixture(scope="module")
def panel():
    source = _full_source(tuple(f"C{i:02}" for i in range(30)))
    return build_teaching_panel(source, _exposure(source))


@pytest.fixture(scope="module")
def overview(panel):
    return _estimate_overview(panel)


def _saved(panel, outcome: str, baseline: str | None = None) -> dict:
    """A run as the run endpoint returns it and the page saves it."""
    design = RegressionDesign(outcome, teaching=True, baseline=baseline)
    result, _ = run_design_with_benchmark(panel, design)
    return {
        "design": _design_info(design),
        "result": result.to_dict(),
        "model_snapshot": model_snapshot(outcome, design.baseline),
        "variable_catalog": variable_catalog(outcome, design.baseline),
    }


def _runs(panel, choices: dict[int, str | None]) -> list[dict]:
    session = empty_session()
    session["steps"] = {
        str(step): {"data": {"run": json.loads(json.dumps(_saved(panel, STEPS[step], choices.get(step))))}}
        for step in STEPS
    }
    runs = _saved_runs(session)
    assert [run["step"] for run in runs] == [11, 12, 13, 14]
    return runs


def _step_sections(markdown: str) -> dict[int, str]:
    parts = re.split(r"^### 步骤 (\d+) · ", markdown, flags=re.M)
    return {int(parts[i]): parts[i + 1] for i in range(1, len(parts), 2)}


# Saved Ys other than the defaults, so "the saved bar" is not just the first one.
CHOICES = {11: None, 12: "3b_FGY_GVC_C_share", 13: "GVCPs", 14: "betweenesscentrality"}


def test_saved_bar_equals_the_step_table_and_the_course_estimate(panel, overview):
    runs = _runs(panel, CHOICES)
    markdown = "\n".join(_evidence_summary(runs, None, None, overview))
    sections = _step_sections(markdown)
    for run in runs:
        step, outcome, design, result = run["step"], run["outcome"], run["design"], run["result"]
        coefficient = result["coefs"][0]
        assert coefficient["name"] == X_COLUMN
        # The same data and computation: the course's bar for this Y is the saved run's estimate.
        row = next(item for item in overview["outcomes"][outcome] if item["key"] == design["baseline"])
        for key in ("coef", "ci_low", "ci_high"):
            assert row[key] == pytest.approx(coefficient[key], rel=1e-12, abs=1e-15)
        assert row["depvar_std"] == pytest.approx(result["depvar_std"], rel=1e-12)

        section = sections[step]
        (chart,) = [json.loads(block) for block in CHART.findall(section)]
        assert chart["type"] == "diverging-bar"
        # One bar per Y of the family, in the family's order; exactly the saved one is marked.
        assert len(chart["items"]) == len(BASELINES[outcome])
        saved = [item for item in chart["items"] if item.get("saved")]
        assert len(saved) == 1
        (bar,) = saved
        assert chart["items"].index(bar) == [b.key for b in BASELINES[outcome]].index(design["baseline"])
        # Its numbers are the table's numbers: the native value printed in the table's precision.
        _label, effect, _interval = _natural_effect(outcome, design, result, coefficient)
        table = section.split("| 项目 | 结果 |", 1)[1]
        assert f"**{effect}**" in table
        native = bar["text"].split("（", 1)[0]
        assert effect.startswith(native + " ")
        if outcome in ("trade", "production"):
            # Shares: per 1 percentage point of X in percentage points, the table's interval too.
            assert chart["x_label"].endswith("（个百分点）")
            assert bar["value"] == pytest.approx(coefficient["coef"], rel=1e-3)
            assert (
                f"[{_signed(coefficient['ci_low'], 2)}, " in table or f"[{_signed(coefficient['ci_low'], 3)}, " in table
            )
        else:
            # Mixed units: standard deviations, SD = (β × 0.01) / depvar_std, with the native value first.
            assert chart["x_label"].endswith("（个标准差）")
            std = result["depvar_std"]
            point = coefficient["coef"] * 0.01 / std
            bounds = (coefficient["ci_low"] * 0.01 / std, coefficient["ci_high"] * 0.01 / std)
            assert bar["value"] == pytest.approx(point, rel=1e-3)
            assert bar["ci_low"] == pytest.approx(bounds[0], rel=1e-3)
            assert bar["ci_high"] == pytest.approx(bounds[1], rel=1e-3)
            sd = _signed(point, standardized_digits(point, bounds))[1:]
            assert bar["text"] == f"{native}（{sd} 个标准差）"
            assert (
                bar["sub"]
                == {"length": "长度单位", "position": "位置指数单位", "network": "中心性原始单位"}[
                    design["depvar_kind"]
                ]
            )
            if outcome == "network":
                # The table states the same SD size ("幅度约 0.047 个标准差").
                assert f"幅度约 {sd} 个标准差" in effect
        # The other bars are the course's estimates of the other Ys.
        for item, course in zip(chart["items"], overview["outcomes"][outcome]):
            if item.get("saved"):
                continue
            scale = 1.0 if course["kind"] == "share" else 0.01 / course["depvar_std"]
            assert item["value"] == pytest.approx(course["coef"] * scale, rel=1e-3)
        assert "其余 Y 是课程用同一份数据、同一个模型算出的结果" in section
        if outcome == "production":
            # As on the page: the four forward shares add up to 100%, so their four estimates add up to about 0.
            total = sum(
                item["coef"]
                for item in overview["outcomes"]["production"]
                if item["key"] in ("1_VA_D_share", "2_VA_RT_share", "3a_VA_GVC_S_share", "3b_VA_GVC_C_share")
            )
            shown = "0.00" if abs(total) < 0.005 else _signed(total, 2)
            assert (
                f"- 纯国内、传统贸易、简单 GVC、复杂 GVC 四项份额合计 100%，所以这四条相加约为 0（{shown}）。"
                in section
            )
        else:
            assert "四项份额合计 100%" not in section
        # The binned scatter and the single-dot coefficient plot are gone.
        assert '"type":"binscatter"' not in section and '"type":"coefficient"' not in section


def test_summary_chart_has_one_standardized_bar_per_saved_run(panel, overview):
    runs = _runs(panel, CHOICES)
    markdown = "\n".join(_evidence_summary(runs, None, None, overview))
    summary = markdown.split("### 四项回归结果汇总", 1)[1].split("### 步骤 11", 1)[0]
    (chart,) = [json.loads(block) for block in CHART.findall(summary)]
    assert chart["type"] == "diverging-bar" and chart["x_label"].endswith("（个标准差）")
    assert [item["sub"] for item in chart["items"]] == [
        "步骤 11 · 贸易流",
        "步骤 12 · 生产",
        "步骤 13 · 长度",
        "步骤 14 · 网络",
    ]
    assert not any(item.get("saved") for item in chart["items"])
    units = {"trade": "个百分点", "production": "个百分点", "length": "个位置指数单位", "network": "个中心性原始单位"}
    for item, run in zip(chart["items"], runs):
        coefficient, std = run["result"]["coefs"][0], run["result"]["depvar_std"]
        point = coefficient["coef"] * 0.01 / std
        bounds = (coefficient["ci_low"] * 0.01 / std, coefficient["ci_high"] * 0.01 / std)
        assert item["value"] == pytest.approx(point, rel=1e-3)
        assert (item["ci_low"], item["ci_high"]) == pytest.approx(bounds, rel=1e-3)
        sd = _signed(point, standardized_digits(point, bounds))[1:]
        _label, effect, _interval = _natural_effect(run["outcome"], run["design"], run["result"], coefficient)
        native = effect.split("（", 1)[0]
        assert item["text"] == f"{native}（{sd} 个标准差）"
        assert native.endswith(units[run["outcome"]])
    assert chart["title"] == "四步保存的结果（都换算成标准差）"
    # The table (whose columns the PDF check reads) stays ahead of the chart.
    assert summary.index("| 步骤 | 指标 |") < summary.index("```gvcsim-chart")


def test_uncertain_and_suppressed_bars_and_a_missing_overview():
    design = _design_info(RegressionDesign("production", teaching=True, baseline="3b_FGY_GVC_C_share"))
    coefficient = {"name": X_COLUMN, "coef": 0.007501, "ci_low": -0.0112, "ci_high": 0.0262}
    result = {"status": "ok", "support": {"status": "ok"}, "depvar_std": 0.058, "coefs": [coefficient]}
    rows = [
        {
            "key": item.key,
            "label": item.label,
            "kind": item.kind,
            "coef": -0.3,
            "ci_low": -0.4,
            "ci_high": -0.2,
            "status": "ok",
            "suppress_inference": False,
            "depvar_std": 0.05,
        }
        for item in BASELINES["production"]
    ]
    rows[1].update(suppress_inference=True, status="insufficient")
    rows[2].update(coef=None)
    chart = json.loads(
        family_chart(12, "production", design, result, coefficient, {"outcomes": {"production": rows}})[1]
    )
    items = {item["label"]: item for item in chart["items"]}
    # The weak Y keeps its interval across 0 (drawn grey on the page and in the report) and the table's digits.
    assert items["后向复杂 GVC 生产份额"] == {
        "label": "后向复杂 GVC 生产份额",
        "value": 0.007501,
        "text": "+0.008",
        "ci_low": -0.0112,
        "ci_high": 0.0262,
        "saved": True,
    }
    # A suppressed interval is left out (no whisker); a Y without an estimate is a 0 bar saying so, as on the page.
    assert "ci_low" not in items[BASELINES["production"][1].label]
    missing = BASELINES["production"][2].label
    assert items[missing] == {"label": missing, "value": 0.0, "text": "没算出估计值"}
    assert "note" not in chart and "sub" not in items["后向复杂 GVC 生产份额"]
    # Without the course estimates the chart still shows the saved Y, in the family's unit.
    alone = family_chart(12, "production", design, result, coefficient, None)
    (only,) = json.loads(alone[1])["items"]
    assert (
        only["saved"] and only["text"] == "+0.008" and json.loads(alone[1])["title"].startswith("步骤 12 · 你保存的 Y")
    )
    assert not any("其余 Y" in line for line in alone)
    length = _design_info(RegressionDesign("length", teaching=True))
    length_coefficient = {"name": X_COLUMN, "coef": -1.8143, "ci_low": -1.9155, "ci_high": -1.7132}
    length_result = {"status": "ok", "support": {"status": "ok"}, "depvar_std": 0.5819, "coefs": [length_coefficient]}
    (bar,) = json.loads(family_chart(13, "length", length, length_result, length_coefficient, None)[1])["items"]
    assert bar["text"] == "-0.018（0.031 个标准差）"
    assert bar["sub"] == "长度单位"
    # Without a recorded SD the bar is 0 and says so, after the native value (the page's "（没有标准差）").
    (bare,) = json.loads(
        family_chart(13, "length", length, {**length_result, "depvar_std": None}, length_coefficient, None)[1]
    )["items"]
    assert (bare["value"], bare["text"]) == (0.0, "-0.018（没有标准差）")
    summary = json.loads(
        summary_chart(
            {
                13: {"outcome": "length", "design": length, "result": {**length_result, "depvar_std": None}},
                12: {"outcome": "production", "design": design, "result": result},
            }
        )[1]
    )
    assert [item["sub"] for item in summary["items"]] == ["步骤 12 · 生产", "步骤 13 · 长度"]
    assert [item["text"] for item in summary["items"]] == [
        "+0.008 个百分点（0.001 个标准差）",
        "-0.018 个长度单位（没有标准差）",
    ]
    assert summary["note"].endswith("步骤 11 · 贸易流、步骤 14 · 网络：还没计算。")
