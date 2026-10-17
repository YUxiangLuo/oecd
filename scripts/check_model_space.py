#!/usr/bin/env python3
"""Check a representative model grid for steps 11–14 against the teaching data construction.

The teaching panel (gvcsim/regression/teaching.py) generates each Y as

    Y = unit level + β·(0.6·X_t + 0.4·X_{t−1}) + (−0.0095·β)·汇率变动 + β·(0.5·ΔGDP对数 − 0.006·Δ开放度)
        + noise_scale·(unit×year noise + country×year noise + common year zigzag)

(v13 values; the report reads the published gammas) with 人口增长率 and FDI generated but unrelated to Y, no lag-2
relation, the exchange rate and the two macro paths correlated with the first tariff wave (confounders: GDP in the
tariff's direction, openness against it), a common year zigzag absorbed by year or country×year effects, and three ICIO-derived
controls that are real data. This script
fits every X-lag set and distinct fixed-effect set crossed with 13 representative control settings, for every Y a page
may choose. It does not enumerate every control subset with independent lag choices. It uses the production estimator and checks each
result against what that construction implies (recovery of β where the model is right, the designed biases where it
is wrong, false positives for unrelated controls, numerical identities, and agreement with the library benchmark).

Run from the repository root:

    PYTHONPATH=. uv run python scripts/check_model_space.py run --out dogfood-output/model-space
    PYTHONPATH=. uv run python scripts/check_model_space.py report --out dogfood-output/model-space \
        --markdown /tmp/model-space-check.md --summary /tmp/model-space-summary.json

``run`` writes one JSON line per fit (resumable); ``report`` evaluates them. Numbers are for the current release only.

``--variant NAME`` (run and report) uses a candidate generator setting from scripts/teaching_variants.py instead of the
published panel, and ``--ys default`` limits the sweep to the four default Ys and the zero-effect Y. ``distinct`` reads a
sweep and reports how far each single change to the default model moves the two-year total (whether a student who
changes one thing sees a different number):

    PYTHONPATH=. uv run python scripts/check_model_space.py run --out dogfood-output/model-space-P17 --variant P17 --ys default
    PYTHONPATH=. uv run python scripts/check_model_space.py distinct --out dogfood-output/model-space
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import itertools
import json
import math
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import teaching_variants  # noqa: E402

from gvcsim.regression.design import RegressionDesign
from gvcsim.regression.panel import run_design_with_benchmark
from gvcsim.regression.spec import CONTROLS, DEFAULT_SPEC, FIXED_EFFECT_LABELS, FIXED_EFFECTS, ModelSpec
from gvcsim.regression.teaching import (
    EXCHANGE_RATE_COLUMN,
    EXCHANGE_RATE_GAMMA_FACTOR,
    FDI_COLUMN,
    GDP_COLUMN,
    LAG_SHARES,
    MACRO_CONTROLS,
    OPENNESS_COLUMN,
    OUTCOMES,
    POPULATION_COLUMN,
    WEAK_Y,
    X_LAG_COLUMNS,
    selectable_baselines,
)

ICIO_CONTROLS = ("manufacturing_va_share", "log_gdp_proxy", "export_intensity")
DEFAULT_CONTROLS = tuple(key for key, _ in DEFAULT_SPEC.controls)

# Control settings, each a name and (control, lag) pairs. Together with every X-lag set and every distinct
# fixed-effect set they span the workbench's choices the construction says something about.
CONTROL_SETTINGS: dict[str, tuple[tuple[str, int], ...]] = {
    "none": (),
    "default": DEFAULT_SPEC.controls,
    "no_fx": tuple(item for item in DEFAULT_SPEC.controls if item[0] != EXCHANGE_RATE_COLUMN),
    "no_gdp": tuple(item for item in DEFAULT_SPEC.controls if item[0] != GDP_COLUMN),
    "no_openness": tuple(item for item in DEFAULT_SPEC.controls if item[0] != OPENNESS_COLUMN),
    "fx_only": ((EXCHANGE_RATE_COLUMN, 0),),
    "default+population": (*DEFAULT_SPEC.controls, (POPULATION_COLUMN, 0)),
    "default+fdi": (*DEFAULT_SPEC.controls, (FDI_COLUMN, 0)),
    "default+population+fdi": (*DEFAULT_SPEC.controls, (POPULATION_COLUMN, 0), (FDI_COLUMN, 0)),
    "default+icio": (*DEFAULT_SPEC.controls, *((key, 0) for key in ICIO_CONTROLS)),
    "all8": tuple((key, 0) for key in CONTROLS),
    "default_lag1": tuple((key, 1) for key, _ in DEFAULT_SPEC.controls),
    "fx_lag1+gdp+openness": ((EXCHANGE_RATE_COLUMN, 1), (GDP_COLUMN, 0), (OPENNESS_COLUMN, 0)),
}


def x_sets() -> list[tuple[int, ...]]:
    return [combo for size in (1, 2, 3) for combo in itertools.combinations((0, 1, 2), size)]


def fixed_effect_sets() -> list[tuple[str, ...]]:
    """Every distinct canonical set (a combined effect makes its parts redundant): 13 of the 32 subsets."""
    seen: dict[tuple[str, ...], None] = {}
    for size in range(len(FIXED_EFFECTS) + 1):
        for combo in itertools.combinations(FIXED_EFFECTS, size):
            spec = ModelSpec((0,), (), combo).canonical()
            seen.setdefault(spec.fixed_effects, None)
    return list(seen)


def grid() -> list[tuple[str, ModelSpec]]:
    specs = []
    for lags in x_sets():
        for effects in fixed_effect_sets():
            for name, controls in CONTROL_SETTINGS.items():
                specs.append((name, ModelSpec(lags, controls, effects).canonical()))
    return specs


def spec_id(outcome: str, key: str, spec: ModelSpec) -> str:
    return json.dumps([outcome, key, spec.to_dict()], sort_keys=True, ensure_ascii=False)


def ys(which: str = "all") -> list[tuple[str, str, float | None, str]]:
    """Every Y a page may choose, or (``default``) each family's default Y plus the zero-effect Y."""
    items = [(outcome, item) for outcome in OUTCOMES for item in selectable_baselines(outcome)]
    if which == "default":
        items = [
            (outcome, item)
            for outcome, item in items
            if item is selectable_baselines(outcome)[0] or (outcome, item.key) == WEAK_Y
        ]
    return [(outcome, item.key, item.beta, item.kind) for outcome, item in items]


