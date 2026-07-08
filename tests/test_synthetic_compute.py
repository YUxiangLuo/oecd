"""轻量 synthetic compute 验收。

CI 中通常没有 66MB×多年 OECD ICIO 原始表,真实数据 API 测试会自动跳过。
这个测试用 conftest 的 2 国×2 行业小 IOSystem 跑完整 compute_year→build_panel
链路,确保预计算产物 schema、控制变量质检与面板拼接不会只在有真实数据时才被覆盖。
"""

import json

import pandas as pd

from gvcsim import pipeline, shocks
from gvcsim.data import controls
from gvcsim import config


def test_synthetic_compute_writes_panel_and_qc(tmp_path, fake_io, monkeypatch):
    processed = tmp_path / "processed"
    shock_dir = tmp_path / "shocks"
    for module in (config, pipeline, controls, shocks):
        if hasattr(module, "PROCESSED_DIR"):
            monkeypatch.setattr(module, "PROCESSED_DIR", processed)
    monkeypatch.setattr(shocks, "SHOCKS_DIR", shock_dir)
    monkeypatch.setattr(pipeline.loader, "load", lambda year: fake_io)

    for year in [2018, 2019]:
        pipeline.compute_year(year, verbose=False)
    panel = pipeline.build_panel()

    expected_files = [
        "indicators_country_2018.csv",
        "indicators_industry_2018.csv",
        "network_edges_2018.csv",
        "export_exposure_2018.csv",
        "controls_country.csv",
        "qc_controls.json",
        "qc_shocks.json",
        "panel_industry.csv",
        "panel_country.csv",
    ]
    for name in expected_files:
        assert (processed / name).exists(), name

    controls_df = pd.read_csv(processed / "controls_country.csv")
    assert {"country", "year", "macro_log_gdp_usd", "gdp_deflator"}.issubset(controls_df.columns)
    assert len(controls_df) == 4  # 2 countries × 2 years

    controls_qc = json.loads((processed / "qc_controls.json").read_text(encoding="utf-8"))
    assert len(controls_qc) == 5
    assert all(c["passed"] for c in controls_qc), controls_qc

    assert len(panel) == 8  # 2 countries × 2 sectors × 2 years
    assert {"entity_id", "tariff_shock", "treated", "macro_log_gdp_usd"}.issubset(panel.columns)
    # 客户口径字段与回归派生列都应进入面板
    assert {"DVAex", "taxsub", "SVA", "PLv_GVC", "betweenesscentrality"}.issubset(panel.columns)
    assert {"gross_exports", "FVA_share", "3b_VA_GVC_C_share", "3_VA_GVC_share"}.issubset(panel.columns)
