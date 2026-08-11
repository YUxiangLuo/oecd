from types import SimpleNamespace

import pytest

from gvcsim import preflight


def test_preflight_checks_app_fixed_files_and_database(monkeypatch):
    calls = []
    monkeypatch.setattr(preflight.importlib, "import_module", lambda name: calls.append(name) or SimpleNamespace(app=object()))
    monkeypatch.setattr(preflight.config, "IS_PRODUCTION", False)
    monkeypatch.setattr(preflight.artifacts, "validate_release", lambda *_: {"files": 20, "years": 2})
    monkeypatch.setattr(preflight.config, "processed_years", lambda: [2019, 2020])
    monkeypatch.setattr(preflight.db, "startup", lambda: calls.append("start"))
    monkeypatch.setattr(preflight.db, "readiness", lambda: {"status": "ok"})
    monkeypatch.setattr(preflight.db, "shutdown", lambda: calls.append("stop"))
    report = preflight.run()
    assert report == {"status": "ok", "years": [2019, 2020], "artifacts": {"files": 20, "years": 2}, "database": {"status": "ok"}}
    assert calls == ["gvcsim.api", "start", "stop"]


def test_preflight_always_closes_database(monkeypatch):
    closed = []
    monkeypatch.setattr(preflight.importlib, "import_module", lambda _name: SimpleNamespace(app=object()))
    monkeypatch.setattr(preflight.config, "IS_PRODUCTION", False)
    monkeypatch.setattr(preflight.artifacts, "validate_release", lambda *_: {"files": 1})
    monkeypatch.setattr(preflight.config, "processed_years", lambda: [2020])
    monkeypatch.setattr(preflight.db, "startup", lambda: (_ for _ in ()).throw(RuntimeError("down")))
    monkeypatch.setattr(preflight.db, "shutdown", lambda: closed.append(True))
    with pytest.raises(RuntimeError, match="down"):
        preflight.run()
    assert closed == [True]
