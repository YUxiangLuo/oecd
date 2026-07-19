"""步骤2:数据质检。

每个检查返回 QcCheck(可序列化),供 CLI 打印和 API 前端渲染共用。
检查内容覆盖 ICIO 原始矩阵、政策冲击面板与国家-年份控制变量:
维度一致性、缺失值/负值、会计恒等式、里昂惕夫逆矩阵数学性质、
国家/行业覆盖范围、控制变量 schema/范围/构造恒等式。
"""

from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from gvcsim.data.controls import ALL_CONTROL_COLUMNS

# 会计恒等式允许的相对误差
TOLERANCE = 0.01
# 关键国家:缺了说明解析出了问题
KEY_REGIONS = ["CHN", "USA", "JPN", "DEU"]

SHOCK_COLUMNS = [
    "country",
    "sector",
    "year",
    "tariff_shock",
    "treated",
    "announced_date",
    "effective_date",
]

SHOCK_VALUE_PAIRS = [
    ("tariff_shock", "treated"),
    ("sanction_shock", "sanction_treated"),
    ("export_control_shock", "export_control_treated"),
]

SHOCK_DATE_COLUMNS = [
    ("tariff_shock", "announced_date", "effective_date"),
    ("sanction_shock", "sanction_announced_date", "sanction_effective_date"),
    ("export_control_shock", "export_control_announced_date", "export_control_effective_date"),
]

CONTROL_REQUIRED_COLUMNS = ["country", "year", *ALL_CONTROL_COLUMNS]

QC_OK = "ok"
QC_DISCLOSURE = "disclosure"
QC_WARNING = "warning"
QC_FATAL = "fatal"
QC_SEVERITIES = (QC_OK, QC_DISCLOSURE, QC_WARNING, QC_FATAL)


@dataclass
class QcCheck:
    name: str  # 质检项名称
    kind: str  # 类型(结构 / 数值 / 经济含义)
    passed: bool
    detail: str = ""
    warnings: list[str] = field(default_factory=list)
    # 该检查失败时的严重度。fatal 会阻断产物发布；warning 只有在显式
    # 接受并披露后才能继续。通过但仍带 warnings 的检查会序列化为 disclosure。
    severity: str = QC_FATAL

    def to_dict(self) -> dict:
        payload = asdict(self)
        payload["severity"] = self.effective_severity
        return payload

    @property
    def effective_severity(self) -> str:
        if not self.passed:
            return self.severity
        return QC_DISCLOSURE if self.warnings else QC_OK


def summarize_checks(checks: list[QcCheck], *, override: bool = False) -> dict:
    """把一组检查归纳为可机器执行、也可持续披露的发布结论。"""
    by_severity: dict[str, list[str]] = {level: [] for level in QC_SEVERITIES}
    for check in checks:
        by_severity[check.effective_severity].append(check.name)
    fatal = by_severity[QC_FATAL]
    warning = by_severity[QC_WARNING]
    return {
        "publishable": not fatal or override,
        "override": bool(override and fatal),
        "requires_disclosure": bool(fatal or warning or by_severity[QC_DISCLOSURE]),
        "fatal": fatal,
        "warning": warning,
        "disclosure": by_severity[QC_DISCLOSURE],
        "passed": by_severity[QC_OK],
    }


def check_shapes(io) -> QcCheck:
    n = len(io.get_regions()) * len(io.get_sectors())
    bad = [f"{name}{df.shape}" for name, df in [("Z", io.Z), ("Y", io.Y), ("x", io.x)] if df.shape[0] != n]
    return QcCheck(
        name="维度一致性(Z/Y/x 行数 = 国家数×行业数)",
        kind="结构",
        passed=not bad,
        detail=f"期望维度 {n}" + (f",异常: {bad}" if bad else ""),
    )


