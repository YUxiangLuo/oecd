"""设计有效性状态机的语义契约。

这些测试守住的不是"接口能跑",而是"结果能否报告":处理支持度不足或处理
路径与估计量不相容时,必须抑制 p 值、星号与置信区间。
"""

import pandas as pd
import pytest

from gvcsim.config import PROCESSED_DIR
from gvcsim.regression.validity import (
    MAX_REVERSAL_SHARE,
    MIN_TREATED_CLUSTERS,
    STATUS_INSUFFICIENT,
    STATUS_INVALID_DESIGN,
    STATUS_OK,
    STATUS_WARNING,
    analyze_support,
    scan_reversal,
)

needs_panel = pytest.mark.skipif(
    not (PROCESSED_DIR / "panel_industry.csv").exists(),
    reason="需要 gvcsim compute 产出的行业级面板",
)


def _panel(rows: list[tuple[str, int, float]]) -> pd.DataFrame:
    """rows: (country, year, intensity)。entity=country,cluster=country。"""
    return pd.DataFrame([{"country": c, "year": y, "shock": v, "treated": int(v > 0)} for c, y, v in rows])


def _support(df: pd.DataFrame, absorbing: bool = True):
    return analyze_support(
        df,
        entity="country",
        time="year",
        cluster="country",
        treated_col="treated",
        absorbing=absorbing,
        intensity_col="shock",
    )


def _many_treated(n_treated: int, n_control: int, years=(2016, 2017, 2018)) -> pd.DataFrame:
    rows = []
    for i in range(n_treated):
        for y in years:
            rows.append((f"T{i}", y, 1.0 if y >= 2017 else 0.0))
    for i in range(n_control):
        for y in years:
            rows.append((f"C{i}", y, 0.0))
    return _panel(rows)


def test_counts_treated_and_untreated_clusters_separately():
    s = _support(_many_treated(n_treated=3, n_control=9))
    assert s.treated_clusters == 3
    assert s.untreated_clusters == 9
    assert s.treated_entities == 3
    assert s.untreated_entities == 9
    assert s.total_entities == 12


def test_distinguishes_never_treated_entities_from_fully_untreated_clusters():
    rows = []
    for country in ("A", "B", "C", "D", "E"):
        for industry in ("treated", "control"):
            for year in (2016, 2017, 2018):
                rows.append(
                    {
                        "country": country,
                        "entity_id": f"{country}-{industry}",
                        "year": year,
                        "shock": float(industry == "treated" and year >= 2017),
                        "treated": int(industry == "treated" and year >= 2017),
                    }
                )
    s = analyze_support(
        pd.DataFrame(rows),
        entity="entity_id",
        time="year",
        cluster="country",
        treated_col="treated",
        absorbing=True,
        intensity_col="shock",
    )
    assert s.untreated_clusters == 0
    assert s.treated_entities == 5
    assert s.untreated_entities == 5
    assert any("只使用从未处理或截至比较期尚未处理" in reason for reason in s.reasons)


def test_too_few_treated_clusters_is_insufficient_regardless_of_total_clusters():
    """总聚类数很多不能补救处理聚类过少——这正是 HEAD 的核心误导。"""
    s = _support(_many_treated(n_treated=2, n_control=74))
    assert s.treated_clusters == 2
    assert s.untreated_clusters == 74
    assert s.status == STATUS_INSUFFICIENT
    assert s.suppress_inference is True


def test_enough_treated_clusters_is_ok():
    s = _support(_many_treated(n_treated=MIN_TREATED_CLUSTERS, n_control=9))
    assert s.status == STATUS_OK
    assert s.suppress_inference is False


def test_no_never_treated_entity_is_warning_not_suppressed():
    """全部实体都受处理时识别只靠时点差异;披露但不抑制推断。"""
    rows = []
    for i in range(MIN_TREATED_CLUSTERS + 1):
        for y in (2016, 2017, 2018):
            rows.append((f"T{i}", y, 1.0 if y >= 2017 + (i % 2) else 0.0))
    s = _support(_panel(rows))
    assert s.untreated_clusters == 0
    assert s.untreated_entities == 0
    assert s.status == STATUS_WARNING
    assert s.suppress_inference is False


def test_large_share_reversal_under_absorbing_is_invalid_design():
    """撤销比例超上限 → 估计对象被实质改变,停止推断。"""
    rows = []
    for i in range(MIN_TREATED_CLUSTERS + 1):
        # 全部处理个体在 2018 年撤销:2/3 的处理后个体-年被误编码。
        rows += [(f"T{i}", 2016, 0.0), (f"T{i}", 2017, 1.0), (f"T{i}", 2018, 0.0)]
    s = _support(_panel(rows))
    assert s.reversal_share > MAX_REVERSAL_SHARE
    assert s.status == STATUS_INVALID_DESIGN
    assert s.suppress_inference is True


