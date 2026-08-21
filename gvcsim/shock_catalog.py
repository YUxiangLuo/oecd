"""Static shock contracts, fallback exposure constants, and event catalogues."""

from __future__ import annotations

from dataclasses import dataclass, field

DEMO_FILE = "demo_trade_war_tariffs.csv"
EXPOSURE_PREFIX = "export_exposure"

# treated 阈值:全部出口的平均额外关税超过 0.1 个百分点才算受处理,
# 避免"土耳其对美反制 × 美国微小对土出口份额"这类痕量项污染处理组。
TREATED_THRESHOLD = 0.001
SHOCK_CONTRACT_VERSION = 1
EXPOSURE_MODE_FIXED_PRETREATMENT = "fixed_pretreatment"
EXPOSURE_MODE_CONTEMPORANEOUS = "contemporaneous"
EXPOSURE_MODES = (EXPOSURE_MODE_FIXED_PRETREATMENT, EXPOSURE_MODE_CONTEMPORANEOUS)
EXPOSURE_SOURCE_OECD_ICIO = "oecd_icio_bilateral_flow"
EXPOSURE_SOURCE_STYLIZED = "stylized_teaching_fallback"
EXPOSURE_SOURCES = (EXPOSURE_SOURCE_OECD_ICIO, EXPOSURE_SOURCE_STYLIZED)
OECD_EXPOSURE_DISCLOSURE = "出口暴露度来自经发布校验的 OECD ICIO 双边流向；政策事件映射与冲击数值编码仍是教学口径。"
STYLIZED_EXPOSURE_DISCLOSURE = "风格化出口暴露度仅供教学测试，不是 OECD ICIO 观测值，不得表述为官方数据。"
ZERO_TOTAL_EXPORTS_POLICY = "total_exports=0 时 bilateral_exports 必须为 0，export_exposure 明确定义为 0。"
EVENT_SOURCE_OFFICIAL = "official_event_source"
EVENT_SOURCE_TEACHING = "teaching_encoding_no_event_source"
EVENT_SOURCE_STATUSES = (EVENT_SOURCE_OFFICIAL, EVENT_SOURCE_TEACHING)
EVENT_SOURCE_DISCLOSURE = (
    "只有列出 URL 的事件与日期可视为有官方事件来源；ICIO 行业映射与数值强度始终是未逐项引证的教学编码，不是官方统计。"
)

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

SHOCK_DEFINITIONS = {
    SHOCK_TARIFF: (
        "各关税事件的双边行业平均加征税率乘以目标经济体对加征方的出口暴露度后求和；数值表示全部出口面对的平均额外关税。"
    ),
    SHOCK_SANCTIONS: (
        "把制裁名单事件中的目标实体手工映射到目标经济体×ICIO 行业的教学暴露强度；"
        "该强度不是关税税率，也不使用出口暴露度加权。"
    ),
    SHOCK_EXPORT_CONTROL: (
        "把出口管制实体清单手工映射到目标经济体×ICIO 行业的教学供应受限强度；"
        "该强度不是关税税率，也不使用出口暴露度加权。"
    ),
}

SHOCK_FIELD_SPECS = {
    SHOCK_TARIFF: {
        "shock_field": "tariff_shock",
        "treated_field": "treated",
        "announced_date_field": "announced_date",
        "effective_date_field": "effective_date",
        "note_field": "note",
    },
    SHOCK_SANCTIONS: {
        "shock_field": "sanction_shock",
        "treated_field": "sanction_treated",
        "announced_date_field": "sanction_announced_date",
        "effective_date_field": "sanction_effective_date",
        "note_field": "sanction_note",
    },
    SHOCK_EXPORT_CONTROL: {
        "shock_field": "export_control_shock",
        "treated_field": "export_control_treated",
        "announced_date_field": "export_control_announced_date",
        "effective_date_field": "export_control_effective_date",
        "note_field": "export_control_note",
    },
}


def shock_contract_metadata() -> dict:
    """Exact, versioned schema and provenance contract for the wide shock artifact."""
    return {
        "version": SHOCK_CONTRACT_VERSION,
        "treated_threshold": TREATED_THRESHOLD,
        "treated_operator": ">",
        "types": {shock_type: dict(spec) for shock_type, spec in SHOCK_FIELD_SPECS.items()},
        "tariff_exposure": {
            "source_field": "tariff_exposure_source",
            "mode_field": "tariff_exposure_mode",
            "disclosure_field": "tariff_exposure_disclosure",
            "allowed_sources": list(EXPOSURE_SOURCES),
            "allowed_modes": list(EXPOSURE_MODES),
        },
    }


def validate_shock_contract_metadata(value: object) -> None:
    if value != shock_contract_metadata():
        raise ValueError(f"unsupported or incomplete shock contract; version {SHOCK_CONTRACT_VERSION} is required")


# ---------------------------------------------------------------------------
# 出口暴露度 fallback:各经济体货物出口中流向美国的份额。
# 量级参考 2017–2019 UN Comtrade 方向别结构:北美邻国 ~0.75,东亚 0.1–0.2,
# 欧盟内部国家对美敞口低(0.02–0.1),资源出口国普遍较低。
# 正常生产路径必须使用 export_exposure_<year>.csv；这里只服务显式 opt-in 的教学测试。
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

# Catalogue imposers absent from the base ICIO country dimension are aggregate
# destinations.  Their flow is the non-overlapping sum of these base destinations.
COMPOSITE_IMPOSER_MEMBERS = {"EU": frozenset(EU27)}


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
    timeline_note: str = ""
    source_urls: tuple[str, ...] = ()

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
    timeline_note: str = ""
    source_urls: tuple[str, ...] = ()

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
        name="美国301对华关税(四批清单复合处理；时间线标首批)",
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
        timeline_note="该行把 List 1、2、3、4A 的年度行业暴露合并为一个复合处理；宣布日和生效日只对应首批清单，后续批次已体现在 2018–2020 年强度中。",
        source_urls=(
            "https://www.ustr.gov/issue-areas/enforcement/section-301-investigations/section-301-china/34-billion-trade-action",
            "https://www.ustr.gov/issue-areas/enforcement/section-301-investigations/section-301-china/200-billion-trade-action",
        ),
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
        name="OFAC SDN:新疆生产建设兵团(XPCC)指定",
        shock_type=SHOCK_SANCTIONS,
        targets=("CHN",),
        announced="2020-07-31",
        effective="2020-07-31",
        entities=("XPCC", "与 XPCC 相关的被指定人员"),
        intensities={
            "C13T15": {2020: 0.030},
            "A01_02": {2020: 0.012},
            "C20": {2020: 0.010},
        },
        timeline_note="本事件只对应 OFAC 于 2020-07-31 作出的 SDN 指定；行业强度是教学映射，不把其他进口限制混入同一事件。",
        source_urls=("https://ofac.treasury.gov/recent-actions/20200731",),
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