def check_missing_and_negative(io) -> QcCheck:
    warnings = []
    passed = True
    for name, df in [("Z", io.Z), ("Y", io.Y)]:
        n_nan = int(df.isna().sum().sum())
        n_neg = int((df < 0).sum().sum())
        if n_nan > 0:
            passed = False
            warnings.append(f"{name} 存在 {n_nan} 个缺失值")
        if n_neg > 0:
            warnings.append(f"{name} 存在 {n_neg} 个负值(通常是库存变化等特殊科目,需人工确认)")
    n_neg_x = int((io.x.iloc[:, 0] < 0).sum())
    if n_neg_x > 0:
        passed = False
        warnings.append(f"总产出 x 存在 {n_neg_x} 个负值")
    return QcCheck(
        name="缺失值 / 负值检查",
        kind="数值",
        passed=passed,
        detail="无缺失值" if passed else "存在缺失值或负产出",
        warnings=warnings,
    )


def check_accounting_identity(io) -> QcCheck:
    """总产出 = 中间使用行和 + 最终需求行和。"""
    computed = io.Z.sum(axis=1) + io.Y.sum(axis=1)
    reported = io.x.iloc[:, 0]
    rel_diff = (computed - reported).abs() / reported.replace(0, np.nan)
    n_bad = int((rel_diff > TOLERANCE).sum())
    worst = rel_diff.sort_values(ascending=False).head(3)
    warnings = [f"{idx}: 相对误差 {val:.4%}" for idx, val in worst.items() if val > TOLERANCE]
    return QcCheck(
        name="会计恒等式(x = Z行和 + Y行和)",
        kind="经济含义",
        passed=n_bad == 0,
        detail=f"最大相对误差 {rel_diff.max():.4%},超容差({TOLERANCE:.0%})条目 {n_bad} 个",
        warnings=warnings,
    )


def check_leontief_inverse(io) -> QcCheck:
    """(I-A)@L ≈ I,且不存在**实质性**的 A 列和 ≥ 1(隐含增加值≤0)。

    列和≥1 在真实 ICIO 里并不罕见:某国某部门当年增加值为负(疫情下的航空运输、
    产出规模极小的部门被统计误差放大)都会触发。这类越界必须披露,但不足以判定
    整年数据不可用——矩阵逆本身仍精确成立。因此判定只看 substantive_bad
    (非 ROW 且产出≥1000),与 severity 的口径保持一致;其余仍以 warning 级别
    进入披露项,不会因为"通过"而从学生的披露清单里消失。
    """
    A, L = io.A.values, io.L.values
    identity = np.eye(A.shape[0])
    max_err = float(np.abs((identity - A) @ L - identity).max())

    col_sums = io.A.sum(axis=0)
    bad = col_sums[col_sums >= 1]
    warnings = []
    substantive_bad = []
    for idx in bad.index:
        output = float(io.x.loc[idx].iloc[0])
        if idx[0] != "ROW" and output >= 1000:
            substantive_bad.append(idx)
        note = (
            "ROW 为账户闭合构造的余项地区,可忽略"
            if idx[0] == "ROW"
            else "产出规模极小,大概率是统计误差放大,可忽略"
            if output < 1000
            else "⚠ 产出规模不小,建议核实数据/解析问题"
        )
        warnings.append(f"{idx}: 列和={bad[idx]:.4f},总产出={output:.1f} —— {note}")

    return QcCheck(
        name="里昂惕夫逆矩阵性质((I-A)L≈I,A列和<1)",
        kind="数值",
        passed=max_err < 1e-6 and not substantive_bad,
        detail=(
            f"(I-A)L 最大误差 {max_err:.2e},列和≥1 的部门 {len(bad)} 个"
            + (
                f"(其中 {len(substantive_bad)} 个产出规模不小,需核实)"
                if substantive_bad
                else "(均为 ROW 或极小规模,按披露项处理)"
                if len(bad)
                else ""
            )
        ),
        warnings=warnings,
        # 小规模部门的 A 列和越界仍须披露，但不足以阻断整套产物；矩阵
        # 逆性质失败或非 ROW 且产出不小的部门越界才是 fatal。
        severity=QC_FATAL if max_err >= 1e-6 or substantive_bad else QC_WARNING,
    )


def check_coverage(io) -> QcCheck:
    regions = set(io.get_regions())
    missing = [r for r in KEY_REGIONS if r not in regions]
    return QcCheck(
        name="国家/行业覆盖范围",
        kind="结构",
        passed=not missing,
        detail=f"{len(regions)} 个国家/地区 × {len(io.get_sectors())} 个行业"
        + (f",缺少关键国家: {missing}" if missing else ""),
    )


