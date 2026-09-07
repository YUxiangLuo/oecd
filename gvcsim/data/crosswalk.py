"""Small, traceable HS2017→ISIC→ICIO examples with a fictional tariff basket.

Classification follows the product's producing activity, never its upstream inputs.
The basket includes untaxed products in each industry denominator. Neither its
values nor rates are observations or inputs to the policy regression panel.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from gvcsim.data.quality import QcCheck

# HS6, product description, producing ISIC division, ICIO industry.
_EXAMPLES = (
    ("010121", "纯种繁殖马", "01", "A01_02"),
    ("030111", "活的淡水观赏鱼（捕捞或养殖）", "03", "A03"),
    ("854231", "处理器及控制器集成电路", "26", "C26"),
    ("854239", "其他集成电路", "26", "C26"),
    ("870323", "仅火花点火发动机、排量超过1500且不超过3000cc的乘用车", "29", "C29"),
    ("940360", "其他木家具（非办公室、厨房或卧室用）", "31", "C31T33"),
)
HS_DESCRIPTIONS = {code[:2]: description for code, description, _isic, _industry in _EXAMPLES}
_SOURCE = "https://unstats.un.org/unsd/classifications/Econ/Detail/EN"


def build_crosswalk() -> pd.DataFrame:
    """Selected HS6 products all have an unambiguous ICIO producing industry."""
    return pd.DataFrame(
        [
            {
                "hs_code": code,
                "hs_chapter": code[:2],
                "hs_description": description,
                "isic_division": isic,
                "icio_sector": industry,
                "weight": 1.0,
                "note": f"按商品生产活动归入 ISIC {isic}；不按所含上游部件拆分",
                "source_url": f"{_SOURCE}/2089/{code}",
                "industry_source_url": f"{_SOURCE}/27/{isic}",
            }
            for code, description, isic, industry in _EXAMPLES
        ]
    )


def demo_hs_list() -> pd.DataFrame:
    """A complete six-product fictional basket, including untaxed products.

    value_weight is a share of this entire basket, NOT just the covered list.
    coverage is binary here; annual rates are hypothetical calendar-year rates.
    """
    schedule = {
        "010121": (0.10, 0, 0.0, 0.0, 0.0),
        "030111": (0.10, 0, 0.0, 0.0, 0.0),
        "854231": (0.20, 1, 0.10, 0.25, 0.25),
        "854239": (0.30, 0, 0.0, 0.0, 0.0),
        "870323": (0.20, 1, 0.05, 0.20, 0.10),
        "940360": (0.10, 0, 0.0, 0.0, 0.0),
    }
    return pd.DataFrame(
        [
            {
                "hs_code": code,
                "hs_chapter": code[:2],
                "list_name": "虚构加税清单" if coverage else "未列入清单（保留分母）",
                "value_weight": value,
                "coverage": coverage,
                "rate_2018": first,
                "rate_2019": second,
                "rate_2020": third,
                "note": description,
                "source_url": f"{_SOURCE}/2089/{code}",
            }
            for code, description, _isic, _industry in _EXAMPLES
            for value, coverage, first, second, third in [schedule[code]]
        ]
    )


def map_demo_to_icio(year: int = 2019) -> pd.DataFrame:
    """Industry mean in the complete fictional basket, including zero-rate goods."""
    if year not in (2018, 2019, 2020):
        raise ValueError("year 必须是 2018、2019 或 2020")
    merged = demo_hs_list().merge(
        build_crosswalk()[["hs_code", "icio_sector", "weight"]], on="hs_code", validate="one_to_one"
    )
    merged["mapped_value_weight"] = merged.value_weight * merged.weight
    merged["affected_value_weight"] = merged.mapped_value_weight * merged.coverage
    merged["tariff_contribution"] = merged.affected_value_weight * merged[f"rate_{year}"]
    grouped = merged.groupby("icio_sector", as_index=False).agg(
        mapped_value_weight=("mapped_value_weight", "sum"),
        affected_value_weight=("affected_value_weight", "sum"),
        tariff_contribution=("tariff_contribution", "sum"),
        top_hs_chapters=("hs_code", lambda values: "、".join(values)),
    )
    grouped["avg_tariff"] = grouped.tariff_contribution / grouped.mapped_value_weight
    return grouped.sort_values(["avg_tariff", "icio_sector"], ascending=[False, True]).reset_index(drop=True)


def check_crosswalk(crosswalk: pd.DataFrame | None = None) -> list[QcCheck]:
    cw = build_crosswalk() if crosswalk is None else crosswalk.copy()
    expected = {code: (isic, industry) for code, _desc, isic, industry in _EXAMPLES}
    codes = cw.hs_code.astype(str)
    complete = set(codes) == set(expected) and not codes.duplicated().any()
    classifications = all(expected.get(row.hs_code) == (row.isic_division, row.icio_sector) for row in cw.itertuples())
    weights = pd.to_numeric(cw.weight, errors="coerce")
    valid_weights = bool(np.isfinite(weights).all() and (weights > 0).all() and (weights <= 1).all())
    sum_ok = valid_weights and bool(np.allclose(cw.assign(weight=weights).groupby("hs_code").weight.sum(), 1.0))
    return [
        QcCheck(
            name="所选 HS6 示例覆盖",
            kind="结构",
            passed=complete,
            detail="只检查六个指定商品；不宣称覆盖所有HS章，不包含保留章77",
        ),
        QcCheck(
            name="商品生产行业对应",
            kind="结构",
            passed=classifications,
            detail="对照所列HS/ISIC来源核对生产行业；供应链上游传导须另用投入产出模型",
        ),
        QcCheck(name="每个商品映射权重和=1", kind="数值", passed=sum_ok, detail="本例六个商品均可直接对应一个ICIO行业"),
        QcCheck(
            name="映射权重有限且在(0,1]", kind="数值", passed=valid_weights, detail="权重用于商品归属，不是上游投入系数"
        ),
    ]


def demo_payload(year: int = 2019) -> dict:
    cw, hs = build_crosswalk(), demo_hs_list()
    return {
        "year": year,
        "summary": {
            "n_hs_chapters": int(cw.hs_chapter.nunique()),
            "n_hs_products": int(cw.hs_code.nunique()),
            "n_crosswalk_rows": len(cw),
            "n_icio_sectors": int(cw.icio_sector.nunique()),
            "demo_list_value_coverage": float((hs.value_weight * hs.coverage).sum()),
        },
        "checks": [check.to_dict() for check in check_crosswalk(cw)],
        "hs_rows": hs.to_dict(orient="records"),
        "mapped_rows": map_demo_to_icio(year).to_dict(orient="records"),
        "crosswalk_rows": cw.to_dict(orient="records"),
        "disclaimer": "HS2017→ISIC→ICIO 使用六个可查来源的商品生产行业示例。贸易权重与税率完全虚构，不复现美国301，也不进入回归面板。均值分母包括本篮子未加税商品；它不是完整现实行业的平均税率。",
    }
