import csv
import os
from pathlib import Path

import pytest

from gvcsim.data.raw_icio import (
    DimensionContract,
    RawICIOValidationError,
    clear_raw_validation_cache,
    raw_bilateral_exports,
    raw_dimensions_metadata,
    raw_file_identity,
    resolve_year_source,
    validate_raw_dimensions_metadata,
    validate_raw_file,
    validate_raw_source_bindings,
    validate_raw_years,
    production_dimension_contract,
)


SMALL = DimensionContract("fixture", 1, ("AAA", "BBB"), ("s1",), ("HFCE", "INVNT"))


def _rows(contract: DimensionContract = SMALL) -> tuple[list[str], list[list[str]]]:
    industries = list(contract.industry_labels)
    demand = list(contract.final_demand_labels)
    header = ["V1", *industries, *demand, "OUT"]
    width = len(header)
    rows = [[label, *(["1"] * (width - 1))] for label in industries]
    rows.extend([[account, *(["0.1"] * (width - 1))] for account in ("TLS", "VA", "OUT")])
    return header, rows


def _write(path: Path, *, mutate=None, contract: DimensionContract = SMALL) -> None:
    header, rows = _rows(contract)
    if mutate:
        mutate(header, rows)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


def test_source_controlled_production_contract_has_exact_icio2023_dimensions():
    contract = production_dimension_contract()
    assert contract.contract_id == "oecd-icio-2023-dimensions"
    assert contract.version == 1
    assert len(contract.countries) == 77
    assert len(contract.industries) == 45
    assert contract.final_demand_categories == ("HFCE", "NPISH", "GGFC", "GFCF", "INVNT", "DPABR")


def test_unique_year_source_rejects_missing_and_duplicate(tmp_path: Path):
    with pytest.raises(FileNotFoundError, match="实际找到 0 个"):
        resolve_year_source(2020, tmp_path)
    _write(tmp_path / "ICIO2023_2020.csv")
    _write(tmp_path / "ICIO_ALT_2020.csv")
    with pytest.raises(FileNotFoundError, match="实际找到 2 个"):
        resolve_year_source(2020, tmp_path)


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda header, _rows: header.__setitem__(2, header[1]), "duplicate header"),
        (lambda _header, rows: rows[1].pop(), "row width"),
        (lambda _header, rows: rows.__setitem__(1, list(rows[0])), "duplicate row"),
        (lambda _header, rows: rows[0].__setitem__(1, ""), "blank numeric"),
        (lambda _header, rows: rows[0].__setitem__(1, "bad"), "bad numeric"),
        (lambda _header, rows: rows[0].__setitem__(1, "NaN"), "non-finite"),
        (lambda _header, rows: rows[0].__setitem__(1, "Inf"), "non-finite"),
        (lambda _header, rows: rows.pop(-3), "account mismatch"),
    ],
)
def test_strict_raw_validator_rejects_malformed_tokens_and_structure(tmp_path: Path, mutation, message):
    path = tmp_path / "ICIO2023_2020.csv"
    _write(path, mutate=mutation)
    with pytest.raises(RawICIOValidationError, match=message):
        validate_raw_file(path, SMALL)


def test_strict_raw_validator_invalidates_atomic_same_size_replacement_with_restored_mtime(tmp_path: Path):
    path = tmp_path / "ICIO2023_2020.csv"
    _write(path)
    clear_raw_validation_cache()
    validate_raw_file(path, SMALL)
    original = path.stat()
    original_identity = raw_file_identity(path)

    replacement = tmp_path / "replacement.csv"
    _write(replacement, mutate=lambda _header, rows: rows[0].__setitem__(1, "x"))
    assert replacement.stat().st_size == original.st_size
    os.replace(replacement, path)
    os.utime(path, ns=(original.st_atime_ns, original.st_mtime_ns))

    replaced = path.stat()
    assert replaced.st_ino != original.st_ino
    assert raw_file_identity(path) != original_identity
    with pytest.raises(RawICIOValidationError, match="bad numeric"):
        validate_raw_file(path, SMALL)


def test_raw_file_identity_changes_even_when_all_stat_fields_collide(
    tmp_path: Path, freeze_file_metadata, file_identity_backend
):
    path = tmp_path / "ICIO2023_2020.csv"
    _write(path)
    original = freeze_file_metadata(path)
    original_identity = raw_file_identity(path)
    assert original_identity[:7] == (
        str(path.resolve()),
        original.st_dev,
        original.st_ino,
        original.st_mode,
        original.st_size,
        original.st_mtime_ns,
        original.st_ctime_ns,
    )
    payload = path.read_bytes().replace(b",1,", b",x,", 1)
    assert len(payload) == original.st_size

    path.write_bytes(payload)
    os.utime(path, ns=(original.st_atime_ns, original.st_mtime_ns))

    changed = path.stat()
    assert changed.st_ino == original.st_ino
    assert changed.st_size == original.st_size
    assert changed.st_mtime_ns == original.st_mtime_ns
    assert changed.st_ctime_ns == original.st_ctime_ns
    assert raw_file_identity(path) != original_identity


