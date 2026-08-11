import sys

import pytest

from gvcsim import pipeline, preflight
from gvcsim.cli import main


@pytest.mark.parametrize("command", [["artifact-prune"], ["serve", "--workers", "2"], ["benchmark"]])
def test_removed_complexity_commands_and_options_are_not_registered(monkeypatch, command):
    monkeypatch.setattr(sys, "argv", ["gvcsim", *command])
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 2


def test_compute_recover_pending_uses_explicit_recovery_path(monkeypatch):
    calls = []
    monkeypatch.setattr(sys, "argv", ["gvcsim", "compute", "--recover-pending"])
    monkeypatch.setattr(pipeline, "recover_pending", lambda: calls.append("recover"))
    monkeypatch.setattr(pipeline, "run", lambda *_args, **_kwargs: pytest.fail("normal compute must not run"))
    main()
    assert calls == ["recover"]


@pytest.mark.parametrize("years", [["--years", "2020"], ["--years"]])
def test_compute_recovery_rejects_build_options(monkeypatch, years):
    monkeypatch.setattr(sys, "argv", ["gvcsim", "compute", "--recover-pending", *years])
    with pytest.raises(SystemExit, match="不能与"):
        main()


def test_preflight_command_reports_fixed_dataset(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["gvcsim", "preflight"])
    monkeypatch.setattr(
        preflight, "run", lambda: {"years": [2019, 2020], "database": {"schema_version": "gvcsim-teaching-db-v8"}}
    )
    main()
    output = capsys.readouterr().out
    assert "2019,2020" in output and "gvcsim-teaching-db-v8" in output


def test_preflight_failure_is_nonzero(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["gvcsim", "preflight"])
    monkeypatch.setattr(preflight, "run", lambda: (_ for _ in ()).throw(RuntimeError("database unavailable")))
    with pytest.raises(SystemExit, match="database unavailable"):
        main()
