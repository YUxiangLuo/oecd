"""基准对账(gvcsim benchmark)的合并与统计逻辑测试。"""

import numpy as np
import pandas as pd
import pytest

from gvcsim import benchmark


def test_stats_computes_correlation_and_relative_diff():
    n = 40
    rng = np.random.default_rng(7)
    a = rng.uniform(1, 100, n)
    merged = pd.DataFrame(
        {
            "country": ["AAA"] * n,
            "industry": [f"s{i}" for i in range(n)],
            "year": [2018] * n,
            "X_client": a,
            "X_ours": a * 1.10,  # 系统性高 10%:相关=1,中位相对差 ≈ 0.1/1.05
        }
    )
    stat = benchmark._stats(merged, "X")
    assert stat is not None
    assert stat.n == n
    assert stat.pearson == pytest.approx(1.0)
    assert stat.spearman == pytest.approx(1.0)
    assert stat.median_rel_diff == pytest.approx(0.10 / 1.05, rel=1e-6)
    assert "AAA-s" in stat.top_dev
    assert len(stat.top_dev.split(";")) == 10


def test_stats_ignores_nan_and_requires_min_sample():
    merged = pd.DataFrame(
        {
            "country": ["AAA"] * 5,
            "industry": [f"s{i}" for i in range(5)],
            "year": [2018] * 5,
            "X_client": [1.0, 2.0, np.nan, 4.0, 5.0],
            "X_ours": [1.0, 2.0, 3.0, np.nan, 5.0],
        }
    )
    assert benchmark._stats(merged, "X") is None  # 有效样本 < 10


def test_load_client_fixes_duplicate_backward_column(tmp_path, monkeypatch):
    """客户生产分解 xlsx 的最后一列误标为 3b_VA_GVC_C,应按位置纠正为 3b_FGY_GVC_C。"""
    csv = tmp_path / "t" / "样例.csv"
    csv.parent.mkdir()
    csv.write_text(
        "year,country,industry ,3b_VA_GVC_C,FGY,3b_VA_GVC_C\n2018,AAA,s1,1.0,2.0,3.0\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(benchmark, "CLIENT_DOCS_DIR", tmp_path)
    df = benchmark._load_client("t/样例.csv")
    assert list(df.columns) == ["year", "country", "industry", "3b_VA_GVC_C", "FGY", "3b_FGY_GVC_C"]
    assert df.loc[0, "3b_FGY_GVC_C"] == 3.0


@pytest.mark.skipif(not benchmark.CLIENT_DOCS_DIR.exists(), reason="缺少 client-docs 客户资料")
def test_client_files_resolvable():
    for spec in benchmark.TOPICS.values():
        path = benchmark._find_client_file(spec["file"])
        assert path.exists()
