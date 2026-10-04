"""Chinese display names for ICIO country and industry codes in generated reports.

Mirrors ``COUNTRY_NAMES`` / ``SECTOR_NAMES`` in ``frontend/src/viz/shared.tsx`` so a report reads
the same way as the pages the student used ("CHN 中国", "C26 计算机电子光学").
``tests/test_report_labels.py`` keeps the two copies in step.
"""

from __future__ import annotations

# fmt: off
SECTOR_NAMES: dict[str, str] = {
    "A01_02": "农林牧业", "A03": "渔业", "B05_06": "能源矿产开采", "B07_08": "金属矿开采", "B09": "采矿支持服务",
    "C10T12": "食品饮料烟草", "C13T15": "纺织服装皮革", "C16": "木材制品", "C17_18": "造纸印刷", "C19": "焦炭与精炼油",
    "C20": "化学品", "C21": "医药", "C22": "橡胶塑料", "C23": "非金属矿物制品", "C24": "基本金属", "C25": "金属制品",
    "C26": "计算机电子光学", "C27": "电气设备", "C28": "机械设备", "C29": "汽车及零部件", "C30": "其他运输设备",
    "C31T33": "家具及其他制造", "D": "电力燃气", "E": "供水与废弃物", "F": "建筑", "G": "批发零售",
    "H49": "陆路运输", "H50": "水路运输", "H51": "航空运输", "H52": "仓储与运输辅助", "H53": "邮政快递",
    "I": "住宿餐饮", "J58T60": "出版影视广播", "J61": "电信", "J62_63": "IT与信息服务", "K": "金融保险",
    "L": "房地产", "M": "专业科技服务", "N": "行政与支持服务", "O": "公共管理与国防", "P": "教育",
    "Q": "卫生与社会工作", "R": "文体娱乐", "S": "其他服务", "T": "家庭自用生产",
}

COUNTRY_NAMES: dict[str, str] = {
    "CHN": "中国", "JPN": "日本", "KOR": "韩国", "TWN": "中国台湾", "HKG": "中国香港",
    "VNM": "越南", "THA": "泰国", "MYS": "马来西亚", "IDN": "印度尼西亚", "PHL": "菲律宾",
    "SGP": "新加坡", "KHM": "柬埔寨", "LAO": "老挝", "MMR": "缅甸", "BRN": "文莱",
    "IND": "印度", "BGD": "孟加拉国", "PAK": "巴基斯坦",
    "AUT": "奥地利", "BEL": "比利时", "BGR": "保加利亚", "BLR": "白俄罗斯", "CHE": "瑞士",
    "CYP": "塞浦路斯", "CZE": "捷克", "DEU": "德国", "DNK": "丹麦", "ESP": "西班牙",
    "EST": "爱沙尼亚", "FIN": "芬兰", "FRA": "法国", "GBR": "英国", "GRC": "希腊",
    "HRV": "克罗地亚", "HUN": "匈牙利", "IRL": "爱尔兰", "ISL": "冰岛", "ITA": "意大利",
    "LTU": "立陶宛", "LUX": "卢森堡", "LVA": "拉脱维亚", "MLT": "马耳他", "NLD": "荷兰",
    "NOR": "挪威", "POL": "波兰", "PRT": "葡萄牙", "ROU": "罗马尼亚", "RUS": "俄罗斯",
    "SVK": "斯洛伐克", "SVN": "斯洛文尼亚", "SWE": "瑞典", "TUR": "土耳其", "UKR": "乌克兰",
    "USA": "美国", "CAN": "加拿大", "MEX": "墨西哥", "ARG": "阿根廷", "BRA": "巴西",
    "CHL": "智利", "COL": "哥伦比亚", "CRI": "哥斯达黎加", "PER": "秘鲁",
    "SAU": "沙特阿拉伯", "ISR": "以色列", "JOR": "约旦", "EGY": "埃及", "MAR": "摩洛哥",
    "TUN": "突尼斯", "NGA": "尼日利亚", "ZAF": "南非", "CIV": "科特迪瓦", "CMR": "喀麦隆",
    "SEN": "塞内加尔",
    "AUS": "澳大利亚", "NZL": "新西兰", "KAZ": "哈萨克斯坦", "ROW": "世界其他地区",
}
# fmt: on


def country_label(code: str) -> str:
    """Display name such as "CHN 中国"; unknown codes are returned unchanged."""
    name = COUNTRY_NAMES.get(code)
    return f"{code} {name}" if name else code


def sector_label(code: str) -> str:
    """Display name such as "C26 计算机电子光学"; unknown codes are returned unchanged."""
    name = SECTOR_NAMES.get(code)
    return f"{code} {name}" if name else code