def test_even_small_reversal_stops_absorbing_inference():
    """行数占比不能界定估计对象偏差，即使少量撤销也停止吸收型推断。"""
    rows = []
    for i in range(40):  # 40 个处理国家,各 2 个处理后年份
        rows += [(f"T{i}", 2016, 0.0), (f"T{i}", 2017, 1.0), (f"T{i}", 2018, 1.0)]
    # 仅 1 个国家撤销 → 1/80 处理后个体-年 = 1.25% < 5%
    rows = [r for r in rows if not (r[0] == "T0" and r[1] == 2018)]
    rows.append(("T0", 2018, 0.0))
    for i in range(10):
        for y in (2016, 2017, 2018):
            rows.append((f"C{i}", y, 0.0))
    s = _support(_panel(rows))
    assert s.reversal_entities == ["T0"]
    assert 0 < s.reversal_share < 0.05
    assert s.status == STATUS_INVALID_DESIGN
    assert s.suppress_inference is True


def test_reversal_ignored_for_non_absorbing_estimator():
    """强度法逐年跟随真实路径,撤销不构成设计冲突。"""
    rows = []
    for i in range(MIN_TREATED_CLUSTERS + 1):
        rows += [(f"T{i}", 2016, 0.0), (f"T{i}", 2017, 1.0), (f"T{i}", 2018, 0.0)]
    s = _support(_panel(rows), absorbing=False)
    assert s.reversal_entities == []
    assert s.status == STATUS_OK


def test_threshold_flicker_is_not_reported_as_reversal():
    """强度跌破 treated 阈值但仍 > 0 不是政策撤销,不能误报 invalid_design。"""
    df = pd.DataFrame(
        [
            {"country": "A", "year": 2016, "shock": 0.0, "treated": 0},
            {"country": "A", "year": 2017, "shock": 0.0013, "treated": 1},
            # 强度仍为正、政策仍在生效,只是跌破 treated 阈值 0.001。
            {"country": "A", "year": 2018, "shock": 0.0009, "treated": 0},
        ]
    )
    assert scan_reversal(df, "country", "year", "shock").entities == []
    # 若误用阈值化的处理指示列,则会把这次波动误报为撤销。
    assert scan_reversal(df, "country", "year", "treated").entities == ["A"]


def test_frozen_treated_flag_onset_defines_window_despite_pre_g_positive_intensity():
    df = pd.DataFrame(
        [
            # 正但低于 treated 阈值的强度不能提前开启吸收型窗口。
            {"country": "A", "year": 2016, "shock": 0.0009, "treated": 0},
            {"country": "A", "year": 2017, "shock": 0.0, "treated": 0},
            {"country": "A", "year": 2018, "shock": 0.10, "treated": 1},
            {"country": "A", "year": 2019, "shock": 0.0, "treated": 0},
        ]
    )
    scan = scan_reversal(df, "country", "year", "shock", first_by_entity=pd.Series({"A": 2018}))
    assert scan.entities == ["A"]
    assert scan.post_rows == 2
    assert scan.miscoded_rows == 1
    assert scan.share == pytest.approx(0.5)


def test_reversal_share_measures_post_treatment_entity_years():
    df = _panel(
        [
            ("A", 2016, 0.0),
            ("A", 2017, 1.0),
            ("A", 2018, 0.0),  # 处理后 2 年,误编码 1
            ("B", 2016, 0.0),
            ("B", 2017, 1.0),
            ("B", 2018, 1.0),  # 处理后 2 年,误编码 0
        ]
    )
    scan = scan_reversal(df, "country", "year", "shock")
    assert scan.entities == ["A"]
    assert scan.post_rows == 4
    assert scan.miscoded_rows == 1
    assert scan.share == pytest.approx(0.25)


def test_reversal_window_starts_at_first_treatment_and_survives_reactivation():
    """吸收型窗口从**首次**处理年起算,中途撤销再恢复的年份仍计为误编码。

    这条锁的是窗口语义本身:首次处理前的未处理年不进分母,首次处理后的
    每个"关掉"的年都进分子——撤销后又恢复不会把窗口重置。
    """
    df = _panel(
        [
            ("A", 2016, 0.0),  # 首次处理前:不进窗口
            ("A", 2017, 1.0),  # 首次处理年 → 窗口起点
            ("A", 2018, 0.0),  # 撤销:误编码
            ("A", 2019, 1.0),  # 恢复:窗口不重置,本年不算误编码
            ("A", 2020, 0.0),  # 再次撤销:误编码
        ]
    )
    scan = scan_reversal(df, "country", "year", "shock")
    assert scan.entities == ["A"]
    assert scan.post_rows == 4  # 2017–2020,不含 2016
    assert scan.miscoded_rows == 2  # 2018 与 2020
    assert scan.share == pytest.approx(0.5)


def test_reversal_scan_does_not_depend_on_row_order():
    """判定只由"个体的时间路径"决定,与行在表里的顺序无关。"""
    rows = [
        ("A", 2016, 0.0),
        ("A", 2017, 1.0),
        ("A", 2018, 0.0),
        ("B", 2016, 1.0),
        ("B", 2017, 1.0),
        ("B", 2018, 1.0),
    ]
    ordered = scan_reversal(_panel(rows), "country", "year", "shock")
    shuffled_rows = [rows[i] for i in (4, 2, 0, 5, 1, 3)]
    shuffled = scan_reversal(_panel(shuffled_rows), "country", "year", "shock")
    assert (shuffled.entities, shuffled.miscoded_rows, shuffled.post_rows) == (
        ordered.entities,
        ordered.miscoded_rows,
        ordered.post_rows,
    )
    assert ordered.entities == ["A"]
