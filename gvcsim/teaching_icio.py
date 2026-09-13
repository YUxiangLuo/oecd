"""供步骤 2--4 演示的微型 ICIO 账户。

这些合成账户只在内存中构造，并复用正式指标函数；它们不属于数据发布产物，
也不会被报告流水线读取。
"""

from functools import lru_cache
import math

from fastapi import APIRouter
import numpy as np
import pandas as pd

from gvcsim.indicators.core import build_arrays
from gvcsim.indicators.length import sector_length
from gvcsim.indicators.production import sector_production
from gvcsim.indicators.tradeflow import sector_tradeflow

router = APIRouter(prefix="/api/teaching", tags=["teaching"])

REGIONS = ["甲国", "乙国", "丙国"]
SECTORS = ["初级品", "加工品"]
INDEX = pd.MultiIndex.from_product([REGIONS, SECTORS], names=["region", "sector"])

_SCENARIOS = [
    ("direct", "直接生产", "甲国加工品不使用中间投入，直接创造100增加值，形成100最终品并由甲国消费。", "甲国", "甲国"),
    ("domestic", "国内生产与吸收", "甲国以40增加值生产初级品，投入甲国加工；加工再增加60，形成100并由甲国消费。", "甲国", "甲国"),
    ("final-export", "最终品出口", "甲国以40初级品和60加工增加值生产100最终品，最终品出口并由乙国消费。", "甲国", "乙国"),
    ("simple-gvc", "简单全球价值链", "甲国以40增加值生产中间品并出口乙国；乙国增加60加工价值，100最终品由乙国消费。", "乙国", "乙国"),
    ("complex-gvc", "复杂全球价值链", "甲国以40增加值生产中间品并出口乙国；乙国增加60加工价值后，将100最终品出口丙国消费。", "乙国", "丙国"),
    ("return-home", "返回本国的价值链", "乙国进口甲国40中间投入，增加60加工价值后，将100最终品返回甲国消费。", "乙国", "甲国"),
]


class _FactorInputs:
    def __init__(self, va: np.ndarray):
        self.F = pd.DataFrame([np.zeros(len(va)), va], index=["TLS", "VA"], columns=INDEX)


class _TeachingIO:
    """build_arrays 所需的最小、已完成 calc_all 的 IOSystem 表面。"""

    def __init__(self, processor: str, consumer: str, intermediate_amount: float = 40):
        n = len(INDEX)
        z = np.zeros((n, n))
        y = np.zeros((n, len(REGIONS)))
        origin = INDEX.get_loc(("甲国", "初级品"))
        processing = INDEX.get_loc((processor, "加工品"))
        z[origin, processing] = intermediate_amount
        y[processing, REGIONS.index(consumer)] = 100.0

        x = z.sum(axis=1) + y.sum(axis=1)
        va = x - z.sum(axis=0)
        with np.errstate(divide="ignore", invalid="ignore"):
            a = np.divide(z, x, out=np.zeros_like(z), where=x > 0)

        self.Z = pd.DataFrame(z, index=INDEX, columns=INDEX)
        self.Y = pd.DataFrame(
            y,
            index=INDEX,
            columns=pd.MultiIndex.from_product([REGIONS, ["最终需求"]]),
        )
        self.x = pd.DataFrame({"indout": x}, index=INDEX)
        self.A = pd.DataFrame(a, index=INDEX, columns=INDEX)
        self.L = pd.DataFrame(np.linalg.inv(np.eye(n) - a), index=INDEX, columns=INDEX)
        self.factor_inputs = _FactorInputs(va)


def _records(frame: pd.DataFrame) -> list[dict[str, float | None]]:
    records = []
    for row in frame.to_numpy(dtype=float):
        records.append({col: (float(value) if math.isfinite(value) else None) for col, value in zip(frame.columns, row)})
    return records


@lru_cache(maxsize=1)
def teaching_icio_payload() -> dict[str, list[dict[str, object]]]:
    scenarios = []
    for scenario_id, title, description, processor, consumer in _SCENARIOS:
        arr = build_arrays(_TeachingIO(processor, consumer, 0 if scenario_id == "direct" else 40))
        trade = sector_tradeflow(arr)
        trade["gross_exports"] = arr.E
        scenarios.append(
            {
                "id": scenario_id,
                "title": title,
                "description": description,
                "nodes": [f"{region}·{sector}" for region, sector in arr.index],
                "regions": arr.regions,
                "Z": arr.Z.tolist(),
                "Y": arr.Yd.tolist(),
                "va": arr.va.tolist(),
                "x": arr.x.tolist(),
                "A": arr.A.tolist(),
                "B": arr.B.tolist(),
                "trade": _records(trade),
                "production": _records(sector_production(arr)),
                "length": _records(sector_length(arr)),
            }
        )
    return {"scenarios": scenarios}


@router.get("/icio")
def teaching_icio() -> dict[str, list[dict[str, object]]]:
    return teaching_icio_payload()
