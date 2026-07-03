"""
OECD ICIO 数据校验脚本

用法:
    uv run python validate_icio.py

前提: 已经用 download_icio.py 下载并 parse 过数据,
且 OECD_ICIO 目录下有对应年份的数据。
"""

import numpy as np
import pandas as pd
import pymrio
from pathlib import Path

# ============ 配置区 ============
DATA_DIR = Path("./OECD_ICIO")
YEAR = 2018
# 会计恒等式允许的相对误差(超过这个比例视为异常)
TOLERANCE = 0.01
# =================================


def section(title: str):
    print("\n" + "=" * 60)
    print(title)
    print("=" * 60)


def check_shapes(io):
    section("1. 维度一致性检查")
    n_regions = len(io.get_regions())
    n_sectors = len(io.get_sectors())
    expected_dim = n_regions * n_sectors
    print(f"地区数: {n_regions}, 行业数: {n_sectors}, 期望矩阵维度: {expected_dim}")

    checks = {
        "Z (中间使用矩阵)": io.Z.shape,
        "Y (最终需求矩阵)": io.Y.shape,
        "x (总产出向量)": io.x.shape,
    }
    ok = True
    for name, shape in checks.items():
        row_ok = shape[0] == expected_dim
        status = "✓" if row_ok else "✗ 异常"
        print(f"  {name}: {shape}  {status}")
        ok = ok and row_ok
    return ok


def check_missing_and_negative(io):
    section("2. 缺失值 / 负值检查")
    ok = True

    for name, df in [("Z", io.Z), ("Y", io.Y)]:
        n_nan = df.isna().sum().sum()
        n_neg = (df < 0).sum().sum()
        print(f"  {name}: NaN数量={n_nan}, 负值数量={n_neg}")
        if n_nan > 0:
            print(f"    ⚠ 存在缺失值,建议检查具体位置: df.isna().any(axis=1)")
            ok = False
        if n_neg > 0:
            print(f"    ⚠ 中间流量/最终需求出现负值,通常代表库存变化等特殊科目,需人工确认是否合理")

    if hasattr(io, "x") and io.x is not None:
        n_neg_x = (io.x.iloc[:, 0] < 0).sum()
        print(f"  x (总产出): 负值数量={n_neg_x}")
        if n_neg_x > 0:
            ok = False
    return ok


def check_accounting_identity(io):
    """
    核心会计恒等式: 总产出 x = 中间使用行和 + 最终需求行和
    即 x_i = sum_j(Z_ij) + sum_k(Y_ik)
    """
    section("3. 会计恒等式检查 (总产出 = 中间使用 + 最终需求)")

    row_sum_Z = io.Z.sum(axis=1)
    row_sum_Y = io.Y.sum(axis=1)
    computed_x = row_sum_Z + row_sum_Y
    reported_x = io.x.iloc[:, 0]

    diff = (computed_x - reported_x).abs()
    rel_diff = diff / reported_x.replace(0, np.nan)

    n_bad = (rel_diff > TOLERANCE).sum()
    max_rel_diff = rel_diff.max()

    print(f"  检查条目数: {len(reported_x)}")
    print(f"  超过{TOLERANCE:.0%}相对误差的条目数: {n_bad}")
    print(f"  最大相对误差: {max_rel_diff:.4%}")

    if n_bad > 0:
        print("\n  误差最大的5个 (region, sector):")
        worst = rel_diff.sort_values(ascending=False).head(5)
        for idx, val in worst.items():
            print(f"    {idx}: 相对误差 {val:.4%} "
                  f"(计算值={computed_x[idx]:.1f}, 报告值={reported_x[idx]:.1f})")
        return False

    print("  ✓ 会计恒等式基本成立")
    return True