def _variant(args: argparse.Namespace) -> teaching_variants.Variant | None:
    key = getattr(args, "variant", None)
    return teaching_variants.VARIANTS[key] if key else None


def _load_panel(args: argparse.Namespace) -> tuple[str, Any]:
    variant = _variant(args)
    if variant is None:
        from gvcsim.regression_routes import read_teaching_panel

        return read_teaching_panel()
    return f"variant:{variant.key}", teaching_variants.build_panel(variant)


def run(args: argparse.Namespace) -> None:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    release, panel = _load_panel(args)
    # Bind the actual loaded values, not a later filesystem snapshot or a release label alone.
    provenance = {
        "release": release,
        "panel_sha256": hashlib.sha256(panel.to_csv(index=False).encode()).hexdigest(),
        "implementation_sha256": hashlib.sha256(
            b"".join(
                path.name.encode() + b"\0" + hashlib.sha256(path.read_bytes()).digest()
                for path in sorted(Path(__file__).resolve().parents[1].joinpath("gvcsim/regression").glob("*.py"))
                + [Path(__file__).resolve(), Path(teaching_variants.__file__).resolve()]
            )
        ).hexdigest(),
    }
    lines = out / "runs.jsonl"
    done: set[str] = set()
    if lines.exists():
        with lines.open(encoding="utf-8") as handle:
            for raw in handle:
                previous = json.loads(raw)
                if previous.get("provenance") != provenance:
                    raise ValueError("运行证据与当前数据或代码不一致（或缺失）；请使用新输出目录重新运行")
                done.add(previous["id"])
    specs = grid()
    targets = [item for item in ys(args.ys) if not args.keys or item[1] in args.keys]
    total = len(specs) * len(targets)
    print(f"release {release}: {len(specs)} specs × {len(targets)} Y = {total} fits, {len(done)} done", flush=True)
    started = time.time()
    count = len(done)
    with lines.open("a", encoding="utf-8") as handle:
        for outcome, key, beta, kind in targets:
            for setting, spec in specs:
                identity = spec_id(outcome, key, spec)
                if identity in done:
                    continue
                design = RegressionDesign(outcome, teaching=True, baseline=key, spec=spec)
                record: dict[str, Any] = {
                    "id": identity,
                    "release": release,
                    "provenance": provenance,
                    "outcome": outcome,
                    "key": key,
                    "beta": beta,
                    "kind": kind,
                    "setting": setting,
                    "spec": spec.to_dict(),
                }
                try:
                    result, benchmark = run_design_with_benchmark(panel, design)
                    payload = result.to_dict()
                    record.update(
                        {
                            "status": payload.get("status"),
                            "suppressed": bool((payload.get("support") or {}).get("suppress_inference")),
                            "n_obs": payload.get("n_obs"),
                            "r2_within": payload.get("r2_within"),
                            "coefs": [
                                {k: item.get(k) for k in ("name", "coef", "se", "ci_low", "ci_high", "p")}
                                for item in payload.get("coefs", [])
                            ],
                            "cumulative": (
                                {k: payload["cumulative"].get(k) for k in ("coef", "se", "ci_low", "ci_high", "p")}
                                if payload.get("cumulative")
                                else None
                            ),
                            "omitted": [
                                {k: item.get(k) for k in ("name", "reason", "by")}
                                for item in payload.get("omitted", [])
                            ],
                            "benchmark_passed": bool(benchmark.get("coef_check_passed")),
                            "benchmark_backend": benchmark.get("backend"),
                        }
                    )
                except Exception as error:  # noqa: BLE001 — a refusal is a result of the sweep, recorded as such
                    record.update({"status": "error", "error": f"{type(error).__name__}: {error}"})
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                handle.flush()
                count += 1
                if count % 200 == 0:
                    rate = (count - len(done)) / max(time.time() - started, 1e-9)
                    remaining = (total - count) / max(rate, 1e-9)
                    print(f"{count}/{total} ({rate:.1f}/s, ~{remaining / 60:.0f} min left)", flush=True)
    print("done", flush=True)


# ---------------------------------------------------------------------------------------------------------------------
# Evaluation


def _coef(record: dict[str, Any], name: str) -> dict[str, Any] | None:
    return next((item for item in record.get("coefs", []) if item["name"] == name), None)


def _contains(stat: dict[str, Any] | None, target: float) -> bool | None:
    if not stat or stat.get("ci_low") is None or stat.get("ci_high") is None:
        return None
    return bool(stat["ci_low"] <= target <= stat["ci_high"])


def _x_sum(record: dict[str, Any]) -> dict[str, Any] | None:
    lags = record["spec"]["x_lags"]
    if len(lags) == 1:
        return _coef(record, X_LAG_COLUMNS[lags[0]])
    return record.get("cumulative")


