import json
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from gvcsim import data_routes, regression_routes, shocks
from gvcsim.artifacts import ArtifactContractError
from gvcsim.data import quality
from gvcsim.api import app

from gvcsim.regression.design import RegressionDesign


def _qc_checks(scope: str) -> list[dict]:
    return [
        {
            "name": name,
            "kind": "结构",
            "passed": True,
            "detail": "ok",
            "warnings": [],
            "severity": "ok",
        }
        for name in quality.QC_EXPECTED_CHECKS[scope]
    ]


def _indicator_frame(*, industry: bool = False) -> pd.DataFrame:
    rows = []
    for country, scale in (("AAA", 1.0), ("BBB", 2.0)):
        row = {
            "country": country,
            "DVAex": scale,
            "DVArt": scale,
            "DDC": scale,
            "FVA": scale,
            "FDC": scale,
            "taxsub": scale,
            "3_VA_GVC": scale,
            "SVA": 10 * scale,
            "3b_VA_GVC_C": scale / 2,
            "weighted degree": scale,
            "betweenesscentrality": scale / 10,
        }
        if industry:
            row["industry"] = "s1"
        rows.append(row)
    return pd.DataFrame(rows)


def _shock_frame() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "year": 2020,
                "country": "AAA",
                "sector": "s1",
                "tariff_shock": 0.2,
                "treated": 1,
                "announced_date": "2020-01-01",
                "effective_date": "2020-02-01",
                "note": "tariff-event",
                "sanction_shock": 0.4,
                "sanction_treated": 1,
                "sanction_announced_date": "2020-03-01",
                "sanction_effective_date": "2020-04-01",
                "sanction_note": "sanction-event",
                "export_control_shock": 0.0,
                "export_control_treated": 0,
                "export_control_announced_date": "",
                "export_control_effective_date": "",
                "export_control_note": "",
                "shock_type": "tariff",
                "tariff_exposure_source": "oecd_icio_bilateral_flow",
                "tariff_exposure_mode": "fixed_pretreatment",
                "tariff_exposure_disclosure": "",
            },
            {
                "year": 2020,
                "country": "BBB",
                "sector": "s2",
                "tariff_shock": 0.0,
                "treated": 0,
                "announced_date": "",
                "effective_date": "",
                "note": "",
                "sanction_shock": 0.0,
                "sanction_treated": 0,
                "sanction_announced_date": "",
                "sanction_effective_date": "",
                "sanction_note": "",
                "export_control_shock": 0.0,
                "export_control_treated": 0,
                "export_control_announced_date": "",
                "export_control_effective_date": "",
                "export_control_note": "",
                "shock_type": "tariff",
                "tariff_exposure_source": "oecd_icio_bilateral_flow",
                "tariff_exposure_mode": "fixed_pretreatment",
                "tariff_exposure_disclosure": "",
            },
        ]
    )


def test_data_discovery_qc_and_db_adapters(tmp_path, monkeypatch):
    monkeypatch.setattr(data_routes, "PROCESSED_DIR", tmp_path)
    monkeypatch.setattr(data_routes, "RAW_DATA_DIR", tmp_path)
    monkeypatch.setattr(data_routes, "processed_years", lambda: [2020])
    monkeypatch.setattr(
        data_routes,
        "dataset_metadata",
        lambda: {
            "years": [2020],
            "generated_at": "now",
            "qc_contract": quality.qc_contract_metadata(),
        },
    )

    country = _indicator_frame()
    industry = _indicator_frame(industry=True)
    monkeypatch.setattr(
        data_routes,
        "_read_csv",
        lambda name: industry.copy() if "industry" in name else country.copy(),
    )
    assert data_routes.meta()["countries"] == ["AAA", "BBB"]
    assert data_routes.steps()["steps"]
    assert data_routes.indicators_schema()

    monkeypatch.setattr(data_routes.icio_browser, "meta", lambda: {"years": [2020]})
    assert data_routes.db_meta() == {"years": [2020]}
    with pytest.raises(HTTPException) as missing:
        data_routes.db_slice(2020, page=1, page_size=10)
    assert missing.value.status_code == 404

    (tmp_path / "ICIO-demo_2020.csv").write_text("x\n1\n", encoding="utf-8")
    monkeypatch.setattr(data_routes.icio_browser, "slice_table", lambda **kwargs: kwargs)
    assert data_routes.db_slice(2020, table="z", page=2, page_size=10)["page"] == 2
    monkeypatch.setattr(
        data_routes.icio_browser, "slice_table", lambda **kwargs: (_ for _ in ()).throw(ValueError("bad"))
    )
    with pytest.raises(HTTPException) as invalid:
        data_routes.db_slice(2020, page=1, page_size=10)
    assert invalid.value.status_code == 400

    shock_checks = _qc_checks(quality.QC_SCOPE_SHOCKS)
    control_checks = _qc_checks(quality.QC_SCOPE_CONTROLS)
    annual_checks = _qc_checks(quality.QC_SCOPE_ICIO)
    (tmp_path / "qc_shocks.json").write_text(json.dumps(shock_checks), encoding="utf-8")
    (tmp_path / "qc_controls.json").write_text(json.dumps(control_checks), encoding="utf-8")
    (tmp_path / "qc_2020.json").write_text(json.dumps(annual_checks), encoding="utf-8")
    assert data_routes.qc_shocks() == shock_checks
    assert data_routes.qc_controls() == control_checks
    assert data_routes.qc(2020) == annual_checks
    (tmp_path / "qc_2020.json").write_text("[]", encoding="utf-8")
    with pytest.raises(ArtifactContractError, match="非空"):
        data_routes.qc(2020)
    (tmp_path / "qc_2020.json").write_text(json.dumps(annual_checks), encoding="utf-8")
    monkeypatch.setattr(data_routes, "dataset_metadata", lambda: {"years": [2020]})
    with pytest.raises(ArtifactContractError, match="QC contract"):
        data_routes.qc(2020)
    with pytest.raises(HTTPException):
        data_routes.qc(2019)


