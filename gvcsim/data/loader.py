"""步骤1:OECD ICIO 数据下载与加载(基于 pymrio)。"""

import csv
from pathlib import Path

import pandas as pd
import pymrio

from gvcsim.config import RAW_DATA_DIR


def download(years: list[int]) -> None:
    """下载指定年份的 OECD ICIO 数据到 RAW_DATA_DIR。"""
    RAW_DATA_DIR.mkdir(parents=True, exist_ok=True)
    pymrio.download_oecd(storage_folder=RAW_DATA_DIR, years=years)


def _source_csv(year: int) -> Path:
    """返回某年的唯一 OECD 宽表，避免同年多文件时静默选错来源。"""
    matches = sorted(RAW_DATA_DIR.glob(f"ICIO*_{year}.csv"))
    if len(matches) != 1:
        raise FileNotFoundError(f"期望找到 1 个 {year} 年 ICIO CSV，实际找到 {len(matches)} 个: {matches}")
    return matches[0]


def _read_reported_output(path: Path, index: pd.MultiIndex) -> pd.Series:
    """从 OECD 原始宽表读取 ``OUT`` 账户行，并按 pymrio 的节点顺序对齐。

    ``pymrio.parse_oecd`` 不保留原始 ``OUT`` 行；随后 ``calc_all`` 会直接用
    ``Z`` 行和加 ``Y`` 行和构造 ``x``。如果不在这里另存一份，后续所谓的
    ``x = Z + Y`` 检查只是把同一个计算结果与自身比较，无法发现源表错位。
    """
    labels = [f"{region}_{sector}" for region, sector in index]
    with path.open(newline="", encoding="utf-8-sig") as handle:
        rows = csv.reader(handle)
        try:
            header = next(rows)
        except StopIteration as error:
            raise ValueError(f"OECD ICIO 文件为空: {path}") from error
        if len(header) != len(set(header)):
            raise ValueError(f"OECD ICIO 表头含重复列: {path}")
        positions = {label: pos for pos, label in enumerate(header)}
        missing = [label for label in labels if label not in positions]
        if missing:
            raise ValueError(f"OUT 账户缺少 {len(missing)} 个国家-行业列，例如 {missing[:3]}")
        output_row = next((row for row in rows if row and row[0] == "OUT"), None)

    if output_row is None:
        raise ValueError(f"OECD ICIO 文件缺少 OUT 账户行: {path}")
    try:
        values = [float(output_row[positions[label]]) for label in labels]
    except (IndexError, ValueError) as error:
        raise ValueError(f"OUT 账户包含缺列或非数值: {path}") from error
    return pd.Series(values, index=index, name="OUT", dtype=float)


def load(year: int):
    """解析某年 ICIO 表并确保 A/L/x 等核心矩阵已计算。

    返回 pymrio.IOSystem,核心属性:
      Z 中间使用矩阵 (N×N)、Y 最终需求矩阵、x 总产出向量、
      A 技术系数矩阵、L 全球里昂惕夫逆矩阵 (I-A)^-1，另附
      reported_output(OECD 原始 OUT 账户)用于独立 QC。
    N = 国家数 × 行业数(ICIO2023: 77×45 = 3465)。
    """
    source = _source_csv(year)
    io = pymrio.parse_oecd(path=RAW_DATA_DIR, year=year)
    # 必须在 calc_all 之外独立读取；这是对源表的观测值，不是派生的 x。
    io.reported_output = _read_reported_output(source, io.Z.index)
    if io.A is None or io.L is None:
        io.calc_all()
    return io
