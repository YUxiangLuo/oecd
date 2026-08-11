"""步骤11:贸易政策冲击数据接入。

真实系统应接入 PIIE 中美关税追踪库 / WTO / GTA / OFAC-BIS 清单(见项目
说明文档 4.2 节)。开发起点阶段提供一份**拟真的演示数据**:以 2018–2020
全球贸易摩擦为原型,按真实事件逐条编码,覆盖全部 77 个经济体、45 个行业:

  事件层(税率量级参考 PIIE / Bown (2021) 公布的统计,非精确值):
    · 美国 201 保障措施(光伏/洗衣机)—— 全球所有对美出口国
    · 美国 232 钢铝关税 —— 全球(澳豁免、阿/巴/韩配额、加墨中途豁免、土一度加倍)
    · 美国 301 对华关税四批清单 —— 行业异质、逐年加码、第一阶段协议后部分回调
    · 中方对美反制 —— 农产品/能源/汽车为主
    · 欧盟/加拿大/墨西哥/土耳其/俄罗斯/印度对美反制 —— 232 再平衡
    · 美国航空补贴案(空客裁决)对德法西英加税

  冲击变量定义:tariff_shock[c,s,y] = Σ_事件 双边行业平均加征税率 × 出口暴露度,
  其中"双边行业平均加征税率"已折算清单覆盖面与年内生效月数,"出口暴露度"优先
  使用 OECD ICIO 真实双边流向计算(c 国出口流向加征方的份额)。
  因此 tariff_shock 可解读为:该国-行业全部出口面对的平均额外关税。

⚠ 演示数据不能用于真实研究结论。接入真实数据(PIIE 面板 + HS→ICIO 官方
crosswalk)时,实现一个返回同结构 (country, sector, year) 面板的 loader 即可。
"""

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from gvcsim.config import PROCESSED_DIR
from gvcsim.indicators.core import IcioArrays

DEMO_FILE = "demo_trade_war_tariffs.csv"
EXPOSURE_PREFIX = "export_exposure"

# treated 阈值:全部出口的平均额外关税超过 0.1 个百分点才算受处理,
# 避免"土耳其对美反制 × 美国微小对土出口份额"这类痕量项污染处理组。
TREATED_THRESHOLD = 0.001
EXPOSURE_MODE_FIXED_PRETREATMENT = "fixed_pretreatment"
EXPOSURE_MODE_CONTEMPORANEOUS = "contemporaneous"
EXPOSURE_MODES = (EXPOSURE_MODE_FIXED_PRETREATMENT, EXPOSURE_MODE_CONTEMPORANEOUS)

# 稳定英文键 → (强度列, 处理指示列)。键是 API 契约,展示文案见 SHOCK_LABELS:
# 界面改个措辞不该变成破坏性 API 变更。
SHOCK_TARIFF = "tariff"
SHOCK_SANCTIONS = "sanctions"
SHOCK_EXPORT_CONTROL = "export_control"

SHOCK_SPECS = {
    SHOCK_TARIFF: ("tariff_shock", "treated"),
    SHOCK_SANCTIONS: ("sanction_shock", "sanction_treated"),
    SHOCK_EXPORT_CONTROL: ("export_control_shock", "export_control_treated"),
}

SHOCK_LABELS = {
    SHOCK_TARIFF: "关税冲击",
    SHOCK_SANCTIONS: "制裁清单",
    SHOCK_EXPORT_CONTROL: "出口管制",
}

