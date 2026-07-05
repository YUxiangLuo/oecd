"""冲击演示面板的结构与"拟真性"测试(不依赖真实数据)。"""

import numpy as np
import pandas as pd
import pytest

from gvcsim.shocks import TREATED_THRESHOLD, demo_shock_panel

COUNTRIES = ["CHN", "USA", "DEU", "CAN", "AUS", "BRA", "VNM", "TUR"]
SECTORS = ["A01_02", "C24", "C26", "C28", "C29", "K", "J62_63"]
YEARS = [2016, 2017, 2018, 2019, 2020]


def _panel():
    return demo_shock_panel(COUNTRIES, SECTORS, YEARS).set_index(
        ["country", "sector", "year"]
    )


def test_full_coverage_and_bounds():
    df = _panel()
    # 全组合覆盖、无缺失
    assert len(df) == len(COUNTRIES) * len(SECTORS) * len(YEARS)
    assert not df["tariff_shock"].isna().any()
    # 平均额外关税不可能为负,也不该超过 50%
    assert df["tariff_shock"].between(0, 0.5).all()
    # treated 与阈值一致
    assert (
        (df["tariff_shock"] > TREATED_THRESHOLD) == (df["treated"] == 1)
    ).all()


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
    assert (df["shock_type"] == "关税冲击").all()


def test_uses_icio_export_exposure_when_provided():
    exposure_panel = pd.DataFrame([
        {"country": "CHN", "imposer": "USA", "year": 2019, "export_exposure": 0.50},
        {"country": "USA", "imposer": "CHN", "year": 2019, "export_exposure": 0.25},
        {"country": "USA", "imposer": "MEX", "year": 2019, "export_exposure": 0.00},
        {"country": "USA", "imposer": "IND", "year": 2019, "export_exposure": 0.00},
    ])
    df = demo_shock_panel(
        ["CHN", "USA"],
        ["C26", "A01_02"],
        [2019],
        exposure_panel=exposure_panel,
    ).set_index(["country", "sector", "year"])

    # 301 C26 rate is 0.16 in 2019, plus the all-partner 201 safeguard rate 0.012.
    assert df.loc[("CHN", "C26", 2019), "tariff_shock"] == pytest.approx((0.16 + 0.012) * 0.50)
    # China retaliation on US agriculture is 0.26 in 2019.
    assert df.loc[("USA", "A01_02", 2019), "tariff_shock"] == pytest.approx(0.26 * 0.25)
