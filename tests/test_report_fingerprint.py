import copy

import pytest

from gvcsim.classroom import records


def _session():
    return {
        "version": "experiment-session-simple-v3",
        "steps": {
            "1": {"data": {"slice": {"year": 2020}, "observation": {"row": "CHN_A01_02", "value": 1.0}}},
            "2": {"data": {"year": 2020, "country": "CHN", "compared": ["CHN", "USA"], "observations": [{"value": 1}]}},
            "9": {"data": {"chart": "heat", "drill": "CHN", "heat_sort": "degree", "observations": [{"value": 2}]}},
        },
        "shared": {},
    }


def _report_for(session):
    return {
        "provenance": {
            "session_fingerprint": records._session_fingerprint(session),
            "report_fingerprint": records.report_fingerprint(session),
        }
    }


def test_browsing_view_settings_does_not_outdate_a_report_but_changing_material_does():
    session = _session()
    report = _report_for(session)
    browsed = copy.deepcopy(session)
    browsed["steps"]["1"]["data"]["slice"] = {"year": 2016}
    browsed["steps"]["2"]["data"].update(year=2017, country="KOR")
    browsed["steps"]["9"]["data"].update(chart="network", drill="USA", heat_sort="betweenness", heat_coverage="all")
    assert records.report_matches_session(browsed, report)

    changed = copy.deepcopy(session)
    changed["steps"]["2"]["data"]["compared"] = ["KOR", "USA"]
    assert not records.report_matches_session(changed, report)


def test_reports_saved_before_the_view_exclusion_keep_the_full_session_check():
    session = _session()
    legacy = {"provenance": {"session_fingerprint": records._session_fingerprint(session)}}
    assert records.report_matches_session(session, legacy)
    browsed = copy.deepcopy(session)
    browsed["steps"]["2"]["data"]["year"] = 2017
    assert not records.report_matches_session(browsed, legacy)


def test_exploration_view_selections_do_not_outdate_a_report():
    """Steps 6–9 keep the countries and view of an exploration-only chart; that is browsing, not material."""
    session = _session()
    report = _report_for(session)
    browsed = copy.deepcopy(session)
    browsed["steps"]["9"]["data"]["network_browse"] = {"countries": ["BRN", "USA"], "view": "topology"}
    browsed["steps"]["2"]["data"]["browse_selection"] = {"first": "BRN", "others": ["USA"], "view": "structure"}
    assert records.report_matches_session(browsed, report)


@pytest.mark.parametrize(
    "original,replacement,equivalent",
    [
        (2020, 2020.0, True),
        (0, -0.0, True),
        (123456789012345680000, 1.2345678901234568e20, True),
        (123456789012345683968, 1.2345678901234568e20, False),
        (1, True, False),
        (1, "1", False),
        (1, 1.0000000000000002, False),
    ],
)
def test_report_currency_uses_json_numeric_values_not_number_spelling(original, replacement, equivalent):
    session = _session()
    session["steps"]["2"]["data"]["observations"][0]["value"] = original
    report = _report_for(session)
    session["steps"]["2"]["data"]["observations"][0]["value"] = replacement
    assert records.report_matches_session(session, report) is equivalent
