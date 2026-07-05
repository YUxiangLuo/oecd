"""HS→ICIO crosswalk mock 的结构与映射工作流测试。"""

import numpy as np

from gvcsim.data import crosswalk


def test_crosswalk_covers_all_hs_chapters_and_weights_sum_to_one():
    cw = crosswalk.build_crosswalk()

    assert cw["hs_chapter"].nunique() == 97
    assert cw["icio_sector"].nunique() >= 20

    sums = cw.groupby("hs_chapter")["weight"].sum()
    assert np.allclose(sums.to_numpy(), 1.0)


def test_crosswalk_quality_checks_pass():
    checks = crosswalk.check_crosswalk()

    assert len(checks) == 4
    assert all(c.passed for c in checks), [(c.name, c.detail, c.warnings) for c in checks]


def test_demo_hs_list_maps_to_core_icio_manufacturing_sectors():
    mapped = crosswalk.map_demo_to_icio(2019)
    by_sector = mapped.set_index("icio_sector")

    for sector in ["C26", "C28", "C29"]:
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
