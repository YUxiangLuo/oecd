"""Cohort-time 成对差值复用：保持删聚类、缺失观察和独立请求的既有语义。"""

from dataclasses import replace

import numpy as np
import pandas as pd
import pytest

from gvcsim.regression import panel
from gvcsim.regression.design import RegressionDesign


@pytest.fixture
def industry_panel():
    rows = []
    for country in range(16):
        for industry in range(3):
            cohort = (2020 if country == 0 else 2018) if industry == 0 else 2019 if industry == 1 else None
            for year in range(2016, 2021):
                treated = cohort is not None and year >= cohort
                outcome = (
                    0.1 * country
                    + 0.2 * industry
                    + 0.1 * (year - 2016)
                    + 0.03 * ((country * 7 + industry * 11 + year * 3) % 17)
                    + (0.2 * (year - cohort + 1) if treated else 0)
                )
                if (country, industry, year) in {(1, 0, 2017), (3, 1, 2020), (5, 2, 2018)}:
                    outcome = np.nan
                rows.append(
                    {
                        "country": f"C{country:02d}",
                        "entity_id": f"C{country:02d}_S{industry}",
                        "year": year,
                        "FVA_share": outcome,
                        "treated": int(treated),
                        "tariff_shock": 0.02 if treated else 0.0,
                    }
                )
    return pd.DataFrame(rows)


def _event_times(model, method):
    if method == "did":
        return None
    return [period["event_time"] for period in model.event_support["periods"] if period["estimated"]]


@pytest.mark.parametrize("method", ["did", "event_study"])
def test_reused_pairs_match_rebuilding_after_cluster_deletion(industry_panel, method):
    model = panel.prepare_design_model(industry_panel, RegressionDesign(outcome="trade", method=method))
    event_times = _event_times(model, method)
    prepared = panel._prepare_cohort_time_cells(model, event_times)
    original = model.data.copy(deep=True)
    baseline = panel._cohort_time_att_values(model, event_times, prepared_cells=prepared)

    # 每个国家都同时有处理行业与对照行业，删除时必须同步过滤两侧。
    for cluster in sorted(model.data[model.cluster].unique()):
        filtered = replace(model, data=model.data.loc[model.data[model.cluster] != cluster].copy())
        expected = panel._cohort_time_att_values(filtered, event_times)
        actual = panel._cohort_time_att_values(model, event_times, omitted_cluster=cluster, prepared_cells=prepared)
        assert actual == expected

    # 复用与删除操作都不能改变下一次估计的分量或原始样本。
    assert panel._cohort_time_att_values(model, event_times, prepared_cells=prepared) == baseline
    pd.testing.assert_frame_equal(model.data, original)


@pytest.mark.parametrize("method", ["did", "event_study"])
def test_public_jackknife_prepares_pairs_once_per_run(industry_panel, method, monkeypatch):
    original_prepare = panel._prepare_cohort_time_cells
    calls = []

    def counted(model, event_times):
        calls.append(model.depvar)
        return original_prepare(model, event_times)

    monkeypatch.setattr(panel, "_prepare_cohort_time_cells", counted)
    design = RegressionDesign(outcome="trade", method=method)
    result, audit = panel.run_design_with_benchmark(industry_panel, design)

    assert result.n_clusters == 16
    assert audit["benchmark_passed"] is True
    assert any(coefficient.se is not None for coefficient in result.coefs)
    assert calls == ["FVA_share"]
    changed = industry_panel.assign(FVA_share=industry_panel["FVA_share"] * 2)
    second, _ = panel.run_design_with_benchmark(changed, design)
    assert calls == ["FVA_share", "FVA_share"]
    for old, new in zip(result.coefs, second.coefs, strict=True):
        assert new.coef == pytest.approx(2 * old.coef)


def test_deleting_only_control_cluster_remains_unestimable(industry_panel):
    # 所有未处理行业归于同一个对照国家；删除它后不得残留缓存中的对照观察。
    frame = industry_panel.copy()
    control = frame["entity_id"].str.endswith("_S2")
    frame.loc[control, "country"] = "CONTROL"
    model = panel.prepare_design_model(frame, RegressionDesign(outcome="trade"))
    prepared = panel._prepare_cohort_time_cells(model, None)
    # 尚未处理 cohort 仍可给早期单元作对照，但最后一个处理年必须消失。
    _, cells = panel._cohort_time_att_values(model, None, omitted_cluster="CONTROL", prepared_cells=prepared)
    assert cells
    assert all(cell["time"] < 2020 for cell in cells)

    late_only = [cell for cell in prepared if cell.time == 2020]
    with pytest.raises(ValueError, match="没有可估计的 cohort-time ATT 单元"):
        panel._cohort_time_att_values(model, None, omitted_cluster="CONTROL", prepared_cells=late_only)
