"""Which processed release and panel a committed benchmark was computed on.

The committed benchmark JSONs are evidence for a specific data release.  A later code-only change can leave the
number of fits intact while the processed data move; this module records both the release a benchmark was computed
on and the release it has been validated against, and refuses a current release that matches neither.

A rebuild that is documented as equivalent (for example the 2026-10-16 release that changed only the exchange-rate
unit label) carries ``status = "documented-equivalent-rebuild"``.  The note is the evidence for that claim; this
module checks the hashes and the top-level evidence, not the numeric equivalence itself.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, cast

from gvcsim import config

KIND = "benchmark-release-binding"
VERSION = 1
STATUS_COMPUTED = "computed-on-current"
STATUS_EQUIVALENT = "documented-equivalent-rebuild"
STATUSES = frozenset({STATUS_COMPUTED, STATUS_EQUIVALENT})
_RELEASE = re.compile(r"[0-9a-f]{32}")
_SHA256 = re.compile(r"[0-9a-f]{64}")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def current_binding(
    root: Path | None = None,
    *,
    panel_name: str = "panel_teaching.csv",
    exposure_name: str | None = None,
) -> dict[str, Any] | None:
    """The current processed release and the requested artifact hashes, or None when they are not readable."""
    base = Path(root or config.PROCESSED_DIR).resolve()
    dataset = base / "dataset.json"
    panel = base / panel_name
    if not dataset.is_file() or not panel.is_file():
        return None
    try:
        metadata = json.loads(dataset.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    release = metadata.get("release_id")
    if not isinstance(release, str) or _RELEASE.fullmatch(release) is None:
        return None
    result: dict[str, Any] = {
        "release": release,
        "panel": panel_name,
        "panel_sha256": file_sha256(panel),
    }
    if exposure_name is not None:
        exposure = base / exposure_name
        if not exposure.is_file():
            return None
        result["exposure"] = exposure_name
        result["exposure_sha256"] = file_sha256(exposure)
    return result


def binding_from_current(
    current: dict[str, Any] | None,
    *,
    note: str,
    status: str = STATUS_COMPUTED,
) -> dict[str, Any] | None:
    """A binding block for a run that read exactly the current release; None when no release is readable."""
    if current is None:
        return None
    return {
        "kind": KIND,
        "version": VERSION,
        "computed": dict(current),
        "validated": dict(current),
        "status": status,
        "note": note,
    }


def _block_problem(block: object, *, expected_panel: str, expected_exposure: str | None) -> str | None:
    if not isinstance(block, dict):
        return "binding 的 computed/validated 不是对象"
    required = {"release", "panel", "panel_sha256"}
    if expected_exposure is not None:
        required |= {"exposure", "exposure_sha256"}
    missing = sorted(required - set(block))
    if missing:
        return f"binding 缺少字段：{', '.join(missing)}"
    release, panel, panel_sha = block["release"], block["panel"], block["panel_sha256"]
    if not isinstance(release, str) or _RELEASE.fullmatch(release) is None:
        return "binding.release 必须是 32 位小写十六进制"
    if panel != expected_panel:
        return f"binding.panel 是 {panel!r}，期望 {expected_panel!r}"
    if not isinstance(panel_sha, str) or _SHA256.fullmatch(panel_sha) is None:
        return "binding.panel_sha256 必须是 64 位小写十六进制"
    if expected_exposure is not None:
        if block["exposure"] != expected_exposure:
            return f"binding.exposure 是 {block['exposure']!r}，期望 {expected_exposure!r}"
        exposure_sha = block["exposure_sha256"]
        if not isinstance(exposure_sha, str) or _SHA256.fullmatch(exposure_sha) is None:
            return "binding.exposure_sha256 必须是 64 位小写十六进制"
    return None


def binding_problem(
    benchmark: dict[str, Any],
    current: dict[str, Any] | None,
    *,
    expected_panel: str,
    expected_exposure: str | None = None,
) -> str | None:
    """Why the benchmark is not bound to the current release, or None when computed/validated matches it."""
    binding = benchmark.get("binding")
    if not isinstance(binding, dict):
        return "benchmark 缺少 binding 块"
    if binding.get("kind") != KIND or type(binding.get("version")) is not int or binding["version"] != VERSION:
        return "binding.kind/version 不匹配"
    status = binding.get("status")
    if status not in STATUSES:
        return f"binding.status 必须是 {sorted(STATUSES)}"
    if not isinstance(binding.get("note"), str) or not binding["note"].strip():
        return "binding.note 必须写明等价依据"
    computed, validated = binding.get("computed"), binding.get("validated")
    for label, block in (("computed", computed), ("validated", validated)):
        problem = _block_problem(block, expected_panel=expected_panel, expected_exposure=expected_exposure)
        if problem is not None:
            return f"binding.{label}：{problem}"
    if current is None:
        return f"当前 release 的 dataset.json/{expected_panel} 不可读，无法核对 binding"
    computed_block = cast(dict[str, Any], computed)
    validated_block = cast(dict[str, Any], validated)
    current_release = current.get("release")
    current_panel = current.get("panel_sha256")
    current_exposure = current.get("exposure_sha256")

    def matches(block: dict[str, Any]) -> bool:
        return (
            block["release"] == current_release
            and block["panel_sha256"] == current_panel
            and (expected_exposure is None or block["exposure_sha256"] == current_exposure)
        )

    if matches(computed_block) or matches(validated_block):
        return None
    return (
        f"当前 release {current_release} / {expected_panel} {str(current_panel)[:12]}… "
        f"既不是 computed（{computed_block['release']} / {computed_block['panel_sha256'][:12]}…）"
        f"也不是 validated（{validated_block['release']} / {validated_block['panel_sha256'][:12]}…）；"
        "请重跑生成脚本或记录新的等价重建。"
    )


def metadata_problem(
    benchmark: dict[str, Any],
    *,
    kind: str,
    expected_panel: str,
    expected_exposure: str | None = None,
) -> str | None:
    """Why the benchmark's top-level evidence and its binding block disagree, or None."""
    binding = benchmark.get("binding")
    if not isinstance(binding, dict) or not isinstance(binding.get("computed"), dict):
        return "benchmark 缺少 binding.computed"
    computed = binding["computed"]
    if kind == "model_space":
        if benchmark.get("release") != computed.get("release"):
            return "release 与 binding.computed.release 不一致"
        fits = benchmark.get("fits")
        if type(fits) is not int or fits <= 0:
            return "fits 必须是正整数"
    elif kind == "teaching_design":
        if benchmark.get("source_panel_sha256") != computed.get("panel_sha256"):
            return "source_panel_sha256 与 binding.computed.panel_sha256 不一致"
        source_exposure = benchmark.get("source_exposure")
        if expected_exposure is not None:
            if not isinstance(source_exposure, dict) or source_exposure.get("sha256") != computed.get(
                "exposure_sha256"
            ):
                return "source_exposure.sha256 与 binding.computed.exposure_sha256 不一致"
    else:
        return f"未知 benchmark 类型：{kind}"
    if computed.get("panel") != expected_panel:
        return f"binding.computed.panel 是 {computed.get('panel')!r}，期望 {expected_panel!r}"
    return None