# ---------------------------------------------------------------------------
# 出口暴露度 fallback:各经济体货物出口中流向美国的份额。
# 量级参考 2017–2019 UN Comtrade 方向别结构:北美邻国 ~0.75,东亚 0.1–0.2,
# 欧盟内部国家对美敞口低(0.02–0.1),资源出口国普遍较低。
# 生产路径优先使用 export_exposure_<year>.csv,这里只服务小型测试和旧产物回退。
# ---------------------------------------------------------------------------
_EXPOSURE_TO_USA = {
    # 北美
    "CAN": 0.75,
    "MEX": 0.77,
    # 东亚 / 东南亚 / 南亚
    "CHN": 0.19,
    "JPN": 0.19,
    "KOR": 0.12,
    "TWN": 0.12,
    "HKG": 0.08,
    "VNM": 0.20,
    "THA": 0.11,
    "MYS": 0.09,
    "IDN": 0.10,
    "PHL": 0.15,
    "SGP": 0.08,
    "KHM": 0.23,
    "LAO": 0.02,
    "MMR": 0.05,
    "BRN": 0.02,
    "IND": 0.16,
    "BGD": 0.17,
    "PAK": 0.16,
    # 西欧
    "DEU": 0.09,
    "GBR": 0.13,
    "FRA": 0.08,
    "ITA": 0.09,
    "ESP": 0.05,
    "NLD": 0.05,
    "BEL": 0.06,
    "IRL": 0.28,
    "CHE": 0.15,
    "AUT": 0.07,
    "SWE": 0.07,
    "DNK": 0.08,
    "FIN": 0.07,
    "NOR": 0.05,
    "ISL": 0.05,
    "PRT": 0.05,
    "GRC": 0.04,
    "LUX": 0.02,
    "MLT": 0.05,
    "CYP": 0.02,
    # 中东欧 / 独联体
    "POL": 0.03,
    "CZE": 0.02,
    "SVK": 0.02,
    "HUN": 0.03,
    "SVN": 0.02,
    "HRV": 0.02,
    "BGR": 0.02,
    "ROU": 0.02,
    "EST": 0.02,
    "LVA": 0.02,
    "LTU": 0.04,
    "UKR": 0.01,
    "BLR": 0.01,
    "RUS": 0.03,
    "KAZ": 0.02,
    # 美洲(除北美)
    "BRA": 0.12,
    "ARG": 0.06,
    "CHL": 0.14,
    "COL": 0.28,
    "PER": 0.12,
    "CRI": 0.38,
    # 中东 / 非洲
    "TUR": 0.05,
    "ISR": 0.26,
    "SAU": 0.10,
    "JOR": 0.25,
    "EGY": 0.06,
    "MAR": 0.04,
    "TUN": 0.03,
    "NGA": 0.15,
    "ZAF": 0.07,
    "CIV": 0.06,
    "CMR": 0.03,
    "SEN": 0.02,
    # 大洋洲 / 其他
    "AUS": 0.04,
    "NZL": 0.10,
    "ROW": 0.10,
    "USA": 0.0,  # 自己对自己无出口
}

# 美国出口中流向各反制方的份额(反制事件只打美国,所以只需这一行)。
_USA_EXPOSURE_TO = {
    "CHN": 0.08,
    "EU": 0.19,
    "CAN": 0.18,
    "MEX": 0.16,
    "TUR": 0.006,
    "RUS": 0.004,
    "IND": 0.02,
}

# 欧盟作为加征方时按 EU27 聚合。2018 年的欧盟反制事件虽发生在英国脱欧前,
# 本项目的 ICIO 国家口径与既有 export_exposure_<year>.csv 均按 EU27 口径聚合,
# 英国相关冲击另在空客案事件中单列。
EU27 = {
    "AUT",
    "BEL",
    "BGR",
    "CYP",
    "CZE",
    "DEU",
    "DNK",
    "ESP",
    "EST",
    "FIN",
    "FRA",
    "GRC",
    "HRV",
    "HUN",
    "IRL",
    "ITA",
    "LTU",
    "LUX",
    "LVA",
    "MLT",
    "NLD",
    "POL",
    "PRT",
    "ROU",
    "SVK",
    "SVN",
    "SWE",
}


@dataclass(frozen=True)
class TariffEvent:
    """一条政策冲击事件:加征方对目标国若干行业的双边平均加征税率(按年)。

    rates[sector][year] 已折算两层"稀释":清单只覆盖行业内部分产品(覆盖面),
    以及年中生效(生效月数/12)。overrides 给国别特例(豁免/配额/加倍)。
    """

    name: str
    imposer: str  # 加征方("EU" 表示欧盟整体)
    targets: tuple[str, ...] | str  # 目标国;"ALL" = 全部经济体(除加征方)
    announced: str
    effective: str
    rates: dict[str, dict[int, float]]
    exempt: tuple[str, ...] = ()
    overrides: dict[str, dict[str, dict[int, float]]] = field(default_factory=dict)

    def rate(self, country: str, sector: str, year: int) -> float:
        table = self.overrides.get(country, self.rates)
        return table.get(sector, {}).get(year, 0.0)


