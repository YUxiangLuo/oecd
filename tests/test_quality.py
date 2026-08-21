"""数据质检模块测试。"""

import numpy as np
import pandas as pd
import pytest

from gvcsim.data import quality


def _serialized(scope: str) -> list[dict]:
    return [
        {
            "name": name,
            "kind": "结构",
            "passed": True,
            "detail": "ok",
            "warnings": [],
            "severity": "ok",
        }
        for name in quality.QC_EXPECTED_CHECKS[scope]
    ]


def test_qc_contract_requires_complete_nonempty_supported_scope():
    checks = _serialized(quality.QC_SCOPE_CONTROLS)
    assert quality.validate_serialized_checks(checks, scope=quality.QC_SCOPE_CONTROLS) == checks
    with pytest.raises(ValueError, match="非空"):
        quality.validate_serialized_checks([], scope=quality.QC_SCOPE_CONTROLS)
    with pytest.raises(ValueError, match="未知 QC scope"):
        quality.validate_serialized_checks(checks, scope="unknown")
    with pytest.raises(ValueError, match="版本"):
        quality.validate_serialized_checks(
            checks,
            scope=quality.QC_SCOPE_CONTROLS,
            contract_version=99,
        )
    with pytest.raises(ValueError, match="不能为空"):
        quality.summarize_serialized_checks([])
    with pytest.raises(ValueError, match="布尔值"):
        quality.summarize_serialized_checks(checks, override="yes")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="布尔值"):
        quality.summarize_checks([quality.QcCheck("x", "结构", True)], override=1)  # type: ignore[arg-type]


def test_qc_contract_binds_each_check_to_its_failure_severity():
    annual = _serialized(quality.QC_SCOPE_ICIO)
    annual[0].update({"passed": False, "severity": "warning"})
    with pytest.raises(ValueError, match="必须为 fatal"):
        quality.validate_serialized_checks(annual, scope=quality.QC_SCOPE_ICIO)

    annual = _serialized(quality.QC_SCOPE_ICIO)
    factor = next(item for item in annual if item["name"] == "因子投入与派生指标定义域(VA/TLS)")
    factor.update({"passed": False, "severity": "warning"})
    assert quality.validate_serialized_checks(annual, scope=quality.QC_SCOPE_ICIO) == annual
    factor["severity"] = "fatal"
    with pytest.raises(ValueError, match="必须为 warning"):
        quality.validate_serialized_checks(annual, scope=quality.QC_SCOPE_ICIO)


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
                "sanction_shock": 0.0,
                "sanction_treated": 0,
                "sanction_announced_date": "",
                "sanction_effective_date": "",
                "sanction_note": "",
                "export_control_shock": 0.0,
                "export_control_treated": 0,
                "export_control_announced_date": "",
                "export_control_effective_date": "",
                "export_control_note": "",
                "tariff_exposure_source": "oecd_icio_bilateral_flow",
                "tariff_exposure_mode": "fixed_pretreatment",
                "tariff_exposure_disclosure": "",
            }
            for c in ["AAA", "BBB"]
            for s in ["s1", "s2"]
            for y in [2019, 2020]
        ]
    )

    checks = quality.check_shock_panel(df, ["AAA", "BBB"], ["s1", "s2"], [2019, 2020])

    assert len(checks) == 6
    assert all(c.passed for c in checks), [(c.name, c.detail, c.warnings) for c in checks]
    coverage = next(c for c in checks if c.name.startswith("关税处理组覆盖比例"))
    assert "关税处理 1/4" in coverage.detail
    assert "制裁处理 0（描述性）" in coverage.detail
    assert "出口管制处理 0（描述性）" in coverage.detail


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


def _complete_shock_rows(values: list[float]) -> pd.DataFrame:
    rows = []
    for index, value in enumerate(values):
        hit = value > 0
        rows.append({
            "country": f"C{index}", "sector": "s1", "year": 2020, "shock_type": "tariff",
            "tariff_shock": value, "treated": int(value > 0.001),
            "announced_date": "2020-01-01" if hit else "",
            "effective_date": "2020-02-01" if hit else "", "note": "event" if hit else "",
            "sanction_shock": 0.0, "sanction_treated": 0,
            "sanction_announced_date": "", "sanction_effective_date": "", "sanction_note": "",
            "export_control_shock": 0.0, "export_control_treated": 0,
            "export_control_announced_date": "", "export_control_effective_date": "",
            "export_control_note": "", "tariff_exposure_source": "oecd_icio_bilateral_flow",
            "tariff_exposure_mode": "fixed_pretreatment", "tariff_exposure_disclosure": "",
        })
    return pd.DataFrame(rows)


def test_shock_threshold_is_strict_and_complete_types_are_mandatory():
    frame = _complete_shock_rows([0.0009, 0.001, 0.0011])
    checks = quality.check_shock_panel(frame, ["C0", "C1", "C2"], ["s1"], [2020])
    assert next(check for check in checks if check.name == "treated 标记与阈值一致").passed
    assert frame["treated"].tolist() == [0, 0, 1]

    missing_half = frame.drop(columns=["sanction_treated"])
    malformed = quality.check_shock_panel(missing_half, ["C0", "C1", "C2"], ["s1"], [2020])
    assert len(malformed) == 6
    assert not malformed[0].passed
    assert "sanction_treated" in " ".join(malformed[0].warnings)


def test_shock_exposure_provenance_rejects_unknown_mixed_and_undisclosed_fallback():
    frame = _complete_shock_rows([0.0011, 0.0])
    provenance_name = "关税出口暴露度来源与口径"

    unknown = frame.copy()
    unknown["tariff_exposure_mode"] = "unknown"
    assert not next(c for c in quality.check_shock_panel(unknown, ["C0", "C1"], ["s1"], [2020]) if c.name == provenance_name).passed

    mixed = frame.copy()
    mixed.loc[1, "tariff_exposure_source"] = "stylized_teaching_fallback"
    mixed.loc[1, "tariff_exposure_disclosure"] = "风格化出口暴露度仅供教学测试，不是 OECD ICIO 观测值，不得表述为官方数据。"
    assert not next(c for c in quality.check_shock_panel(mixed, ["C0", "C1"], ["s1"], [2020]) if c.name == provenance_name).passed

    fallback = frame.copy()
    fallback["tariff_exposure_source"] = "stylized_teaching_fallback"
    assert not next(c for c in quality.check_shock_panel(fallback, ["C0", "C1"], ["s1"], [2020]) if c.name == provenance_name).passed

    fallback["tariff_exposure_disclosure"] = "风格化出口暴露度仅供教学测试，不是 OECD ICIO 观测值，不得表述为官方数据。"
    check = next(c for c in quality.check_shock_panel(fallback, ["C0", "C1"], ["s1"], [2020]) if c.name == provenance_name)
    assert check.passed
    assert check.effective_severity == quality.QC_DISCLOSURE
