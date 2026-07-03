"""
GVC (全球价值链) 核心指标计算脚本

计算三个最常用的GVC指标:
  1. 上游度 (Upstreamness)      —— 这个行业离"最终消费者"有多远
  2. 后向GVC参与度 (Backward)   —— 我的出口里,有多少其实是"进口的中间品"
  3. 前向GVC参与度 (Forward)    —— 我卖给别人的中间品,有多少又被别人转手出口了

用法:
    uv run python gvc_indicators.py

前提: 已用 download_icio.py 下载好数据,OECD_ICIO 目录下有对应年份数据。

⚠️ 方法论说明(诚实告知,不要被"指标"两个字唬住):
本脚本用的是学界常见的"简化版"分解方法,不是完整的
Koopman-Wang-Wei (2014) 多国增加值分解(那个方法要处理"来回绕圈"的
增加值,数学上复杂得多)。简化版对大多数探索性分析、回归实验的数量级
和排序结论是可靠的,但如果你以后要投论文追求小数点后精确到位,
需要换成专门的分解工具(比如 decompr 这个R包,或直接实现KWW分解)。
"""

import numpy as np
import pandas as pd
import pymrio
from pathlib import Path

DATA_DIR = Path("./OECD_ICIO")
YEAR = 2018


def load_data():
    io = pymrio.parse_oecd(path=DATA_DIR, year=YEAR)
    if io.A is None or io.L is None:
        print("尚未计算 A/L 矩阵,正在执行 calc_all()...")
        io.calc_all()
    return io


def compute_value_added(io):
    """
    增加值 = 总产出 - 中间投入
    va_j = x_j - sum_i(Z_ij)   即用掉的中间品总额从总产出里扣掉,剩下的就是增加值
    (工资、利润、税收等,这部分不会再流向下一轮生产)
    """
    va = io.x.iloc[:, 0] - io.Z.sum(axis=0)
    return va


def compute_upstreamness(io):
    """
    Antras-Chor (2012) 上游度指标。

    直觉: 如果你的产出100%直接卖给消费者,你就是"最下游",U=1。
    如果你的产出要经过好几道加工才能到消费者手里(比如钢铁->零件->整车->4S店),
    你就"更上游",U会更大。

    公式: Ad_ij = Z_ij / x_i  (按行业i的总产出分摊,而不是按购买方j的总产出分摊,
    这是和技术系数矩阵A方向相反的地方,不要弄混)
    U = (I - Ad)^(-1) @ 全1向量
    """
    x = io.x.iloc[:, 0]

    # 诊断: 找出总产出为0的行业(这些行业除法会产生 0/0=NaN 或 非零/0=inf)
    zero_output = x[x == 0]
    if len(zero_output) > 0:
        print(f"  ⚠ 发现 {len(zero_output)} 个总产出为0的行业(通常是极小经济体没有该产业),"
              f"已将其分摊行置0处理: {list(zero_output.index)[:5]}"
              f"{' ...' if len(zero_output) > 5 else ''}")

    Ad = io.Z.div(x, axis=0)  # 按行(i)除,不是按列
    # 产出为0的行业没有任何东西可分摊,分摊行本来就该是全0,清理NaN/inf
    Ad = Ad.replace([np.inf, -np.inf], np.nan).fillna(0)

    n = Ad.shape[0]
    I = np.eye(n)
    try:
        U = np.linalg.solve(I - Ad.values, np.ones(n))
    except np.linalg.LinAlgError:
        print("  ⚠ 矩阵仍然奇异,改用最小二乘法(lstsq)求近似解")
        U, *_ = np.linalg.lstsq(I - Ad.values, np.ones(n), rcond=None)

    return pd.Series(U, index=io.Z.index, name="upstreamness")


def compute_gross_exports(io, regions):
    """
    国家r对全世界的出口总额,按r自己的每个行业分开算。
    出口 = 卖给别国当中间品用的部分(Z) + 卖给别国最终消费者的部分(Y)
    注意要把"卖给自己国内"的部分排除掉,那不算出口。
    """
    exports = pd.Series(0.0, index=io.Z.index)
    for r in regions:
        z_r = io.Z.loc[r]  # 行=r的45个行业, 列=全世界所有(国家,行业)
        y_r = io.Y.loc[r]

        z_export = z_r.loc[:, z_r.columns.get_level_values(0) != r].sum(axis=1)
        y_export = y_r.loc[:, y_r.columns.get_level_values(0) != r].sum(axis=1)

        exports.loc[r] = (z_export + y_export).values
    exports.name = "gross_exports"
    return exports