@dataclass(frozen=True)
class EntityListEvent:
    """制裁/出口管制实体清单风格的演示事件。

    intensities 是已经从"实体 → 国家-行业暴露"聚合到 ICIO 行业后的强度,
    可解释为该国家-行业在该类政策下的暴露程度。它是 mock 强度变量,
    不是关税税率。
    """

    name: str
    shock_type: str
    targets: tuple[str, ...]
    announced: str
    effective: str
    intensities: dict[str, dict[int, float]]
    entities: tuple[str, ...]
    removal: str = ""

    @property
    def shock_col(self) -> str:
        return SHOCK_SPECS[self.shock_type][0]

    @property
    def treated_col(self) -> str:
        return SHOCK_SPECS[self.shock_type][1]


# 232 钢铝的基准年率:25% 钢 + 10% 铝,按 C24 内钢/铝出口结构混合 ≈ 0.20,
# 2018 年 3 月 23 日生效(9.3/12 个月)。
_S232_BASE = {"C24": {2018: 0.16, 2019: 0.20, 2020: 0.20}}

EVENTS = [
    TariffEvent(
        name="美国201保障措施(光伏、洗衣机)",
        imposer="USA",
        targets="ALL",
        announced="2018-01-22",
        effective="2018-02-07",
        # 30%/20–50% 的品目税率 × 行业内覆盖面(光伏占 C26 出口 ~5%,
        # 家电占 C27 出口 ~8%),税率逐年退坡
        rates={
            "C26": {2018: 0.014, 2019: 0.012, 2020: 0.010},
            "C27": {2018: 0.030, 2019: 0.026, 2020: 0.022},
        },
    ),
    TariffEvent(
        name="美国232钢铝关税",
        imposer="USA",
        targets="ALL",
        announced="2018-03-08",
        effective="2018-03-23",
        rates=_S232_BASE,
        exempt=("AUS",),  # 澳大利亚全程豁免
        overrides={
            # 阿根廷/巴西/韩国以配额换豁免:无从价税,仅配额约束的影子成本
            "ARG": {"C24": {2018: 0.03, 2019: 0.03, 2020: 0.03}},
            "BRA": {"C24": {2018: 0.03, 2019: 0.03, 2020: 0.03}},
            "KOR": {"C24": {2018: 0.03, 2019: 0.03, 2020: 0.03}},
            # 加墨 2018-06 起被征、2019-05 豁免
            "CAN": {"C24": {2018: 0.11, 2019: 0.08, 2020: 0.0}},
            "MEX": {"C24": {2018: 0.11, 2019: 0.08, 2020: 0.0}},
            # 土耳其 2018-08 起钢税加倍至 50%,2019-05 恢复
            "TUR": {"C24": {2018: 0.24, 2019: 0.24, 2020: 0.20}},
        },
    ),
    TariffEvent(
        name="美国301对华关税(四批清单)",
        imposer="USA",
        targets=("CHN",),
        announced="2018-06-15",
        effective="2018-07-06",
        # 行业平均税率:List 1/2(25%,2018-07/08)→ List 3(10%→25%,
        # 2018-09/2019-05)→ List 4A(15%→7.5%,2019-09/2020-02);
        # 2020 为第一阶段协议后的维持水平
        rates={
            "C26": {2018: 0.05, 2019: 0.16, 2020: 0.14},
            "C27": {2018: 0.08, 2019: 0.20, 2020: 0.18},
            "C28": {2018: 0.11, 2019: 0.23, 2020: 0.23},
            "C29": {2018: 0.10, 2019: 0.24, 2020: 0.24},
            "C30": {2018: 0.03, 2019: 0.10, 2020: 0.10},
            "C20": {2018: 0.06, 2019: 0.17, 2020: 0.17},
            "C21": {2019: 0.03, 2020: 0.03},
            "C22": {2018: 0.07, 2019: 0.21, 2020: 0.21},
            "C23": {2018: 0.04, 2019: 0.19, 2020: 0.19},
            "C24": {2018: 0.05, 2019: 0.21, 2020: 0.21},
            "C25": {2018: 0.06, 2019: 0.22, 2020: 0.22},
            "C16": {2018: 0.03, 2019: 0.20, 2020: 0.20},
            "C17_18": {2018: 0.03, 2019: 0.19, 2020: 0.19},
            "C19": {2019: 0.05, 2020: 0.05},
            "C13T15": {2019: 0.05, 2020: 0.06},
            "C31T33": {2018: 0.03, 2019: 0.19, 2020: 0.18},
            "C10T12": {2018: 0.02, 2019: 0.08, 2020: 0.08},
            "A01_02": {2018: 0.01, 2019: 0.03, 2020: 0.03},
            "A03": {2018: 0.02, 2019: 0.09, 2020: 0.09},
            "B05_06": {2019: 0.01, 2020: 0.01},
            "B07_08": {2018: 0.01, 2019: 0.04, 2020: 0.04},
            "B09": {2019: 0.04, 2020: 0.04},
        },
    ),
    TariffEvent(
        name="中方对美反制关税",
        imposer="CHN",
        targets=("USA",),
        announced="2018-06-16",
        effective="2018-07-06",
        # 大豆等农产品 25%+10% 打满;能源(LNG/煤/原油)2019 加码;
        # 汽车 25% 于 2019-01 暂停;2020 为第一阶段协议采购豁免后的水平
        rates={
            "A01_02": {2018: 0.13, 2019: 0.26, 2020: 0.20},
            "A03": {2018: 0.12, 2019: 0.24, 2020: 0.18},
            "C10T12": {2018: 0.10, 2019: 0.22, 2020: 0.17},
            "B05_06": {2018: 0.02, 2019: 0.12, 2020: 0.09},
            "C19": {2019: 0.05, 2020: 0.04},
            "C29": {2018: 0.12, 2019: 0.04, 2020: 0.02},
            "C30": {2018: 0.02, 2019: 0.02, 2020: 0.01},
            "C20": {2018: 0.06, 2019: 0.14, 2020: 0.11},
            "C21": {2019: 0.03, 2020: 0.02},
            "C22": {2018: 0.05, 2019: 0.12, 2020: 0.10},
            "C23": {2019: 0.08, 2020: 0.06},
            "C24": {2018: 0.04, 2019: 0.10, 2020: 0.08},
            "C25": {2018: 0.04, 2019: 0.10, 2020: 0.08},
            "C26": {2018: 0.03, 2019: 0.09, 2020: 0.07},
            "C27": {2018: 0.04, 2019: 0.10, 2020: 0.08},
            "C28": {2018: 0.04, 2019: 0.11, 2020: 0.09},
            "C16": {2018: 0.03, 2019: 0.10, 2020: 0.08},
            "C17_18": {2018: 0.03, 2019: 0.10, 2020: 0.08},
        },
    ),
    TariffEvent(
        name="欧盟对美再平衡关税(232反制)",
        imposer="EU",
        targets=("USA",),
        announced="2018-06-06",
        effective="2018-06-22",
        # 25% 打钢制品、摩托车、波本威士忌、牛仔裤等 €2.8B 清单
        rates={
            "C24": {2018: 0.13, 2019: 0.22, 2020: 0.22},
            "C30": {2018: 0.08, 2019: 0.14, 2020: 0.14},
            "C10T12": {2018: 0.04, 2019: 0.07, 2020: 0.07},
            "C13T15": {2018: 0.02, 2019: 0.04, 2020: 0.04},
        },
    ),
    TariffEvent(
        name="加拿大对美反制关税",
        imposer="CAN",
        targets=("USA",),
        announced="2018-05-31",
        effective="2018-07-01",
        # 与 232 同步:2019-05 随豁免一并取消
        rates={
            "C24": {2018: 0.11, 2019: 0.08},
            "C10T12": {2018: 0.02, 2019: 0.01},
            "C31T33": {2018: 0.01, 2019: 0.01},
        },
    ),
    TariffEvent(
        name="墨西哥对美反制关税",
        imposer="MEX",
        targets=("USA",),
        announced="2018-06-05",
        effective="2018-06-05",
        rates={
            "C24": {2018: 0.13, 2019: 0.08},
            "C10T12": {2018: 0.06, 2019: 0.04},
            "A01_02": {2018: 0.03, 2019: 0.02},
        },
    ),
    TariffEvent(
        name="土耳其对美反制关税",
        imposer="TUR",
        targets=("USA",),
        announced="2018-06-21",
        effective="2018-06-21",
        rates={
            "C29": {2018: 0.15, 2019: 0.15, 2020: 0.15},
            "C10T12": {2018: 0.10, 2019: 0.10, 2020: 0.10},
            "B05_06": {2018: 0.05, 2019: 0.05, 2020: 0.05},
        },
    ),
    TariffEvent(
        name="俄罗斯对美反制关税",
        imposer="RUS",
        targets=("USA",),
        announced="2018-07-06",
        effective="2018-08-05",
        rates={"C28": {2018: 0.06, 2019: 0.15, 2020: 0.15}},
    ),
    TariffEvent(
        name="印度对美反制关税",
        imposer="IND",
        targets=("USA",),
        announced="2018-06-21",
        effective="2019-06-16",
        rates={
            "A01_02": {2019: 0.10, 2020: 0.17},
            "C20": {2019: 0.02, 2020: 0.03},
            "C24": {2019: 0.05, 2020: 0.08},
        },
    ),
    TariffEvent(
        name="美国航空补贴案关税(空客裁决)",
        imposer="USA",
        targets=("DEU", "FRA", "ESP", "GBR"),
        announced="2019-10-02",
        effective="2019-10-18",
        # 10%(2020-03 升至 15%)打飞机,25% 打葡萄酒/威士忌/奶酪等
        rates={
            "C30": {2019: 0.03, 2020: 0.13},
            "C10T12": {2019: 0.02, 2020: 0.075},
            "C28": {2020: 0.02},
        },
    ),
]