def test_indicator_network_and_missing_artifact_views(tmp_path, monkeypatch):
    monkeypatch.setattr(data_routes, "PROCESSED_DIR", tmp_path)
    country = _indicator_frame()
    industry = _indicator_frame(industry=True)
    edges = pd.DataFrame([{"source": "AAA", "target": "BBB", "weight": np.inf}])

    def read(name: str) -> pd.DataFrame:
        if name.startswith("network"):
            return edges.copy()
        if "industry" in name:
            return industry.copy()
        return country.copy()

    monkeypatch.setattr(data_routes, "_read_csv", read)
    rows = data_routes.indicators_country(2020, "AAA")
    assert rows[0]["gross_exports"] == 6
    page = data_routes.indicators_industry(2020, "AAA", "s1", 1, 5)
    assert page["total"] == 1 and page["rows"][0]["country"] == "AAA"
    network = data_routes.viz_network(2020)
    assert len(network["nodes"]) == 2 and network["edges"][0]["weight"] is None
    assert data_routes._clean_value(float("nan")) is None

    with pytest.raises(HTTPException) as missing:
        data_routes._read_path(tmp_path / "missing.csv")
    assert missing.value.status_code == 404
    with pytest.raises(HTTPException):
        data_routes.qc_shocks()
    with pytest.raises(HTTPException):
        data_routes.qc_controls()

    (tmp_path / "controls_country.csv").write_text("country,year\nAAA,2020\n", encoding="utf-8")
    monkeypatch.setattr(data_routes, "_read_path", lambda path: pd.DataFrame({"country": ["AAA"], "year": [2020]}))
    monkeypatch.setattr(
        data_routes,
        "dataset_metadata",
        lambda: {"qc_contract": quality.qc_contract_metadata()},
    )
    control_checks = _qc_checks(quality.QC_SCOPE_CONTROLS)
    monkeypatch.setattr(
        data_routes.quality,
        "check_controls_country",
        lambda frame: [SimpleNamespace(to_dict=lambda row=row: row) for row in control_checks],
    )
    assert data_routes.qc_controls() == control_checks


def test_indicator_and_network_routes_preserve_incomplete_gross_exports(monkeypatch):
    country = _indicator_frame()
    country.loc[0, "taxsub"] = np.nan
    country.loc[1, ["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"]] = np.nan
    edges = pd.DataFrame([{"source": "AAA", "target": "BBB", "weight": 1.0}])

    def read(name: str) -> pd.DataFrame:
        return edges.copy() if name.startswith("network") else country.copy()

    monkeypatch.setattr(data_routes, "_read_csv", read)

    rows = data_routes.indicators_country(2020)
    assert rows[0]["gross_exports"] is None
    assert rows[0]["FVA_share"] is None
    assert rows[0]["DVAex_share"] is None
    assert rows[1]["gross_exports"] is None
    assert rows[1]["FVA_share"] is None

    network = data_routes.viz_network(2020)
    assert [node["gross_exports"] for node in network["nodes"]] == [None, None]


