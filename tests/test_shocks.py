"""冲击演示面板的结构与"拟真性"测试(不依赖真实数据)。"""

import numpy as np
import pandas as pd
import pytest

from gvcsim.indicators.core import build_arrays
from gvcsim import shocks
from gvcsim.shocks import TREATED_THRESHOLD, build_export_exposure, demo_shock_panel, events_metadata

COUNTRIES = ["CHN", "USA", "DEU", "CAN", "AUS", "BRA", "VNM", "TUR"]
SECTORS = ["A01_02", "C24", "C26", "C28", "C29", "K", "J62_63"]
YEARS = [2016, 2017, 2018, 2019, 2020]


def _complete_exposure(
    countries: list[str],
    years: list[int],
    overrides: dict[tuple[str, str, int], float] | None = None,
) -> pd.DataFrame:
    """Build a self-consistent tiny complete ICIO dimension with both flow columns."""
    overrides = overrides or {}
    base = sorted({*countries, *(set(shocks.catalogue_tariff_imposers()) - {"EU"})})
    rows = []
    for country in base:
        for year in years:
            shares = {destination: overrides.get((country, destination, year), 0.0) for destination in base}
            shares[country] = 0.0
            remaining = 1.0 - sum(shares.values())
            if remaining < -1e-12:
                raise ValueError("fixture overrides exceed one")
            residual = next(
                destination for destination in base if destination != country and shares[destination] == 0.0
            )
            shares[residual] += max(remaining, 0.0)
            for destination in base:
                rows.append(
                    {
                        "country": country,
                        "imposer": destination,
                        "year": year,
                        "bilateral_exports": shares[destination],
                        "total_exports": 1.0,
                        "export_exposure": shares[destination],
                    }
                )
            eu_share = sum(shares.get(member, 0.0) for member in shocks.EU27)
            rows.append(
                {
                    "country": country,
                    "imposer": "EU",
                    "year": year,
                    "bilateral_exports": eu_share,
                    "total_exports": 1.0,
                    "export_exposure": eu_share,
                }
            )
    return pd.DataFrame(rows)


