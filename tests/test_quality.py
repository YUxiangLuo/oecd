"""数据质检模块测试。"""

import numpy as np
import pandas as pd

from gvcsim.data import quality


def test_all_checks_pass_on_consistent_system(fake_io):
    checks = quality.run_all(fake_io)
    names = [c.name for c in checks]
    assert len(checks) == 5
    for c in checks:
        # 合成系统满足会计恒等式、无缺失值、矩阵性质良好;
        # 覆盖范围检查因缺少 CHN/USA 等关键国家而失败是预期行为
        if "覆盖范围" in c.name:
            assert not c.passed
        else:
            assert c.passed, f"{c.name}: {c.detail} {c.warnings}"
    assert any("会计恒等式" in n for n in names)


def test_accounting_identity_detects_corruption(fake_io):
    # 人为破坏总产出,恒等式检查必须报错
    fake_io.x.iloc[0, 0] *= 1.5
    check = quality.check_accounting_identity(fake_io)
    assert not check.passed
    assert check.warnings


def test_missing_value_detection(fake_io):
    fake_io.Z.iloc[1, 2] = np.nan
    check = quality.check_missing_and_negative(fake_io)
    assert not check.passed


def test_shock_panel_quality_passes_on_complete_panel():
    df = pd.DataFrame([
        {
            "country": c,
            "sector": s,
            "year": y,
            "tariff_shock": 0.02 if (c, s, y) == ("AAA", "s1", 2020) else 0.0,
            "treated": 1 if (c, s, y) == ("AAA", "s1", 2020) else 0,
            "shock_type": "关税冲击",
            "announced_date": "2020-01-01" if (c, s, y) == ("AAA", "s1", 2020) else "",
            "effective_date": "2020-02-01" if (c, s, y) == ("AAA", "s1", 2020) else "",
            "note": "test" if (c, s, y) == ("AAA", "s1", 2020) else "",
        }
        for c in ["AAA", "BBB"]
        for s in ["s1", "s2"]
        for y in [2019, 2020]
    ])

    checks = quality.check_shock_panel(df, ["AAA", "BBB"], ["s1", "s2"], [2019, 2020])

    assert len(checks) == 5
    assert all(c.passed for c in checks), [(c.name, c.detail, c.warnings) for c in checks]


def test_shock_panel_quality_detects_bad_timeline_and_threshold():
    df = pd.DataFrame([
        {
            "country": "AAA",
            "sector": "s1",
            "year": 2020,
            "tariff_shock": 0.02,
            "treated": 0,
            "announced_date": "2020-03-01",
            "effective_date": "2020-02-01",
        }
    ])

    checks = quality.check_shock_panel(df, ["AAA"], ["s1"], [2020])
    by_name = {c.name: c for c in checks}

    assert not by_name["冲击事件时间线(宣布日≤生效日)"].passed
    assert not by_name["treated 标记与阈值一致"].passed