def _has_control(record: dict[str, Any], key: str, lag: int = 0) -> bool:
    return any(item["name"] == key and item["lag"] == lag for item in record["spec"]["controls"])


def _effects(record: dict[str, Any]) -> set[str]:
    return set(record["spec"]["fixed_effects"])


def _unit_fe(record: dict[str, Any]) -> bool:
    return "country_industry" in _effects(record)


def _year_fe(record: dict[str, Any]) -> bool:
    return bool(_effects(record) & {"year", "country_year"})


def _country_year(record: dict[str, Any]) -> bool:
    return "country_year" in _effects(record)


def _confounders_handled(record: dict[str, Any]) -> bool:
    """The three confounders are in the model at lag 0, or absorbed by country × year effects."""
    if _country_year(record):
        return True
    return all(_has_control(record, key, 0) for key in (EXCHANGE_RATE_COLUMN, GDP_COLUMN, OPENNESS_COLUMN))


def _well_specified(record: dict[str, Any]) -> bool:
    return _unit_fe(record) and _year_fe(record) and _confounders_handled(record)


def _one_confounder_omitted(record: dict[str, Any], key: str) -> bool:
    """Unit + year effects (no country × year), the other two confounders in at lag 0, ``key`` not in at all."""
    others = {EXCHANGE_RATE_COLUMN, GDP_COLUMN, OPENNESS_COLUMN} - {key}
    return (
        _unit_fe(record)
        and _year_fe(record)
        and not _country_year(record)
        and all(_has_control(record, other, 0) for other in others)
        and not any(item["name"] == key for item in record["spec"]["controls"])
    )


def _year_fe_omitted_only(record: dict[str, Any]) -> bool:
    """The default model without its year effects: unit effects only, the three confounders in at lag 0."""
    return _effects(record) == {"country_industry"} and all(
        _has_control(record, key, 0) for key in (EXCHANGE_RATE_COLUMN, GDP_COLUMN, OPENNESS_COLUMN)
    )


def _fx_omitted_only(record: dict[str, Any]) -> bool:
    """Unit and year effects, GDP and openness in, the exchange rate out (and not absorbed)."""
    return (
        _unit_fe(record)
        and _year_fe(record)
        and not _country_year(record)
        and not any(_has_control(record, EXCHANGE_RATE_COLUMN, lag) for lag in (0, 1))
        and _has_control(record, GDP_COLUMN, 0)
        and _has_control(record, OPENNESS_COLUMN, 0)
    )


# A well-specified estimate within this relative distance of β counts as recovering it even when its (very narrow)
# interval misses β; a designed omission counts as showing when it moves the estimate at least this far the designed way.
RECOVERY_TOLERANCE = 0.025


def _rel(value: float, beta: float) -> float:
    return (value - beta) / beta if beta else float("nan")


class Check:
    def __init__(self, name: str, description: str):
        self.name, self.description = name, description
        self.passed = 0
        self.failed: list[dict[str, Any]] = []
        self.skipped = 0

    def add(self, ok: bool | None, record: dict[str, Any], detail: str = "") -> None:
        if ok is None:
            self.skipped += 1
        elif ok:
            self.passed += 1
        else:
            self.failed.append(
                {"key": record["key"], "setting": record["setting"], "spec": record["spec"], "detail": detail}
            )

    @property
    def total(self) -> int:
        return self.passed + len(self.failed)


