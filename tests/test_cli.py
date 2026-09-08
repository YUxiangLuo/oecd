import sys

import pytest

from gvcsim import config, pipeline, preflight
from gvcsim.cli import main


@pytest.mark.parametrize(
    "command",
    [
        ["artifact-prune"],
        ["serve", "--workers", "2"],
        ["benchmark"],
        ["regress"],
        ["report"],
        ["compute", "--recover-pending"],
        ["compute", "--allow-qc-override"],
    ],
)
def test_removed_complexity_commands_and_options_are_not_registered(monkeypatch, command):
    monkeypatch.setattr(sys, "argv", ["gvcsim", *command])
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 2


def test_compute_help_has_no_diagnostic_override(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["gvcsim", "compute", "--help"])
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 0
    output = " ".join(capsys.readouterr().out.split())
    assert "override" not in output


def test_compute_integrity_failure_recommends_fixing_input(monkeypatch):
    error = pipeline.QualityGateError(
        "shock_panel",
        {"passed": False, "failures": ["bad shock"]},
    )
    monkeypatch.setattr(sys, "argv", ["gvcsim", "compute"])
    monkeypatch.setattr(pipeline, "run", lambda *_args, **_kwargs: (_ for _ in ()).throw(error))
    with pytest.raises(SystemExit, match="请修复完整性或数学检查失败"):
        main()


def test_preflight_command_reports_fixed_dataset(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["gvcsim", "preflight"])
    monkeypatch.setattr(
        preflight, "run", lambda: {"years": [2019, 2020], "database": {"schema_version": "gvcsim-teaching-db-v9"}}
    )
    main()
    output = capsys.readouterr().out
    assert "2019,2020" in output and "gvcsim-teaching-db-v9" in output


def test_preflight_failure_is_nonzero(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["gvcsim", "preflight"])
    monkeypatch.setattr(preflight, "run", lambda: (_ for _ in ()).throw(RuntimeError("database unavailable")))
    with pytest.raises(SystemExit, match="database unavailable"):
        main()


def test_classroom_init_requires_an_explicit_database_dsn(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["gvcsim", "classroom-init"])
    monkeypatch.setattr(config, "PG_DSN", "")
    with pytest.raises(SystemExit, match="缺少 GVCSIM_PG_DSN"):
        main()