@pytest.mark.parametrize("check", ["strict", "binding", "browser"])
def test_raw_caches_do_not_trust_colliding_stat_fields(
    tmp_path: Path, freeze_file_metadata, file_identity_backend, check
):
    from gvcsim.data import icio_browser

    path = tmp_path / "ICIO2023_2020.csv"
    _write(path)
    freeze_file_metadata(path)
    clear_raw_validation_cache()
    published = raw_dimensions_metadata([2020], tmp_path, SMALL)
    old = icio_browser._read_columns(path, ("AAA_s1",))
    original = path.read_bytes()
    changed = original.replace(b",1,", b",x," if check == "strict" else b",2,", 1)
    assert changed != original and len(changed) == len(original)
    path.write_bytes(changed)

    if check == "strict":
        with pytest.raises(RawICIOValidationError, match="bad numeric"):
            validate_raw_file(path, SMALL)
    elif check == "binding":
        with pytest.raises(RawICIOValidationError, match="source binding mismatch"):
            validate_raw_source_bindings(published, [2020], tmp_path)
    else:
        assert icio_browser._read_columns(path, ("AAA_s1",)).iloc[0, 0] == 2
        assert old.iloc[0, 0] == 1


def test_strict_raw_validator_rejects_contract_dimension_code_drift(tmp_path: Path):
    path = tmp_path / "ICIO2023_2020.csv"
    _write(path)
    drifted = DimensionContract("drift", 1, ("AAA", "CCC"), ("s1",), ("HFCE", "INVNT"))
    with pytest.raises(RawICIOValidationError, match="code-set mismatch"):
        validate_raw_file(path, drifted)


def test_independent_raw_bilateral_recomputation_uses_base_and_composite_destinations(tmp_path: Path):
    _write(tmp_path / "ICIO2023_2020.csv")

    rows = raw_bilateral_exports(
        2020,
        tmp_path,
        SMALL,
        {"GROUP": {"BBB"}},
    )
    by_key = {(row["country"], row["sector"], row["imposer"]): row for row in rows}

    assert set(by_key) == {
        (country, sector, destination)
        for country in SMALL.countries
        for sector in SMALL.industries
        for destination in (*SMALL.countries, "GROUP")
    }
    assert by_key["AAA", "s1", "AAA"]["bilateral_exports"] == 0.0
    assert by_key["AAA", "s1", "BBB"]["bilateral_exports"] == 3.0
    assert by_key["AAA", "s1", "BBB"]["total_exports"] == 3.0
    assert by_key["AAA", "s1", "BBB"]["export_exposure"] == 1.0
    assert by_key["AAA", "s1", "GROUP"]["bilateral_exports"] == 3.0
    assert by_key["BBB", "s1", "GROUP"]["bilateral_exports"] == 0.0


def test_cross_year_layout_drift_and_metadata_tampering_fail(tmp_path: Path):
    first = tmp_path / "ICIO2023_2019.csv"
    second = tmp_path / "ICIO2023_2020.csv"
    _write(first)
    _write(second, mutate=lambda header, _rows: header.__setitem__(slice(1, 3), reversed(header[1:3])))
    with pytest.raises(RawICIOValidationError, match="cross-year"):
        validate_raw_years([2019, 2020], tmp_path, SMALL)

    _write(second)
    metadata = raw_dimensions_metadata([2019, 2020], tmp_path, SMALL)
    assert metadata["countries"] == 2
    assert metadata["industries"] == 1
    assert metadata["final_demand_categories"] == 2
    assert set(metadata["years"]) == {"2019", "2020"}
    assert metadata["metadata_version"] == 2
    assert metadata["years"]["2020"] == {
        "source_file": "ICIO2023_2020.csv",
        "source_bytes": second.stat().st_size,
        "source_sha256": metadata["years"]["2020"]["source_sha256"],
    }
    assert len(metadata["years"]["2020"]["source_sha256"]) == 64
    metadata["country_codes_sha256"] = "0" * 64
    with pytest.raises(RawICIOValidationError, match="does not match"):
        validate_raw_dimensions_metadata(metadata, [2019, 2020], tmp_path, SMALL)


def test_raw_source_binding_rejects_same_layout_different_values(tmp_path: Path):
    path = tmp_path / "ICIO2023_2020.csv"
    _write(path)
    metadata = raw_dimensions_metadata([2020], tmp_path, SMALL)
    original = path.read_bytes()
    changed = original.replace(b",1,", b",2,", 1)
    assert len(changed) == len(original)
    path.write_bytes(changed)
    clear_raw_validation_cache()

    with pytest.raises(RawICIOValidationError, match="source binding mismatch"):
        validate_raw_source_bindings(metadata, [2020], tmp_path)