def evaluate(records: list[dict[str, Any]]) -> tuple[list[Check], dict[str, Any]]:
    checks = {
        "benchmark": Check("库对照", "每次估计都通过与 linearmodels 的系数对照（估计器正确性）"),
        "estimable": Check("可估计", "没有报错、没有停止推断的设定（全部 X 项被去掉的设定除外）"),
        "recover_cumulative": Check(
            "正确设定恢复 β",
            "国家×行业 + 年份（或国家×年份）固定效应、三项混杂控制在内（或被国家×年份吸收）、X 含当年与上年："
            "两年累计的 95% 区间包含预设 β，或与 β 的相对偏差不超过 2.5%（单次抽样下区间极窄时按偏差判断）",
        ),
        "recover_cumulative_ci": Check(
            "正确设定恢复 β（仅看区间）", "同上，只按 95% 区间是否包含 β 计；未通过的是区间很窄、偏差在 2.5% 以内的设定"
        ),
        "recover_split": Check("正确设定恢复 60/40 拆分", "同上：当年项区间包含 0.6β、上年项区间包含 0.4β"),
        "lag2_null": Check("L2.X 为零", "正确设定加入 L2.X：其区间包含 0（数据没有两年后关联）"),
        "fx_slope": Check("汇率斜率", "正确设定：汇率变动系数区间包含 −0.0095β"),
        "gdp_slope": Check(
            "GDP 斜率", f"正确设定且 GDP 在内：GDP 对数系数区间包含 {MACRO_CONTROLS[GDP_COLUMN]['gamma_factor']}β"
        ),
        "openness_slope": Check(
            "开放度斜率", f"正确设定且开放度在内：开放度系数区间包含 {MACRO_CONTROLS[OPENNESS_COLUMN]['gamma_factor']}β"
        ),
        "null_controls": Check("无关控制为零", "正确设定加入人口增长率／FDI：其系数区间包含 0"),
        "null_controls_keep_beta": Check("无关控制不改变 β", "正确设定加入人口增长率／FDI：累计区间仍包含 β"),
        "icio_keep_beta": Check("ICIO 控制不改变 β", "正确设定加入 3 个 ICIO 派生控制：累计区间仍包含 β"),
        "omit_fx_overstates": Check(
            "漏汇率高估", "单位 + 年份固定效应、GDP 与开放度在内、汇率不在：累计关联的幅度大于 |β|，且区间不含 β"
        ),
        "omit_gdp_overstates": Check(
            "漏 GDP 高估",
            "单位 + 年份固定效应、汇率与开放度在内、GDP 对数不在：累计关联的幅度比 |β| 大至少 2.5%（恢复判定的门槛；"
            "v13 的设计偏差约 +9%）。去掉一个混杂后区间变宽，单次抽样下区间是否含 β 只在明细中给出",
        ),
        "omit_openness_understates": Check(
            "漏开放度低估",
            "单位 + 年份固定效应、汇率与 GDP 在内、贸易开放度不在：累计关联的幅度比 |β| 小至少 2.5%（v13 的设计偏差约 −6%）；"
            "区间是否含 β 只在明细中给出",
        ),
        "omit_year_fe_understates": Check(
            "去掉年份固定效应低估",
            "只留国家×行业固定效应、三项混杂控制在内：累计关联的幅度小于 |β|，且区间不含 β（v13 起的共同年份锯齿）",
        ),
        "lagged_fx_does_not_fix": Check(
            "滞后汇率不能替代当期汇率",
            "单位 + 年份固定效应、汇率只取滞后 1 期、GDP 与开放度在内：累计关联仍被高估（幅度大于 |β| 且区间不含 β）",
        ),
        "x_only_understates": Check(
            "只放当期 X 低估", "正确设定只放当期 X：估计幅度在 0.6|β| 与 |β| 之间（当年项吸收部分上年关联）"
        ),
        "weak_null": Check("零效应 Y", "后向复杂 GVC 生产份额（β = 0）在正确设定下累计区间包含 0"),
        "identity_production_total": Check("恒等式：前向 GVC 总份额 = 简单 + 复杂", "每个设定、每一项系数逐位相等"),
        "identity_production_domestic": Check(
            "恒等式：纯国内 = 1 − 简单 − 复杂 − 传统", "每个设定、每一项系数逐位相等（常数项除外）"
        ),
        "identity_network_degree": Check("恒等式：加权总度 = 入度 + 出度", "每个设定、每一项系数逐位相等"),
        "identity_trade_mirror": Check(
            "贸易：国内增加值出口占比 = −外国增加值项占比的关联",
            "正确设定下两者 X 各项之和的差不超过其余项占比的噪声（|和| < 0.01），且符号相反；"
            "错误设定下其余项占比自身的单位水平也会混入估计，不在此核查",
        ),
    }
    by_id = {record["id"]: record for record in records}

    def partner(record: dict[str, Any], key: str) -> dict[str, Any] | None:
        spec = ModelSpec.from_dict(record["spec"])
        return by_id.get(spec_id(record["outcome"], key, spec))

    misspecified_contains: Counter[str] = Counter()
    misspecified_total: Counter[str] = Counter()
    misspecified_rel: dict[str, list[float]] = defaultdict(list)
    weak_significant_misspecified = 0
    weak_misspecified_total = 0
    ratio_signs: Counter[str] = Counter()
    for record in records:
        beta = record["beta"]
        lags = tuple(record["spec"]["x_lags"])
        if record.get("status") == "error":
            checks["estimable"].add(False, record, record.get("error", ""))
            continue
        checks["benchmark"].add(record.get("benchmark_passed"), record, "benchmark failed")
        checks["estimable"].add(not record.get("suppressed"), record, f"status={record.get('status')}")
        total = _x_sum(record)
        well = _well_specified(record)
        # Identities: any Y, any spec.
        if record["key"] == "3_VA_GVC_share":
            a, b = partner(record, "3a_VA_GVC_S_share"), partner(record, "3b_VA_GVC_C_share")
            ok = None
            if a and b:
                ok = all(
                    math.isclose(
                        _coef(record, c["name"])["coef"],
                        _coef(a, c["name"])["coef"] + _coef(b, c["name"])["coef"],
                        rel_tol=1e-7,
                        abs_tol=1e-9,
                    )  # type: ignore[index]
                    for c in record["coefs"]
                )
            checks["identity_production_total"].add(ok, record)
        if record["key"] == "1_VA_D_share":
            parts = [partner(record, k) for k in ("3a_VA_GVC_S_share", "3b_VA_GVC_C_share", "2_VA_RT_share")]
            ok = None
            if all(parts):
                ok = all(
                    math.isclose(
                        _coef(record, c["name"])["coef"],
                        -sum(_coef(p, c["name"])["coef"] for p in parts),
                        rel_tol=1e-7,
                        abs_tol=1e-9,
                    )  # type: ignore[index, union-attr]
                    for c in record["coefs"]
                )
            checks["identity_production_domestic"].add(ok, record)
        if record["key"] == "weighted_degree":
            i, o = partner(record, "weighted_indegree"), partner(record, "weighted_outdegree")
            ok = None
            if i and o:
                ok = all(
                    math.isclose(
                        _coef(record, c["name"])["coef"],
                        _coef(i, c["name"])["coef"] + _coef(o, c["name"])["coef"],
                        rel_tol=1e-7,
                        abs_tol=1e-6,
                    )  # type: ignore[index]
                    for c in record["coefs"]
                )
            checks["identity_network_degree"].add(ok, record)
        if record["key"] == "DVAex_share" and _well_specified(record):
            f = partner(record, "FVA_share")
            ok = None
            if f and total and _x_sum(f):
                mirror = total["coef"] + _x_sum(f)["coef"]  # type: ignore[index]
                ok = abs(mirror) < 0.01 and (total["coef"] * _x_sum(f)["coef"] < 0)  # type: ignore[index]
            checks["identity_trade_mirror"].add(ok, record, f"sum={total['coef'] if total else None}")
        if record["key"] == "GVCPs" and well and lags == (0, 1) and total:
            ratio_signs["negative" if total["coef"] < 0 else "positive"] += 1
            if total.get("ci_low") is not None and total["ci_low"] <= 0 <= total["ci_high"]:
                ratio_signs["includes_0"] += 1
        if beta is None:
            continue
        if beta == 0.0:
            if lags == (0, 1) and record.get("cumulative"):
                if well:
                    checks["weak_null"].add(
                        _contains(record["cumulative"], 0.0), record, f"cum={record['cumulative']['coef']:.4f}"
                    )
                else:
                    weak_misspecified_total += 1
                    if _contains(record["cumulative"], 0.0) is False:
                        weak_significant_misspecified += 1
            continue
        if record.get("suppressed") or not total:
            continue
        if well and 0 in lags and 1 in lags:
            cumulative = record["cumulative"]
            rel = _rel(cumulative["coef"], beta)
            contained = _contains(cumulative, beta)
            detail = f"cum={cumulative['coef']:.4g} rel={rel:+.1%} ci=[{cumulative['ci_low']:.4g}, {cumulative['ci_high']:.4g}]"
            checks["recover_cumulative"].add(bool(contained) or abs(rel) <= RECOVERY_TOLERANCE, record, detail)
            checks["recover_cumulative_ci"].add(contained, record, detail)
            x0, x1 = _coef(record, X_LAG_COLUMNS[0]), _coef(record, X_LAG_COLUMNS[1])
            split = _contains(x0, LAG_SHARES[0] * beta) and _contains(x1, LAG_SHARES[1] * beta)
            checks["recover_split"].add(split, record, f"x={x0['coef']:.4g} lag1={x1['coef']:.4g}")  # type: ignore[index]
            if 2 in lags:
                checks["lag2_null"].add(
                    _contains(_coef(record, X_LAG_COLUMNS[2]), 0.0),
                    record,
                    f"lag2={_coef(record, X_LAG_COLUMNS[2])['coef']:.4g}",
                )  # type: ignore[index]
            if _has_control(record, EXCHANGE_RATE_COLUMN, 0) and not _country_year(record):
                stat = _coef(record, EXCHANGE_RATE_COLUMN)
                target = EXCHANGE_RATE_GAMMA_FACTOR * beta
                checks["fx_slope"].add(
                    _contains(stat, target),
                    record,
                    f"fx={stat['coef']:.4g} target={target:.4g} ci=[{stat['ci_low']:.4g}, {stat['ci_high']:.4g}]",
                )  # type: ignore[index]
            if _has_control(record, GDP_COLUMN, 0) and not _country_year(record):
                stat = _coef(record, GDP_COLUMN)
                target = MACRO_CONTROLS[GDP_COLUMN]["gamma_factor"] * beta
                checks["gdp_slope"].add(
                    _contains(stat, target),
                    record,
                    f"gdp={stat['coef']:.4g} target={target:.4g} ci=[{stat['ci_low']:.4g}, {stat['ci_high']:.4g}]",
                )  # type: ignore[index]
            if _has_control(record, OPENNESS_COLUMN, 0) and not _country_year(record):
                stat = _coef(record, OPENNESS_COLUMN)
                target = MACRO_CONTROLS[OPENNESS_COLUMN]["gamma_factor"] * beta
                checks["openness_slope"].add(
                    _contains(stat, target),
                    record,
                    f"open={stat['coef']:.4g} target={target:.4g} ci=[{stat['ci_low']:.4g}, {stat['ci_high']:.4g}]",
                )  # type: ignore[index]
            for key in (POPULATION_COLUMN, FDI_COLUMN):
                if _has_control(record, key, 0) and not _country_year(record):
                    checks["null_controls"].add(
                        _contains(_coef(record, key), 0.0),
                        record,
                        f"{key}={_coef(record, key)['coef']:.4g} p={_coef(record, key)['p']:.3f}",
                    )  # type: ignore[index]
            if record["setting"] in ("default+population", "default+fdi", "default+population+fdi"):
                checks["null_controls_keep_beta"].add(
                    _contains(cumulative, beta), record, f"cum={cumulative['coef']:.4g}"
                )
            if record["setting"] in ("default+icio", "all8"):
                checks["icio_keep_beta"].add(
                    _contains(cumulative, beta),
                    record,
                    f"cum={cumulative['coef']:.4g} rel={_rel(cumulative['coef'], beta):+.1%}",
                )
        if _fx_omitted_only(record) and lags == (0, 1) and record.get("cumulative"):
            cumulative = record["cumulative"]
            overstated = abs(cumulative["coef"]) > abs(beta) and not _contains(cumulative, beta)
            checks["omit_fx_overstates"].add(
                overstated, record, f"cum={cumulative['coef']:.4g} rel={_rel(cumulative['coef'], beta):+.1%}"
            )
        if _one_confounder_omitted(record, GDP_COLUMN) and lags == (0, 1) and record.get("cumulative"):
            cumulative = record["cumulative"]
            checks["omit_gdp_overstates"].add(
                _rel(cumulative["coef"], beta) >= RECOVERY_TOLERANCE,
                record,
                f"cum={cumulative['coef']:.4g} rel={_rel(cumulative['coef'], beta):+.1%}"
                f" ci含β={'是' if _contains(cumulative, beta) else '否'}",
            )
        if _one_confounder_omitted(record, OPENNESS_COLUMN) and lags == (0, 1) and record.get("cumulative"):
            cumulative = record["cumulative"]
            checks["omit_openness_understates"].add(
                _rel(cumulative["coef"], beta) <= -RECOVERY_TOLERANCE,
                record,
                f"cum={cumulative['coef']:.4g} rel={_rel(cumulative['coef'], beta):+.1%}"
                f" ci含β={'是' if _contains(cumulative, beta) else '否'}",
            )
        if _year_fe_omitted_only(record) and lags == (0, 1) and record.get("cumulative"):
            cumulative = record["cumulative"]
            checks["omit_year_fe_understates"].add(
                abs(cumulative["coef"]) < abs(beta) and not _contains(cumulative, beta),
                record,
                f"cum={cumulative['coef']:.4g} rel={_rel(cumulative['coef'], beta):+.1%}",
            )
        if (
            record["setting"] == "fx_lag1+gdp+openness"
            and _unit_fe(record)
            and _year_fe(record)
            and not _country_year(record)
            and lags == (0, 1)
            and record.get("cumulative")
        ):
            cumulative = record["cumulative"]
            overstated = abs(cumulative["coef"]) > abs(beta) and not _contains(cumulative, beta)
            checks["lagged_fx_does_not_fix"].add(
                overstated, record, f"cum={cumulative['coef']:.4g} rel={_rel(cumulative['coef'], beta):+.1%}"
            )
        if well and lags == (0,):
            value = abs(total["coef"])
            checks["x_only_understates"].add(
                LAG_SHARES[0] * abs(beta) < value < abs(beta),
                record,
                f"x={total['coef']:.4g} rel={_rel(total['coef'], beta):+.1%}",
            )
        if not well and lags == (0, 1) and record.get("cumulative"):
            misspecified_total[record["key"]] += 1
            if _contains(record["cumulative"], beta):
                misspecified_contains[record["key"]] += 1
            misspecified_rel[record["key"]].append(_rel(record["cumulative"]["coef"], beta))
    extras = {
        "misspecified_specs_whose_interval_still_contains_beta": {
            key: {
                "contains": misspecified_contains[key],
                "total": misspecified_total[key],
                "rel_min": min(misspecified_rel[key]),
                "rel_max": max(misspecified_rel[key]),
            }
            for key in sorted(misspecified_total)
        },
        "weak_y_misspecified_significant": {
            "significant": weak_significant_misspecified,
            "total": weak_misspecified_total,
        },
        "position_ratio_signs_well_specified": dict(ratio_signs),
    }
    return list(checks.values()), extras