def test_shock_and_crosswalk_views(monkeypatch):
    frame = _shock_frame()
    monkeypatch.setattr(data_routes, "_read_shocks", lambda: frame.copy())
    monkeypatch.setattr(
        data_routes.shocks,
        "events_metadata",
        lambda: [
            {"name": "tariff-event", "shock_type": "tariff"},
            {"name": "sanction-event", "shock_type": "sanctions"},
            {"name": "not-in-panel", "shock_type": "tariff"},
        ],
    )
    events_response = data_routes.shock_events()
    assert [row["name"] for row in events_response["events"]] == ["tariff-event", "sanction-event"]
    assert "OECD ICIO" in events_response["disclaimer"]
    summary = data_routes.shock_summary("sanctions")
    assert summary["years"][0]["treated_pairs"] == 1
    panel = data_routes.shock_panel(2020, "sanctions", "AAA", "s1", filter="treated", page=1, page_size=10)
    assert panel["total"] == 1
    assert panel["rows"][0]["shock_intensity"] == 0.4
    assert "OECD ICIO" in panel["disclaimer"]
    assert "main_imposer" not in panel["rows"][0]
    assert "export_exposure" not in panel["rows"][0]
    assert "tariff_shock" not in panel["rows"][0]
    assert "不是关税税率" in panel["type"]["definition"]
    export_control = data_routes.shock_panel(2020, "export_control", "AAA", "s1", filter="all", page=1, page_size=10)
    assert "export_exposure" not in export_control["rows"][0]
    assert "关税" in export_control["type"]["definition"]
    assert "不使用出口暴露度" in export_control["type"]["definition"]

    with pytest.raises(HTTPException) as invalid:
        data_routes.shock_summary("unknown")
    assert invalid.value.status_code == 400

    monkeypatch.setattr(data_routes.crosswalk, "demo_payload", lambda year: {"year": year})
    assert data_routes.crosswalk_demo(2019) == {"year": 2019}
    monkeypatch.setattr(data_routes.crosswalk, "demo_payload", lambda year: (_ for _ in ()).throw(ValueError("bad")))
    with pytest.raises(HTTPException):
        data_routes.crosswalk_demo(2019)


def test_shock_api_disclaimer_uses_validated_source_and_rejects_unknown_or_mixed(monkeypatch):
    fallback = _shock_frame()
    fallback["tariff_exposure_source"] = "stylized_teaching_fallback"
    fallback["tariff_exposure_disclosure"] = shocks.STYLIZED_EXPOSURE_DISCLOSURE
    monkeypatch.setattr(data_routes, "_read_shocks", lambda: fallback.copy())
    response = data_routes.shock_events()
    assert response["disclaimer"].endswith(shocks.STYLIZED_EXPOSURE_DISCLOSURE)
    assert "来自经发布校验的 OECD" not in response["disclaimer"]

    unknown = fallback.copy()
    unknown["tariff_exposure_source"] = "unknown"
    monkeypatch.setattr(data_routes, "_read_shocks", lambda: unknown.copy())
    with pytest.raises(data_routes.ArtifactContractError, match="来源未知或混合"):
        data_routes.shock_events()

    mixed = fallback.copy()
    mixed.loc[mixed.index[0], "tariff_exposure_source"] = shocks.EXPOSURE_SOURCE_OECD_ICIO
    mixed.loc[mixed.index[0], "tariff_exposure_disclosure"] = ""
    monkeypatch.setattr(data_routes, "_read_shocks", lambda: mixed.copy())
    with pytest.raises(data_routes.ArtifactContractError, match="来源未知或混合"):
        data_routes.shock_panel(2020, "sanctions")


def test_shock_filters_distinguish_nonzero_from_authoritative_treated(monkeypatch):
    frame = pd.concat([_shock_frame().iloc[[0]].copy() for _ in range(3)], ignore_index=True)
    frame["country"] = ["LOW", "EDGE", "HIGH"]
    frame["sanction_shock"] = [0.0009, 0.001, 0.0011]
    frame["sanction_treated"] = [0, 0, 1]
    monkeypatch.setattr(data_routes, "_read_shocks", lambda: frame.copy())

    treated = data_routes.shock_panel(2020, "sanctions", filter="treated")
    nonzero = data_routes.shock_panel(2020, "sanctions", filter="nonzero")
    all_rows = data_routes.shock_panel(2020, "sanctions", filter="all")
    legacy = data_routes.shock_panel(2020, "sanctions", only_hit=True)
    summary = data_routes.shock_summary("sanctions")["years"][0]

    assert [row["country"] for row in treated["rows"]] == ["HIGH"]
    assert [row["country"] for row in nonzero["rows"]] == ["HIGH", "EDGE", "LOW"]
    assert nonzero["total"] == all_rows["total"] == legacy["total"] == 3
    assert summary["treated_pairs"] == 1
    assert summary["nonzero_pairs"] == 3
    with pytest.raises(HTTPException, match="不能同时"):
        data_routes.shock_panel(2020, "sanctions", filter="treated", only_hit=True)


