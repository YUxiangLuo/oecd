"""为真实前后端 Playwright smoke 生成极小、确定性的预计算产物。

该脚本只在 CI 的干净 checkout 中运行，不下载 OECD 大表；数学流水线仍走正式
``pipeline.compute_year``，API 因而读取真实产物格式而非路由 mock。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from gvcsim import pipeline


class TinyIOSystem:
    def __init__(self, year: int) -> None:
        regions = ["AUS", "CHN", "DEU", "USA"]
        # C24 在 2018 年受关税冲击，P 始终未受冲击；三年结构让真实 DID
        # 同时拥有处理/对照个体与冲击前后变异，smoke 可以真正运行估计。
        sectors = ["C24", "P"]
        index = pd.MultiIndex.from_product([regions, sectors], names=["region", "sector"])
        y_cols = pd.MultiIndex.from_product([regions, ["final"]], names=["region", "category"])
        n = len(index)
        rows, cols = np.indices((n, n))
        trend = year - 2017
        # 对称、严格为正且列和小于产出的微型投入矩阵；年份扰动保持确定性，
        # 避免回归结果变量在时间维度完全不变而形成退化协方差。
        z = 0.35 + 0.08 * ((rows + cols) % 4)
        z += np.eye(n) * (6.0 + (rows[:, 0] % 3))
        z *= 1.0 + trend * 0.012 * (((rows + cols) % 3) - 1)

        destinations = len(regions)
        y_rows, y_cols_idx = np.indices((n, destinations))
        y = 3.0 + ((y_rows * 2 + y_cols_idx * 3) % 7)
        for row_index, (region, _sector) in enumerate(index):
            y[row_index, regions.index(region)] += 16.0
        y *= 1.0 + trend * 0.009 * (((y_rows * 3 + y_cols_idx) % 5) - 2)
        x = z.sum(axis=1) + y.sum(axis=1)
        a = z / x[None, :]
        self.Z = pd.DataFrame(z, index=index, columns=index)
        self.Y = pd.DataFrame(y, index=index, columns=y_cols)
        self.x = pd.DataFrame({"indout": x}, index=index)
        self.A = pd.DataFrame(a, index=index, columns=index)
        self.L = pd.DataFrame(np.linalg.inv(np.eye(len(x)) - a), index=index, columns=index)
        self._regions = regions
        self._sectors = sectors

    def get_regions(self) -> list[str]:
        return self._regions

    def get_sectors(self) -> list[str]:
        return self._sectors


def main() -> None:
    original = pipeline.loader.load

    def load_tiny(year: int) -> TinyIOSystem:
        return TinyIOSystem(year)

    try:
        pipeline.loader.load = load_tiny
        for year in (2017, 2018, 2019):
            pipeline.compute_year(year, verbose=False)
        pipeline.build_panel()
    finally:
        pipeline.loader.load = original


if __name__ == "__main__":
    main()
