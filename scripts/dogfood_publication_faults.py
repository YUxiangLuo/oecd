"""Run real compute in isolated directories and interrupt precise publication phases.

Uses an existing validated CI-only synthetic release and raw inputs; never touches
an active classroom directory or database. Child markers are outside artifact trees.
"""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path


def child(phase, marker):
    import pandas as pd

    from gvcsim import pipeline, publication

    stopped = False

    def checkpoint():
        nonlocal stopped
        if stopped:
            return
        stopped = True
        marker.write_text(phase)
        os.kill(os.getpid(), signal.SIGSTOP)

    if phase in {"artifact", "readonly", "diskfull", "concurrent"}:
        original = pd.DataFrame.to_csv

        def to_csv(frame, path=None, *args, **kwargs):
            result = original(frame, path, *args, **kwargs)
            if path is not None and Path(path).name == "export_exposure_2016.csv":
                checkpoint()
            return result

        pd.DataFrame.to_csv = to_csv
    elif phase == "manifest":
        original_metadata = pipeline.write_dataset_metadata

        def metadata(*args, **kwargs):
            result = original_metadata(*args, **kwargs)
            checkpoint()
            return result

        pipeline.write_dataset_metadata = metadata
    elif phase == "fsync":
        sync_tree, fsync = publication.durably_sync_release, os.fsync
        armed = False

        def sync(path):
            nonlocal armed
            armed = True
            return sync_tree(path)

        def sync_file(fd):
            fsync(fd)
            if armed:
                checkpoint()

        publication.durably_sync_release = sync
        os.fsync = sync_file
    elif phase == "promote":
        promote = publication.promote_staging

        def promoted(*args):
            promote(*args)
            checkpoint()

        publication.promote_staging = promoted
    elif phase in {"before_switch", "after_switch"}:
        replace = os.replace

        def replace_pointer(source, target, *args, **kwargs):
            active = Path(target) == pipeline.PROCESSED_DIR
            if active and phase == "before_switch":
                checkpoint()
            result = replace(source, target, *args, **kwargs)
            if active and phase == "after_switch":
                checkpoint()
            return result

        os.replace = replace_pointer
    elif phase in {"cleanup", "cleanup_denied"}:
        cleanup = publication.cleanup_old_releases

        def cleanup_phase(current):
            if phase == "cleanup":
                checkpoint()
                return cleanup(current)
            store = publication.release_store(current)
            store.chmod(0o300)
            try:
                return cleanup(current)
            finally:
                store.chmod(0o700)

        publication.cleanup_old_releases = cleanup_phase
    pipeline.run()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed-release", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--child",
        choices=[
            "artifact",
            "manifest",
            "fsync",
            "promote",
            "before_switch",
            "after_switch",
            "cleanup",
            "cleanup_denied",
            "readonly",
            "diskfull",
            "concurrent",
        ],
    )
    parser.add_argument("--marker", type=Path)
    parser.add_argument(
        "--phases",
        nargs="+",
        default=[
            "artifact",
            "manifest",
            "fsync",
            "promote",
            "before_switch",
            "after_switch",
            "cleanup",
            "cleanup_denied",
            "readonly",
            "concurrent",
        ],
    )
    parser.add_argument("--attempts", type=int, default=2)
    args = parser.parse_args()
    if args.child:
        child(args.child, args.marker)
        return
    if os.environ.get("GVCSIM_CI_SYNTHETIC") != "1" or os.environ.get("CI") != "true":
        parser.error("requires explicit CI synthetic mode")
    from gvcsim import artifacts, publication

    seed = args.seed_release.resolve()
    artifacts.validate_release(seed)
    old_id = json.loads((seed / "dataset.json").read_text())["release_id"]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    results = []
    for attempt in range(1, args.attempts + 1):
        for phase in args.phases:
            case = output / f"{phase}-{attempt}"
            case.mkdir()
            data = case / "data"
            mounted = False
            process = None
            try:
                data.mkdir()
                if phase == "diskfull":
                    subprocess.run(
                        [
                            "sudo",
                            "mount",
                            "-t",
                            "tmpfs",
                            "-o",
                            f"size=32M,uid={os.getuid()},gid={os.getgid()},mode=0700",
                            "tmpfs",
                            str(data),
                        ],
                        check=True,
                    )
                    mounted = True
                active = data / "processed"
                store = publication.release_store(active)
                store.mkdir()
                previous = store / old_id
                shutil.copytree(seed, previous)
                active.symlink_to(previous.relative_to(data))
                marker = case / "marker"
                env = {**os.environ, "GVCSIM_DATA_DIR": str(data), "GVCSIM_PG_DSN": ""}
                # No teaching DB is configured: compute must remain database-independent.
                with (case / "compute.log").open("w") as log:
                    process = subprocess.Popen(
                        [sys.executable, __file__, "--child", phase, "--marker", str(marker), "--output", str(case)],
                        env=env,
                        stdout=log,
                        stderr=log,
                    )
                    if phase == "cleanup_denied":
                        assert process.wait(timeout=90) == 0, (case / "compute.log").read_text()[-1200:]
                        assert "无法扫描旧发布目录" in (case / "compute.log").read_text()
                    else:
                        deadline = time.monotonic() + 90
                        while not marker.exists() and time.monotonic() < deadline and process.poll() is None:
                            time.sleep(0.02)
                        assert marker.exists(), (case / "compute.log").read_text()[-1200:]
                        while "\nState:\tT" not in Path(f"/proc/{process.pid}/status").read_text():
                            assert time.monotonic() < deadline, "child did not stop at its checkpoint"
                            time.sleep(0.01)
                        if phase == "concurrent":
                            second = subprocess.run(
                                [sys.executable, "-m", "gvcsim.cli", "compute"],
                                env=env,
                                capture_output=True,
                                text=True,
                                timeout=15,
                            )
                            assert second.returncode != 0 and "已有 gvcsim compute" in second.stderr
                            (case / "concurrent.log").write_text(second.stderr)
                        if phase in {"readonly", "diskfull"}:
                            if phase == "readonly":
                                next(store.glob(".build-*")).chmod(0o500)
                            else:
                                with (data / "bounded-filler").open("wb", buffering=0) as filler:
                                    try:
                                        while True:
                                            filler.write(b"x" * 1024 * 1024)
                                            filler.flush()
                                    except OSError as error:
                                        assert error.errno == 28
                            process.send_signal(signal.SIGCONT)
                            assert process.wait(timeout=30) != 0
                            text = (case / "compute.log").read_text()
                            assert ("No space left" if phase == "diskfull" else "Permission denied") in text
                        else:
                            process.kill()
                            assert process.wait(timeout=10) == -signal.SIGKILL
                    result = artifacts.validate_release(active)
                    changed = result["release_id"] != old_id
                    assert changed == (phase in {"after_switch", "cleanup", "cleanup_denied"}), (phase, result)
                    assert artifacts.validate_release(previous)["release_id"] == old_id
                    if phase == "diskfull":
                        (data / "bounded-filler").unlink()
                    for staging in store.glob(".build-*"):
                        staging.chmod(0o700)
                    with publication.compute_lock(active):
                        pass
                    if phase == "concurrent":
                        recovered = subprocess.run(
                            [sys.executable, "-m", "gvcsim.cli", "compute"],
                            env=env,
                            capture_output=True,
                            text=True,
                            timeout=90,
                        )
                        assert recovered.returncode == 0, recovered.stderr
                        assert artifacts.validate_release(active)["release_id"] != old_id
                        assert list(store.iterdir()) == [active.resolve()]
                        assert not previous.exists()
                    results.append(
                        {
                            "case": phase,
                            "attempt": attempt,
                            "active": "new" if changed else "old",
                            "previous_valid": True,
                            "lock_released": True,
                            "passed": True,
                        }
                    )
                    print(json.dumps(results[-1]), flush=True)
            finally:
                if process and process.poll() is None:
                    process.kill()
                    process.wait(timeout=10)
                if mounted:
                    subprocess.run(["sudo", "umount", str(data)], check=True)
                (output / "results.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
