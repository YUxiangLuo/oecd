import sys

import pytest

from gvcsim.cli import main


def test_regress_rejects_removed_step_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["gvcsim", "regress", "--step", "12"])

    with pytest.raises(SystemExit) as exc:
        main()

    assert exc.value.code == 2
