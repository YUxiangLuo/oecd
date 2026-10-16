import re
from pathlib import Path

from gvcsim.report_labels import COUNTRY_NAMES, SECTOR_NAMES, country_label, sector_label

SHARED = Path(__file__).resolve().parents[1] / "frontend" / "src" / "viz" / "shared.tsx"


def _frontend_map(name: str) -> dict[str, str]:
    source = SHARED.read_text(encoding="utf-8")
    body = source.split(f"{name}: Record<string, string> = {{", 1)[1].split("};", 1)[0]
    return dict(re.findall(r'(\w+): "([^"]+)"', body))


def test_report_names_match_the_pages():
    assert COUNTRY_NAMES == _frontend_map("COUNTRY_NAMES")
    assert SECTOR_NAMES == _frontend_map("SECTOR_NAMES")


def test_labels_keep_the_code_and_fall_back_to_it():
    assert country_label("CHN") == "CHN 中国"
    assert sector_label("C26") == "C26 计算机电子光学"
    assert country_label("XXX") == "XXX"
    assert sector_label("S7") == "S7"


def test_steps_2_to_5_readings_print_as_the_saved_label():
    from gvcsim.report_common import format_metric

    # Frontend formatMetric: a betweenness above 0 but below 0.5 is real, not the 0 of a node on no route.
    assert format_metric(0.25, "count") == "<1"
    assert format_metric(0.7, "count") == "1"
    assert format_metric(43.0, "count") == "43"
    assert format_metric(0.0002, "amount") == "<0.001"
    assert format_metric(2807184.244, "amount") == "2,807,184"
    assert format_metric(0.1173, "pct") == "11.730%"
    assert format_metric(0.0, "pct") == "0%"
    assert format_metric(150.123, "number") == "150"
    assert format_metric(0.4567, "number") == "0.457"
    # Rounded as the page rounds (frontend parity checked case by case): toLocaleString sends a tie of the
    # shortest decimal form away from zero, toFixed rounds the exact binary value; Python alone rounds to even.
    assert format_metric(0.5, "count") == "1"
    assert format_metric(2.5, "count") == "3"
    assert format_metric(0.0625, "number") == "0.063"
    assert format_metric(1.0005, "number") == "1.000"


def test_chart_readings_state_changes_in_the_chart_unit():
    from gvcsim.report_observed import _card_reading, _change, _reading

    assert _change(11.556, 11.73, "%") == "+0.174 个百分点"
    assert _reading(11.73, "%") == "11.730%"
    assert _change(1000.0, 2808184.244, "百万美元") == "+2,807,184 百万美元"
    assert _change(3.2, 3.092, "长度单位") == "-0.108"
    # Betweenness counts paths: whole numbers, as on the page.
    assert _change(500.0, 232.069, "未归一化介数") == "-268"
    assert _reading(0, "%") == "0%"
    # At the decimals of the two readings, as the trend card: "10 → 11" changes by "+1", not "+0.577"; an amount
    # below 10 keeps three decimals; a change too small for them is said so; no change reads 0.
    assert _change(10.2, 10.777, "百万美元") == "+1 百万美元"
    assert _change(3.0, 3.5, "百万美元") == "+0.500 百万美元"
    assert _change(0.3, 5.0, "未归一化介数") == "+4.700"
    assert _change(16.7431, 16.7432, "%") == "+不到 0.001 个百分点"
    assert _change(12.0, 12.0, "%") == "0 个百分点"
    assert _change(0.0, 2.5, "未归一化介数") == "+3"
    assert _card_reading(-2.4995, "百万美元") == "-2.500"
    assert _reading(232.5, "未归一化介数") == "233"
