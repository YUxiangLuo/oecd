from types import SimpleNamespace

import numpy as np
import pandas as pd

from gvcsim.regression import panel, transforms
from gvcsim.regression.design import (
    METHOD_TWFE_INTENSITY,
    PRICE_MODE_REAL,
    SCENARIO_CONFOUNDED,
    SCENARIO_NOISY,
)


def test_panel_keeps_transform_compatibility_reexports():
    for name in (
        "_apply_sample_filter",
        "_stable_noise",
        "_attach_baseline_gvc",
        "_real_amount",
        "_real_log_from_log",
        "_country_year_real_growth",
        "_apply_price_mode",
        "_apply_teaching_scenario",
    ):
        assert getattr(panel, name) is getattr(transforms, name)
    assert panel.BASE_GVC_COL == transforms.BASE_GVC_COL
    assert panel.BASELINE_GVC_COL == transforms.BASELINE_GVC_COL
    assert panel.METHOD_TWFE_INTENSITY is METHOD_TWFE_INTENSITY
    assert panel.SCENARIO_CONFOUNDED is SCENARIO_CONFOUNDED
    assert panel.SCENARIO_NOISY is SCENARIO_NOISY


def test_sample_filter_removes_only_row_aggregate():
    frame = pd.DataFrame({"country": ["CHN", "ROW", "USA"], "value": [1, 2, 3]})
    filtered, notes = transforms._apply_sample_filter(frame, SimpleNamespace(exclude_row=True))

    assert filtered["country"].tolist() == ["CHN", "USA"]
    assert notes == ["样本过滤:已排除 ROW(世界其他地区聚合账户) 1 行"]


def test_real_price_transform_and_noisy_scenario_are_deterministic():
    frame = pd.DataFrame(
        {
            "country": ["CHN", "CHN", "USA", "USA"],
            "entity": ["CHN", "CHN", "USA", "USA"],
            "year": [2019, 2020, 2019, 2020],
            "outcome": [1.0, 1.2, 0.8, 0.9],
            "shock": [0.01, 0.02, 0.0, 0.01],
            "treated": [1, 1, 0, 0],
            "gdp_deflator": [1.0, 2.0, 1.0, 2.0],
            "log_gdp_proxy": np.log1p([100.0, 200.0, 80.0, 160.0]),
        }
    )
    price_design = SimpleNamespace(price_mode=PRICE_MODE_REAL)
    real = transforms._apply_price_mode(frame, price_design)
    assert np.allclose(real["log_gdp_proxy"], np.log1p([100.0, 100.0, 80.0, 80.0]))

    scenario_design = SimpleNamespace(
        scenario=SCENARIO_NOISY,
        depvar="outcome",
        entity="entity",
        method=METHOD_TWFE_INTENSITY,
        shock_col="shock",
        treated_col="treated",
    )
    first, first_notes = transforms._apply_teaching_scenario(frame, scenario_design)
    second, second_notes = transforms._apply_teaching_scenario(frame, scenario_design)
    pd.testing.assert_frame_equal(first, second)
    assert first_notes == second_notes
    assert not first["outcome"].equals(frame["outcome"])
