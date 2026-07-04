from pathlib import Path

import pytest

from gvcsim.data import icio_browser


def _write_fixture(raw_dir: Path) -> None:
    (raw_dir / "ICIO2023_2020.csv").write_text(
        "\n".join([
            "V1,AAA_s1,AAA_s2,BBB_s1,AAA_HFCE,AAA_GFCF,BBB_HFCE,BBB_GFCF,OUT",
            "AAA_s1,1,2,3,10,11,12,13,39",
            "AAA_s2,4,5,6,14,15,16,17,77",
            "BBB_s1,7,8,9,18,19,20,21,111",
            "TLS,0.1,0.2,0.3,0,0,0,0,0",
            "VA,30,40,50,0,0,0,0,120",
            "OUT,40,50,60,0,0,0,0,150",
        ]),
        encoding="utf-8",
    )


def _write_substring_sector_fixture(raw_dir: Path) -> None:
    (raw_dir / "ICIO2023_2020.csv").write_text(
        "\n".join([
            "V1,AAA_T,AAA_C10T12,BBB_T,BBB_C10T12,AAA_HFCE,BBB_HFCE,OUT",
            "AAA_T,1,2,3,4,10,11,31",
            "AAA_C10T12,5,6,7,8,12,13,51",
            "BBB_T,9,10,11,12,14,15,71",
            "BBB_C10T12,13,14,15,16,16,17,91",
            "TLS,0.1,0.2,0.3,0.4,0,0,0",
            "VA,30,40,50,60,0,0,180",
            "OUT,40,50,60,70,0,0,220",
        ]),
        encoding="utf-8",
    )


def test_meta_reads_raw_icio_shape(tmp_path: Path):
    _write_fixture(tmp_path)

    meta = icio_browser.meta(tmp_path)

    assert meta["years"] == [2020]
    assert meta["default_year"] == 2020
    assert meta["countries"] == ["AAA", "BBB"]
    assert meta["sectors"] == ["s1", "s2"]
    assert meta["final_demand_categories"] == ["HFCE", "GFCF"]
    assert meta["account_rows"] == ["TLS", "VA", "OUT"]
    assert meta["n_rows"] == 6
    assert meta["n_columns"] == 9


def test_z_slice_filters_row_and_column_industries(tmp_path: Path):
    _write_fixture(tmp_path)

    page = icio_browser.slice_table(
        2020,
        "z",
        row_country="AAA",
        col_country="BBB",
        page_size=10,
        raw_dir=tmp_path,
    )

    assert page["total"] == 2
    assert page["columns"] == ["row", "BBB_s1"]
    assert page["rows"] == [
        {"row": "AAA_s1", "BBB_s1": 3},
        {"row": "AAA_s2", "BBB_s1": 6},
    ]


def test_y_slice_filters_final_demand_destination(tmp_path: Path):
    _write_fixture(tmp_path)

    page = icio_browser.slice_table(
        2020,
        "y",
        row_country="AAA",
        col_country="BBB",
        page_size=10,
        raw_dir=tmp_path,
    )

    assert page["total"] == 2
    assert page["columns"] == ["row", "BBB_HFCE", "BBB_GFCF"]
    assert page["rows"][0] == {"row": "AAA_s1", "BBB_HFCE": 12, "BBB_GFCF": 13}


def test_y_slice_can_select_one_final_demand_category(tmp_path: Path):
    _write_fixture(tmp_path)

    page = icio_browser.slice_table(
        2020,
        "y",
        row_country="AAA",
        col_country="BBB",
        col_sector="GFCF",
        page_size=10,
        raw_dir=tmp_path,
    )

    assert page["columns"] == ["row", "BBB_GFCF"]
    assert page["rows"][1] == {"row": "AAA_s2", "BBB_GFCF": 17}


def test_accounts_slice_transposes_account_rows(tmp_path: Path):
    _write_fixture(tmp_path)

    page = icio_browser.slice_table(
        2020,
        "accounts",
        row_country="AAA",
        page_size=10,
        raw_dir=tmp_path,
    )

    assert page["total"] == 2
    assert page["columns"] == ["row", "TLS", "VA", "OUT"]
    assert page["rows"] == [
        {"row": "AAA_s1", "TLS": 0.1, "VA": 30, "OUT": 40},
        {"row": "AAA_s2", "TLS": 0.2, "VA": 40, "OUT": 50},
    ]


def test_sector_filter_matches_exact_code_not_substring(tmp_path: Path):
    _write_substring_sector_fixture(tmp_path)

    z = icio_browser.slice_table(
        2020,
        "z",
        row_country="AAA",
        col_country="BBB",
        row_sector="T",
        col_sector="T",
        page_size=10,
        raw_dir=tmp_path,
    )
    assert z["total"] == 1
    assert z["columns"] == ["row", "BBB_T"]
    assert z["rows"] == [{"row": "AAA_T", "BBB_T": 3}]

    accounts = icio_browser.slice_table(
        2020,
        "accounts",
        row_country="AAA",
        row_sector="T",
        page_size=10,
        raw_dir=tmp_path,
    )
    assert accounts["total"] == 1
    assert accounts["rows"] == [{"row": "AAA_T", "TLS": 0.1, "VA": 30, "OUT": 40}]


def test_slice_validates_table_and_page_size(tmp_path: Path):
    _write_fixture(tmp_path)

    with pytest.raises(ValueError, match="table"):
        icio_browser.slice_table(2020, "bad", raw_dir=tmp_path)
    with pytest.raises(ValueError, match="page_size"):
        icio_browser.slice_table(2020, "z", page_size=201, raw_dir=tmp_path)
