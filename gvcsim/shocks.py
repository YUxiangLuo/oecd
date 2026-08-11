"""步骤11:贸易政策冲击数据接入。

真实系统应接入 PIIE 中美关税追踪库 / WTO / GTA / OFAC-BIS 清单(见项目
说明文档 4.2 节)。开发起点阶段提供一份**拟真的演示数据**:以 2017–2020
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

import numpy as np
import pandas as pd

from gvcsim.config import PROCESSED_DIR
from gvcsim.indicators.core import IcioArrays

from gvcsim.shock_catalog import (
    DEMO_FILE as DEMO_FILE,
    ENTITY_LIST_EVENTS as ENTITY_LIST_EVENTS,
    EVENTS as EVENTS,
    EXPOSURE_MODE_CONTEMPORANEOUS as EXPOSURE_MODE_CONTEMPORANEOUS,
    EXPOSURE_MODE_FIXED_PRETREATMENT as EXPOSURE_MODE_FIXED_PRETREATMENT,
    EXPOSURE_MODES as EXPOSURE_MODES,
    EXPOSURE_PREFIX as EXPOSURE_PREFIX,
    EU27 as EU27,
    SHOCK_EXPORT_CONTROL as SHOCK_EXPORT_CONTROL,
    SHOCK_LABELS as SHOCK_LABELS,
    SHOCK_SANCTIONS as SHOCK_SANCTIONS,
    SHOCK_SPECS as SHOCK_SPECS,
    SHOCK_TARIFF as SHOCK_TARIFF,
    TREATED_THRESHOLD as TREATED_THRESHOLD,
    EntityListEvent as EntityListEvent,
    TariffEvent as TariffEvent,
    _EXPOSURE_TO_USA as _EXPOSURE_TO_USA,
    _S232_BASE as _S232_BASE,
    _USA_EXPOSURE_TO as _USA_EXPOSURE_TO,
)


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
                "timeline_note": tariff_event.timeline_note or None,
                "source_urls": list(tariff_event.source_urls),
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
                "timeline_note": entity_event_def.timeline_note or None,
                "source_urls": list(entity_event_def.source_urls),
            }
        )
    return out


def load_shocks() -> pd.DataFrame:
    """读取 (country, sector, year) 冲击面板。接入真实数据后在这里切换数据源。"""
    path = PROCESSED_DIR / DEMO_FILE
    if not path.exists():
        raise FileNotFoundError(f"未找到冲击数据 {path},请先运行 `gvcsim compute` 生成演示数据")
    return pd.read_csv(path, keep_default_na=False)
