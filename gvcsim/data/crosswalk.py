"""HS→ICIO 行业映射 mock 与映射工作流演示。

真实接入时应使用 UN Stats / OECD 官方 HS-ISIC-ICIO crosswalk。本模块按
真实 crosswalk 的 schema 做一份确定性 mock:

  hs_chapter(HS 2 位章) → icio_sector(ICIO 45 行业之一) + weight

并提供一份美国 301 清单风格的小样本,演示如何把 HS 章级清单税率折算成
ICIO 行业平均税率。所有数值只用于教学,不构成研究数据。
"""

from __future__ import annotations

from collections import defaultdict

import pandas as pd

from gvcsim.data.quality import QcCheck

HS_DESCRIPTIONS = {
    "01": "活动物",
    "02": "肉及食用杂碎",
    "03": "鱼及水产品",
    "04": "乳品、蛋、蜂蜜",
    "05": "其他动物产品",
    "06": "活植物",
    "07": "蔬菜",
    "08": "水果坚果",
    "09": "咖啡茶香料",
    "10": "谷物",
    "11": "粉、淀粉",
    "12": "油籽与饲料",
    "13": "树胶树脂",
    "14": "编结植物材料",
    "15": "动植物油脂",
    "16": "肉鱼制品",
    "17": "糖及糖食",
    "18": "可可及制品",
    "19": "谷物制品",
    "20": "蔬果制品",
    "21": "杂项食品",
    "22": "饮料酒醋",
    "23": "食品工业残渣",
    "24": "烟草",
    "25": "盐、硫磺、石料",
    "26": "矿砂、矿渣",
    "27": "矿物燃料",
    "28": "无机化学品",
    "29": "有机化学品",
    "30": "药品",
    "31": "肥料",
    "32": "染料涂料",
    "33": "香料化妆品",
    "34": "洗涤剂蜡",
    "35": "蛋白胶",
    "36": "炸药火工",
    "37": "照相电影用品",
    "38": "杂项化工",
    "39": "塑料",
    "40": "橡胶",
    "41": "生皮皮革",
    "42": "皮革制品",
    "43": "毛皮",
    "44": "木及木制品",
    "45": "软木",
    "46": "编结品",
    "47": "纸浆",
    "48": "纸及纸板",
    "49": "印刷品",
    "50": "蚕丝",
    "51": "羊毛",
    "52": "棉花",
    "53": "其他植物纤维",
    "54": "化纤长丝",
    "55": "化纤短纤",
    "56": "毡布无纺布",
    "57": "地毯",
    "58": "特种机织物",
    "59": "浸渍织物",
    "60": "针织物",
    "61": "针织服装",
    "62": "非针织服装",
    "63": "其他纺织制品",
    "64": "鞋靴",
    "65": "帽类",
    "66": "伞杖鞭",
    "67": "羽毛人发制品",
    "68": "石材石膏水泥",
    "69": "陶瓷",
    "70": "玻璃",
    "71": "珠宝贵金属",
    "72": "钢铁",
    "73": "钢铁制品",
    "74": "铜及制品",
    "75": "镍及制品",
    "76": "铝及制品",
    "77": "保留章",
    "78": "铅及制品",
    "79": "锌及制品",
    "80": "锡及制品",
    "81": "其他贱金属",
    "82": "工具刀具",
    "83": "贱金属杂项制品",
    "84": "机械设备",
    "85": "电机电气设备",
    "86": "铁路设备",
    "87": "车辆及零件",
    "88": "航空航天器",
    "89": "船舶",
    "90": "光学医疗仪器",
    "91": "钟表",
    "92": "乐器",
    "93": "武器弹药",
    "94": "家具灯具",
    "95": "玩具运动用品",
    "96": "杂项制品",
    "97": "艺术品古董",
}


def _chapters(start: int, end: int) -> list[str]:
    return [f"{i:02d}" for i in range(start, end + 1)]


