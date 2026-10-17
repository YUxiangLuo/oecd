"""The model-space check (scripts/check_model_space.py): its grid and the predicates its verdicts rest on."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import check_model_space as cms  # noqa: E402
import teaching_variants  # noqa: E402

from gvcsim.regression import teaching  # noqa: E402
from gvcsim.regression.spec import DEFAULT_SPEC, ModelSpec  # noqa: E402
from gvcsim.regression.teaching import EXCHANGE_RATE_COLUMN, GDP_COLUMN, OPENNESS_COLUMN  # noqa: E402


def _record(spec: ModelSpec, setting: str = "x") -> dict:
    return {"spec": spec.canonical().to_dict(), "setting": setting, "key": "FVA_share", "outcome": "trade"}


def test_grid_spans_every_x_set_every_distinct_effect_set_and_each_control_setting():
    effects = cms.fixed_effect_sets()
    assert len(effects) == 13 and () in effects and ("country_industry", "year") in effects
    # A combined effect makes its parts redundant: no set lists both.
    assert all(not ({"country", "industry"} & set(fe)) or "country_industry" not in fe for fe in effects)
    assert len(cms.x_sets()) == 7
    specs = cms.grid()
    assert len(specs) == 7 * 13 * len(cms.CONTROL_SETTINGS)
    assert len({cms.spec_id("trade", "FVA_share", spec) for _, spec in specs}) == len(specs)
    assert len(cms.ys()) == 17


def test_resume_refuses_changed_data_and_report_refuses_mixed_evidence(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace

    from test_model_spec import _panel

    panel = _panel()
    monkeypatch.setattr(cms, "_load_panel", lambda args: ("release-a", panel))
    monkeypatch.setattr(cms, "grid", lambda: [("default", DEFAULT_SPEC)])
    monkeypatch.setattr(cms, "ys", lambda which="all": [("trade", "FVA_share", -0.55, "share")])
    args = SimpleNamespace(out=str(tmp_path), ys="default", keys=[], markdown=str(tmp_path / "report.md"))
    cms.run(args)
    path = tmp_path / "runs.jsonl"
    original = path.read_text()
    record = json.loads(original)
    assert record["status"] != "error"
    assert record["provenance"]["release"] == "release-a"
    cms.run(args)
    assert path.read_text() == original
    panel.loc[0, "teaching_y_trade"] += 0.1
    with pytest.raises(ValueError, match="运行证据"):
        cms.run(args)
    assert path.read_text() == original
    record["release"] = "release-b"
    path.write_text(original + json.dumps(record) + "\n")
    with pytest.raises(ValueError, match="不能混用"):
        cms._report(args, None)
    with pytest.raises(ValueError, match="不能混用"):
        cms.distinct(args)


def test_well_specified_means_unit_and_year_effects_with_the_confounders_in_or_absorbed():
    default = _record(DEFAULT_SPEC)
    assert cms._well_specified(default)
    # Country × year effects absorb the three confounders: no control needed.
    assert cms._well_specified(_record(ModelSpec((0, 1), (), ("country_industry", "country_year"))))
    # Without the unit effect, or without a year effect, or with a confounder missing, the model is wrong.
    assert not cms._well_specified(_record(ModelSpec((0, 1), DEFAULT_SPEC.controls, ("country", "industry", "year"))))
    assert not cms._well_specified(_record(ModelSpec((0, 1), DEFAULT_SPEC.controls, ("country_industry",))))
    no_fx = tuple(item for item in DEFAULT_SPEC.controls if item[0] != EXCHANGE_RATE_COLUMN)
    assert not cms._well_specified(_record(ModelSpec((0, 1), no_fx, ("country_industry", "year"))))
    # A lagged confounder is not the confounder.
    lagged = ((EXCHANGE_RATE_COLUMN, 1), (GDP_COLUMN, 0), (OPENNESS_COLUMN, 0))
    assert not cms._well_specified(_record(ModelSpec((0, 1), lagged, ("country_industry", "year"))))
    # The omitted-exchange-rate case the design was built to show.
    assert cms._fx_omitted_only(_record(ModelSpec((0, 1), no_fx, ("country_industry", "year"))))
    assert not cms._fx_omitted_only(_record(ModelSpec((0, 1), no_fx, ("country_industry", "country_year"))))


def test_interval_checks_read_the_estimate_and_its_bounds():
    assert cms._contains({"ci_low": -0.6, "ci_high": -0.5}, -0.55) is True
    assert cms._contains({"ci_low": -0.6, "ci_high": -0.56}, -0.55) is False
    assert cms._contains({"ci_low": None, "ci_high": None}, -0.55) is None
    single = {"spec": ModelSpec((0,), (), ()).to_dict(), "coefs": [{"name": "teaching_tariff_exposure", "coef": -0.4}]}
    assert cms._x_sum(single) == {"name": "teaching_tariff_exposure", "coef": -0.4}
    two = {"spec": DEFAULT_SPEC.to_dict(), "coefs": [], "cumulative": {"coef": -0.55}}
    assert cms._x_sum(two) == {"coef": -0.55}


def test_default_ys_are_the_four_defaults_and_the_zero_effect_y():
    assert [key for _, key, _, _ in cms.ys("default")] == [
        "FVA_share",
        "3b_VA_GVC_C_share",
        "3b_FGY_GVC_C_share",
        "PLv_GVC",
        "weighted_degree",
    ]


def test_single_changes_cover_x_terms_controls_and_every_other_effect_set():
    moves = cms._moves()
    groups = {group for group, _, _ in moves}
    assert groups == {"X 项", "去掉控制", "控制改滞后", "加控制", "固定效应"}
    labels = [label for _, label, _ in moves]
    assert "去掉汇率变动" in labels and "汇率变动改滞后 1 期" in labels and "无固定效应" in labels
    assert sum(1 for group, _, _ in moves if group == "固定效应") == len(cms.fixed_effect_sets()) - 1
    assert sum(1 for group, _, _ in moves if group == "X 项") == len(cms.x_sets()) - 1
    assert all(spec != DEFAULT_SPEC.canonical() for _, _, spec in moves)


def test_variant_v13_is_the_published_generator_and_applied_restores_every_constant():
    v13 = teaching_variants.VARIANTS["v13"]
    assert v13 is teaching_variants.VARIANTS["P17"]
    assert v13.gdp_gamma == teaching.MACRO_CONTROLS[GDP_COLUMN]["gamma_factor"] == 0.5
    assert v13.openness_gamma == teaching.MACRO_CONTROLS[OPENNESS_COLUMN]["gamma_factor"] == -0.006
    assert v13.wave1_extra_growth == teaching.WAVE1_EXTRA_GDP_GROWTH == 0.04
    assert v13.common_growth == teaching.COMMON_GDP_GROWTH == 0.015
    assert v13.wave1_openness_rise == teaching.WAVE1_OPENNESS_RISE == 4.0
    assert v13.fx_depreciation == teaching.EXCHANGE_RATE_DEPRECIATION == -8.0
    assert v13.year_trend == teaching.COMMON_YEAR_TREND == (0.0, 0.0, -4.0, 2.0, -4.0)
    assert v13.lows == () and teaching.default_baseline("trade").calibration[0] == 0.27
    v12 = teaching_variants.VARIANTS["v12"]
    assert (v12.gdp_gamma, v12.openness_gamma, v12.fx_depreciation) == (0.08, 0.0015, -6.0)
    before = (
        teaching.MACRO_CONTROLS[GDP_COLUMN]["gamma_factor"],
        teaching.MACRO_CONTROLS[OPENNESS_COLUMN]["gamma_factor"],
        teaching.WAVE1_EXTRA_GDP_GROWTH,
        teaching.COMMON_GDP_GROWTH,
        teaching.EXCHANGE_RATE_DEPRECIATION,
        teaching.WAVE1_OPENNESS_RISE,
        teaching.COMMON_YEAR_TREND,
        teaching.default_baseline("trade").calibration,
    )
    with teaching_variants.applied(v12):
        assert teaching.MACRO_CONTROLS[GDP_COLUMN]["gamma_factor"] == 0.08
        assert teaching.MACRO_CONTROLS[OPENNESS_COLUMN]["gamma_factor"] == 0.0015
        assert teaching.COMMON_YEAR_TREND == (-0.4, -0.2, 0.0, 0.2, 0.4)
        assert teaching.default_baseline("trade").calibration == (0.25, 0.30, 0.006)
        assert teaching.baseline("network", "betweenesscentrality").calibration[0] == 2000.0
        # Identity Ys are not recalibrated: only the drawn parts have floors.
        assert teaching.baseline("production", "1_VA_D_share").calibration == (0.0, 0.0, 0.0)
    after = (
        teaching.MACRO_CONTROLS[GDP_COLUMN]["gamma_factor"],
        teaching.MACRO_CONTROLS[OPENNESS_COLUMN]["gamma_factor"],
        teaching.WAVE1_EXTRA_GDP_GROWTH,
        teaching.COMMON_GDP_GROWTH,
        teaching.EXCHANGE_RATE_DEPRECIATION,
        teaching.WAVE1_OPENNESS_RISE,
        teaching.COMMON_YEAR_TREND,
        teaching.default_baseline("trade").calibration,
    )
    assert after == before
    # Relative size: + overstated, − understated, a sign flip beyond −100%.
    assert teaching_variants._rel(-0.66, -0.55) == pytest.approx(0.2)
    assert teaching_variants._rel(-0.44, -0.55) == pytest.approx(-0.2)
    assert teaching_variants._rel(0.11, -0.55) == pytest.approx(-1.2)


def test_the_v13_omission_predicates_pick_one_change_from_the_default_model():
    controls = DEFAULT_SPEC.controls
    no_gdp = tuple(item for item in controls if item[0] != GDP_COLUMN)
    no_openness = tuple(item for item in controls if item[0] != OPENNESS_COLUMN)
    assert cms._one_confounder_omitted(_record(ModelSpec((0, 1), no_gdp, ("country_industry", "year"))), GDP_COLUMN)
    assert not cms._one_confounder_omitted(
        _record(ModelSpec((0, 1), no_gdp, ("country_industry", "year"))), OPENNESS_COLUMN
    )
    assert cms._one_confounder_omitted(
        _record(ModelSpec((0, 1), no_openness, ("country_industry", "year"))), OPENNESS_COLUMN
    )
    # Country × year effects absorb the confounders: not an omission.
    assert not cms._one_confounder_omitted(
        _record(ModelSpec((0, 1), no_gdp, ("country_industry", "country_year"))), GDP_COLUMN
    )
    assert cms._year_fe_omitted_only(_record(ModelSpec((0, 1), controls, ("country_industry",))))
    assert not cms._year_fe_omitted_only(_record(ModelSpec((0, 1), no_gdp, ("country_industry",))))
    assert not cms._year_fe_omitted_only(_record(DEFAULT_SPEC))


def test_key_specs_name_the_default_model_and_every_preset():
    named = cms.key_specs([])
    labels = [label for label, _key, _spec in named]
    assert labels[0] == "默认模型"
    from gvcsim.regression.workbench import PRESETS

    for _key, _tier, label, _question, spec in PRESETS:
        assert (label, "", spec.canonical()) in named