def run_all(io) -> list[QcCheck]:
    return [
        check_shapes(io),
        check_missing_and_negative(io),
        check_accounting_identity(io),
        check_leontief_inverse(io),
        check_coverage(io),
    ]


def check_controls_country(
    controls_df: pd.DataFrame,
    countries: list[str] | None = None,
    years: list[int] | None = None,
) -> list[QcCheck]:
    """国家-年份控制变量产物质检。

    controls_country.csv 是回归面板的重要右表:一旦 schema、维度或数值范围异常,
    DID/FE 控制变量会静默缺失或引入不可解释的尺度问题。因此这里独立检查
    country×year 完整性、数值有限性、构造恒等式和主要取值范围。
    """
    df = controls_df.copy()
    checks: list[QcCheck] = []

    missing_cols = [c for c in CONTROL_REQUIRED_COLUMNS if c not in df.columns]
    extra_cols = [c for c in df.columns if c not in CONTROL_REQUIRED_COLUMNS]
    checks.append(
        QcCheck(
            name="控制变量 schema(country/year + 控制列)",
            kind="结构",
            passed=not missing_cols,
            detail=(
                f"期望 {len(CONTROL_REQUIRED_COLUMNS)} 列,实际 {len(df.columns)} 列;"
                f"缺失 {len(missing_cols)} 列,额外 {len(extra_cols)} 列"
            ),
            warnings=[
                *[f"缺失列:{c}" for c in missing_cols[:8]],
                *[f"额外列:{c}" for c in extra_cols[:5]],
            ],
        )
    )
    if missing_cols:
        return checks

    countries = sorted(countries if countries is not None else df["country"].dropna().unique().tolist())
    years = sorted(int(y) for y in (years if years is not None else df["year"].dropna().unique().tolist()))
    expected = pd.MultiIndex.from_product([countries, years], names=["country", "year"])
    actual = pd.MultiIndex.from_frame(df[["country", "year"]])
    missing = expected.difference(actual)
    extra = actual.difference(expected)
    duplicated = int(actual.duplicated().sum())
    checks.append(
        QcCheck(
            name="控制变量维度对齐(country×year)",
            kind="结构",
            passed=len(missing) == 0 and len(extra) == 0 and duplicated == 0,
            detail=(
                f"期望 {len(expected)} 行,实际 {len(df)} 行;"
                f"缺失组合 {len(missing)} 个,额外组合 {len(extra)} 个,重复组合 {duplicated} 个"
            ),
            warnings=[
                *[f"缺失:{m}" for m in list(missing[:3])],
                *[f"额外:{m}" for m in list(extra[:3])],
            ],
        )
    )

    numeric = df[ALL_CONTROL_COLUMNS].apply(pd.to_numeric, errors="coerce")
    n_missing = int(numeric.isna().sum().sum())
    finite_mask = np.isfinite(numeric.to_numpy(dtype=float))
    n_non_finite = int(finite_mask.size - finite_mask.sum())
    checks.append(
        QcCheck(
            name="控制变量数值有限性",
            kind="数值",
            passed=n_missing == 0 and n_non_finite == 0,
            detail=f"缺失/非数值 {n_missing} 个,非有限值 {n_non_finite} 个",
            warnings=[
                f"{col}: 缺失/非数值 {int(numeric[col].isna().sum())} 个"
                for col in ALL_CONTROL_COLUMNS
                if numeric[col].isna().any()
            ][:6],
        )
    )

    identity_diff = (
        numeric["macro_log_gdp_usd"] - numeric["macro_log_population"] - numeric["macro_log_gdp_per_capita"]
    ).abs()
    max_identity_diff = float(identity_diff.max()) if len(identity_diff) else 0.0
    base = df.assign(_row=np.arange(len(df))).sort_values(["country", "year"])
    first_idx = base.groupby("country", sort=False)["_row"].first().to_numpy()
    base_checks = []
    for col, expected_value in [
        ("trade_gross_exports_index", 1.0),
        ("prod_va_total_index", 1.0),
        ("gdp_deflator", 1.0),
    ]:
        vals = numeric.iloc[first_idx][col]
        bad = int((vals - expected_value).abs().gt(1e-9).sum())
        if bad:
            base_checks.append(f"{col} 首年不等于 {expected_value:g}: {bad} 国")
    checks.append(
        QcCheck(
            name="控制变量构造恒等式",
            kind="经济含义",
            passed=max_identity_diff < 1e-9 and not base_checks,
            detail=f"log GDP - log population - log per capita 最大误差 {max_identity_diff:.2e}",
            warnings=base_checks,
        )
    )

    range_specs = {
        "export_intensity": (0.0, 10.0),
        "manufacturing_va_share": (0.0, 1.0),
        "services_va_share": (0.0, 1.0),
        "trade_gross_exports_index": (0.0, np.inf),
        "prod_va_total_index": (0.0, np.inf),
        "macro_exchange_rate_change": (-0.20, 0.20),
        "macro_fdi_inflow_gdp": (0.0, 0.25),
        "gdp_deflator": (0.0, np.inf),
        "inflation_rate": (0.0, 0.20),
    }
    range_warnings = []
    for col, (lo, hi) in range_specs.items():
        bad = numeric[col].lt(lo) | numeric[col].gt(hi)
        if bad.any():
            range_warnings.append(f"{col} 超出 [{lo:g},{hi:g}] 共 {int(bad.sum())} 行")
    share_sum = numeric["manufacturing_va_share"] + numeric["services_va_share"]
    bad_share_sum = int(share_sum.gt(1.05).sum())
    if bad_share_sum:
        range_warnings.append(f"制造业+服务业份额超过 105% 共 {bad_share_sum} 行")
    checks.append(
        QcCheck(
            name="控制变量经济范围",
            kind="经济含义",
            passed=not range_warnings,
            detail="份额、指数、通胀/汇率/FDI mock 均在预设范围内" if not range_warnings else "存在越界值",
            warnings=range_warnings[:8],
        )
    )

    return checks


