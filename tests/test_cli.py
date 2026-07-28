import sys

import pytest

from gvcsim import preflight
from gvcsim.cli import main


def test_regress_rejects_removed_step_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["gvcsim", "regress", "--step", "12"])

    with pytest.raises(SystemExit) as exc:
        main()

    assert exc.value.code == 2


def test_removed_customer_benchmark_command_is_not_registered(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["gvcsim", "benchmark"])

    with pytest.raises(SystemExit) as exc:
        main()

    assert exc.value.code == 2


def test_network_country_regression_is_rejected_before_loading_data(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["gvcsim", "regress", "--outcome", "network", "--granularity", "country"],
    )

    with pytest.raises(SystemExit, match="介数中心性恒为 0"):
        main()


def test_serve_rejects_reload_with_multiple_workers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["gvcsim", "serve", "--reload", "--workers", "2"])

    with pytest.raises(SystemExit, match="不兼容"):
        main()


def test_serve_rejects_unbounded_or_zero_capacity(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["gvcsim", "serve", "--workers", "0"])

    with pytest.raises(SystemExit, match="必须为正数"):
        main()


def test_preflight_command_reports_success(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(sys, "argv", ["gvcsim", "preflight"])
    monkeypatch.setattr(
        preflight,
        "run",
        lambda: {
            "manifest_id": "artifact-123",
            "years": [2019, 2020],
            "database": {"schema_version": "gvcsim-teaching-db-v6"},
        },
    )

    main()

    output = capsys.readouterr().out
    assert "artifact-123" in output
    assert "2019,2020" in output
    assert "gvcsim-teaching-db-v6" in output


def test_preflight_command_exits_nonzero_on_dependency_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["gvcsim", "preflight"])
    monkeypatch.setattr(
        preflight,
        "run",
        lambda: (_ for _ in ()).throw(RuntimeError("PostgreSQL unavailable")),
    )

    with pytest.raises(SystemExit, match="服务启动预检失败.*PostgreSQL unavailable"):
        main()
