"""全局路径与常量配置。所有模块统一从这里取路径,避免各自写死。"""

from pathlib import Path

# 仓库根目录(gvcsim/ 的上一级)
ROOT = Path(__file__).resolve().parent.parent

# 原始 OECD ICIO 数据(pymrio 下载的 ICIO2023_<year>.csv)
RAW_DATA_DIR = ROOT / "OECD_ICIO"

# 预计算产物:面板指标 CSV、质检 JSON、网络指标等
PROCESSED_DIR = ROOT / "data" / "processed"

# 政策冲击数据(关税/制裁/出口管制清单)
SHOCKS_DIR = ROOT / "data" / "shocks"

# 自动生成的实验报告
REPORTS_DIR = ROOT / "reports"

# ICIO2023 版本覆盖的年份范围(pymrio download_oecd 支持的区间)
SUPPORTED_YEARS = range(1995, 2021)


def available_years(raw_dir: Path = RAW_DATA_DIR) -> list[int]:
    """扫描本地已下载的原始数据年份(升序、去重)。"""
    years = set()
    for f in raw_dir.glob("ICIO*_*.csv"):
        try:
            years.add(int(f.stem.rsplit("_", 1)[1]))
        except ValueError:
            continue
    return sorted(years)


def processed_years() -> list[int]:
    """扫描已完成指标预计算的年份。"""
    return sorted(int(f.stem.rsplit("_", 1)[1]) for f in PROCESSED_DIR.glob("indicators_country_*.csv"))
