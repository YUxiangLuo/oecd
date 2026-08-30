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
    ],
)
def test_removed_complexity_commands_and_options_are_not_registered(monkeypatch, command):
    monkeypatch.setattr(sys, "argv", ["gvcsim", *command])
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 2


def test_compute_help_discloses_non_overridable_shock_qc(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["gvcsim", "compute", "--help"])
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 0
    output = " ".join(capsys.readouterr().out.split())
    assert "冲击 schema、来源与语义 fatal 永不可 override" in output


def test_compute_shock_qc_failure_does_not_recommend_override(monkeypatch):
    error = pipeline.QualityGateError(
        "shock_panel",
        {"fatal": ["bad shock"], "publishable": False, "override": False},
        override_allowed=False,
    )
    monkeypatch.setattr(sys, "argv", ["gvcsim", "compute", "--allow-qc-override"])
    monkeypatch.setattr(pipeline, "run", lambda *_args, **_kwargs: (_ for _ in ()).throw(error))
    with pytest.raises(SystemExit, match="不可 override；请修复输入"):
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