def _panel():
    return demo_shock_panel(COUNTRIES, SECTORS, YEARS, allow_stylized_fallback=True).set_index(
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
    assert ((df["tariff_shock"] > TREATED_THRESHOLD) == (df["treated"] == 1)).all()


def test_demo_panel_generation_has_deterministic_key_order():
    generated = demo_shock_panel(
        ["USA", "CHN"],
        ["C26", "C24"],
        [2020, 2018],
        allow_stylized_fallback=True,
    )
    expected = demo_shock_panel(
        ["CHN", "USA"],
        ["C24", "C26"],
        [2018, 2020],
        allow_stylized_fallback=True,
    )

    pd.testing.assert_frame_equal(generated, expected, check_exact=True)
    keys = list(generated[["country", "sector", "year"]].itertuples(index=False, name=None))
    assert keys == sorted(keys)


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
    assert section_301["source_status"] == "official_event_source"
    assert "教学编码" in section_301["source_disclosure"]

    uncited = next(event for event in events if event["name"].startswith("美国232"))
    assert uncited["source_status"] == "teaching_encoding_no_event_source"
    assert uncited["source_urls"] == []
    assert uncited["source_disclosure"] == section_301["source_disclosure"]
    assert uncited["peak_rate"] == 0.24
    assert uncited["top_sectors"] == ["C24"]

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
        allow_stylized_fallback=True,
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


def test_persisted_exposure_and_shock_loaders_preserve_round_trip_floats(tmp_path, monkeypatch):
    monkeypatch.setattr(shocks, "PROCESSED_DIR", tmp_path)
    sensitive_exposure = 0.0042146112887785974
    years = [2017, 2018]
    raw_exposure = _complete_exposure(
        ["DEU", "USA"],
        years,
        {("DEU", "USA", 2017): sensitive_exposure},
    )
    for year in years:
        raw_exposure.loc[raw_exposure["year"].eq(year)].to_csv(
            tmp_path / f"{shocks.EXPOSURE_PREFIX}_{year}.csv",
            index=False,
        )

    loaded_exposure = shocks.load_export_exposure(years)
    assert loaded_exposure is not None
    exposure_key = (
        loaded_exposure["country"].eq("DEU")
        & loaded_exposure["imposer"].eq("USA")
        & loaded_exposure["year"].eq(2017)
    )
    assert loaded_exposure.loc[exposure_key, "export_exposure"].item() == sensitive_exposure

    raw_panel = demo_shock_panel(
        ["DEU", "USA"],
        ["C24"],
        years,
        export_exposure=raw_exposure,
    )
    raw_key = raw_panel["country"].eq("DEU") & raw_panel["sector"].eq("C24") & raw_panel["year"].eq(2018)
    raw_shock = raw_panel.loc[raw_key, "tariff_shock"].item()
    assert raw_shock == sensitive_exposure * 0.16

    shocks.write_demo(["DEU", "USA"], ["C24"], years)
    published = pd.read_csv(
        tmp_path / shocks.DEMO_FILE,
        keep_default_na=False,
        float_precision="round_trip",
    )
    published_key = (
        published["country"].eq("DEU") & published["sector"].eq("C24") & published["year"].eq(2018)
    )
    assert published.loc[published_key, "tariff_shock"].item() == raw_shock

    loaded_shocks = shocks.load_shocks()
    loaded_key = (
        loaded_shocks["country"].eq("DEU")
        & loaded_shocks["sector"].eq("C24")
        & loaded_shocks["year"].eq(2018)
    )
    assert loaded_shocks.loc[loaded_key, "tariff_shock"].item() == raw_shock
    untreated_key = (
        loaded_shocks["country"].eq("DEU")
        & loaded_shocks["sector"].eq("C24")
        & loaded_shocks["year"].eq(2017)
    )
    assert loaded_shocks.loc[untreated_key, "note"].item() == ""


def test_demo_panel_uses_passed_pretreatment_export_exposure():
    exposure = _complete_exposure(
        ["DEU", "USA"],
        [2017, 2018],
        {("DEU", "USA", 2017): 0.5},
    )
    df = demo_shock_panel(["DEU", "USA"], ["C24"], [2017, 2018], export_exposure=exposure)
    val = df.set_index(["country", "sector", "year"]).loc[("DEU", "C24", 2018), "tariff_shock"]
    # 232 钢铝 2018 年 C24 基准税率 0.16 × 2017 ICIO 暴露度 0.5。
    assert val == 0.08


def test_fixed_pretreatment_exposure_rejects_release_without_earlier_year():
    exposure = _complete_exposure(
        ["DEU", "USA"],
        [2018],
        {("DEU", "USA", 2018): 0.5},
    )
    with pytest.raises(ValueError, match="不得回退到最早处理年"):
        demo_shock_panel(["DEU", "USA"], ["C24"], [2018], export_exposure=exposure)


def test_tariff_primary_uses_last_pretreatment_weight_and_keeps_contemporaneous_robustness():
    exposure = _complete_exposure(
        ["DEU", "USA"],
        [2017, 2018, 2019],
        {
            ("DEU", "USA", 2017): 0.20,
            ("DEU", "USA", 2018): 0.80,
            ("DEU", "USA", 2019): 0.90,
        },
    )
    panel = demo_shock_panel(["DEU", "USA"], ["C24"], [2017, 2018, 2019], export_exposure=exposure)
    row = panel.set_index(["country", "sector", "year"]).loc[("DEU", "C24", 2018)]
    assert row["tariff_shock"] == 0.16 * 0.20
    assert row["tariff_shock_contemporaneous"] == 0.16 * 0.80
    assert row["tariff_exposure_mode"] == "fixed_pretreatment"
    assert row["tariff_exposure_source"] == "oecd_icio_bilateral_flow"
    assert row["tariff_exposure_disclosure"] == ""


def test_stylized_exposure_requires_explicit_opt_in_and_records_disclosure():
    with pytest.raises(ValueError, match="禁止隐式"):
        demo_shock_panel(["DEU", "USA"], ["C24"], [2018])
    with pytest.raises(ValueError, match="非空表"):
        demo_shock_panel(
            ["DEU", "USA"],
            ["C24"],
            [2018],
            export_exposure=pd.DataFrame(
                columns=["country", "imposer", "year", "bilateral_exports", "total_exports", "export_exposure"]
            ),
        )

    panel = demo_shock_panel(["DEU", "USA"], ["C24"], [2018], allow_stylized_fallback=True)
    assert set(panel["tariff_exposure_source"]) == {"stylized_teaching_fallback"}
    assert set(panel["tariff_exposure_mode"]) == {"fixed_pretreatment"}
    assert panel["tariff_exposure_disclosure"].str.contains("不是 OECD ICIO").all()


@pytest.mark.parametrize("invalid", [-1.0, 1.0001])
def test_oecd_exposure_rejects_values_outside_unit_interval(invalid):
    frame = _complete_exposure(["DEU"], [2018])
    frame.loc[0, "export_exposure"] = invalid
    with pytest.raises(ValueError, match=r"\[0,1\]"):
        shocks.validate_export_exposure(frame, countries=["DEU"], years=[2018])


def test_oecd_exposure_rejects_duplicate_and_missing_catalogue_coverage():
    frame = _complete_exposure(["DEU"], [2018])
    duplicate = pd.concat([frame, frame.iloc[[0]]], ignore_index=True)
    with pytest.raises(ValueError, match="键重复"):
        shocks.validate_export_exposure(duplicate, countries=["DEU"], years=[2018])

    missing = frame.iloc[1:].copy()
    with pytest.raises(ValueError, match="覆盖不精确"):
        shocks.validate_export_exposure(missing, countries=["DEU"], years=[2018])
    with pytest.raises(ValueError, match="覆盖不精确"):
        demo_shock_panel(["DEU"], ["C24"], [2018], export_exposure=missing)


def test_oecd_exposure_requires_both_flow_evidence_columns():
    frame = _complete_exposure(["DEU"], [2018])
    without_flows = frame.drop(columns=["bilateral_exports", "total_exports"])

    with pytest.raises(ValueError, match="bilateral_exports.*total_exports|total_exports.*bilateral_exports"):
        shocks.validate_export_exposure(without_flows)


def test_oecd_exposure_rejects_impossible_sum_inconsistent_total_and_destination_drift():
    frame = _complete_exposure(["DEU"], [2018])

    impossible = frame.copy()
    row = impossible.index[(impossible["country"] == "DEU") & (impossible["imposer"] != "DEU")][0]
    impossible.loc[row, ["bilateral_exports", "export_exposure"]] *= 0.5
    with pytest.raises(ValueError, match="加总不等于|加总不可能"):
        shocks.validate_export_exposure(impossible)

    inconsistent = frame.copy()
    inconsistent.loc[0, "total_exports"] = 2.0
    inconsistent.loc[0, "export_exposure"] = inconsistent.loc[0, "bilateral_exports"] / 2.0
    with pytest.raises(ValueError, match="total_exports 不一致"):
        shocks.validate_export_exposure(inconsistent)

    missing = frame.drop(index=frame.index[frame["imposer"] == "EU"][0])
    with pytest.raises(ValueError, match="覆盖不精确"):
        shocks.validate_export_exposure(missing)

    extra = pd.concat(
        [
            frame,
            frame.iloc[[0]].assign(imposer="EXTRA", bilateral_exports=0.0, export_exposure=0.0),
        ],
        ignore_index=True,
    )
    with pytest.raises(ValueError, match="覆盖不精确"):
        shocks.validate_export_exposure(extra)


def test_oecd_exposure_rejects_ratio_mismatch_and_enforces_zero_total_policy():
    frame = _complete_exposure(["DEU"], [2018])
    frame["bilateral_exports"] = 0.0
    frame["total_exports"] = 10.0
    frame.loc[0, ["bilateral_exports", "export_exposure"]] = [2.0, 0.3]
    with pytest.raises(ValueError, match="不一致"):
        shocks.validate_export_exposure(frame, countries=["DEU"], years=[2018])

    zero_total = frame.copy()
    zero_total.loc[0, ["bilateral_exports", "total_exports", "export_exposure"]] = [1.0, 0.0, 0.0]
    with pytest.raises(ValueError, match="不得超过|零出口规则"):
        shocks.validate_export_exposure(zero_total, countries=["DEU"], years=[2018])


def test_oecd_exposure_requires_nonblank_identifiers_and_integral_finite_year():
    frame = _complete_exposure(["DEU"], [2018])
    frame.loc[0, "country"] = " "
    with pytest.raises(ValueError, match="空白标识符"):
        shocks.validate_export_exposure(frame)

    frame = _complete_exposure(["DEU"], [2018])
    frame["year"] = frame["year"].astype(float)
    frame.loc[0, "year"] = 2018.5
    with pytest.raises(ValueError, match="有限整数"):
        shocks.validate_export_exposure(frame)


def test_write_demo_fails_without_oecd_exposure_unless_fallback_is_explicit(tmp_path, monkeypatch):
    monkeypatch.setattr(shocks, "PROCESSED_DIR", tmp_path)
    monkeypatch.setattr(shocks, "load_export_exposure", lambda _years: None)

    with pytest.raises(ValueError, match="缺少 OECD ICIO"):
        shocks.write_demo(["DEU", "USA"], ["C24"], [2018])
    assert not (tmp_path / shocks.DEMO_FILE).exists()

    shocks.write_demo(["DEU", "USA"], ["C24"], [2018], allow_stylized_fallback=True)
    written = pd.read_csv(tmp_path / shocks.DEMO_FILE)
    assert set(written["tariff_exposure_source"]) == {"stylized_teaching_fallback"}
