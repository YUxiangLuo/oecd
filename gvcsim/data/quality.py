"""步骤3:数据质检 —— validate_icio.py 的结构化重构版。

每个检查返回 QcCheck(可序列化),供 CLI 打印和 API 前端渲染共用。
检查内容与原脚本一致:维度一致性、缺失值/负值、会计恒等式、
里昂惕夫逆矩阵数学性质、国家/行业覆盖范围。
"""

from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

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


@dataclass
class QcCheck:
    name: str            # 质检项名称
    kind: str            # 类型(结构 / 数值 / 经济含义)
    passed: bool
    detail: str = ""
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def check_shapes(io) -> QcCheck:
    n = len(io.get_regions()) * len(io.get_sectors())
    bad = [
        f"{name}{df.shape}"
        for name, df in [("Z", io.Z), ("Y", io.Y), ("x", io.x)]
        if df.shape[0] != n
    ]
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
            warnings.append(
                f"{name} 存在 {n_neg} 个负值(通常是库存变化等特殊科目,需人工确认)"
            )
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
    """(I-A)@L ≈ I,且 A 列和 < 1(否则隐含增加值≤0,矩阵接近奇异)。"""
    A, L = io.A.values, io.L.values
    identity = np.eye(A.shape[0])
    max_err = float(np.abs((identity - A) @ L - identity).max())

    col_sums = io.A.sum(axis=0)
    bad = col_sums[col_sums >= 1]
    warnings = []
    for idx in bad.index:
        output = float(io.x.loc[idx].iloc[0])
        note = (
            "ROW 为账户闭合构造的余项地区,可忽略" if idx[0] == "ROW"
            else "产出规模极小,大概率是统计误差放大,可忽略" if output < 1000
            else "⚠ 产出规模不小,建议核实数据/解析问题"
        )
        warnings.append(f"{idx}: 列和={bad[idx]:.4f},总产出={output:.1f} —— {note}")

    return QcCheck(
        name="里昂惕夫逆矩阵性质((I-A)L≈I,A列和<1)",
        kind="数值",
        passed=max_err < 1e-6 and len(bad) == 0,
        detail=f"(I-A)L 最大误差 {max_err:.2e},列和≥1 的部门 {len(bad)} 个",
        warnings=warnings,
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


def check_shock_panel(
    shock_df: pd.DataFrame,
    countries: list[str],
    sectors: list[str],
    years: list[int],
    treated_threshold: float = 0.001,
) -> list[QcCheck]:
    """政策冲击面板质检。

    目标是补齐步骤3的第二类数据质检:冲击面板必须覆盖完整
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

    expected = pd.MultiIndex.from_product(
        [countries, sectors, years], names=["country", "sector", "year"]
    )
    actual = pd.MultiIndex.from_frame(df[["country", "sector", "year"]])
    missing = expected.difference(actual)
    extra = actual.difference(expected)
    duplicated = int(actual.duplicated().sum())
    checks.append(QcCheck(
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
    ))

    shock = pd.to_numeric(df["tariff_shock"], errors="coerce")
    n_missing = int(shock.isna().sum())
    out_of_range = df[(shock < 0) | (shock > 0.5)]
    checks.append(QcCheck(
        name="冲击强度值域(tariff_shock ∈ [0,0.5])",
        kind="数值",
        passed=n_missing == 0 and out_of_range.empty,
        detail=f"缺失/非数值 {n_missing} 个,越界 {len(out_of_range)} 个",
        warnings=[
            f"{r.country}-{r.sector}-{r.year}: {r.tariff_shock}"
            for r in out_of_range.head(5).itertuples(index=False)
        ],
    ))

    hit = shock > 0
    ann = pd.to_datetime(df["announced_date"].replace("", pd.NA), errors="coerce")
    eff = pd.to_datetime(df["effective_date"].replace("", pd.NA), errors="coerce")
    missing_dates = hit & (ann.isna() | eff.isna())
    reversed_dates = hit & ann.notna() & eff.notna() & (ann > eff)
    checks.append(QcCheck(
        name="冲击事件时间线(宣布日≤生效日)",
        kind="结构",
        passed=not missing_dates.any() and not reversed_dates.any(),
        detail=f"受冲击记录 {int(hit.sum())} 条;缺少日期 {int(missing_dates.sum())} 条,日期倒置 {int(reversed_dates.sum())} 条",
        warnings=[
            f"{r.country}-{r.sector}-{r.year}: announced={r.announced_date}, effective={r.effective_date}"
            for r in df[missing_dates | reversed_dates].head(5).itertuples(index=False)
        ],
    ))

    treated = pd.to_numeric(df["treated"], errors="coerce")
    invalid_treated = ~treated.isin([0, 1])
    mismatch = treated.fillna(-1).astype(int) != (shock > treated_threshold).astype(int)
    checks.append(QcCheck(
        name="treated 标记与阈值一致",
        kind="数值",
        passed=not invalid_treated.any() and not mismatch.any(),
        detail=(
            f"非法 treated 值 {int(invalid_treated.sum())} 个;"
            f"与 tariff_shock>{treated_threshold:g} 不一致 {int(mismatch.sum())} 个"
        ),
        warnings=[
            f"{r.country}-{r.sector}-{r.year}: shock={r.tariff_shock}, treated={r.treated}"
            for r in df[invalid_treated | mismatch].head(5).itertuples(index=False)
        ],
    ))

    total_pairs = max(len(countries) * len(sectors), 1)
    yearly = []
    bad_years = []
    for year, g in df.assign(_shock=shock, _treated=treated).groupby("year"):
        share = float((g["_treated"] == 1).sum() / total_pairs)
        mean_hit = float(g.loc[g["_treated"] == 1, "_shock"].mean()) if (g["_treated"] == 1).any() else 0.0
        yearly.append(f"{int(year)}:处理组合占比 {share:.2%},受处理均值 {mean_hit:.3%}")
        if g["_shock"].gt(0).any() and not (0 < share <= 0.25):
            bad_years.append(int(year))
    checks.append(QcCheck(
        name="处理组覆盖比例合理性",
        kind="经济含义",
        passed=not bad_years,
        detail="; ".join(yearly),
        warnings=[f"{y} 年处理组合占比超出 (0,25%] 合理区间" for y in bad_years],
    ))

    return checks
