"""HS→ICIO crosswalk mock 的结构与映射工作流测试。"""

import numpy as np

from gvcsim.data import crosswalk


def test_selected_hs6_products_have_producing_industries_and_unit_weights():
    cw = crosswalk.build_crosswalk()

    assert cw["hs_code"].nunique() == 6
    assert cw["icio_sector"].nunique() == 5

    sums = cw.groupby("hs_code")["weight"].sum()
    assert np.allclose(sums.to_numpy(), 1.0)


def test_crosswalk_quality_checks_pass():
    checks = crosswalk.check_crosswalk()

    assert len(checks) == 4
    assert all(c.passed for c in checks), [(c.name, c.detail, c.warnings) for c in checks]


def test_demo_hs_list_maps_to_core_icio_manufacturing_sectors():
    mapped = crosswalk.map_demo_to_icio(2019)
    by_sector = mapped.set_index("icio_sector")

    for sector in ["C26", "C29"]:
        assert sector in by_sector.index
        assert by_sector.loc[sector, "avg_tariff"] > 0.05

    assert mapped.iloc[0]["avg_tariff"] >= mapped.iloc[-1]["avg_tariff"]


def test_invalid_demo_year_is_rejected():
    try:
        crosswalk.map_demo_to_icio(2021)
    except ValueError as e:
        assert "2018" in str(e)
    else:
        raise AssertionError("2021 年不应被接受")


def test_crosswalk_preserves_untaxed_goods_and_rejects_fish_as_agriculture():
    cw = crosswalk.build_crosswalk()
    assert "77" not in set(cw.hs_chapter)
    assert cw.set_index("hs_code").loc["030111", "icio_sector"] == "A03"
    assert cw.set_index("hs_code").loc["010121", "icio_sector"] == "A01_02"
    changed = cw.copy()
    changed.loc[changed.hs_code == "030111", "icio_sector"] = "A01_02"
    assert not next(c for c in crosswalk.check_crosswalk(changed) if c.name == "商品生产行业对应").passed
    # Both covered (0.2) and uncovered (0.3) chips belong in the C26 denominator.
    row = crosswalk.map_demo_to_icio(2019).set_index("icio_sector").loc["C26"]
    assert np.isclose(row.avg_tariff, 0.2 * 0.25 / (0.2 + 0.3))
