"""多 worker 父进程启动预检。"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from gvcsim import preflight


def test_preflight_loads_asgi_app_and_checks_all_startup_dependencies(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        preflight.importlib,
        "import_module",
        lambda name: calls.append(f"import:{name}") or SimpleNamespace(app=object()),
    )
    monkeypatch.setattr(preflight.config, "IS_PRODUCTION", True)
    monkeypatch.setattr(
        preflight.config,
        "validate_security_config",
        lambda: calls.append("security"),
    )
    monkeypatch.setattr(
        preflight.artifacts,
        "validate_release",
        lambda *_args, **kwargs: (
            calls.append(f"artifacts:{kwargs['validate_sources']}") or {"files": 31, "sources": 42}
        ),
    )
    monkeypatch.setattr(preflight.config, "processed_years", lambda: [2016, 2017])
    monkeypatch.setattr(preflight.artifacts, "manifest_id", lambda: "manifest-id")
    monkeypatch.setattr(preflight.concurrency, "validate_runtime", lambda: calls.append("runtime"))
    monkeypatch.setattr(
        preflight.concurrency,
        "capacity_snapshot",
        lambda: calls.append("capacity") or {"coordination": "cross-process-flock"},
    )
    monkeypatch.setattr(preflight.classroom_db, "startup", lambda: calls.append("database:start"))
    monkeypatch.setattr(
        preflight.classroom_db,
        "readiness",
        lambda: calls.append("database:ready") or {"status": "ok"},
    )
    monkeypatch.setattr(preflight.classroom_db, "close_pool", lambda: calls.append("database:close"))

    report = preflight.run()

    assert report == {
        "status": "ok",
        "manifest_id": "manifest-id",
        "years": [2016, 2017],
        "artifacts": {"files": 31, "sources": 42},
        "database": {"status": "ok"},
        "capacity": {"coordination": "cross-process-flock"},
    }
    assert calls == [
        "import:gvcsim.api",
        "security",
        "artifacts:True",
        "runtime",
        "capacity",
        "database:start",
        "database:ready",
        "database:close",
    ]


def test_preflight_closes_partial_database_startup_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    closed: list[bool] = []
    monkeypatch.setattr(preflight.importlib, "import_module", lambda _name: SimpleNamespace(app=object()))
    monkeypatch.setattr(preflight.config, "IS_PRODUCTION", False)
    monkeypatch.setattr(preflight.config, "validate_capacity_config", lambda: None)
    monkeypatch.setattr(preflight.artifacts, "validate_release", lambda *_args, **_kwargs: {"files": 1, "sources": 1})
    monkeypatch.setattr(preflight.config, "processed_years", lambda: [2020])
    monkeypatch.setattr(preflight.artifacts, "manifest_id", lambda: "manifest-id")
    monkeypatch.setattr(preflight.concurrency, "validate_runtime", lambda: None)
    monkeypatch.setattr(
        preflight.concurrency,
        "capacity_snapshot",
        lambda: {"coordination": "cross-process-flock"},
    )
    monkeypatch.setattr(
        preflight.classroom_db,
        "startup",
        lambda: (_ for _ in ()).throw(RuntimeError("database unavailable")),
    )
    monkeypatch.setattr(preflight.classroom_db, "close_pool", lambda: closed.append(True))

    with pytest.raises(RuntimeError, match="database unavailable"):
        preflight.run()

    assert closed == [True]
