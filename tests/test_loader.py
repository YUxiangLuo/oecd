"""OECD 原始表加载边界测试。"""

import pandas as pd
import pytest
import io
import zipfile

from gvcsim.data import loader
from gvcsim.data.raw_icio import DimensionContract, RawICIOValidationError


@pytest.fixture
def download_source(tmp_path, monkeypatch):
    """Use the real pymrio downloader/renamer with an in-memory OECD archive."""
    contract = DimensionContract("download-test", 1, ("AAA",), ("s1",), ("HFCE",))
    csv = "V1,AAA_s1,AAA_HFCE,OUT\nAAA_s1,1,2,3\nTLS,0,0,0\nVA,2,0,2\nOUT,3,2,5\n"
    monkeypatch.setattr(loader, "RAW_DATA_DIR", tmp_path)
    monkeypatch.setattr(loader, "dimension_contract_for", lambda _: contract)
    calls = []
    content = {f"{year}_SML.csv": csv for year in range(2011, 2021)}

    def fake_download(url, **_kwargs):
        calls.append(url)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for name, value in content.items():
                archive.writestr(name, value)

        class Response:
            def iter_content(self, _size):
                yield buffer.getvalue()

        return Response()

    monkeypatch.setitem(loader.pymrio.download_oecd.__globals__, "ssl_fix", fake_download)
    return csv, calls, content


def test_download_deduplicates_bundles_and_preserves_existing_files(tmp_path, download_source):
    csv, calls, _ = download_source
    existing = tmp_path / "ICIO2023_2020.csv"
    existing.write_text(csv)
    original_inode = existing.stat().st_ino
    (tmp_path / "notes.txt").write_text("keep this")
    loader.download([2016, 2017, 2016, 2015, 2020])
    assert len(calls) == 2
    assert len(set(calls)) == 2
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "ICIO2023_2015.csv",
        "ICIO2023_2016.csv",
        "ICIO2023_2017.csv",
        "ICIO2023_2020.csv",
        "notes.txt",
    ]
    assert existing.stat().st_ino == original_inode
    assert (tmp_path / "notes.txt").read_text() == "keep this"
    loader.download([2015, 2016, 2017, 2020])
    assert len(calls) == 2


def test_download_rejects_bad_requested_file_before_installing_any(tmp_path, download_source):
    _, _, content = download_source
    content["2017_SML.csv"] = "bad CSV"
    with pytest.raises(RawICIOValidationError):
        loader.download([2016, 2017])
    assert list(tmp_path.iterdir()) == []


def test_download_rejects_ambiguous_existing_source_without_network(tmp_path, download_source):
    csv, calls, _ = download_source
    for name in ("ICIO2023_2016.csv", "ICIO_ALT_2016.csv"):
        (tmp_path / name).write_text(csv)
    with pytest.raises(FileNotFoundError, match="实际找到 2 个"):
        loader.download([2016, 2017])
    assert calls == []


def test_download_empty_and_out_of_range_are_not_all_year_requests(tmp_path, download_source):
    _, calls, _ = download_source
    loader.download([])
    with pytest.raises(ValueError, match="1995–2020"):
        loader.download([2021])
    assert calls == []


def test_read_reported_output_preserves_source_values_and_reorders_to_matrix(tmp_path):
    path = tmp_path / "ICIO2023_2020.csv"
    path.write_text(
        "V1,AAA_s1,BBB_s1,AAA_HFCE,OUT\n"
        "AAA_s1,1,2,3,6\n"
        "BBB_s1,4,5,6,15\n"
        "TLS,0.1,0.2,0,0\n"
        "VA,8.9,9.8,0,0\n"
        "OUT,10,20,9,30\n",
        encoding="utf-8",
    )
    index = pd.MultiIndex.from_tuples(
        [("BBB", "s1"), ("AAA", "s1")],
        names=["region", "sector"],
    )

    output = loader._read_reported_output(path, index)

    assert output.index.equals(index)
    assert output.tolist() == [20.0, 10.0]


def test_read_reported_output_rejects_missing_node_column(tmp_path):
    path = tmp_path / "ICIO2023_2020.csv"
    path.write_text("V1,AAA_s1,OUT\nOUT,10,10\n", encoding="utf-8")
    index = pd.MultiIndex.from_tuples(
        [("AAA", "s1"), ("BBB", "s1")],
        names=["region", "sector"],
    )

    with pytest.raises(ValueError, match="缺少 1 个"):
        loader._read_reported_output(path, index)


def test_year_source_rejects_ambiguous_year(tmp_path, monkeypatch):
    (tmp_path / "ICIO2023_2020.csv").touch()
    (tmp_path / "ICIO_ALT_2020.csv").touch()
    monkeypatch.setattr(loader, "RAW_DATA_DIR", tmp_path)

    with pytest.raises(FileNotFoundError, match="实际找到 2 个"):
        loader.resolve_year_source(2020, loader.RAW_DATA_DIR)
