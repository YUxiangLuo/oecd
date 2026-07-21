"""数据质检模块测试。"""

import numpy as np
import pandas as pd

from gvcsim.data import quality


def test_all_checks_pass_on_consistent_system(fake_io):
    checks = quality.run_all(fake_io)
    names = [c.name for c in checks]
    assert len(checks) == 7
    for c in checks:
        # 合成系统满足会计恒等式、无缺失值、矩阵性质良好;
        # 覆盖范围检查因缺少 CHN/USA 等关键国家而失败是预期行为
        if "覆盖范围" in c.name:
            assert not c.passed
        else:
            assert c.passed, f"{c.name}: {c.detail} {c.warnings}"
    assert any("会计恒等式" in n for n in names)


def test_accounting_identity_detects_corruption(fake_io):
    # 人为破坏源表 OUT，独立恒等式检查必须报错。
    fake_io.reported_output.iloc[0] *= 1.5
    check = quality.check_accounting_identity(fake_io)
    assert not check.passed
    assert check.warnings


def test_accounting_identity_does_not_compare_derived_x_to_itself(fake_io):
    # calc_all 派生的 x 不是这个 QC 的“观测值”；只改 x 不应伪装成源表错误。
    fake_io.x.iloc[0, 0] *= 1.5
    check = quality.check_accounting_identity(fake_io)
    assert check.passed


def test_input_accounting_identity_detects_factor_corruption(fake_io):
    idx = fake_io.Z.index[0]
    fake_io.factor_inputs.F.loc["VA", idx] += 10.0
    check = quality.check_input_accounting_identity(fake_io)
    assert not check.passed
    assert check.warnings


def test_negative_va_is_warning_while_cost_identity_still_closes(fake_io):
    idx = fake_io.Z.index[0]
    primary_input = float(fake_io.factor_inputs.F.loc[["TLS", "VA"], idx].sum())
    fake_io.factor_inputs.F.loc["VA", idx] = -5.0
    fake_io.factor_inputs.F.loc["TLS", idx] = primary_input + 5.0

    factor = quality.check_factor_inputs(fake_io)
    identity = quality.check_input_accounting_identity(fake_io)

    assert not factor.passed
    assert factor.effective_severity == quality.QC_WARNING
    assert identity.passed
    assert any("行业级生产份额必须置空" in warning for warning in factor.warnings)


def test_a_column_sum_above_one_is_not_itself_leontief_failure(fake_io):
    A = np.zeros((4, 4))
    A[0, 1] = 1.2
    A[1, 0] = 0.2
    fake_io.A.iloc[:, :] = A
    fake_io.L.iloc[:, :] = np.linalg.inv(np.eye(4) - A)

    check = quality.check_leontief_inverse(fake_io)

    assert fake_io.A.sum(axis=0).max() > 1
    assert check.passed, (check.detail, check.warnings)


def test_spectral_radius_at_least_one_is_fatal_even_when_inverse_exists(fake_io):
    A = np.zeros((4, 4))
    A[0, 1] = 1.1
    A[1, 0] = 1.1
    fake_io.A.iloc[:, :] = A
    fake_io.L.iloc[:, :] = np.linalg.inv(np.eye(4) - A)

    check = quality.check_leontief_inverse(fake_io)

    assert not check.passed
    assert check.effective_severity == quality.QC_FATAL
    assert any("谱半径" in warning for warning in check.warnings)


def test_missing_value_detection(fake_io):
    fake_io.Z.iloc[1, 2] = np.nan
    check = quality.check_missing_and_negative(fake_io)
    assert not check.passed


def test_shape_check_rejects_unit_drift(fake_io):
    fake_io.unit.iloc[:, 0] = "EUR"

    check = quality.check_shapes(fake_io)

    assert not check.passed
    assert "Million USD" in check.detail


def test_shock_panel_quality_passes_on_complete_panel():
    df = pd.DataFrame(
        [
            {
                "country": c,
                "sector": s,
                "year": y,
                "tariff_shock": 0.02 if (c, s, y) == ("AAA", "s1", 2020) else 0.0,
                "treated": 1 if (c, s, y) == ("AAA", "s1", 2020) else 0,
                "shock_type": "tariff",
                "announced_date": "2020-01-01" if (c, s, y) == ("AAA", "s1", 2020) else "",
                "effective_date": "2020-02-01" if (c, s, y) == ("AAA", "s1", 2020) else "",
                "note": "test" if (c, s, y) == ("AAA", "s1", 2020) else "",
            }
            for c in ["AAA", "BBB"]
            for s in ["s1", "s2"]
            for y in [2019, 2020]
        ]
    )

    checks = quality.check_shock_panel(df, ["AAA", "BBB"], ["s1", "s2"], [2019, 2020])

    assert len(checks) == 5
    assert all(c.passed for c in checks), [(c.name, c.detail, c.warnings) for c in checks]


def test_shock_panel_quality_detects_bad_timeline_and_threshold():
    df = pd.DataFrame(
        [
            {
                "country": "AAA",
                "sector": "s1",
                "year": 2020,
                "tariff_shock": 0.02,
                "treated": 0,
                "announced_date": "2020-03-01",
                "effective_date": "2020-02-01",
            }
        ]
    )

    checks = quality.check_shock_panel(df, ["AAA"], ["s1"], [2020])
    by_name = {c.name: c for c in checks}

    assert not by_name["冲击事件时间线(宣布日≤生效日)"].passed
    assert not by_name["treated 标记与阈值一致"].passed
