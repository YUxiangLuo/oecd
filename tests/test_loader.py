"""OECD 原始表加载边界测试。"""

import pandas as pd
import pytest

from gvcsim.data import loader


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
