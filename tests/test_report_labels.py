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


def test_chart_readings_state_changes_in_the_chart_unit():
    from gvcsim.report_observed import _change, _reading

    assert _change(0.174, "%") == "+0.174 个百分点"
    assert _reading(11.73, "%") == "11.730%"
    assert _change(2807184.244, "百万美元") == "+2,807,184 百万美元"
    assert _change(-0.108, "长度单位") == "-0.108"
    # Betweenness counts paths: whole numbers, as on the page.
    assert _change(-267.931, "未归一化介数") == "-268"
    assert _reading(0, "%") == "0%"
