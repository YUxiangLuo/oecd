"""步骤1:OECD ICIO 数据下载与加载(基于 pymrio)。"""

import pymrio

from gvcsim.config import RAW_DATA_DIR


def download(years: list[int]) -> None:
    """下载指定年份的 OECD ICIO 数据到 RAW_DATA_DIR。"""
    RAW_DATA_DIR.mkdir(parents=True, exist_ok=True)
    pymrio.download_oecd(storage_folder=RAW_DATA_DIR, years=years)


def load(year: int):
    """解析某年 ICIO 表并确保 A/L/x 等核心矩阵已计算。

    返回 pymrio.IOSystem,核心属性:
      Z 中间使用矩阵 (N×N)、Y 最终需求矩阵、x 总产出向量、
      A 技术系数矩阵、L 全球里昂惕夫逆矩阵 (I-A)^-1。
    N = 国家数 × 行业数(ICIO2023: 77×45 = 3465)。
    """
    io = pymrio.parse_oecd(path=RAW_DATA_DIR, year=year)
    if io.A is None or io.L is None:
        io.calc_all()
    return io