ENTITY_LIST_EVENTS = [
    EntityListEvent(
        name="OFAC SDN 风格:俄铝 RUSAL 制裁",
        shock_type=SHOCK_SANCTIONS,
        targets=("RUS",),
        announced="2018-04-06",
        effective="2018-04-06",
        removal="2019-01-27",
        entities=("United Company RUSAL", "EN+ Group"),
        intensities={
            # 铝/基础金属最直接;2019 解除后保留短期合规摩擦。
            "C24": {2018: 0.080, 2019: 0.025},
            "B07_08": {2018: 0.025, 2019: 0.010},
            "K": {2018: 0.020, 2019: 0.008},
        },
    ),
    EntityListEvent(
        name="OFAC/二级制裁风格:俄罗斯能源金融限制",
        shock_type=SHOCK_SANCTIONS,
        targets=("RUS",),
        announced="2017-08-02",
        effective="2017-08-02",
        entities=("Russian energy SOEs", "sanctioned financial institutions"),
        intensities={
            "B05_06": {2017: 0.018, 2018: 0.026, 2019: 0.026, 2020: 0.026},
            "B09": {2017: 0.014, 2018: 0.020, 2019: 0.020, 2020: 0.020},
            "K": {2017: 0.012, 2018: 0.018, 2019: 0.018, 2020: 0.018},
        },
    ),
    EntityListEvent(
        name="OFAC 风格:涉疆实体与进口限制",
        shock_type=SHOCK_SANCTIONS,
        targets=("CHN",),
        announced="2020-07-20",
        effective="2020-07-20",
        entities=("XPCC", "textile supply-chain entities"),
        intensities={
            "C13T15": {2020: 0.030},
            "A01_02": {2020: 0.012},
            "C20": {2020: 0.010},
        },
    ),
    EntityListEvent(
        name="BIS 实体清单:华为及关联公司",
        shock_type=SHOCK_EXPORT_CONTROL,
        targets=("CHN",),
        announced="2019-05-16",
        effective="2019-05-16",
        entities=("Huawei", "Huawei affiliates"),
        intensities={
            "C26": {2019: 0.060, 2020: 0.090},
            "J62_63": {2019: 0.030, 2020: 0.050},
            "C27": {2019: 0.020, 2020: 0.030},
        },
    ),
    EntityListEvent(
        name="BIS 实体清单:中芯国际 SMIC",
        shock_type=SHOCK_EXPORT_CONTROL,
        targets=("CHN",),
        announced="2020-12-18",
        effective="2020-12-18",
        entities=("SMIC", "SMIC subsidiaries"),
        intensities={
            # 年末生效,按年内暴露折算后强度较低。
            "C26": {2020: 0.020},
            "C28": {2020: 0.010},
        },
    ),
]


