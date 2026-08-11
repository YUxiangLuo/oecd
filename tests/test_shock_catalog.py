import hashlib
import json

from gvcsim import shock_catalog, shocks


def test_shocks_preserves_catalog_reexport_identity():
    for name in (
        "DEMO_FILE",
        "EXPOSURE_PREFIX",
        "TREATED_THRESHOLD",
        "EXPOSURE_MODE_FIXED_PRETREATMENT",
        "EXPOSURE_MODE_CONTEMPORANEOUS",
        "EXPOSURE_MODES",
        "SHOCK_TARIFF",
        "SHOCK_SANCTIONS",
        "SHOCK_EXPORT_CONTROL",
        "SHOCK_SPECS",
        "SHOCK_LABELS",
        "EU27",
        "TariffEvent",
        "EntityListEvent",
        "EVENTS",
        "ENTITY_LIST_EVENTS",
    ):
        assert getattr(shocks, name) is getattr(shock_catalog, name)


def test_event_metadata_contract_is_unchanged_by_extraction():
    metadata = shocks.events_metadata()
    canonical = json.dumps(metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()

    assert len(metadata) == 16
    assert hashlib.sha256(canonical).hexdigest() == "f16acbdfa181b9e9338df31da78bf3e68bfa0ddcda4aa4dadaeb2258173fce3e"
    assert metadata[0]["name"] == "美国201保障措施(光伏、洗衣机)"
    assert metadata[-1]["name"] == "BIS 实体清单:中芯国际 SMIC"
