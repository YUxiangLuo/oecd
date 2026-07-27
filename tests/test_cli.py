import sys

import pytest

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