def _base_mapping() -> dict[str, list[tuple[str, float, str]]]:
    mapping: dict[str, list[tuple[str, float, str]]] = {}

    def assign(chapters: list[str], rows: list[tuple[str, float, str]]) -> None:
        for hs in chapters:
            mapping[hs] = rows

    assign(_chapters(1, 3), [("A01_02", 0.75, "农业/畜牧"), ("A03", 0.25, "水产品")])
    assign(_chapters(4, 14), [("A01_02", 1.0, "农林牧产品")])
    assign(_chapters(15, 24), [("C10T12", 0.88, "食品饮料烟草"), ("A01_02", 0.12, "上游农业")])
    assign(["25"], [("B07_08", 0.70, "非能源矿物"), ("C23", 0.30, "非金属矿物制品")])
    assign(["26"], [("B07_08", 0.85, "矿砂"), ("C24", 0.15, "冶炼环节")])
    assign(["27"], [("B05_06", 0.60, "煤油气"), ("C19", 0.35, "石油炼焦"), ("D", 0.05, "能源转换")])
    assign(
        ["28", "29", "31", "32", "33", "34", "35", "36", "37", "38"],
        [("C20", 0.90, "化学品"), ("C21", 0.10, "医药相关")],
    )
    assign(["30"], [("C21", 0.95, "药品"), ("C20", 0.05, "化工原料")])
    assign(["39", "40"], [("C22", 0.92, "塑料橡胶"), ("C20", 0.08, "化工原料")])
    assign(_chapters(41, 43), [("C13T15", 0.75, "皮革服饰"), ("C31T33", 0.25, "其他制品")])
    assign(_chapters(44, 46), [("C16", 0.95, "木制品"), ("A01_02", 0.05, "林业")])
    assign(_chapters(47, 49), [("C17_18", 0.92, "纸印刷"), ("C16", 0.08, "上游木浆")])
    assign(_chapters(50, 67), [("C13T15", 0.95, "纺织服装"), ("C20", 0.05, "化纤化工")])
    assign(_chapters(68, 70), [("C23", 0.96, "非金属矿物制品"), ("B07_08", 0.04, "矿物投入")])
    assign(["71"], [("C24", 0.70, "贵金属"), ("C31T33", 0.30, "珠宝工艺品")])
    assign(["72", "74", "75", "76", "78", "79", "80", "81"], [("C24", 1.0, "基本金属")])
    assign(["73", "82", "83"], [("C25", 0.86, "金属制品"), ("C24", 0.14, "基本金属")])
    assign(["77"], [("C24", 1.0, "保留章按金属处理")])
    assign(["84"], [("C28", 0.82, "通用/专用机械"), ("C26", 0.10, "控制模块"), ("C27", 0.08, "电气部件")])
    assign(["85"], [("C26", 0.62, "电子光学"), ("C27", 0.30, "电气设备"), ("C28", 0.08, "机械集成")])
    assign(["86"], [("C30", 0.76, "其他运输设备"), ("C25", 0.24, "金属结构件")])
    assign(["87"], [("C29", 0.86, "汽车及零部件"), ("C27", 0.08, "电气部件"), ("C25", 0.06, "金属部件")])
    assign(["88"], [("C30", 0.80, "航空航天"), ("C26", 0.12, "航电系统"), ("C25", 0.08, "结构件")])
    assign(["89"], [("C30", 0.88, "船舶"), ("C25", 0.12, "金属结构件")])
    assign(["90"], [("C26", 0.70, "光学医疗仪器"), ("C21", 0.12, "医疗耗材"), ("C28", 0.18, "精密机械")])
    assign(["91", "92"], [("C26", 0.45, "精密部件"), ("C31T33", 0.55, "其他制造")])
    assign(["93"], [("C25", 0.65, "金属武器部件"), ("C26", 0.20, "电子火控"), ("C31T33", 0.15, "其他制造")])
    assign(
        ["94", "95", "96", "97"],
        [("C31T33", 0.86, "家具玩具杂项"), ("C13T15", 0.08, "纺织部件"), ("C22", 0.06, "塑料部件")],
    )
    return mapping


def build_crosswalk() -> pd.DataFrame:
    """返回 HS2→ICIO crosswalk mock。"""
    rows = []
    for hs, targets in sorted(_base_mapping().items()):
        for sector, weight, note in targets:
            rows.append(
                {
                    "hs_chapter": hs,
                    "hs_description": HS_DESCRIPTIONS[hs],
                    "icio_sector": sector,
                    "weight": weight,
                    "note": note,
                }
            )
    return pd.DataFrame(rows)


def demo_hs_list() -> pd.DataFrame:
    """美国 301 清单风格 HS 章级样本。

    value_weight 表示该章在示例清单贸易额中的占比,coverage 表示清单覆盖该章
    商品的比例。rate_* 是年均附加税率(已近似考虑生效月份)。
    """
    rows = [
        ("84", "List 1/2/3", 0.28, 0.70, 0.11, 0.23, 0.23, "机械设备覆盖广"),
        ("85", "List 1/2/3/4A", 0.30, 0.62, 0.08, 0.20, 0.18, "电子电气品类"),
        ("87", "List 1/2", 0.13, 0.58, 0.10, 0.24, 0.24, "汽车零部件"),
        ("90", "List 1/2", 0.08, 0.42, 0.04, 0.12, 0.12, "光学医疗仪器"),
        ("39", "List 3", 0.08, 0.45, 0.05, 0.17, 0.17, "塑料制品"),
        ("73", "List 2/3", 0.06, 0.52, 0.05, 0.18, 0.18, "钢铁制品"),
        ("94", "List 4A", 0.07, 0.35, 0.00, 0.06, 0.06, "家具灯具"),
    ]
    return pd.DataFrame(
        rows,
        columns=[
            "hs_chapter",
            "list_name",
            "value_weight",
            "coverage",
            "rate_2018",
            "rate_2019",
            "rate_2020",
            "note",
        ],
    )


