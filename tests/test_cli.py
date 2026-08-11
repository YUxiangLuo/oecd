import sys
from pathlib import Path

import pytest

from gvcsim import artifact_retention, artifacts, config, preflight, quizzes
from gvcsim.classroom import db as classroom_db
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


def test_artifact_prune_is_dry_run_by_default(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["gvcsim", "artifact-prune", "--keep-latest", "5"])
    monkeypatch.setattr(config, "PROCESSED_DIR", Path("/srv/gvcsim/data/processed"))
    captured: dict[str, object] = {}
    candidate = artifact_retention.Release("1" * 16, Path("/srv/gvcsim/data/artifacts") / ("1" * 16), 1024, 1)
    plan = artifact_retention.PrunePlan(
        current_manifest_id="2" * 16,
        references={"3" * 16: ("assignments",)},
        retained_recent=("4" * 16,),
        candidates=(candidate,),
        skipped=(),
    )

    def planned(artifacts_dir, current, *, keep_latest, apply):
        captured.update(
            artifacts_dir=artifacts_dir,
            current=current,
            keep_latest=keep_latest,
            apply=apply,
        )
        return plan

    monkeypatch.setattr(artifact_retention, "prune_artifacts", planned)

    main()

    assert captured == {
        "artifacts_dir": Path("/srv/gvcsim/data/artifacts"),
        "current": Path("/srv/gvcsim/data/processed"),
        "keep_latest": 5,
        "apply": False,
    }
    output = capsys.readouterr().out
    assert "dry-run" in output
    assert "0.0 MiB" in output


def test_artifact_prune_reports_fail_closed_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["gvcsim", "artifact-prune", "--apply"])
    monkeypatch.setattr(
        artifact_retention,
        "prune_artifacts",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("database unavailable")),
    )

    with pytest.raises(SystemExit, match="产物清理拒绝执行.*database unavailable"):
        main()


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
            "database": {"schema_version": "gvcsim-teaching-db-v7"},
        },
    )

    main()

    output = capsys.readouterr().out
    assert "artifact-123" in output
    assert "2019,2020" in output
    assert "gvcsim-teaching-db-v7" in output


def test_preflight_command_exits_nonzero_on_dependency_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["gvcsim", "preflight"])
    monkeypatch.setattr(
        preflight,
        "run",
        lambda: (_ for _ in ()).throw(RuntimeError("PostgreSQL unavailable")),
    )

    with pytest.raises(SystemExit, match="服务启动预检失败.*PostgreSQL unavailable"):
        main()


def test_quiz_attempt_reset_requires_confirmation_and_the_current_version(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        classroom_db,
        "reset_active_attempts_for_quiz",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("不得触碰数据库")),
    )
    monkeypatch.setattr(sys, "argv", ["gvcsim", "classroom-reset-attempts", "--quiz-version", quizzes.QUIZ_VERSION])
    with pytest.raises(SystemExit, match="确认备份后加 --confirm"):
        main()

    monkeypatch.setattr(
        sys,
        "argv",
        ["gvcsim", "classroom-reset-attempts", "--quiz-version", "course-quiz-stale", "--confirm"],
    )
    with pytest.raises(SystemExit, match="题库版本不匹配.*拒绝重置"):
        main()


def test_quiz_attempt_reset_records_the_current_version(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    captured: dict[str, str] = {}
    monkeypatch.setattr(
        sys,
        "argv",
        ["gvcsim", "classroom-reset-attempts", "--quiz-version", quizzes.QUIZ_VERSION, "--confirm"],
    )
    monkeypatch.setattr(artifacts, "manifest_id", lambda: "f" * 16)

    def reset(version: str, manifest_id: str) -> dict[str, object]:
        captured.update(version=version, manifest_id=manifest_id)
        return {"already_applied": False, "reset_count": 2}

    monkeypatch.setattr(classroom_db, "reset_active_attempts_for_quiz", reset)
    main()

    assert captured == {"version": quizzes.QUIZ_VERSION, "manifest_id": "f" * 16}
    assert "归档并重建 2 个当前 attempt" in capsys.readouterr().out