def test_shock_panel_paginates_before_enrichment(monkeypatch):
    frame = pd.concat([_shock_frame().iloc[[0]].copy() for _ in range(70)], ignore_index=True)
    frame["country"] = [f"C{index:03d}" for index in range(len(frame))]
    frame["tariff_shock"] = np.arange(len(frame), dtype=float) / 1000
    frame["treated"] = 1
    monkeypatch.setattr(data_routes, "_read_shocks", lambda: frame.copy())
    enriched_sizes = []

    def enrich(page: pd.DataFrame, _year: int) -> pd.DataFrame:
        enriched_sizes.append(len(page))
        return page.assign(main_imposer="USA")

    monkeypatch.setattr(data_routes, "_with_tariff_exposure", enrich)
    result = data_routes.shock_panel(2020, "tariff", filter="all", page=2, page_size=25)

    assert result["total"] == 70
    assert len(result["rows"]) == 25
    assert enriched_sizes == [25]
    assert result["rows"][0]["shock_intensity"] == pytest.approx(0.044)


@pytest.mark.parametrize(
    ("sort", "expected"),
    [
        ("intensity_desc", [("AAA", "s3"), ("BBB", "s1"), ("CCC", "s2"), ("AAA", "s1")]),
        ("intensity_asc", [("AAA", "s1"), ("AAA", "s3"), ("BBB", "s1"), ("CCC", "s2")]),
        ("country_asc", [("AAA", "s1"), ("AAA", "s3"), ("BBB", "s1"), ("CCC", "s2")]),
        ("industry_asc", [("AAA", "s1"), ("BBB", "s1"), ("CCC", "s2"), ("AAA", "s3")]),
    ],
)
def test_shock_panel_applies_global_stable_sort_before_pagination(monkeypatch, sort, expected):
    frame = pd.concat([_shock_frame().iloc[[0]].copy() for _ in range(4)], ignore_index=True)
    frame["country"] = ["CCC", "AAA", "AAA", "BBB"]
    frame["sector"] = ["s2", "s1", "s3", "s1"]
    frame["sanction_shock"] = [0.2, 0.1, 0.2, 0.2]
    monkeypatch.setattr(data_routes, "_read_shocks", lambda: frame.copy())

    first = data_routes.shock_panel(2020, "sanctions", filter="all", sort=sort, page=1, page_size=2)
    second = data_routes.shock_panel(2020, "sanctions", filter="all", sort=sort, page=2, page_size=2)

    combined = [(row["country"], row["sector"]) for row in first["rows"] + second["rows"]]
    assert combined == expected
    assert first["sort"] == second["sort"] == sort


@pytest.mark.parametrize(
    ("shock_type", "values", "expected"),
    [
        ("tariff", [0.3, 0.1, 0.2], ["AAA", "CCC", "BBB"]),
        ("sanctions", [0.1, 0.3, 0.2], ["BBB", "CCC", "AAA"]),
        ("export_control", [0.2, 0.1, 0.3], ["CCC", "AAA", "BBB"]),
    ],
)
def test_shock_intensity_sort_uses_the_selected_type_column(monkeypatch, shock_type, values, expected):
    frame = pd.concat([_shock_frame().iloc[[0]].copy() for _ in range(3)], ignore_index=True)
    frame["country"] = ["AAA", "BBB", "CCC"]
    frame["tariff_shock"] = [0.3, 0.1, 0.2]
    frame["sanction_shock"] = [0.1, 0.3, 0.2]
    frame["export_control_shock"] = [0.2, 0.1, 0.3]
    monkeypatch.setattr(data_routes, "_read_shocks", lambda: frame.copy())
    monkeypatch.setattr(data_routes, "_with_tariff_exposure", lambda page, _year: page)

    result = data_routes.shock_panel(2020, shock_type, filter="all", sort="intensity_desc", page=1, page_size=2)
    retry_equivalent = data_routes.shock_panel(
        2020, shock_type, filter="all", sort="intensity_desc", page=1, page_size=2
    )

    assert [row["country"] for row in result["rows"]] == expected[:2]
    assert [row["shock_intensity"] for row in result["rows"]] == sorted(values, reverse=True)[:2]
    assert retry_equivalent == result


def test_shock_sort_rejects_unknown_direct_value():
    with pytest.raises(HTTPException, match="sort 必须") as invalid:
        data_routes.shock_panel(2020, "sanctions", sort="random")  # type: ignore[arg-type]
    assert invalid.value.status_code == 400