def key_specs(records: list[dict[str, Any]]) -> list[tuple[str, str, ModelSpec]]:
    """The specs the pages name: the default model and the seven presets, plus the classic wrong ones."""
    from gvcsim.regression.workbench import PRESETS

    named = [("默认模型", DEFAULT_SPEC)]
    named += [(label, spec.canonical()) for _key, _tier, label, _question, spec in PRESETS]
    named += [
        (
            "去掉汇率变动 + 国家×年份 FE",
            ModelSpec((0, 1), CONTROL_SETTINGS["no_fx"], ("country_industry", "country_year")).canonical(),
        ),
        ("只加行业 FE", ModelSpec((0, 1), DEFAULT_SPEC.controls, ("industry",)).canonical()),
        ("无固定效应", ModelSpec((0, 1), DEFAULT_SPEC.controls, ()).canonical()),
        (
            "汇率取滞后 1 期",
            ModelSpec((0, 1), CONTROL_SETTINGS["fx_lag1+gdp+openness"], DEFAULT_SPEC.fixed_effects).canonical(),
        ),
        ("全部 8 个控制", ModelSpec((0, 1), CONTROL_SETTINGS["all8"], DEFAULT_SPEC.fixed_effects).canonical()),
    ]
    return [(label, "", spec) for label, spec in named]