def map_demo_to_icio(year: int = 2019) -> pd.DataFrame:
    """把示例 HS 清单折算到 ICIO 行业平均税率。"""
    rate_col = f"rate_{year}"
    if rate_col not in demo_hs_list().columns:
        raise ValueError("year 必须是 2018、2019 或 2020")
    merged = demo_hs_list().merge(build_crosswalk(), on="hs_chapter", how="left")
    merged["mapped_value_weight"] = merged["value_weight"] * merged["weight"]
    merged["affected_value_weight"] = merged["mapped_value_weight"] * merged["coverage"]
    merged["tariff_contribution"] = merged["affected_value_weight"] * merged[rate_col]

    grouped = merged.groupby("icio_sector", as_index=False).agg(
        mapped_value_weight=("mapped_value_weight", "sum"),
        affected_value_weight=("affected_value_weight", "sum"),
        tariff_contribution=("tariff_contribution", "sum"),
    )
    grouped["avg_tariff"] = (grouped["tariff_contribution"] / grouped["mapped_value_weight"]).where(
        grouped["mapped_value_weight"] > 0, 0.0
    )

    hs_by_sector: dict[str, list[str]] = defaultdict(list)
    for r in merged.sort_values(["icio_sector", "mapped_value_weight"], ascending=[True, False]).itertuples(
        index=False
    ):
        if r.hs_chapter not in hs_by_sector[r.icio_sector]:
            hs_by_sector[r.icio_sector].append(r.hs_chapter)
    grouped["top_hs_chapters"] = grouped["icio_sector"].map(lambda s: "、".join(hs_by_sector[s][:4]))
    return grouped.sort_values("avg_tariff", ascending=False).reset_index(drop=True)


def check_crosswalk(crosswalk: pd.DataFrame | None = None) -> list[QcCheck]:
    cw = build_crosswalk() if crosswalk is None else crosswalk.copy()
    checks: list[QcCheck] = []

    expected_hs = set(HS_DESCRIPTIONS)
    actual_hs = set(cw["hs_chapter"].astype(str))
    missing_hs = sorted(expected_hs - actual_hs)
    checks.append(
        QcCheck(
            name="HS 2位章覆盖",
            kind="结构",
            passed=not missing_hs,
            detail=f"覆盖 {len(actual_hs)}/{len(expected_hs)} 个 HS 章",
            warnings=[f"缺少 HS{h}" for h in missing_hs[:5]],
        )
    )

    sums = cw.groupby("hs_chapter")["weight"].sum()
    bad = sums[(sums - 1.0).abs() > 1e-9]
    checks.append(
        QcCheck(
            name="每个 HS 章映射权重和=1",
            kind="数值",
            passed=bad.empty,
            detail=f"异常 HS 章 {len(bad)} 个",
            warnings=[f"HS{idx}: 权重和 {val:.4f}" for idx, val in bad.head(5).items()],
        )
    )

    goods_sectors = {
        "A01_02",
        "A03",
        "B05_06",
        "B07_08",
        "C10T12",
        "C13T15",
        "C16",
        "C17_18",
        "C19",
        "C20",
        "C21",
        "C22",
        "C23",
        "C24",
        "C25",
        "C26",
        "C27",
        "C28",
        "C29",
        "C30",
        "C31T33",
        "D",
    }
    covered = set(cw["icio_sector"])
    missing_goods = sorted(goods_sectors - covered)
    checks.append(
        QcCheck(
            name="ICIO 商品相关行业覆盖",
            kind="结构",
            passed=not missing_goods,
            detail=f"覆盖 {len(covered & goods_sectors)}/{len(goods_sectors)} 个商品相关 ICIO 行业;"
            "服务业没有直接 HS 商品章,不计入本项",
            warnings=[f"未覆盖:{s}" for s in missing_goods[:5]],
        )
    )

    invalid_weight = cw[(cw["weight"] <= 0) | (cw["weight"] > 1)]
    checks.append(
        QcCheck(
            name="映射权重值域(0,1]",
            kind="数值",
            passed=invalid_weight.empty,
            detail=f"越界权重 {len(invalid_weight)} 条",
            warnings=[
                f"HS{r.hs_chapter}->{r.icio_sector}: {r.weight}" for r in invalid_weight.head(5).itertuples(index=False)
            ],
        )
    )
    return checks


def demo_payload(year: int = 2019) -> dict:
    cw = build_crosswalk()
    hs = demo_hs_list()
    mapped = map_demo_to_icio(year)
    return {
        "year": year,
        "summary": {
            "n_hs_chapters": int(cw["hs_chapter"].nunique()),
            "n_crosswalk_rows": int(len(cw)),
            "n_icio_sectors": int(cw["icio_sector"].nunique()),
            "demo_list_value_coverage": float((hs["value_weight"] * hs["coverage"]).sum()),
        },
        "checks": [c.to_dict() for c in check_crosswalk(cw)],
        "hs_rows": hs.to_dict(orient="records"),
        "mapped_rows": mapped.to_dict(orient="records"),
        "crosswalk_rows": cw.to_dict(orient="records"),
        "disclaimer": "HS→ICIO crosswalk 为拟真 mock,用于教学演示映射工作流;真实研究需替换为官方 crosswalk。",
    }
