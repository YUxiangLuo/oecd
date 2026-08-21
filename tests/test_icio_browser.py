import os
from pathlib import Path

import pytest

from gvcsim.data import icio_browser
from gvcsim.data.raw_icio import DimensionContract, RawICIOValidationError, clear_raw_validation_cache


FIXTURE_CONTRACT = DimensionContract(
    "test-icio", 1, ("AAA", "BBB"), ("s1", "s2"), ("HFCE", "GFCF")
)
SUBSTRING_CONTRACT = DimensionContract(
    "test-substring-icio", 1, ("AAA", "BBB"), ("T", "C10T12"), ("HFCE",)
)


def _write_fixture(raw_dir: Path) -> None:
    (raw_dir / "ICIO2023_2020.csv").write_text(
        "\n".join(
            [
                "V1,AAA_s1,AAA_s2,BBB_s1,BBB_s2,AAA_HFCE,AAA_GFCF,BBB_HFCE,BBB_GFCF,OUT",
                "AAA_s1,1,2,3,4,10,11,12,13,43",
                "AAA_s2,4,5,6,7,14,15,16,17,84",
                "BBB_s1,7,8,9,10,18,19,20,21,112",
                "BBB_s2,2,3,4,5,6,7,8,9,44",
                "TLS,0.1,0.2,0.3,0.4,0,0,0,0,0",
                "VA,30,40,50,60,0,0,0,0,180",
                "OUT,40,50,60,70,0,0,0,0,220",
            ]
        ),
        encoding="utf-8",
    )


def _atomic_replace_same_size(path: Path, content: str) -> None:
    original = path.stat()
    replacement = path.with_name("replacement.csv")
    replacement.write_text(content, encoding="utf-8")
    assert replacement.stat().st_size == original.st_size
    os.replace(replacement, path)
    os.utime(path, ns=(original.st_atime_ns, original.st_mtime_ns))
    assert path.stat().st_ino != original.st_ino
    assert path.stat().st_mtime_ns == original.st_mtime_ns


def _write_substring_sector_fixture(raw_dir: Path) -> None:
    (raw_dir / "ICIO2023_2020.csv").write_text(
        "\n".join(
            [
                "V1,AAA_T,AAA_C10T12,BBB_T,BBB_C10T12,AAA_HFCE,BBB_HFCE,OUT",
                "AAA_T,1,2,3,4,10,11,31",
                "AAA_C10T12,5,6,7,8,12,13,51",
                "BBB_T,9,10,11,12,14,15,71",
                "BBB_C10T12,13,14,15,16,16,17,91",
                "TLS,0.1,0.2,0.3,0.4,0,0,0",
                "VA,30,40,50,60,0,0,180",
                "OUT,40,50,60,70,0,0,220",
            ]
        ),
        encoding="utf-8",
    )


def test_raw_file_validator_uses_unique_year_resolver(tmp_path: Path):
    _write_fixture(tmp_path)
    (tmp_path / "ICIO2022_2020.csv").write_text("duplicate", encoding="utf-8")

    with pytest.raises(FileNotFoundError, match="实际找到 2 个"):
        icio_browser.validate_raw_files([2020], tmp_path, FIXTURE_CONTRACT)


def test_raw_file_validator_rejects_non_regular_and_unreadable_files(tmp_path: Path):
    directory = tmp_path / "ICIO2023_2019.csv"
    directory.mkdir()
    with pytest.raises(OSError, match="普通文件"):
        icio_browser.validate_raw_files([2019], tmp_path)

    unreadable = tmp_path / "ICIO2023_2020.csv"
    unreadable.write_text("x", encoding="utf-8")
    unreadable.chmod(0)
    try:
        with pytest.raises(PermissionError):
            icio_browser.validate_raw_files([2020], tmp_path, FIXTURE_CONTRACT)
    finally:
        unreadable.chmod(0o600)


def test_meta_reads_raw_icio_shape(tmp_path: Path):
    _write_fixture(tmp_path)

    meta = icio_browser.meta(tmp_path, FIXTURE_CONTRACT)

    assert meta["years"] == [2020]
    assert meta["default_year"] == 2020
    assert meta["countries"] == ["AAA", "BBB"]
    assert meta["sectors"] == ["s1", "s2"]
    assert meta["final_demand_categories"] == ["HFCE", "GFCF"]
    assert meta["account_rows"] == ["TLS", "VA", "OUT"]
    assert meta["n_rows"] == 7
    assert meta["n_columns"] == 10