def fmt(value: float | None, kind: str) -> str:
    if value is None or not math.isfinite(value):
        return "—"
    if kind == "share":
        return f"{value:+.3f}"
    if kind == "network":
        return f"{value:+,.0f}" if abs(value) >= 10 else f"{value:+.4f}"
    return f"{value:+.4f}"


def report(args: argparse.Namespace) -> None:
    variant = _variant(args)
    with teaching_variants.applied(variant) if variant else contextlib.nullcontext():
        _report(args, variant)


def _read_records(out: Path) -> list[dict[str, Any]]:
    """Keep both report entry points from silently combining runs across inputs or implementations."""
    records = [json.loads(line) for line in (out / "runs.jsonl").open(encoding="utf-8")]
    identities = {json.dumps([row.get("release"), row.get("provenance")], sort_keys=True) for row in records}
    if len(identities) > 1:
        raise ValueError("报告不能混用不同数据或实现的运行记录")
    return records


def _report(args: argparse.Namespace, variant: teaching_variants.Variant | None) -> None:
    records = _read_records(Path(args.out))
    checks, extras = evaluate(records)
    by_id = {record["id"]: record for record in records}
    present = {(record["outcome"], record["key"]) for record in records}
    targets = [item for item in ys() if (item[0], item[1]) in present]
    spec_count = len({json.dumps(record["spec"], sort_keys=True) for record in records})
    gamma = MACRO_CONTROLS[GDP_COLUMN]["gamma_factor"]
    openness_gamma = MACRO_CONTROLS[OPENNESS_COLUMN]["gamma_factor"]
    where = f"记录中的 release {records[0].get('release')}" if records else "空记录"
    evidence_note = (
        "运行时已记录数据与代码指纹；本报告仅汇总这些记录，不代表在当前版本重新运行或验证等价。"
        if records and records[0].get("provenance")
        else "历史记录缺少运行时数据／代码指纹，不能认证其适用于当前版本。"
    )
    lines = [
        "# 步骤 11–14 模型空间核查" + (f"（{variant.key}）" if variant else ""),
        "",
        f"> {evidence_note}",
        "",
        f"> {where} 上，汇总已有记录中 {len(targets)} 个 Y 的估计，逐项与教学数据的生成规则对照。"
        "默认扫描网格为 7 种 X 滞后组合 × 13 种固定效应组合 × 13 组代表性控制配置；已有记录可能只覆盖其子集，也不穷举工作台的任意控制及滞后组合。生成规则见 `gvcsim/regression/teaching.py`，核查脚本见 `scripts/check_model_space.py`。",
        "",
        f"- 估计次数：{len(records)}；已记录的不同设定数：{spec_count}；Y：{len(targets)}。",
        f"- 生成规则：Y = 单位水平 + β·(0.6·X + 0.4·L1.X) + (−0.0095·β)·汇率变动 + β·({gamma}·ΔGDP对数 + {openness_gamma}·Δ开放度) + 噪声与共同年份趋势；"
        "人口增长率、FDI 与 Y 无关；没有两年后关联；汇率、GDP 增长、开放度上升与第一批加税相关（混杂）。",
        "",
        "## 1. 逐项核查",
        "",
        "| 核查 | 含义 | 通过 | 未通过 | 不适用 |",
        "| --- | --- | --- | --- | --- |",
    ]
    for check in checks:
        lines.append(f"| {check.name} | {check.description} | {check.passed} | {len(check.failed)} | {check.skipped} |")
    lines += ["", "### 未通过的设定", ""]
    any_failed = False
    for check in checks:
        if not check.failed:
            continue
        any_failed = True
        lines.append(f"**{check.name}**（{len(check.failed)}）")
        lines.append("")
        shown = check.failed[: args.max_failures]
        for item in shown:
            spec = ModelSpec.from_dict(item["spec"])
            lines.append(f"- {item['key']} · {item['setting']} · {spec.summary()} · {item['detail']}")
        if len(check.failed) > len(shown):
            lines.append(f"- …另 {len(check.failed) - len(shown)} 个")
        lines.append("")
    if not any_failed:
        lines += ["无。", ""]
    lines += ["### 补充统计", ""]
    mis = extras["misspecified_specs_whose_interval_still_contains_beta"]
    lines.append(
        "错误设定（缺单位或年份固定效应，或混杂未控制）下两年累计区间仍包含 β 的比例（“凑巧接近不代表模型对”）："
    )
    lines.append("")
    lines.append("| Y | 包含 β | 错误设定数 | 相对偏差范围 |")
    lines.append("| --- | --- | --- | --- |")
    for key, item in mis.items():
        lines.append(
            f"| {key} | {item['contains']} | {item['total']} | {item['rel_min']:+.0%} … {item['rel_max']:+.0%} |"
        )
    weak = extras["weak_y_misspecified_significant"]
    lines += [
        "",
        f"零效应 Y 在错误设定下“方向明确”（区间不含 0）的次数：{weak['significant']} / {weak['total']}（错误设定也能显著）。",
        f"GVC 位置指数（比值，无预设 β）在正确设定下的累计关联符号：{extras['position_ratio_signs_well_specified']}。",
        "",
        "## 2. 页面命名的设定逐 Y 对照",
        "",
        "两年累计（或单项 X）估计；括号内为相对预设 β 的偏差。零效应 Y 与位置指数只列估计值。",
        "",
    ]
    named = key_specs(records)
    header = "| Y（β） | " + " | ".join(label for label, _, _ in named) + " |"
    lines += [header, "|" + " --- |" * (len(named) + 1)]
    for outcome, key, beta, kind in targets:
        cells = []
        for _label, _, spec in named:
            record = by_id.get(spec_id(outcome, key, spec))
            if not record:
                cells.append("未算")
                continue
            if record.get("status") == "error":
                cells.append("报错")
                continue
            total = _x_sum(record)
            if not total or record.get("suppressed"):
                cells.append("停止推断" if record.get("suppressed") else "—")
                continue
            value = total["coef"]
            text = fmt(value, kind)
            if beta:
                text += f" ({_rel(value, beta):+.0%})"
                if _contains(total, beta):
                    text += " ✓"
            elif beta == 0.0:
                text += " ∅" if _contains(total, 0.0) else " ✗"
            cells.append(text)
        lines.append(f"| {key}（{fmt(beta, kind) if beta is not None else '比值'}） | " + " | ".join(cells) + " |")
    lines += [
        "",
        "✓ = 区间包含预设 β；∅ = 零效应 Y 的区间包含 0；✗ = 零效应 Y 的区间不含 0。L2.X 一列是三项之和（含 L2.X）。",
        "",
    ]
    text = "\n".join(lines) + "\n"
    target = Path(args.markdown)
    # A hand-written reading of the numbers between the markers survives a regeneration.
    if target.exists():
        previous = target.read_text(encoding="utf-8")
        start, end = previous.find("<!-- notes-start -->"), previous.find("<!-- notes-end -->")
        if 0 <= start < end:
            notes = previous[start : end + len("<!-- notes-end -->")]
            text = text.replace("\n## 1. 逐项核查", f"\n{notes}\n\n## 1. 逐项核查", 1)
    target.write_text(text, encoding="utf-8")
    summary = {
        "release": records[0].get("release") if records else None,
        "provenance": records[0].get("provenance") if records else None,
        "evidence_note": evidence_note,
        "fits": len(records),
        "specs": spec_count,
        "checks": [
            {
                "name": check.name,
                "passed": check.passed,
                "failed": len(check.failed),
                "skipped": check.skipped,
                "failures": check.failed,
            }
            for check in checks
        ],
        "extras": extras,
    }
    Path(args.summary).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(text)


