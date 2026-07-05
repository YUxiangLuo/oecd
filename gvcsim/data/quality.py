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


def check_shock_dimensions(
    shock_df: pd.DataFrame,
    countries: list[str],
    sectors: list[str],
    years: list[int],
) -> QcCheck:
    """Shock panel must cover exactly the ICIO country-sector-year grid."""
    required = {"country", "sector", "year"}
    missing_cols = required - set(shock_df.columns)
    if missing_cols:
        return QcCheck(
            name="冲击面板维度对齐(country×sector×year)",
            kind="结构",
            passed=False,
            detail="缺少字段:" + "、".join(sorted(missing_cols)),
        )

    expected = pd.MultiIndex.from_product(
        [countries, sectors, years], names=["country", "sector", "year"]
    )
    observed = pd.MultiIndex.from_frame(shock_df[["country", "sector", "year"]])
    missing = expected.difference(observed)
    extra = observed.difference(expected)
    dup = int(observed.duplicated().sum())
    warnings = []
    if len(missing):
        warnings.append(f"缺少组合 {len(missing)} 个,示例:{list(missing[:3])}")
    if len(extra):
        warnings.append(f"超出 ICIO 维度组合 {len(extra)} 个,示例:{list(extra[:3])}")
    if dup:
        warnings.append(f"重复组合 {dup} 个")
    return QcCheck(
        name="冲击面板维度对齐(country×sector×year)",
        kind="结构",
        passed=not missing_cols and len(missing) == 0 and len(extra) == 0 and dup == 0,
        detail=f"期望 {len(expected)} 行,实际 {len(shock_df)} 行",
        warnings=warnings,
    )


def check_shock_values(
    shock_df: pd.DataFrame,
    treated_threshold: float = 0.001,
    max_shock: float = 0.5,
) -> QcCheck:
    required = {"tariff_shock", "treated"}
    missing_cols = required - set(shock_df.columns)
    if missing_cols:
        return QcCheck(
            name="冲击强度缺失值 / 值域 / treated 一致性",
            kind="数值",
            passed=False,
            detail="缺少字段:" + "、".join(sorted(missing_cols)),
        )
    shock = pd.to_numeric(shock_df["tariff_shock"], errors="coerce")
    treated = pd.to_numeric(shock_df["treated"], errors="coerce")
    n_nan = int(shock.isna().sum() + treated.isna().sum())
    out_of_bounds = int((~shock.between(0, max_shock)).sum())
    mismatch = int(((shock > treated_threshold) != (treated == 1)).sum())
    warnings = []
    if n_nan:
        warnings.append(f"tariff_shock/treated 存在 {n_nan} 个缺失或非数值")
    if out_of_bounds:
        warnings.append(f"tariff_shock 超出 [0,{max_shock}] 的记录 {out_of_bounds} 条")
    if mismatch:
        warnings.append(f"treated 与阈值 {treated_threshold:.4f} 不一致 {mismatch} 条")
    return QcCheck(
        name="冲击强度缺失值 / 值域 / treated 一致性",
        kind="数值",
        passed=n_nan == 0 and out_of_bounds == 0 and mismatch == 0,
        detail=f"tariff_shock 范围 [{shock.min():.4f},{shock.max():.4f}],"
        f"treated 阈值 {treated_threshold:.4f}",
        warnings=warnings,
    )


def check_shock_timeline(shock_df: pd.DataFrame) -> QcCheck:
    required = {"tariff_shock", "announced_date", "effective_date", "note"}
    missing_cols = required - set(shock_df.columns)
    if missing_cols:
        return QcCheck(
            name="冲击事件时间线完整性",
            kind="经济含义",
            passed=False,
            detail="缺少字段:" + "、".join(sorted(missing_cols)),
        )

    hit = shock_df[pd.to_numeric(shock_df["tariff_shock"], errors="coerce") > 0].copy()
    if hit.empty:
        return QcCheck(
            name="冲击事件时间线完整性",
            kind="经济含义",
            passed=False,
            detail="没有任何正冲击记录",
        )
    ann_missing = int((hit["announced_date"].astype(str) == "").sum())
    eff_missing = int((hit["effective_date"].astype(str) == "").sum())
    note_missing = int((hit["note"].astype(str) == "").sum())
    announced = pd.to_datetime(hit["announced_date"], errors="coerce")
    effective = pd.to_datetime(hit["effective_date"], errors="coerce")
    invalid_date = int((announced.isna() | effective.isna()).sum())
    reversed_date = int((announced > effective).sum())
    warnings = []
    if ann_missing or eff_missing or note_missing:
        warnings.append(
            f"正冲击记录缺少宣布/生效/事件说明: {ann_missing}/{eff_missing}/{note_missing}"
        )
    if invalid_date:
        warnings.append(f"日期无法解析 {invalid_date} 条")
    if reversed_date:
        warnings.append(f"宣布日期晚于生效日期 {reversed_date} 条")
    return QcCheck(
        name="冲击事件时间线完整性",
        kind="经济含义",
        passed=ann_missing == 0 and eff_missing == 0 and note_missing == 0
        and invalid_date == 0 and reversed_date == 0,
        detail=f"正冲击记录 {len(hit)} 条,均应带宣布/生效日期与事件说明",
        warnings=warnings,
    )


def check_shock_treatment_coverage(shock_df: pd.DataFrame) -> QcCheck:
    required = {"country", "year", "treated"}
    missing_cols = required - set(shock_df.columns)
    if missing_cols:
        return QcCheck(
            name="处理组覆盖范围",
            kind="经济含义",
            passed=False,
            detail="缺少字段:" + "、".join(sorted(missing_cols)),
        )
    treated = pd.to_numeric(shock_df["treated"], errors="coerce").fillna(0)
    n_treated = int((treated == 1).sum())
    n_total = len(shock_df)
    by_year = (
        shock_df.assign(_treated=(treated == 1).astype(int))
        .groupby("year")["_treated"].mean()
        .sort_index()
    )
    warnings = [
        f"{int(y)} 年处理比例 {share:.1%}"
        for y, share in by_year.items()
        if share > 0.6
    ]
    return QcCheck(
        name="处理组覆盖范围",
        kind="经济含义",
        passed=0 < n_treated < n_total,
        detail=f"受处理国家–行业–年份 {n_treated}/{n_total} 条;"
        f"覆盖 {shock_df.loc[treated == 1, 'country'].nunique()} 个经济体",
        warnings=warnings,
    )


def run_shock_panel(
    shock_df: pd.DataFrame,
    countries: list[str],
    sectors: list[str],
    years: list[int],
    treated_threshold: float = 0.001,
) -> list[QcCheck]:
    return [
        check_shock_dimensions(shock_df, countries, sectors, years),
        check_shock_values(shock_df, treated_threshold),
        check_shock_timeline(shock_df),
        check_shock_treatment_coverage(shock_df),
    ]
