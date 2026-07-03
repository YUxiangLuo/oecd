"""步骤2:贸易政策冲击数据接入。

真实系统应接入 PIIE 中美关税追踪库 / WTO / GTA / OFAC-BIS 清单(见项目
说明文档 4.2 节)。开发起点阶段先提供一份**风格化的演示数据**:
以 2018 年中美贸易战为原型,量级参考 PIIE 公布的平均关税水平,
让"指标→回归→报告"链路可以端到端跑通。

⚠ demo_shock_panel 产出的是演示数据,不能用于真实研究结论。
接入真实数据时实现一个同样返回 (country, year) → shock 面板的 loader 即可。
"""

import pandas as pd

from gvcsim.config import SHOCKS_DIR

DEMO_FILE = "demo_us_china_tariffs.csv"

# 风格化设定:2018.7 起美对华 301 关税、中方反制。
# 数值 ≈ 双边平均加征税率(参考 PIIE 追踪数据的量级,非精确值)。
_DEMO_EVENTS = [
    # country, year, tariff_shock, announced, effective, note
    ("CHN", 2018, 0.08, "2018-06-15", "2018-07-06", "美对华301关税(第一、二批)"),
    ("CHN", 2019, 0.16, "2019-05-10", "2019-06-01", "301关税加码至约2500亿美元清单"),
    ("CHN", 2020, 0.16, "2020-01-15", "2020-02-14", "第一阶段协议后维持高位"),
    ("USA", 2018, 0.06, "2018-06-16", "2018-07-06", "中方对美反制关税(第一批)"),
    ("USA", 2019, 0.12, "2019-05-13", "2019-06-01", "反制清单扩大"),
    ("USA", 2020, 0.12, "2020-01-15", "2020-02-14", "维持高位"),
]


def demo_shock_panel(countries: list[str], years: list[int]) -> pd.DataFrame:
    """生成覆盖全部 (country, year) 的冲击面板,未受冲击处为 0。

    列:tariff_shock(平均加征税率)、treated(是否受冲击)、
        announced_date / effective_date(支持 DID 的事件时间线)。
    """
    base = pd.MultiIndex.from_product(
        [countries, years], names=["country", "year"]
    ).to_frame(index=False)
    events = pd.DataFrame(
        _DEMO_EVENTS,
        columns=["country", "year", "tariff_shock", "announced_date", "effective_date", "note"],
    )
    df = base.merge(events, on=["country", "year"], how="left")
    df["tariff_shock"] = df["tariff_shock"].fillna(0.0)
    df["treated"] = (df["tariff_shock"] > 0).astype(int)
    return df


def write_demo(countries: list[str], years: list[int]) -> None:
    SHOCKS_DIR.mkdir(parents=True, exist_ok=True)
    demo_shock_panel(countries, years).to_csv(SHOCKS_DIR / DEMO_FILE, index=False)


def load_shocks() -> pd.DataFrame:
    """读取冲击面板。当前只有演示数据;接入真实数据后在这里做数据源切换。"""
    path = SHOCKS_DIR / DEMO_FILE
    if not path.exists():
        raise FileNotFoundError(
            f"未找到冲击数据 {path},请先运行 `gvcsim compute` 生成演示数据"
        )
    return pd.read_csv(path)
