"""冲击演示面板的结构与"拟真性"测试(不依赖真实数据)。"""

import numpy as np
import pandas as pd

from gvcsim.indicators.core import build_arrays
from gvcsim.shocks import TREATED_THRESHOLD, build_export_exposure, demo_shock_panel, events_metadata

COUNTRIES = ["CHN", "USA", "DEU", "CAN", "AUS", "BRA", "VNM", "TUR"]
SECTORS = ["A01_02", "C24", "C26", "C28", "C29", "K", "J62_63"]
YEARS = [2016, 2017, 2018, 2019, 2020]


def _panel():
    return demo_shock_panel(COUNTRIES, SECTORS, YEARS).set_index(["country", "sector", "year"])


def test_full_coverage_and_bounds():
    df = _panel()
    # 全组合覆盖、无缺失
    assert len(df) == len(COUNTRIES) * len(SECTORS) * len(YEARS)
    assert not df["tariff_shock"].isna().any()
    # 平均额外关税不可能为负,也不该超过 50%
    assert df["tariff_shock"].between(0, 0.5).all()
    # treated 与阈值一致
    assert ((df["tariff_shock"] > TREATED_THRESHOLD) == (df["treated"] == 1)).all()


def test_prewar_years_are_zero():
    df = _panel()
    pre = df.xs(2016, level="year")["tariff_shock"]
    assert np.allclose(pre, 0.0)
    assert np.allclose(df.xs(2017, level="year")["tariff_shock"], 0.0)


def test_us_china_escalation():
    df = _panel()["tariff_shock"]
    # 301 对华:2018 开征、2019 加码
    assert 0 < df["CHN", "C26", 2018] < df["CHN", "C26", 2019]
    assert df["CHN", "C28", 2019] > df["CHN", "C26", 2019]  # 机械是重灾区
    # 中方反制:美国农业受创最重
    assert df["USA", "A01_02", 2019] > df["USA", "C26", 2019]
    # 美国汽车 2018 被反制(25%),2019 暂停后大幅回落
    assert df["USA", "C29", 2018] > df["USA", "C29", 2019]


def test_all_countries_hit_by_232():
    """232 钢铝覆盖所有对美出口国:非中美国家 C24 也非零;澳大利亚豁免。"""
    df = _panel()["tariff_shock"]
    for c in ["DEU", "BRA", "VNM", "TUR"]:
        assert df[c, "C24", 2018] > 0, f"{c} 应受232冲击"
    assert df["AUS", "C24", 2018] == 0.0
    # 加拿大 2020 已豁免
    assert df["CAN", "C24", 2018] > 0
    assert df["CAN", "C24", 2020] == 0.0
    # 出口暴露度加权:加拿大(对美出口3/4)所受冲击远大于德国
    assert df["CAN", "C24", 2018] > 3 * df["DEU", "C24", 2018]


def test_services_untouched():
    df = _panel()["tariff_shock"]
    assert np.allclose(df.xs("K", level="sector"), 0.0)
    assert np.allclose(df.xs("J62_63", level="sector"), 0.0)


def test_event_timeline_columns():
    df = _panel()
    hit = df[df["tariff_shock"] > 0]
    assert (hit["announced_date"] != "").all()
    assert (hit["effective_date"] != "").all()
    assert (hit["note"] != "").all()
    assert (df["shock_type"] == "tariff").all()


def test_event_metadata_discloses_composite_timeline_and_correct_xpcc_date():
    events = events_metadata()
    section_301 = next(event for event in events if event["name"].startswith("美国301对华关税"))
    assert "复合处理" in section_301["name"]
    assert "只对应首批" in section_301["timeline_note"]
    assert section_301["source_urls"]

    xpcc = next(event for event in events if "XPCC" in event["name"])
    assert xpcc["announced"] == "2020-07-31"
    assert xpcc["effective"] == "2020-07-31"
    assert xpcc["source_urls"] == ["https://ofac.treasury.gov/recent-actions/20200731"]
    assert "进口限制" not in xpcc["name"]


def test_entity_list_policy_shocks_are_generated():
    df = demo_shock_panel(
        ["CHN", "RUS", "USA"],
        ["C24", "C26", "J62_63", "K", "B05_06"],
        YEARS,
    ).set_index(["country", "sector", "year"])

    assert df.loc[("RUS", "C24", 2018), "sanction_shock"] > 0
    assert df.loc[("RUS", "C24", 2018), "sanction_treated"] == 1
    assert df.loc[("CHN", "C26", 2020), "export_control_shock"] > 0
    assert df.loc[("CHN", "C26", 2020), "export_control_treated"] == 1
    assert "RUSAL" in df.loc[("RUS", "C24", 2018), "sanction_note"]
    assert "华为" in df.loc[("CHN", "C26", 2019), "export_control_note"]


def test_export_exposure_from_icio_flows(fake_io):
    arr = build_arrays(fake_io)
    exposure = build_export_exposure(arr, 2020)
    by_key = exposure.set_index(["country", "imposer", "year"])["export_exposure"]

    # fake_io 只有两个国家,AAA 的全部出口都流向 BBB。
    assert by_key["AAA", "BBB", 2020] == 1.0
    assert by_key["AAA", "AAA", 2020] == 0.0
    assert by_key["BBB", "AAA", 2020] == 1.0


def test_demo_panel_uses_passed_export_exposure():
    exposure = pd.DataFrame(
        [
            {"country": "DEU", "imposer": "USA", "year": 2018, "export_exposure": 0.5},
        ]
    )
    df = demo_shock_panel(["DEU", "USA"], ["C24"], [2018], export_exposure=exposure)
    val = df.set_index(["country", "sector", "year"]).loc[("DEU", "C24", 2018), "tariff_shock"]
    # 232 钢铝 2018 年 C24 基准税率 0.16 × ICIO 暴露度 0.5。
    assert val == 0.08


def test_tariff_primary_uses_last_pretreatment_weight_and_keeps_contemporaneous_robustness():
    exposure = pd.DataFrame(
        [
            {"country": "DEU", "imposer": "USA", "year": 2017, "export_exposure": 0.20},
            {"country": "DEU", "imposer": "USA", "year": 2018, "export_exposure": 0.80},
            {"country": "DEU", "imposer": "USA", "year": 2019, "export_exposure": 0.90},
        ]
    )
    panel = demo_shock_panel(["DEU", "USA"], ["C24"], [2017, 2018, 2019], export_exposure=exposure)
    row = panel.set_index(["country", "sector", "year"]).loc[("DEU", "C24", 2018)]
    assert row["tariff_shock"] == 0.16 * 0.20
    assert row["tariff_shock_contemporaneous"] == 0.16 * 0.80
    assert row["tariff_exposure_mode"] == "fixed_pretreatment"
