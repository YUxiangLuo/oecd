import sys

import pytest

from gvcsim import preflight
from gvcsim.cli import main


@pytest.mark.parametrize("command", [["artifact-prune"], ["serve", "--workers", "2"], ["benchmark"]])
def test_removed_complexity_commands_and_options_are_not_registered(monkeypatch, command):
    monkeypatch.setattr(sys, "argv", ["gvcsim", *command])
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 2


def test_preflight_command_reports_fixed_dataset(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["gvcsim", "preflight"])
    monkeypatch.setattr(preflight, "run", lambda: {
        "years": [2019, 2020], "database": {"schema_version": "gvcsim-teaching-db-v8"}
    })
    main()
    output = capsys.readouterr().out
    assert "2019,2020" in output and "gvcsim-teaching-db-v8" in output


def test_preflight_failure_is_nonzero(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["gvcsim", "preflight"])
    monkeypatch.setattr(preflight, "run", lambda: (_ for _ in ()).throw(RuntimeError("database unavailable")))
    with pytest.raises(SystemExit, match="database unavailable"):
        main()