def build_export_exposure(arr: IcioArrays, year: int) -> pd.DataFrame:
    """用 ICIO 双边流向计算出口暴露度 exposure[c, imposer, year]。

    bilateral_exports = c 卖给 imposer 的中间品 + 最终品(剔除 c 自身);
    total_exports = c 的全部跨境中间品 + 最终品出口。额外写入一列 imposer=EU,
    其目的地为 ICIO 中存在的 EU27 成员之和。
    """
    rows = []
    col_of = {r: j for j, r in enumerate(arr.regions)}

    def country_to_dest(exporter: str, dest: str) -> float:
        if exporter == dest:
            return 0.0
        p = arr.pos[exporter]
        return float(arr.Z[np.ix_(p, arr.pos[dest])].sum() + arr.Yd[p, col_of[dest]].sum())

    for country in arr.regions:
        total = float(arr.E[arr.pos[country]].sum())
        for imposer in arr.regions:
            bilateral = country_to_dest(country, imposer)
            rows.append(
                {
                    "country": country,
                    "imposer": imposer,
                    "year": year,
                    "bilateral_exports": bilateral,
                    "total_exports": total,
                    "export_exposure": bilateral / total if total > 0 else 0.0,
                }
            )

        eu_members = [r for r in arr.regions if r in EU27 and r != country]
        if eu_members:
            bilateral = sum(country_to_dest(country, dest) for dest in eu_members)
            rows.append(
                {
                    "country": country,
                    "imposer": "EU",
                    "year": year,
                    "bilateral_exports": bilateral,
                    "total_exports": total,
                    "export_exposure": bilateral / total if total > 0 else 0.0,
                }
            )

    return pd.DataFrame(rows).sort_values(["country", "imposer", "year"]).reset_index(drop=True)


