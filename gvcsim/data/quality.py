"""步骤3:数据质检 —— validate_icio.py 的结构化重构版。

每个检查返回 QcCheck(可序列化),供 CLI 打印和 API 前端渲染共用。
检查内容与原脚本一致:维度一致性、缺失值/负值、会计恒等式、
里昂惕夫逆矩阵数学性质、国家/行业覆盖范围。
"""

from dataclasses import asdict, dataclass, field

import numpy as np

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
