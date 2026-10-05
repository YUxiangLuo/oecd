import pandas as pd
import pytest
from fastapi import HTTPException

from gvcsim import config, data_routes
from gvcsim.report_reference import industry_reference


def _industry_csv(path, year=2020):
    rows = [
        ("CHN", "C26", 50.0),
        ("USA", "C26", 40.0),
        ("DEU", "C26", 30.0),
        ("JPN", "C26", 10.0),
        ("ROW", "C26", 999.0),
        ("CHN", "C27", 1.0),
        ("USA", "C27", 3.0),
        ("DEU", "C27", 2.0),
        ("JPN", "C27", None),
        # An industry with no flows anywhere: every economy ties at 0.
        ("CHN", "T", 0.0),
        ("USA", "T", 0.0),
        ("DEU", "T", 0.0),
    ]
    pd.DataFrame(rows, columns=["country", "industry", "weighted degree"]).to_csv(
        path / f"indicators_industry_{year}.csv", index=False
    )


def test_industry_reference_compares_the_same_industry_across_economies(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    _industry_csv(tmp_path)
    rows = {row["industry"]: row for row in industry_reference("weighted degree", 2020, countries=("CHN", "USA"))}
    # ROW excluded; a missing reading is left out rather than counted as zero.
    assert rows["C26"]["n"] == 4 and rows["C27"]["n"] == 3
    assert rows["C26"]["median"] == pytest.approx(35.0)
    assert rows["C26"]["ranks"] == {"CHN": 1, "USA": 2}
    assert rows["C27"]["ranks"] == {"CHN": 3, "USA": 1}
    assert rows["C26"]["ties"] == {"CHN": 1, "USA": 1}
    assert (
        rows["T"]["ranks"] == {"CHN": 1, "USA": 1} and rows["T"]["ties"] == {"CHN": 3, "USA": 3} and rows["T"]["n"] == 3
    )
    (only,) = industry_reference("weighted degree", 2020, industry="C27")
    assert only["industry"] == "C27" and only["ranks"] == {}
    # An industry or metric with no readings, or a missing year, gives no reference instead of failing.
    assert industry_reference("weighted degree", 2020, industry="A01_02") == []
    assert industry_reference("no_such_metric", 2020) == []
    assert industry_reference("country", 2020) == [] and industry_reference("industry", 2020) == []
    assert industry_reference("weighted degree", 2019) == []


def test_industry_distribution_endpoint_validates_years_and_countries(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path)
    monkeypatch.setattr(data_routes, "processed_years", lambda: [2020])
    _industry_csv(tmp_path)
    response = data_routes.indicators_industry_distribution(
        metric="weighted degree", years="2020", industry="C26", countries="CHN,USA"
    )
    assert response["metric"] == "weighted degree"
    assert response["rows"] == [
        {
            "year": 2020,
            "industry": "C26",
            "n": 4,
            "p25": pytest.approx(25.0),
            "median": pytest.approx(35.0),
            "p75": pytest.approx(42.5),
            "ranks": {"CHN": 1, "USA": 2},
            "ties": {"CHN": 1, "USA": 1},
        }
    ]
    for kwargs, detail in (
        ({"years": "2019"}, "年份不在当前数据范围内"),
        ({"countries": "CHN,USA,DEU"}, "最多查询两个国家的排名"),
        ({"industry": "A01_02"}, "当前数据没有该指标的行业分布"),
        ({"years": "abc"}, "年份格式无效"),
    ):
        with pytest.raises(HTTPException) as error:
            data_routes.indicators_industry_distribution(
                metric="weighted degree", **{"years": "2020", "industry": None, "countries": "", **kwargs}
            )
        assert error.value.status_code == 422 and error.value.detail == detail