def write_export_exposure(arr: IcioArrays, year: int) -> pd.DataFrame:
    """计算并落盘某年的 ICIO 出口暴露度。"""
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    df = build_export_exposure(arr, year)
    df.to_csv(PROCESSED_DIR / f"{EXPOSURE_PREFIX}_{year}.csv", index=False)
    return df


def load_export_exposure(years: list[int] | None = None) -> pd.DataFrame | None:
    """读取已预计算的出口暴露度;缺少任一年时返回 None 以便测试/旧产物回退。"""
    if years is None:
        paths = sorted(PROCESSED_DIR.glob(f"{EXPOSURE_PREFIX}_*.csv"))
    else:
        paths = [PROCESSED_DIR / f"{EXPOSURE_PREFIX}_{y}.csv" for y in years]
        if any(not p.exists() for p in paths):
            return None
    if not paths:
        return None
    return pd.concat([pd.read_csv(p) for p in paths], ignore_index=True)


def _exposure_map(export_exposure: pd.DataFrame | None) -> dict[tuple[str, str, int], float] | None:
    if export_exposure is None:
        return None
    return {
        (str(r.country), str(r.imposer), int(r.year)): float(r.export_exposure)
        for r in export_exposure.itertuples(index=False)
    }


def _first_tariff_year(country: str, imposer: str, years: list[int]) -> int | None:
    candidates: list[int] = []
    for ev in EVENTS:
        if ev.imposer != imposer or country in ev.exempt:
            continue
        targeted = ev.targets == "ALL" and country != imposer or ev.targets != "ALL" and country in ev.targets
        if not targeted:
            continue
        schedules = ev.overrides.get(country, ev.rates)
        candidates.extend(y for values in schedules.values() for y, rate in values.items() if y in years and rate > 0)
    return min(candidates) if candidates else None


def _fixed_exposure_year(
    country: str,
    imposer: str,
    years: list[int],
    exposure_lookup: dict[tuple[str, str, int], float] | None,
) -> int | None:
    """选取首次处理前最后一个可用 ICIO 年；短面板无前期时明确回退最早年。"""
    if exposure_lookup is None:
        return None
    available = sorted(y for c, i, y in exposure_lookup if c == country and i == imposer)
    if not available:
        return None
    first = _first_tariff_year(country, imposer, years)
    pre = [y for y in available if first is None or y < first]
    return max(pre) if pre else min(available)


def _stylized_exposure(country: str, imposer: str) -> float:
    """小测试与缺少预计算暴露度时的风格化回退口径。"""
    if imposer == "USA":
        return _EXPOSURE_TO_USA.get(country, 0.10)
    # 非美加征方的目标只有美国
    return _USA_EXPOSURE_TO[imposer] if country == "USA" else 0.0