def test_metadata_cache_invalidates_atomic_malformed_same_size_replacement(tmp_path: Path):
    _write_fixture(tmp_path)
    path = tmp_path / "ICIO2023_2020.csv"
    icio_browser.clear_raw_browser_caches()
    clear_raw_validation_cache()
    initial = icio_browser._meta_for_path(path)
    assert "AAA_s1" in initial["row_labels"]

    malformed = path.read_text(encoding="utf-8").replace("AAA_s1,1,2,3", "AAA_x1,1,2,3", 1)
    _atomic_replace_same_size(path, malformed)

    refreshed = icio_browser._meta_for_path(path)
    assert "AAA_x1" in refreshed["row_labels"]
    assert "AAA_s1" not in refreshed["row_labels"]
    with pytest.raises(RawICIOValidationError, match="row code-set"):
        icio_browser.meta(tmp_path, FIXTURE_CONTRACT)


def test_slice_column_cache_invalidates_atomic_malformed_same_size_replacement(tmp_path: Path):
    _write_fixture(tmp_path)
    path = tmp_path / "ICIO2023_2020.csv"
    icio_browser.clear_raw_browser_caches()
    clear_raw_validation_cache()
    initial = icio_browser._read_columns(path, ("V1", "BBB_s1"))
    assert initial.loc[0, "BBB_s1"] == 3

    malformed = path.read_text(encoding="utf-8").replace("AAA_s1,1,2,3", "AAA_s1,1,2,x", 1)
    _atomic_replace_same_size(path, malformed)

    refreshed = icio_browser._read_columns(path, ("V1", "BBB_s1"))
    assert refreshed.loc[0, "BBB_s1"] == "x"
    with pytest.raises(RawICIOValidationError, match="bad numeric"):
        icio_browser.slice_table(
            2020,
            "z",
            raw_dir=tmp_path,
            contract=FIXTURE_CONTRACT,
        )


def test_z_slice_filters_row_and_column_industries(tmp_path: Path):
    _write_fixture(tmp_path)

    page = icio_browser.slice_table(
        2020,
        "z",
        row_country="AAA",
        col_country="BBB",
        page_size=10,
        raw_dir=tmp_path,
        contract=FIXTURE_CONTRACT,
    )

    assert page["total"] == 2
    assert page["columns"] == ["row", "BBB_s1", "BBB_s2"]
    assert page["rows"] == [
        {"row": "AAA_s1", "BBB_s1": 3, "BBB_s2": 4},
        {"row": "AAA_s2", "BBB_s1": 6, "BBB_s2": 7},
    ]
    assert page["row_summaries"] == [
        {"row": "AAA_s1", "slice_total": 7.0, "out": 43.0},
        {"row": "AAA_s2", "slice_total": 13.0, "out": 84.0},
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
        contract=FIXTURE_CONTRACT,
    )

    assert page["total"] == 2
    assert page["columns"] == ["row", "BBB_HFCE", "BBB_GFCF"]
    assert page["rows"][0] == {"row": "AAA_s1", "BBB_HFCE": 12, "BBB_GFCF": 13}
    assert page["row_summaries"][0] == {"row": "AAA_s1", "slice_total": 25.0, "out": 43.0}


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
        contract=FIXTURE_CONTRACT,
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
        contract=FIXTURE_CONTRACT,
    )

    assert page["total"] == 2
    assert page["columns"] == ["row", "TLS", "VA", "OUT"]
    assert page["rows"] == [
        {"row": "AAA_s1", "TLS": 0.1, "VA": 30, "OUT": 40},
        {"row": "AAA_s2", "TLS": 0.2, "VA": 40, "OUT": 50},
    ]
    assert page["row_summaries"] == []


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
        contract=SUBSTRING_CONTRACT,
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
        contract=SUBSTRING_CONTRACT,
    )
    assert accounts["total"] == 1
    assert accounts["rows"] == [{"row": "AAA_T", "TLS": 0.1, "VA": 30, "OUT": 40}]


def test_slice_validates_table_and_page_size(tmp_path: Path):
    _write_fixture(tmp_path)

    with pytest.raises(ValueError, match="table"):
        icio_browser.slice_table(2020, "bad", raw_dir=tmp_path, contract=FIXTURE_CONTRACT)
    with pytest.raises(ValueError, match="page_size"):
        icio_browser.slice_table(2020, "z", page_size=201, raw_dir=tmp_path, contract=FIXTURE_CONTRACT)