def compute_backward_participation(io, va, exports, regions):
    """
    后向GVC参与度 = 出口里"外国增加值"占的比例。

    直觉: 如果一个国家的出口品,原材料/零部件大量依赖进口
    (比如组装iPhone,芯片是韩国造的,只是在你这里拧螺丝),
    这个比例就高,说明这个国家在GVC里更"下游/依赖进口"。

    简化算法(只用本国内部的里昂惕夫子块 L_rr,忽略增加值"出国转一圈又回来"
    这种小概率情况):
        本国增加值含量 DVA_r = 本国增加值系数 · L_rr · 本国出口向量
        外国增加值占比 = 1 - DVA_r / 出口总额
    """
    results = {}
    for r in regions:
        b_r = (va.loc[r] / io.x.loc[r].iloc[:, 0]).replace([np.inf, -np.inf], np.nan).fillna(0)
        L_rr = io.L.loc[r, r]  # 本国内部的里昂惕夫子块 (45x45)
        ex_r = exports.loc[r]

        dva_r = b_r.values @ L_rr.values @ ex_r.values
        ex_total = ex_r.sum()
        fva_share = 1 - dva_r / ex_total if ex_total > 0 else np.nan

        results[r] = {
            "gross_exports": ex_total,
            "domestic_VA_in_exports": dva_r,
            "backward_participation_FVA_share": fva_share,
        }
    return pd.DataFrame(results).T


def compute_forward_participation(io, va, exports, regions):
    """
    前向GVC参与度 = 我供货给别的国家,别的国家又把它转手出口给第三国的比例。

    直觉: 如果你是原材料/零部件大国(比如卖芯片、卖石油),
    你的增加值经常"藏"在别人出口的商品里,这个比例就高,
    说明你在GVC里更"上游/被别人依赖"。

    算法: 对每个国家s(s≠r), 算出"r的增加值,嵌入在s对全世界出口里"的金额:
        r的VA嵌入s的出口 = r的增加值系数 · L_rs(r到s的里昂惕夫子块) · s的出口向量
    把所有s加总,再除以r自己的出口总额做成一个可比的比例。
    """
    b = {
        r: (va.loc[r] / io.x.loc[r].iloc[:, 0]).replace([np.inf, -np.inf], np.nan).fillna(0)
        for r in regions
    }

    results = {}
    for r in regions:
        total_indirect = 0.0
        for s in regions:
            if s == r:
                continue
            L_rs = io.L.loc[r, s]
            ex_s = exports.loc[s]
            total_indirect += b[r].values @ L_rs.values @ ex_s.values

        ex_r_total = exports.loc[r].sum()
        forward_ratio = total_indirect / ex_r_total if ex_r_total > 0 else np.nan

        results[r] = {
            "indirect_VA_in_others_exports": total_indirect,
            "forward_participation_ratio": forward_ratio,
        }
    return pd.DataFrame(results).T


def main():
    print(f"加载 {YEAR} 年 OECD ICIO 数据...")
    io = load_data()
    regions = list(io.get_regions())

    print("\n[1/4] 计算增加值向量...")
    va = compute_value_added(io)

    print("[2/4] 计算上游度指标 (按国家取行业产出加权平均)...")
    upstream = compute_upstreamness(io)
    # 简单算术平均会被"一堆小行业"拉偏,改用产出份额加权,
    # 让真正主导该国经济的大行业(比如尼日利亚的石油开采业)的信号不被稀释
    output_weights = io.x.iloc[:, 0]
    weighted = (upstream * output_weights)
    upstream_by_country = (
        weighted.groupby(level=0).sum() / output_weights.groupby(level=0).sum()
    )
    print("  上游度最高的5个国家(离最终消费者最远,原材料/资本品导向):")
    print(upstream_by_country.sort_values(ascending=False).head(5).to_string())
    print("  上游度最低的5个国家(离最终消费者最近,零售/服务业导向):")
    print(upstream_by_country.sort_values().head(5).to_string())

    print("\n[3/4] 计算各国出口总额与后向GVC参与度...")
    exports = compute_gross_exports(io, regions)
    backward = compute_backward_participation(io, va, exports, regions)
    print("  后向参与度最高的5国(出口里外国增加值占比最高,即进口依赖度最高):")
    print(backward.sort_values("backward_participation_FVA_share", ascending=False)
          ["backward_participation_FVA_share"].head(5).to_string())

    print("\n[4/4] 计算前向GVC参与度(这一步涉及77x77国家对,稍慢,请耐心等待)...")
    forward = compute_forward_participation(io, va, exports, regions)
    print("  前向参与度最高的5国(自己的增加值最常被别国转手出口):")
    print(forward.sort_values("forward_participation_ratio", ascending=False)
          ["forward_participation_ratio"].head(5).to_string())

    # 汇总保存
    summary = backward.join(forward)
    summary["upstreamness_country_avg"] = upstream_by_country
    summary["gvc_total_participation"] = (
        summary["backward_participation_FVA_share"]
        + summary["forward_participation_ratio"]
    )
    summary = summary.sort_values("gvc_total_participation", ascending=False)

    out_path = f"gvc_indicators_{YEAR}.csv"
    summary.to_csv(out_path, encoding="utf-8-sig")
    print(f"\n已保存国家级汇总结果到: {out_path}")
    print("列说明: gross_exports=出口总额, domestic_VA_in_exports=本国增加值含量,")
    print("backward_participation_FVA_share=后向参与度(进口依赖),")
    print("forward_participation_ratio=前向参与度(被别人转手出口的比例),")
    print("gvc_total_participation=两者之和,常被文献直接当作'GVC参与度'总指标使用")


if __name__ == "__main__":
    main()