def _exposure(
    country: str,
    imposer: str,
    year: int,
    exposure_lookup: dict[tuple[str, str, int], float] | None,
    *,
    mode: str = EXPOSURE_MODE_FIXED_PRETREATMENT,
    panel_years: list[int] | None = None,
) -> float:
    """country 的出口中流向 imposer 的份额(冲击的贸易加权系数)。"""
    if exposure_lookup is not None:
        if mode == EXPOSURE_MODE_CONTEMPORANEOUS:
            return exposure_lookup.get((country, imposer, year), 0.0)
        if mode != EXPOSURE_MODE_FIXED_PRETREATMENT:
            raise ValueError(f"未知出口暴露权重口径: {mode}")
        base_year = _fixed_exposure_year(country, imposer, panel_years or [year], exposure_lookup)
        return exposure_lookup.get((country, imposer, base_year), 0.0) if base_year is not None else 0.0
    return _stylized_exposure(country, imposer)


def demo_shock_panel(
    countries: list[str],
    sectors: list[str],
    years: list[int],
    export_exposure: pd.DataFrame | None = None,
    exposure_mode: str = EXPOSURE_MODE_FIXED_PRETREATMENT,
) -> pd.DataFrame:
    """生成覆盖全部 (country, sector, year) 的冲击面板,未受冲击处为 0。

    列:tariff_shock(全部出口面对的平均额外关税)、treated、shock_type、
        announced_date / effective_date(取贡献最大事件,支持 DID 时间线)、note。
    """
    if exposure_mode not in EXPOSURE_MODES:
        raise ValueError(f"exposure_mode 必须是 {EXPOSURE_MODES}")
    shock: dict[tuple[str, str, int], float] = {}
    shock_contemporaneous: dict[tuple[str, str, int], float] = {}
    main_event: dict[tuple[str, str, int], tuple[float, TariffEvent]] = {}
    exposure_lookup = _exposure_map(export_exposure)

    for tariff_event in EVENTS:
        targets = (
            [c for c in countries if c != tariff_event.imposer]
            if tariff_event.targets == "ALL"
            else [c for c in tariff_event.targets if c in countries]
        )
        for c in targets:
            if c in tariff_event.exempt:
                continue
            for s, by_year in (tariff_event.overrides.get(c, tariff_event.rates)).items():
                for y, rate in by_year.items():
                    if y not in years or rate <= 0:
                        continue
                    w = _exposure(c, tariff_event.imposer, y, exposure_lookup, mode=exposure_mode, panel_years=years)
                    if w <= 0:
                        continue
                    contrib = rate * w
                    contemporaneous = rate * _exposure(
                        c,
                        tariff_event.imposer,
                        y,
                        exposure_lookup,
                        mode=EXPOSURE_MODE_CONTEMPORANEOUS,
                        panel_years=years,
                    )
                    tariff_key = (c, s, y)
                    shock[tariff_key] = shock.get(tariff_key, 0.0) + contrib
                    shock_contemporaneous[tariff_key] = shock_contemporaneous.get(tariff_key, 0.0) + contemporaneous
                    if tariff_key not in main_event or contrib > main_event[tariff_key][0]:
                        main_event[tariff_key] = (contrib, tariff_event)

    base = pd.MultiIndex.from_product([countries, sectors, years], names=["country", "sector", "year"]).to_frame(
        index=False
    )
    base["tariff_shock"] = [shock.get((c, s, y), 0.0) for c, s, y in zip(base["country"], base["sector"], base["year"])]
    base["treated"] = (base["tariff_shock"] > TREATED_THRESHOLD).astype(int)
    base["tariff_shock_contemporaneous"] = [
        shock_contemporaneous.get((c, s, y), 0.0) for c, s, y in zip(base["country"], base["sector"], base["year"])
    ]
    base["treated_contemporaneous"] = (base["tariff_shock_contemporaneous"] > TREATED_THRESHOLD).astype(int)
    base["tariff_exposure_mode"] = exposure_mode
    base["shock_type"] = SHOCK_TARIFF

    events = [
        main_event.get((c, s, y), (0.0, None))[1] for c, s, y in zip(base["country"], base["sector"], base["year"])
    ]
    base["announced_date"] = [e.announced if e else "" for e in events]
    base["effective_date"] = [e.effective if e else "" for e in events]
    base["note"] = [e.name if e else "" for e in events]

    # 制裁/出口管制 mock:直接按国家-行业-年份暴露强度写入独立列。
    entity_shock: dict[tuple[str, str, int, str], float] = {}
    entity_event: dict[tuple[str, str, int, str], tuple[float, EntityListEvent]] = {}
    for entity_event_def in ENTITY_LIST_EVENTS:
        for c in [t for t in entity_event_def.targets if t in countries]:
            for s, by_year in entity_event_def.intensities.items():
                if s not in sectors:
                    continue
                for y, intensity in by_year.items():
                    if y not in years or intensity <= 0:
                        continue
                    entity_key = (c, s, y, entity_event_def.shock_col)
                    entity_shock[entity_key] = entity_shock.get(entity_key, 0.0) + intensity
                    if entity_key not in entity_event or intensity > entity_event[entity_key][0]:
                        entity_event[entity_key] = (intensity, entity_event_def)

    for shock_type, (shock_col, treated_col) in SHOCK_SPECS.items():
        if shock_type == SHOCK_TARIFF:
            continue
        base[shock_col] = [
            entity_shock.get((c, s, y, shock_col), 0.0)
            for c, s, y in zip(base["country"], base["sector"], base["year"])
        ]
        base[treated_col] = (base[shock_col] > TREATED_THRESHOLD).astype(int)
        evs = [
            entity_event.get((c, s, y, shock_col), (0.0, None))[1]
            for c, s, y in zip(base["country"], base["sector"], base["year"])
        ]
        prefix = shock_col.removesuffix("_shock")
        base[f"{prefix}_announced_date"] = [e.announced if e else "" for e in evs]
        base[f"{prefix}_effective_date"] = [e.effective if e else "" for e in evs]
        base[f"{prefix}_note"] = [e.name if e else "" for e in evs]
    return base