def _moves() -> list[tuple[str, str, ModelSpec]]:
    """Every single change a student can make to the default model on the page, as (group, label, spec)."""
    default = DEFAULT_SPEC.canonical()
    moves: list[tuple[str, str, ModelSpec]] = []
    for lags in x_sets():
        if lags != default.x_lags:
            moves.append(
                (
                    "X 项",
                    " + ".join("X" if lag == 0 else f"L{lag}.X" for lag in lags),
                    ModelSpec(lags, default.controls, default.fixed_effects).canonical(),
                )
            )
    labels = {key: info.label for key, info in CONTROLS.items()}
    for key, lag in default.controls:
        moves.append(
            (
                "去掉控制",
                f"去掉{labels[key]}",
                ModelSpec(
                    default.x_lags, tuple(item for item in default.controls if item[0] != key), default.fixed_effects
                ).canonical(),
            )
        )
        moves.append(
            (
                "控制改滞后",
                f"{labels[key]}改滞后 1 期",
                ModelSpec(
                    default.x_lags,
                    tuple((name, 1 if name == key else lag) for name, lag in default.controls),
                    default.fixed_effects,
                ).canonical(),
            )
        )
    for key in CONTROLS:
        if key not in dict(default.controls):
            moves.append(
                (
                    "加控制",
                    f"加{labels[key]}",
                    ModelSpec(default.x_lags, (*default.controls, (key, 0)), default.fixed_effects).canonical(),
                )
            )
    for effects in fixed_effect_sets():
        if effects != default.fixed_effects:
            label = " + ".join(FIXED_EFFECT_LABELS[key] for key in effects) if effects else "无固定效应"
            moves.append(("固定效应", label, ModelSpec(default.x_lags, default.controls, effects).canonical()))
    return moves