def test_stylized_page_enrichment_never_labels_or_reads_oecd_exposure(monkeypatch):
    page = pd.DataFrame(
        [
            {
                "country": "DEU",
                "sector": "C24",
                "year": 2018,
                "shock_intensity": 0.02,
                "treated": 1,
                "note": "美国232钢铝关税",
                "tariff_exposure_source": "stylized_teaching_fallback",
                "tariff_exposure_mode": "fixed_pretreatment",
                "tariff_exposure_disclosure": shocks.STYLIZED_EXPOSURE_DISCLOSURE,
            }
        ]
    )
    monkeypatch.setattr(
        data_routes,
        "_current_exposure_index",
        lambda: pytest.fail("stylized fallback must not read the OECD index"),
    )

    enriched = data_routes._with_tariff_exposure(page, 2018)

    assert enriched.loc[0, "export_exposure"] == pytest.approx(0.09)
    assert enriched.loc[0, "exposure_source"] == "stylized_teaching_fallback"
    assert "事件双边行业平均加征税率" in enriched.loc[0, "formula"]


def _exposure_index_fixture() -> pd.DataFrame:
    rows = []
    countries = ("AAA", "BBB", "USA")
    for year, usa_share in ((2017, 0.2), (2020, 0.8)):
        for country in countries:
            shares = {destination: 0.0 for destination in countries}
            if country == "AAA":
                shares.update({"BBB": 1.0 - usa_share, "USA": usa_share})
            else:
                shares["AAA"] = 1.0
            for destination, share in shares.items():
                rows.append(
                    {
                        "country": country,
                        "imposer": destination,
                        "year": year,
                        "bilateral_exports": share,
                        "total_exports": 1.0,
                        "export_exposure": share,
                    }
                )
            rows.append(
                {
                    "country": country,
                    "imposer": "EU",
                    "year": year,
                    "bilateral_exports": 0.0,
                    "total_exports": 1.0,
                    "export_exposure": 0.0,
                }
            )
    return pd.DataFrame(rows)


def test_release_exposure_index_rejects_treatment_without_strictly_earlier_release(monkeypatch):
    data_routes._build_exposure_index.cache_clear()
    exposure = _exposure_index_fixture()
    monkeypatch.setattr(data_routes, "read_csv_artifact", lambda _path: exposure.copy())
    monkeypatch.setattr(
        shocks,
        "EVENTS",
        [
            shocks.TariffEvent(
                name="fixture tariff",
                imposer="USA",
                targets=("AAA",),
                announced="2017-01-01",
                effective="2017-01-01",
                rates={"s1": {2017: 0.02}},
            )
        ],
    )

    with pytest.raises(ArtifactContractError, match="不得回退到最早处理年"):
        data_routes._build_exposure_index(
            "/release",
            "r" * 32,
            (1, 2, 3, 4, 5),
            (2017, 2020),
            (("export_exposure_2020.csv", 1, 2, 3, 4, 5),),
        )


def test_release_exposure_index_builds_and_reads_once_per_exact_key(monkeypatch):
    data_routes._build_exposure_index.cache_clear()
    reads = []
    exposure = _exposure_index_fixture()
    expected_values = shocks._exposure_map(exposure)

    def read(path):
        reads.append(path.name)
        return exposure.copy()

    monkeypatch.setattr(data_routes, "read_csv_artifact", read)
    monkeypatch.setattr(
        shocks,
        "_exposure_map",
        lambda _frame: pytest.fail("release-keyed index must not repeat full exposure validation"),
    )
    state = (("export_exposure_2020.csv", 1, 2, 3, 4, 5),)
    release_stat = (1, 2, 3, 4, 5)
    first = data_routes._build_exposure_index("/release", "r" * 32, release_stat, (2017, 2020), state)
    second = data_routes._build_exposure_index("/release", "r" * 32, release_stat, (2017, 2020), state)

    third = data_routes._build_exposure_index("/release", "r" * 32, (1, 2, 3, 4, 6), (2017, 2020), state)
    assert first is second
    assert third is not first
    assert reads == ["export_exposure_2020.csv", "export_exposure_2020.csv"]
    assert dict(first.values) == expected_values
    assert first.available_years[("AAA", "USA")] == (2017, 2020)
    assert first.fixed_base_years[("AAA", "USA")] == 2017


@pytest.mark.parametrize(
    ("malformation", "match"),
    [
        ("missing", "schema"),
        ("duplicate", "键重复"),
        ("nonfinite", "数值有限值"),
    ],
)
def test_release_exposure_index_fails_closed_for_malformed_direct_fixture(monkeypatch, malformation, match):
    data_routes._build_exposure_index.cache_clear()
    exposure = _exposure_index_fixture()
    if malformation == "missing":
        exposure = exposure.drop(columns=["bilateral_exports"])
    elif malformation == "duplicate":
        exposure = pd.concat([exposure, exposure.iloc[[0]]], ignore_index=True)
    else:
        exposure.loc[0, "total_exports"] = np.inf
    monkeypatch.setattr(data_routes, "read_csv_artifact", lambda _path: exposure.copy())

    with pytest.raises(ValueError, match=match):
        data_routes._build_exposure_index(
            "/release",
            "r" * 32,
            (1, 2, 3, 4, 5),
            (2017, 2020),
            (("export_exposure_2020.csv", 1, 2, 3, 4, 5),),
        )


