"""与客户基准数据对账(gvcsim benchmark)。

client-docs/ 里客户自算的指标样例(网络 1995–2020、生产/长度/贸易 1995–2018)
与本系统 data/processed/indicators_industry_<year>.csv 在重叠年份按
country×industry 内连接,逐指标输出 Pearson/Spearman 相关、中位相对差与
Top-10 偏差样本,写入 reports/client_benchmark.md。

对账目标是"量级与排序一致性",不追求逐值相等:客户数据基于 OECD ICIO 早期
修订版(文件名标注 OECD2021),本系统使用 ICIO2023 修订数据;网络路径类、介数
与特征向量中心性的阈值化去噪口径也有已知差异,详见报告的说明一节。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from gvcsim.config import PROCESSED_DIR, REPORTS_DIR, ROOT, processed_years

CLIENT_DOCS_DIR = ROOT / "client-docs"

# 各专题:客户文件(相对 client-docs/)、参与对账的指标列
TOPICS: dict[str, dict] = {
    "贸易流分解(WWZ)": {
        "file": "4、基于投入产出数据库的双边总贸易流分解指标构建(含若干年份的原始指标数据)/"
        "4、基于投入产出数据库的双边总贸易流分解指标构建(含若干年份的原始指标数据).xlsx",
        "columns": ["DVAex", "DVArt", "DDC", "FVA", "FDC", "taxsub"],
    },
    "生产分解(WWYZ)": {
        "file": "3、基于投入产出数据库的全球价值链生产(最终产品和行业增加值)分解指标构建(含若干年份的原始指标数据)/"
        "3、基于投入产出数据库的全球价值链生产(最终产品和行业增加值)分解指标构建(含若干年份的原始指标数据).xlsx",
        "columns": [
            "SVA",
            "1_VA_D",
            "2_VA_RT",
            "3_VA_GVC",
            "3a_VA_GVC_S",
            "3b_VA_GVC_C",
            "FGY",
            "1_FGY_D",
            "2_FGY_RT",
            "3_FGY_GVC",
            "3a_FGY_GVC_S",
            "3b_FGY_GVC_C",
        ],
    },
    "长度分解(WWYZ 2017b)": {
        "file": "5、基于投入产出数据库的全球价值链长度分解指标构建(含若干年份的原始指标数据)/"
        "5、基于投入产出数据库的全球价值链长度分解指标构建(含若干年份的原始指标数据).csv",
        "columns": ["PLv", "PLv_D", "PLv_RT", "PLv_GVC", "PLy", "PLy_D", "PLy_RT", "PLy_GVC", "Pos_TPL", "GVCPs"],
    },
    "网络指标(Gephi)": {
        "file": "2、基于投入产出数据库的全球生产网络指标构建(含若干年份的原始指标数据)/"
        "2、基于投入产出数据库的全球生产网络指标构建(含若干年份的原始指标数据).csv",
        "columns": [
            "degree",
            "indegree",
            "outdegree",
            "weighted degree",
            "weighted indegree",
            "weighted outdegree",
            "Eccentricity",
            "closnesscentrality",
            "harmonicclosnesscentrality",
            "betweenesscentrality",
            "eigencentrality",
        ],
    },
}

KNOWN_CAVEATS = [
    "数据修订版本:客户样例基于 OECD ICIO 早期修订(文件内标注 OECD2021,年份到 2018/2020);"
    "本系统使用 ICIO2023 修订数据。同一年份的底表数值本身即存在修订差异。",
    "网络建图口径:客户用 Gephi 在全部正流量边上计算;本系统的度/加权度同为全边口径,"
    "路径类指标、介数与特征向量中心性在按流量占比阈值化去噪后的无权图上计算"
    "(纯 Python Brandes 撑不起 ~10^6 级边数的全图)——路径类与介数的量级与排序可比,"
    "逐值不可比。",
    "特征向量中心性:两边都是无权、按最大值归一的幂迭代,但迭代步数与收敛准则不同"
    "(Gephi 默认固定 100 步),小数值节点会有相对差异;客户数据部分年份缺该列。",
    "行覆盖:客户数据剔除了部分零值行业行(如 2018 年 3373 行 < 3465),对账取交集。",
    "对账结论只用于验证实现口径一致性,不构成研究结论。",
]


@dataclass
class IndicatorStat:
    indicator: str
    n: int
    pearson: float
    spearman: float
    median_rel_diff: float
    top_dev: str

    def row(self) -> str:
        return (
            f"| {self.indicator} | {self.n} | {self.pearson:.3f} | {self.spearman:.3f} "
            f"| {self.median_rel_diff:.1%} | {self.top_dev} |"
        )


def _find_client_file(rel: str) -> Path:
    """客户文件名里的中文括号在不同文件系统可能被转写,退化为按前缀匹配。"""
    path = CLIENT_DOCS_DIR / rel
    if path.exists():
        return path
    stem = rel.split("/")[0][:2]  # "4、" 等编号前缀
    suffix = Path(rel).suffix
    for cand in CLIENT_DOCS_DIR.glob(f"{stem}*/*{suffix}"):
        if not cand.name.startswith("~$"):
            return cand
    raise FileNotFoundError(f"client-docs 中找不到 {rel}")


def _read_xlsx(path: Path) -> pd.DataFrame:
    """pymrio 锁定 openpyxl<3.1.1(pandas.read_excel 需要 >=3.1.5),直接用 openpyxl 读。"""
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = ws.iter_rows(values_only=True)
    header = [str(c).strip() if c is not None else "" for c in next(rows)]
    df = pd.DataFrame(rows, columns=header)
    wb.close()
    return df


def _load_client(rel: str) -> pd.DataFrame:
    path = _find_client_file(rel)
    if path.suffix == ".csv":
        df = pd.read_csv(path, encoding="utf-8-sig")
    else:
        df = _read_xlsx(path)
    cols = [str(c).strip() for c in df.columns]
    # 客户生产分解表的最后一列误标为 "3b_VA_GVC_C"(与其说明文档中的笔误一致),
    # 按位置修正为后向复杂 GVC 列 "3b_FGY_GVC_C"。openpyxl 保留重复列名原样,
    # pandas.read_csv 则会把重复列改写成 "X.1",两种情况都处理。
    for i, c in enumerate(cols):
        if c == "3b_VA_GVC_C.1" or (c == "3b_VA_GVC_C" and c in cols[:i]):
            cols[i] = "3b_FGY_GVC_C"
    df.columns = cols
    df = df.rename(columns={"industry ": "industry"})
    df["year"] = pd.to_numeric(df["year"], errors="coerce").astype("Int64")
    return df


def _load_ours(years: list[int]) -> pd.DataFrame:
    return pd.concat(
        [pd.read_csv(PROCESSED_DIR / f"indicators_industry_{y}.csv") for y in years],
        ignore_index=True,
    )


def _stats(merged: pd.DataFrame, col: str) -> IndicatorStat | None:
    a = pd.to_numeric(merged[f"{col}_client"], errors="coerce")
    b = pd.to_numeric(merged[f"{col}_ours"], errors="coerce")
    ok = a.notna() & b.notna() & np.isfinite(a) & np.isfinite(b)
    a, b = a[ok], b[ok]
    if len(a) < 10:
        return None
    pearson = float(a.corr(b))
    spearman = float(a.corr(b, method="spearman"))
    scale = (a.abs() + b.abs()) / 2
    rel = ((a - b).abs() / scale.where(scale > 1e-9)).dropna()
    median_rel = float(rel.median()) if len(rel) else float("nan")
    dev = (a - b).abs() / scale.where(scale > 1e-9)
    top = merged.loc[dev.nlargest(10).index]
    top_txt = ";".join(f"{r.country}-{r.industry}-{r.year}" for r in top.itertuples()) or "—"
    return IndicatorStat(col, int(len(a)), pearson, spearman, median_rel, top_txt)


def run(verbose: bool = True) -> str:
    """执行对账并写 reports/client_benchmark.md,返回文件路径。"""
    years = processed_years()
    if not years:
        raise RuntimeError("没有任何已预计算的年份,请先运行 gvcsim compute")
    ours = _load_ours(years)

    sections = [
        "# 与客户基准数据对账报告\n",
        f"- 生成日期:{date.today().isoformat()}",
        f"- 本系统数据:OECD ICIO2023,{min(years)}–{max(years)},data/processed/indicators_industry_*.csv",
        "- 客户基准:client-docs/ 专题 2/3/4/5 附带的指标样例(country×industry×year)",
        "- 统计口径:重叠年份按 country×industry 内连接;相对差 = |a−b| / ((|a|+|b|)/2)\n",
    ]
    all_stats: list[tuple[str, list[IndicatorStat], list[int], int]] = []
    for topic, spec in TOPICS.items():
        client = _load_client(spec["file"])
        overlap = sorted(set(client["year"].dropna().astype(int)) & set(years))
        sub_client = client[client["year"].isin(overlap)]
        sub_ours = ours[ours["year"].isin(overlap)]
        merged = sub_client.merge(
            sub_ours,
            on=["year", "country", "industry"],
            suffixes=("_client", "_ours"),
            how="inner",
        )
        stats = [s for c in spec["columns"] if (s := _stats(merged, c)) is not None]
        all_stats.append((topic, stats, overlap, len(merged)))
        if verbose:
            print(f"[{topic}] 重叠年份 {overlap},匹配 {len(merged)} 行")

    for topic, stats, overlap, n_rows in all_stats:
        sections += [
            f"## {topic}",
            f"重叠年份:{'、'.join(map(str, overlap)) or '无'};匹配 country×industry×year 行数:{n_rows}\n",
            "| 指标 | N | Pearson | Spearman | 中位相对差 | 最大偏差样本(前10) |",
            "|---|---:|---:|---:|---:|---|",
            *[s.row() for s in stats],
            "",
        ]

    sections += ["## 已知口径差异(对账时的预期偏差来源)", *[f"- {c}" for c in KNOWN_CAVEATS]]

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORTS_DIR / "client_benchmark.md"
    out.write_text("\n".join(sections), encoding="utf-8")
    if verbose:
        print(f"对账报告已生成:{out}")
    return str(out)