def check_shock_panel(
    shock_df: pd.DataFrame,
    countries: list[str],
    sectors: list[str],
    years: list[int],
    treated_threshold: float = 0.001,
) -> list[QcCheck]:
    """政策冲击面板质检。

    目标是补齐步骤11的第二类数据质检:冲击面板必须覆盖完整
    country×sector×year,与 ICIO 指标维度严格对齐,且事件时间线与
    treated 标记可用于 DID / 事件研究。
    """
    df = shock_df.copy()
    checks: list[QcCheck] = []

    missing_cols = [c for c in SHOCK_COLUMNS if c not in df.columns]
    if missing_cols:
        return [
            QcCheck(
                name="冲击面板 schema",
                kind="结构",
                passed=False,
                detail="缺少必要列:" + "、".join(missing_cols),
            )
        ]

    expected = pd.MultiIndex.from_product([countries, sectors, years], names=["country", "sector", "year"])
    actual = pd.MultiIndex.from_frame(df[["country", "sector", "year"]])
    missing = expected.difference(actual)
    extra = actual.difference(expected)
    duplicated = int(actual.duplicated().sum())
    checks.append(
        QcCheck(
            name="冲击面板维度对齐(country×sector×year)",
            kind="结构",
            passed=len(missing) == 0 and len(extra) == 0 and duplicated == 0,
            detail=(
                f"期望 {len(expected)} 行,实际 {len(df)} 行;"
                f"缺失组合 {len(missing)} 个,额外组合 {len(extra)} 个,重复组合 {duplicated} 个"
            ),
            warnings=[
                *[f"缺失:{m}" for m in list(missing[:3])],
                *[f"额外:{m}" for m in list(extra[:3])],
            ],
        )
    )

    present_pairs = [(s, t) for s, t in SHOCK_VALUE_PAIRS if s in df.columns and t in df.columns]
    missing_values = 0
    out_rows = []
    numeric_shocks = {}
    for shock_col, _treated_col in present_pairs:
        shock = pd.to_numeric(df[shock_col], errors="coerce")
        numeric_shocks[shock_col] = shock
        missing_values += int(shock.isna().sum())
        bad = df[(shock < 0) | (shock > 0.5)].copy()
        if not bad.empty:
            bad["_shock_col"] = shock_col
            out_rows.append(bad)
    out_of_range = pd.concat(out_rows, ignore_index=True) if out_rows else pd.DataFrame()
    checks.append(
        QcCheck(
            name="冲击强度值域(*_shock ∈ [0,0.5])",
            kind="数值",
            passed=missing_values == 0 and out_of_range.empty,
            detail=f"检查 {len(present_pairs)} 类冲击;缺失/非数值 {missing_values} 个,越界 {len(out_of_range)} 个",
            warnings=[
                f"{r['country']}-{r['sector']}-{r['year']}: {r['_shock_col']}={r[r['_shock_col']]}"
                for _, r in out_of_range.head(5).iterrows()
            ],
        )
    )

    missing_dates = pd.Series(False, index=df.index)
    reversed_dates = pd.Series(False, index=df.index)
    hit_total = 0
    for shock_col, ann_col, eff_col in SHOCK_DATE_COLUMNS:
        if shock_col not in numeric_shocks or ann_col not in df.columns or eff_col not in df.columns:
            continue
        hit = numeric_shocks[shock_col] > 0
        hit_total += int(hit.sum())
        ann = pd.to_datetime(df[ann_col].replace("", pd.NA), errors="coerce")
        eff = pd.to_datetime(df[eff_col].replace("", pd.NA), errors="coerce")
        missing_dates |= hit & (ann.isna() | eff.isna())
        reversed_dates |= hit & ann.notna() & eff.notna() & (ann > eff)
    checks.append(
        QcCheck(
            name="冲击事件时间线(宣布日≤生效日)",
            kind="结构",
            passed=not missing_dates.any() and not reversed_dates.any(),
            detail=f"受冲击记录 {hit_total} 条;缺少日期 {int(missing_dates.sum())} 条,日期倒置 {int(reversed_dates.sum())} 条",
            warnings=[
                f"{r.country}-{r.sector}-{r.year}: announced={r.announced_date}, effective={r.effective_date}"
                for r in df[missing_dates | reversed_dates].head(5).itertuples(index=False)
            ],
        )
    )

    invalid_treated = pd.Series(False, index=df.index)
    mismatch = pd.Series(False, index=df.index)
    for shock_col, treated_col in present_pairs:
        shock = numeric_shocks[shock_col]
        treated = pd.to_numeric(df[treated_col], errors="coerce")
        invalid_treated |= ~treated.isin([0, 1])
        mismatch |= treated.fillna(-1).astype(int) != (shock > treated_threshold).astype(int)
    checks.append(
        QcCheck(
            name="treated 标记与阈值一致",
            kind="数值",
            passed=not invalid_treated.any() and not mismatch.any(),
            detail=(
                f"非法 treated 值 {int(invalid_treated.sum())} 个;"
                f"与 *_shock>{treated_threshold:g} 不一致 {int(mismatch.sum())} 个"
            ),
            warnings=[
                f"{r['country']}-{r['sector']}-{r['year']}: "
                + "; ".join(f"{s}={r[s]}, {t}={r[t]}" for s, t in present_pairs)
                for _, r in df[invalid_treated | mismatch].head(5).iterrows()
            ],
        )
    )

    total_pairs = max(len(countries) * len(sectors), 1)
    yearly = []
    bad_years = []
    main_shock = numeric_shocks.get("tariff_shock", pd.Series(0.0, index=df.index))
    main_treated = (
        pd.to_numeric(df["treated"], errors="coerce") if "treated" in df.columns else pd.Series(0, index=df.index)
    )
    for year, g in df.assign(_shock=main_shock, _treated=main_treated).groupby("year"):
        share = float((g["_treated"] == 1).sum() / total_pairs)
        mean_hit = float(g.loc[g["_treated"] == 1, "_shock"].mean()) if (g["_treated"] == 1).any() else 0.0
        yearly.append(f"{int(year)}:处理组合占比 {share:.2%},受处理均值 {mean_hit:.3%}")
        if g["_shock"].gt(0).any() and not (0 < share <= 0.25):
            bad_years.append(int(year))
    checks.append(
        QcCheck(
            name="处理组覆盖比例合理性",
            kind="经济含义",
            passed=not bad_years,
            detail="; ".join(yearly),
            warnings=[f"{y} 年处理组合占比超出 (0,25%] 合理区间" for y in bad_years],
        )
    )

    return checks
