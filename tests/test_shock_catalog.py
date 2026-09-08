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


def test_event_metadata_contract_has_claim_scoped_source_statuses():
    metadata = shocks.events_metadata()
    canonical = json.dumps(metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()

    assert len(metadata) == 19
    assert hashlib.sha256(canonical).hexdigest() == "7c70c70a6d6879c70e1ce3e49b106d166f6e6b7b596c3f6be17a340f7cf4ae62"
    assert metadata[0]["name"] == "美国201保障措施(光伏)"
    assert metadata[-1]["name"] == "BIS 实体清单:中芯国际 SMIC"
    statuses = {event["source_status"] for event in metadata}
    assert statuses == {
        "official_event_source_complete",
        "partial_official_event_source",
    }
