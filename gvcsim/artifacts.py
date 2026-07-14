"""只读预计算 CSV 产物加载器。

API 与报告生成必须读取同一份内存视图。缓存键包含文件路径和纳秒级修改
时间，因此运行中的服务在 ``gvcsim compute`` 重写产物后会自动读取新内容。
返回的 DataFrame 由缓存共享；调用方不得原地修改，应在派生列或筛选前复制。
"""

from functools import lru_cache
from pathlib import Path

import pandas as pd


@lru_cache(maxsize=32)
def _cached_csv(path_str: str, mtime_ns: int) -> pd.DataFrame:
    """解析一份 CSV；``mtime_ns`` 只用于缓存失效。"""
    return pd.read_csv(path_str, keep_default_na=False, na_values=[""])


def read_csv_artifact(path: Path) -> pd.DataFrame:
    """读取并缓存一份已存在的 CSV 产物。

    缺失文件保留为 ``FileNotFoundError``，由 API/CLI 各自转换为适合其界面的
    错误。这里不创建目录、不写文件，也不隐藏重新计算后的 mtime 变化。
    """
    if not path.exists():
        raise FileNotFoundError(path)
    return _cached_csv(str(path), path.stat().st_mtime_ns)