def write_demo(
    countries: list[str],
    sectors: list[str],
    years: list[int],
    *,
    exposure_mode: str = EXPOSURE_MODE_FIXED_PRETREATMENT,
) -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    export_exposure = load_export_exposure(years)
    demo_shock_panel(countries, sectors, years, export_exposure=export_exposure, exposure_mode=exposure_mode).to_csv(
        PROCESSED_DIR / DEMO_FILE, index=False
    )


def events_metadata() -> list[dict]:
    """事件表的展示视图(步骤11 前端的事件时间线)。"""
    out = []
    for tariff_event in EVENTS:
        sector_codes = set(tariff_event.rates)
        for override in tariff_event.overrides.values():
            sector_codes.update(override)
        peak = {s: max(by_year.values()) for s, by_year in tariff_event.rates.items()}
        top_sectors = sorted(peak, key=lambda s: peak[s], reverse=True)
        out.append(
            {
                "name": tariff_event.name,
                "shock_type": SHOCK_TARIFF,
                "imposer": tariff_event.imposer,
                "targets": "全部经济体" if tariff_event.targets == "ALL" else "、".join(tariff_event.targets),
                "exempt": "、".join(tariff_event.exempt),
                "announced": tariff_event.announced,
                "effective": tariff_event.effective,
                "n_sectors": len(tariff_event.rates),
                "top_sectors": top_sectors[:3],
                "peak_rate": max(peak.values()),
                "target_codes": [] if tariff_event.targets == "ALL" else list(tariff_event.targets),
                "sector_codes": sorted(sector_codes),
                "all_targets": tariff_event.targets == "ALL",
            }
        )
    for entity_event_def in ENTITY_LIST_EVENTS:
        peak = {s: max(by_year.values()) for s, by_year in entity_event_def.intensities.items()}
        top_sectors = sorted(peak, key=lambda s: peak[s], reverse=True)
        out.append(
            {
                "name": entity_event_def.name,
                "imposer": "USA",
                "targets": "、".join(entity_event_def.targets),
                "exempt": "",
                "announced": entity_event_def.announced,
                "effective": entity_event_def.effective,
                "n_sectors": len(entity_event_def.intensities),
                "top_sectors": top_sectors[:3],
                "peak_rate": max(peak.values()),
                "shock_type": entity_event_def.shock_type,
                "entities": "、".join(entity_event_def.entities),
                "removal": entity_event_def.removal or None,
                "target_codes": list(entity_event_def.targets),
                "sector_codes": sorted(entity_event_def.intensities),
                "all_targets": False,
            }
        )
    return out


def load_shocks() -> pd.DataFrame:
    """读取 (country, sector, year) 冲击面板。接入真实数据后在这里切换数据源。"""
    path = PROCESSED_DIR / DEMO_FILE
    if not path.exists():
        raise FileNotFoundError(f"未找到冲击数据 {path},请先运行 `gvcsim compute` 生成演示数据")
    return pd.read_csv(path, keep_default_na=False)