def _tariff_enrichment_page(
    *,
    note: object = "tariff-event",
    source: str | None = None,
    shock_intensity: float = 0.02,
    treated: int = 1,
) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "country": "AAA",
                "sector": "s1",
                "year": 2020,
                "shock_intensity": shock_intensity,
                "treated": treated,
                "note": note,
                "tariff_exposure_source": source or shocks.EXPOSURE_SOURCE_OECD_ICIO,
                "tariff_exposure_mode": shocks.EXPOSURE_MODE_FIXED_PRETREATMENT,
                "tariff_exposure_disclosure": "",
            }
        ]
    )


@pytest.mark.parametrize("blank_note", ["", "   ", None, np.nan, pd.NA])
def test_structural_zero_tariff_row_has_no_event_or_exposure(monkeypatch, blank_note):
    page = _tariff_enrichment_page(note=blank_note, shock_intensity=0.0, treated=0)
    monkeypatch.setattr(
        data_routes,
        "_current_exposure_index",
        lambda: pytest.fail("a structural zero must not open the OECD exposure index"),
    )

    enriched = data_routes._with_tariff_exposure(page, 2020)

    for column in (
        "main_imposer",
        "export_exposure",
        "export_exposure_fixed",
        "export_exposure_contemporaneous",
        "exposure_base_year",
        "exposure_mode",
        "exposure_source",
    ):
        assert pd.isna(enriched.loc[0, column]), column


def _fixture_tariff_event() -> shocks.TariffEvent:
    return shocks.TariffEvent(
        name="tariff-event",
        imposer="USA",
        targets=("AAA",),
        announced="2020-01-01",
        effective="2020-01-01",
        rates={"s1": {2020: 0.02}},
    )


@pytest.mark.parametrize(
    ("case", "match"),
    [
        ("unknown-event", "无法解析加征方"),
        ("unknown-stylized-event", "无法解析加征方"),
        ("blank-positive-event", "缺少事件"),
        ("blank-treated-event", "缺少事件"),
        ("blank-positive-stylized-event", "缺少事件"),
        ("blank-treated-stylized-event", "缺少事件"),
        ("absent-coverage", "缺少国家/加征方覆盖"),
        ("missing-fixed-key", "缺少固定权重键"),
        ("missing-fixed-year", "缺少固定年份键"),
        ("missing-requested-year", "缺少请求年份键"),
        ("unknown-source", "未知出口暴露度来源"),
    ],
)
def test_oecd_page_enrichment_fails_closed_for_missing_lookup_contract(monkeypatch, case, match):
    monkeypatch.setattr(shocks, "EVENTS", [_fixture_tariff_event()])
    pair = ("AAA", "USA")
    values = {(*pair, 2017): 0.2, (*pair, 2020): 0.3}
    available = {pair: (2017, 2020)}
    fixed = {pair: 2017}
    page = _tariff_enrichment_page()
    if case == "unknown-event":
        page = _tariff_enrichment_page(note="not-in-catalogue")
    elif case == "unknown-stylized-event":
        page = _tariff_enrichment_page(note="not-in-catalogue", source=shocks.EXPOSURE_SOURCE_STYLIZED)
    elif case == "blank-positive-event":
        page = _tariff_enrichment_page(note=np.nan)
    elif case == "blank-treated-event":
        page = _tariff_enrichment_page(note="", shock_intensity=0.0, treated=1)
    elif case == "blank-positive-stylized-event":
        page = _tariff_enrichment_page(note=pd.NA, source=shocks.EXPOSURE_SOURCE_STYLIZED)
    elif case == "blank-treated-stylized-event":
        page = _tariff_enrichment_page(note="", shock_intensity=0.0, treated=1, source=shocks.EXPOSURE_SOURCE_STYLIZED)
    elif case == "absent-coverage":
        available = {}
        fixed = {}
        values = {}
    elif case == "missing-fixed-key":
        fixed = {}
    elif case == "missing-fixed-year":
        fixed = {pair: 2016}
    elif case == "missing-requested-year":
        values.pop((*pair, 2020))
    elif case == "unknown-source":
        page = _tariff_enrichment_page(source="unknown-source")

    index = data_routes._ExposureIndex(values=values, available_years=available, fixed_base_years=fixed)
    monkeypatch.setattr(data_routes, "_current_exposure_index", lambda: index)

    with pytest.raises(ArtifactContractError, match=match):
        data_routes._with_tariff_exposure(page, 2020)