def check_leontief_inverse(io):
    """
    检验里昂惕夫逆矩阵性质: L = (I - A)^-1
    验证方式: (I - A) @ L 应该约等于单位矩阵
    """
    section("4. 里昂惕夫逆矩阵 (L) 正确性检查")

    if io.A is None or io.L is None:
        print("  ✗ A 或 L 矩阵不存在,请先执行 io.calc_all()")
        return False

    A = io.A.values
    L = io.L.values
    I = np.eye(A.shape[0])

    residual = (I - A) @ L - I
    max_abs_error = np.abs(residual).max()

    print(f"  A 矩阵维度: {A.shape}")
    print(f"  L 矩阵维度: {L.shape}")
    print(f"  (I-A)@L 与单位矩阵的最大绝对误差: {max_abs_error:.2e}")

    # 技术系数矩阵每列之和应小于1 (否则经济不可持续,数值上会导致L出现负值或发散)
    # 原理: 列和 = 中间投入/总产出 = 1 - 增加值/总产出, 所以列和>=1 等价于 增加值<=0
    col_sums_A = io.A.sum(axis=0)
    bad = col_sums_A[col_sums_A >= 1]
    n_unstable = len(bad)
    print(f"  A矩阵列和 >= 1 的部门数: {n_unstable} (应为0,否则说明存在数值不稳定风险)")

    if n_unstable > 0:
        print("\n  --- 诊断: 列和>=1 的具体(国家,行业)明细 ---")
        for idx in bad.index:
            output = io.x.loc[idx].iloc[0]
            intermediate_input = io.Z[idx].sum()
            implied_va = output - intermediate_input
            print(f"    {idx}: 列和={bad[idx]:.6f}  "
                  f"总产出={output:.2f}  中间投入={intermediate_input:.2f}  "
                  f"隐含增加值={implied_va:.2f}")
            if idx[0] == "ROW":
                print("      → 注: ROW是OECD为账户闭合构造的余项地区,数据质量本身较低,此类异常可忽略")
            elif output < 1000:  # 阈值可按数据单位(通常是百万美元)调整
                print("      → 注: 该部门总产出规模很小,大概率是统计误差被放大导致,通常可忽略")
            else:
                print("      → ⚠ 该部门产出规模不小,建议进一步核实是否为数据/解析问题")
        print()

    ok = max_abs_error < 1e-6 and n_unstable == 0
    print(f"  {'✓ 里昂惕夫逆矩阵校验通过' if ok else '△ 存在边界异常,详见上方诊断明细'}")
    return ok


def check_region_sector_coverage(io, expected_regions=None):
    section("5. 国家/行业覆盖范围检查")
    regions = list(io.get_regions())
    sectors = list(io.get_sectors())
    print(f"  实际国家/地区数: {len(regions)}")
    print(f"  实际行业数: {len(sectors)}")

    if expected_regions:
        missing = set(expected_regions) - set(regions)
        if missing:
            print(f"  ⚠ 缺少预期国家: {missing}")
        else:
            print("  ✓ 关键国家均存在")
    return regions, sectors


def main():
    print(f"正在加载 {YEAR} 年数据: {DATA_DIR}")
    io = pymrio.parse_oecd(path=DATA_DIR, year=YEAR)

    # 确保核心矩阵已计算(A, L, x等)
    if io.A is None or io.L is None:
        print("尚未计算 A/L 矩阵,正在执行 calc_all()...")
        io.calc_all()

    results = {}
    results["维度检查"] = check_shapes(io)
    results["缺失值/负值检查"] = check_missing_and_negative(io)
    results["会计恒等式检查"] = check_accounting_identity(io)
    results["里昂惕夫逆矩阵检查"] = check_leontief_inverse(io)
    check_region_sector_coverage(io, expected_regions=["CHN", "USA", "JPN", "DEU"])

    section("汇总结果")
    all_ok = True
    for name, ok in results.items():
        status = "✓ 通过" if ok else "✗ 未通过"
        print(f"  {name}: {status}")
        all_ok = all_ok and ok

    print("\n" + ("数据整体校验通过,可以放心用于后续分析。" if all_ok
                   else "存在异常项,建议查看上方细节后再决定是否使用。"))


if __name__ == "__main__":
    main()
