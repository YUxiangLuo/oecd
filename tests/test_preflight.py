from types import SimpleNamespace

import pytest

from gvcsim import preflight, publication


def test_preflight_checks_app_fixed_files_and_database(tmp_path, monkeypatch):
    calls = []
    validation = []
    release = tmp_path / ".processed-releases" / "release"
    release.mkdir(parents=True)
    current = tmp_path / "processed"
    current.symlink_to(".processed-releases/release", target_is_directory=True)
    monkeypatch.setattr(
        preflight.importlib, "import_module", lambda name: calls.append(name) or SimpleNamespace(app=object())
    )
    monkeypatch.setattr(preflight.config, "IS_PRODUCTION", False)
    monkeypatch.setattr(preflight.config, "PROCESSED_DIR", current)

    def validate(*_args, **kwargs):
        validation.append(kwargs)
        return {"files": 20, "years": 2}

    monkeypatch.setattr(preflight.artifacts, "validate_release", validate)
    monkeypatch.setattr(preflight.config, "processed_years", lambda: [2019, 2020])
    monkeypatch.setattr(preflight.db, "startup", lambda: calls.append("start"))
    monkeypatch.setattr(preflight.db, "readiness", lambda: {"status": "ok"})
    monkeypatch.setattr(preflight.db, "shutdown", lambda: calls.append("stop"))
    report = preflight.run()
    assert report == {
        "status": "ok",
        "years": [2019, 2020],
        "artifacts": {"files": 20, "years": 2},
        "database": {"status": "ok"},
    }
    assert calls == ["gvcsim.api", "start", "stop"]
    assert validation == [{"verify_integrity": True, "allow_legacy": False}]


def test_preflight_rejects_pending_publication_before_database(tmp_path, monkeypatch):
    current = tmp_path / "processed"
    monkeypatch.setattr(preflight.config, "PROCESSED_DIR", current)
    publication.write_journal(
        current,
        publication.PublicationJournal(1, None, ".processed-releases/new", "prepared"),
    )
    monkeypatch.setattr(preflight.importlib, "import_module", lambda _name: SimpleNamespace(app=object()))
    monkeypatch.setattr(preflight.config, "IS_PRODUCTION", False)
    monkeypatch.setattr(preflight.db, "startup", lambda: pytest.fail("database must not start"))

    with pytest.raises(publication.PendingPublication, match="recover-pending"):
        preflight.run()


def test_preflight_always_closes_database(monkeypatch):
    closed = []
    monkeypatch.setattr(preflight.importlib, "import_module", lambda _name: SimpleNamespace(app=object()))
    monkeypatch.setattr(preflight.config, "IS_PRODUCTION", False)
    monkeypatch.setattr(preflight.artifacts, "validate_release", lambda *_args, **_kwargs: {"files": 1})
    monkeypatch.setattr(preflight.config, "processed_years", lambda: [2020])
    monkeypatch.setattr(preflight.db, "startup", lambda: (_ for _ in ()).throw(RuntimeError("down")))
    monkeypatch.setattr(preflight.db, "shutdown", lambda: closed.append(True))
    with pytest.raises(RuntimeError, match="down"):
        preflight.run()
    assert closed == [True]