def _authenticated_client(teaching_db, username: str = "student") -> TestClient:
    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": username, "password": "gvclab2026"})
    assert login.status_code == 200
    client.headers["Authorization"] = f"Bearer {login.json()['token']}"
    return client


def test_structural_zero_final_page_is_stable_direct_and_authenticated(teaching_db, monkeypatch):
    frame = _shock_frame()
    frame.loc[1, "note"] = np.nan
    monkeypatch.setattr(data_routes, "_read_shocks", lambda: frame.copy())
    monkeypatch.setattr(
        data_routes,
        "_current_exposure_index",
        lambda: pytest.fail("the final structural-zero page must not open the OECD exposure index"),
    )
    params = {
        "year": 2020,
        "shock_type": "tariff",
        "filter": "all",
        "sort": "intensity_desc",
        "page": 2,
        "page_size": 1,
    }

    direct = data_routes.shock_panel(2020, "tariff", filter="all", sort="intensity_desc", page=2, page_size=1)
    client = _authenticated_client(teaching_db)
    response = client.get("/api/shocks/panel", params=params)
    retry_equivalent = client.get("/api/shocks/panel", params=params)

    assert response.status_code == retry_equivalent.status_code == 200
    assert response.json() == retry_equivalent.json() == direct
    assert direct["total"] == 2
    assert direct["page"] == 2
    assert direct["page_size"] == 1
    assert direct["filter"] == "all"
    assert direct["sort"] == "intensity_desc"
    assert len(direct["rows"]) == 1
    row = direct["rows"][0]
    assert row["shock_intensity"] == 0.0
    assert row["treated"] == 0
    assert row["note"] is None
    for field in (
        "main_imposer",
        "export_exposure",
        "export_exposure_fixed",
        "export_exposure_contemporaneous",
        "exposure_base_year",
        "exposure_mode",
        "exposure_source",
    ):
        assert row[field] is None


def test_authenticated_shock_panel_rejects_unknown_sort(teaching_db):
    response = _authenticated_client(teaching_db).get(
        "/api/shocks/panel",
        params={"year": 2020, "shock_type": "sanctions", "sort": "random"},
    )
    assert response.status_code == 422


def test_oecd_page_enrichment_contract_error_is_controlled_by_app(teaching_db, monkeypatch):
    frame = _shock_frame().iloc[[0]].copy()
    monkeypatch.setattr(data_routes, "_read_shocks", lambda: frame.copy())
    monkeypatch.setattr(shocks, "EVENTS", [_fixture_tariff_event()])
    pair = ("AAA", "USA")
    index = data_routes._ExposureIndex(
        values={(*pair, 2017): 0.2},
        available_years={pair: (2017,)},
        fixed_base_years={pair: 2017},
    )
    monkeypatch.setattr(data_routes, "_current_exposure_index", lambda: index)

    response = _authenticated_client(teaching_db).get(
        "/api/shocks/panel",
        params={"year": 2020, "shock_type": "tariff", "filter": "treated"},
    )

    assert response.status_code == 409
    assert "缺少请求年份键" in response.json()["detail"]


def test_malformed_qc_api_uses_controlled_artifact_error(teaching_db, tmp_path, monkeypatch):
    monkeypatch.setattr(data_routes, "PROCESSED_DIR", tmp_path)
    monkeypatch.setattr(
        data_routes,
        "dataset_metadata",
        lambda: {"qc_contract": quality.qc_contract_metadata()},
    )
    (tmp_path / "qc_2020.json").write_text("[]", encoding="utf-8")

    response = _authenticated_client(teaching_db).get("/api/qc/2020")

    assert response.status_code == 409
    assert "QC" in response.json()["detail"]


def test_regression_options_design_and_validation(teaching_db):
    client = _authenticated_client(teaching_db)
    assert client.get("/api/regression/options").status_code == 200
    design = client.get("/api/regression/design", params={"outcome": "trade"})
    assert design.status_code == 200
    assert design.json()["outcome"] == "trade"
    assert client.get("/api/regression/design", params={"outcome": "bad"}).status_code == 400
    assert client.get("/api/regression/design", params={"outcome": "trade", "step": 12}).status_code == 422
    assert (
        client.get(
            "/api/regression/design",
            params={"outcome": "trade", "shock_type": "sanctions", "weight_mode": "contemporaneous"},
        ).status_code
        == 400
    )


