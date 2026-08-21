from types import SimpleNamespace

import pytest

from gvcsim import preflight


def test_preflight_checks_app_release_and_database(monkeypatch):
    calls = []

    monkeypatch.setattr(
        preflight.importlib, "import_module", lambda name: calls.append(name) or SimpleNamespace(app=object())
    )
    monkeypatch.setattr(preflight.config, "IS_PRODUCTION", False)
    monkeypatch.setattr(preflight.artifacts, "validate_release", lambda *_args, **_kwargs: {"files": 20, "years": 2})
    monkeypatch.setattr(preflight.config, "processed_years", lambda: [2019, 2020])
    monkeypatch.setattr(
        preflight,
        "discover_years",
        lambda raw_dir: calls.append(("raw", raw_dir)) or [2019, 2020],
    )
    monkeypatch.setattr(preflight.db, "startup", lambda: calls.append("start"))
    monkeypatch.setattr(preflight.db, "readiness", lambda: {"status": "ok"})
    monkeypatch.setattr(preflight.db, "shutdown", lambda: calls.append("stop"))
    report = preflight.run()
    assert report["years"] == [2019, 2020]
    assert calls == ["gvcsim.api", ("raw", preflight.config.RAW_DATA_DIR), "start", "stop"]


def test_preflight_always_closes_database(monkeypatch):
    closed = []
    monkeypatch.setattr(preflight.importlib, "import_module", lambda _name: SimpleNamespace(app=object()))
    monkeypatch.setattr(preflight.config, "IS_PRODUCTION", False)
    monkeypatch.setattr(preflight.artifacts, "validate_release", lambda *_args, **_kwargs: {"files": 1})
    monkeypatch.setattr(preflight.config, "processed_years", lambda: [2020])
    monkeypatch.setattr(preflight, "discover_years", lambda *_args: [2020])
    monkeypatch.setattr(preflight.db, "startup", lambda: (_ for _ in ()).throw(RuntimeError("down")))
    monkeypatch.setattr(preflight.db, "shutdown", lambda: closed.append(True))
    with pytest.raises(RuntimeError, match="down"):
        preflight.run()
    assert closed == [True]


def test_preflight_rejects_missing_raw_files_before_database_start(monkeypatch):
    calls = []
    monkeypatch.setattr(preflight.importlib, "import_module", lambda _name: SimpleNamespace(app=object()))
    monkeypatch.setattr(preflight.config, "IS_PRODUCTION", False)
    monkeypatch.setattr(preflight.artifacts, "validate_release", lambda *_args: {"files": 1})
    monkeypatch.setattr(preflight.config, "processed_years", lambda: [2020])
    monkeypatch.setattr(
        preflight,
        "discover_years",
        lambda *_args: (_ for _ in ()).throw(FileNotFoundError("raw unavailable")),
    )
    monkeypatch.setattr(preflight.db, "startup", lambda: calls.append("start"))

    with pytest.raises(preflight.artifacts.ArtifactContractError, match="raw unavailable"):
        preflight.run()
    assert calls == []
