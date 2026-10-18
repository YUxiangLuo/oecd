"""步骤1:OECD ICIO 数据下载与加载(基于 pymrio)。"""

import csv
import os
from pathlib import Path
from tempfile import TemporaryDirectory

import pandas as pd
import pymrio

from gvcsim.config import RAW_DATA_DIR
from gvcsim.data.raw_icio import dimension_contract_for, resolve_year_source, validate_raw_file


def download(years: list[int]) -> None:
    """按 ICIO2023 年份包下载；只安装经过验证的指定年份，已有数据不改名、不覆盖。"""
    requested = sorted(set(years))
    if any(type(year) is not int or not 1995 <= year <= 2020 for year in requested):
        raise ValueError("ICIO2023 支持 1995–2020 年")
    if not requested:
        return
    RAW_DATA_DIR.mkdir(parents=True, exist_ok=True)
    contract = dimension_contract_for(RAW_DATA_DIR)
    missing = []
    for year in requested:
        if list(RAW_DATA_DIR.glob(f"ICIO*_{year}.csv")):
            validate_raw_file(resolve_year_source(year, RAW_DATA_DIR), contract)
        else:
            missing.append(year)
    if not missing:
        return
    bundles = [(1995, 2000), (2001, 2005), (2006, 2010), (2011, 2015), (2016, 2020)]
    # pymrio v2023 renames every file in storage_folder after each bundle.
    # An empty, separate directory per bundle also prevents repeated prefixes.
    with TemporaryDirectory(prefix=".icio-download-", dir=RAW_DATA_DIR) as staging:
        sources = []
        for start, end in bundles:
            targets = [year for year in missing if start <= year <= end]
            if not targets:
                continue
            directory = Path(staging) / f"{start}-{end}"
            pymrio.download_oecd(storage_folder=directory, version="v2023", years=[f"{start}-{end}"])
            for year in targets:
                source = resolve_year_source(year, directory)
                validate_raw_file(source, contract)
                sources.append((year, source))
        # Validate all requested files before installing any. Hard links publish
        # complete files atomically on the same filesystem without overwriting.
        for year, source in sources:
            destination = RAW_DATA_DIR / f"ICIO2023_{year}.csv"
            try:
                os.link(source, destination)
            except FileExistsError:
                validate_raw_file(resolve_year_source(year, RAW_DATA_DIR), contract)


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
    source = resolve_year_source(year, RAW_DATA_DIR)
    validate_raw_file(source, dimension_contract_for(RAW_DATA_DIR))
    io = pymrio.parse_oecd(path=RAW_DATA_DIR, year=year)
    # 必须在 calc_all 之外独立读取；这是对源表的观测值，不是派生的 x。
    io.reported_output = _read_reported_output(source, io.Z.index)
    if io.A is None or io.L is None:
        io.calc_all()
    return io