def distinct(args: argparse.Namespace) -> None:
    """How far each single change to the default model moves the two-year total, per Y, plus the whole grid's spread."""
    records = _read_records(Path(args.out))
    by_id = {record["id"]: record for record in records}
    present = {(record["outcome"], record["key"]) for record in records}
    targets = [item for item in ys() if (item[0], item[1]) in present and item[2]]
    moves = [move for move in _moves() if by_id.get(spec_id(targets[0][0], targets[0][1], move[2]))]
    thresholds = (0.05, 0.10)
    lines = [
        f"## 改一处设定，两年累计变多少（{records[0].get('release', '')}）",
        "",
        "相对默认模型两年累计的变化（+ 为幅度变大）。“全空间”列：全部设定里与默认模型相差至少 5% / 10% 的比例。",
        "",
        "| Y | " + " | ".join(label for _, label, _ in moves) + " | 全空间 ≥5% / ≥10% |",
        "|" + " --- |" * (len(moves) + 2),
    ]
    summary: dict[str, Any] = {}
    for outcome, key, beta, kind in targets:
        base = by_id.get(spec_id(outcome, key, DEFAULT_SPEC.canonical()))
        total = _x_sum(base) if base else None
        if not total:
            continue
        reference = total["coef"]
        cells = []
        per_move: dict[str, float | None] = {}
        for _group, label, spec in moves:
            record = by_id.get(spec_id(outcome, key, spec))
            value = _x_sum(record) if record and record.get("status") != "error" else None
            if not value:
                cells.append("—")
                per_move[label] = None
                continue
            change = (
                (abs(value["coef"]) - abs(reference)) / abs(reference)
                if math.copysign(1, value["coef"]) == math.copysign(1, reference)
                else -(abs(value["coef"]) + abs(reference)) / abs(reference)
            )
            per_move[label] = change
            cells.append(f"{change:+.0%}")
        spread = []
        for record in records:
            if (record["outcome"], record["key"]) != (outcome, key) or record.get("status") == "error":
                continue
            value = _x_sum(record)
            if value:
                spread.append(abs(value["coef"] - reference) / abs(reference))
        shares = (
            [sum(1 for item in spread if item >= threshold) / len(spread) for threshold in thresholds]
            if spread
            else [0.0, 0.0]
        )
        cells.append(" / ".join(f"{share:.0%}" for share in shares))
        lines.append(f"| {key} | " + " | ".join(cells) + " |")
        summary[key] = {
            "moves": per_move,
            "grid_share_at_least": dict(zip([str(t) for t in thresholds], shares, strict=True)),
            "grid_size": len(spread),
        }
    text = "\n".join(lines) + "\n"
    print(text)
    if args.markdown:
        Path(args.markdown).write_text(text, encoding="utf-8")
    if args.summary:
        Path(args.summary).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    runner = sub.add_parser("run")
    runner.add_argument("--out", required=True)
    runner.add_argument("--variant", choices=list(teaching_variants.VARIANTS))
    runner.add_argument("--ys", choices=("all", "default"), default="all")
    runner.add_argument("--keys", nargs="*", help="only these baseline keys (to split a sweep over processes)")
    reporter = sub.add_parser("report")
    reporter.add_argument("--out", required=True)
    reporter.add_argument("--markdown", required=True)
    reporter.add_argument("--summary", required=True)
    reporter.add_argument("--max-failures", type=int, default=30)
    reporter.add_argument("--variant", choices=list(teaching_variants.VARIANTS))
    distincter = sub.add_parser("distinct")
    distincter.add_argument("--out", required=True)
    distincter.add_argument("--markdown")
    distincter.add_argument("--summary")
    args = parser.parse_args()
    if args.command == "run":
        run(args)
    elif args.command == "report":
        report(args)
    else:
        distinct(args)


if __name__ == "__main__":
    sys.exit(main())