def test_regression_run_and_placebo_are_simple_current_results(teaching_db, monkeypatch):
    client = _authenticated_client(teaching_db)
    panel = pd.DataFrame({"country": ["AAA"], "entity_id": ["AAA-s1"]})
    monkeypatch.setattr(regression_routes, "_read_csv", lambda name: panel)

    class Result:
        def to_dict(self):
            return {
                "status": "invalid_design",
                "support": {
                    "untreated_clusters": 0,
                    "treated_clusters": 2,
                    "reversal_entities": ["AAA"],
                    "suppress_inference": True,
                },
            }

    async def fake_cpu(func, *args, **kwargs):
        if func is regression_routes.run_design_with_benchmark:
            return Result(), {"method": "benchmark"}
        return {"draws": kwargs["n_draws"], "seed": kwargs["seed"]}

    monkeypatch.setattr(regression_routes.concurrency, "run_cpu_bound", fake_cpu)
    run = client.post("/api/regression/run", json={"outcome": "network"})
    assert run.status_code == 200
    codes = {check["code"] for check in run.json()["preflight"]["checks"]}
    assert {"no_never_treated_entity", "treatment_reversal", "network_interference", "treatment_weighting"} <= codes
    assert run.json()["preflight"]["can_infer"] is False
    assert "attestation" not in run.json()["result"]

    placebo = client.post("/api/regression/placebo", json={"outcome": "trade", "n_draws": 10, "seed": 7})
    assert placebo.status_code == 200
    assert placebo.json()["placebo"] == {"draws": 10, "seed": 7}


@pytest.mark.parametrize(
    ("mutation", "detail"),
    [
        (lambda frame: frame.assign(country=np.where(frame.index == 0, " ", frame["country"])), "标识变量"),
        (
            lambda frame: frame.assign(FVA_share=np.where(frame.index == 0, "0.2", frame["FVA_share"])),
            "数值变量 FVA_share",
        ),
        (
            lambda frame: frame.assign(tariff_shock=np.where(frame.index == 0, np.inf, frame["tariff_shock"])),
            "数值变量 tariff_shock",
        ),
        (lambda frame: pd.concat([frame, frame.iloc[[0]]], ignore_index=True), "entity-time 唯一"),
    ],
    ids=["blank-entity", "string-outcome", "infinite-regressor", "duplicate-key"],
)
def test_regression_runtime_boundary_maps_to_controlled_route_400(teaching_db, monkeypatch, mutation, detail):
    client = _authenticated_client(teaching_db)
    panel = pd.DataFrame(
        [
            {
                "country": f"C{entity}",
                "year": 2018 + year,
                "FVA_share": 0.1 * entity + 0.03 * year,
                "tariff_shock": 0.02 * entity * year + 0.01 * (entity % 2),
            }
            for entity in range(6)
            for year in range(4)
        ]
    )
    monkeypatch.setattr(regression_routes, "_read_csv", lambda _name: mutation(panel.copy()))

    async def direct_cpu(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(regression_routes.concurrency, "run_cpu_bound", direct_cpu)
    response = client.post(
        "/api/regression/run",
        json={"outcome": "trade", "granularity": "country", "method": "twfe_intensity"},
    )
    assert response.status_code == 400
    assert detail in response.json()["detail"]
    assert "Infinity" not in response.text and "NaN" not in response.text


def test_regression_route_maps_numerical_failure_to_chinese_400(teaching_db, monkeypatch):
    client = _authenticated_client(teaching_db)
    monkeypatch.setattr(regression_routes, "_read_csv", lambda _name: pd.DataFrame({"country": ["AAA"]}))

    async def fail_numerically(*_args, **_kwargs):
        raise np.linalg.LinAlgError("singular")

    monkeypatch.setattr(regression_routes.concurrency, "run_cpu_bound", fail_numerically)
    response = client.post(
        "/api/regression/run",
        json={"outcome": "trade", "granularity": "country", "method": "twfe_intensity"},
    )
    assert response.status_code == 400
    assert response.json()["detail"].startswith("回归线性代数计算失败")


def test_regression_weight_panel_and_teacher_rejection(teaching_db):
    design = RegressionDesign("trade")
    fixed = pd.DataFrame({"tariff_shock": [0.1], "treated": [1]})
    assert regression_routes._panel_for_weight_mode(fixed, design, shocks.EXPOSURE_MODE_FIXED_PRETREATMENT) is fixed
    with pytest.raises(HTTPException) as missing:
        regression_routes._panel_for_weight_mode(fixed, design, shocks.EXPOSURE_MODE_CONTEMPORANEOUS)
    assert missing.value.status_code == 409
    current = fixed.assign(tariff_shock_contemporaneous=0.3, treated_contemporaneous=0)
    selected = regression_routes._panel_for_weight_mode(current, design, shocks.EXPOSURE_MODE_CONTEMPORANEOUS)
    assert selected[design.shock_col].iloc[0] == 0.3

    teacher = _authenticated_client(teaching_db, "teacher")
    assert teacher.post("/api/regression/run", json={"outcome": "trade"}).status_code == 403
