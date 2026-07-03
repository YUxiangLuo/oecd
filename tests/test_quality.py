"""数据质检模块测试。"""

import numpy as np

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
