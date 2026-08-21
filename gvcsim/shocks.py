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
    COMPOSITE_IMPOSER_MEMBERS as COMPOSITE_IMPOSER_MEMBERS,
    DEMO_FILE as DEMO_FILE,
    ENTITY_LIST_EVENTS as ENTITY_LIST_EVENTS,
    EVENTS as EVENTS,
    EVENT_SOURCE_DISCLOSURE as EVENT_SOURCE_DISCLOSURE,
    EVENT_SOURCE_OFFICIAL as EVENT_SOURCE_OFFICIAL,
    EVENT_SOURCE_STATUSES as EVENT_SOURCE_STATUSES,
    EVENT_SOURCE_TEACHING as EVENT_SOURCE_TEACHING,
    EXPOSURE_MODE_CONTEMPORANEOUS as EXPOSURE_MODE_CONTEMPORANEOUS,
    EXPOSURE_MODE_FIXED_PRETREATMENT as EXPOSURE_MODE_FIXED_PRETREATMENT,
    EXPOSURE_MODES as EXPOSURE_MODES,
    EXPOSURE_PREFIX as EXPOSURE_PREFIX,
    EXPOSURE_SOURCE_OECD_ICIO as EXPOSURE_SOURCE_OECD_ICIO,
    EXPOSURE_SOURCE_STYLIZED as EXPOSURE_SOURCE_STYLIZED,
    EXPOSURE_SOURCES as EXPOSURE_SOURCES,
    OECD_EXPOSURE_DISCLOSURE as OECD_EXPOSURE_DISCLOSURE,
    EU27 as EU27,
    SHOCK_CONTRACT_VERSION as SHOCK_CONTRACT_VERSION,
    SHOCK_DEFINITIONS as SHOCK_DEFINITIONS,
    SHOCK_EXPORT_CONTROL as SHOCK_EXPORT_CONTROL,
    SHOCK_FIELD_SPECS as SHOCK_FIELD_SPECS,
    SHOCK_LABELS as SHOCK_LABELS,
    SHOCK_SANCTIONS as SHOCK_SANCTIONS,
    SHOCK_SPECS as SHOCK_SPECS,
    SHOCK_TARIFF as SHOCK_TARIFF,
    STYLIZED_EXPOSURE_DISCLOSURE as STYLIZED_EXPOSURE_DISCLOSURE,
    TREATED_THRESHOLD as TREATED_THRESHOLD,
    ZERO_TOTAL_EXPORTS_POLICY as ZERO_TOTAL_EXPORTS_POLICY,
    EntityListEvent as EntityListEvent,
    TariffEvent as TariffEvent,
    _EXPOSURE_TO_USA as _EXPOSURE_TO_USA,
    _S232_BASE as _S232_BASE,
    _USA_EXPOSURE_TO as _USA_EXPOSURE_TO,
    shock_contract_metadata as shock_contract_metadata,
    validate_shock_contract_metadata as validate_shock_contract_metadata,
)


EXPOSURE_KEY_COLUMNS = ("country", "imposer", "year")
EXPOSURE_FLOW_COLUMNS = ("bilateral_exports", "total_exports")
EXPOSURE_REQUIRED_COLUMNS = (*EXPOSURE_KEY_COLUMNS, *EXPOSURE_FLOW_COLUMNS, "export_exposure")
EXPOSURE_RATIO_RTOL = 1e-12
EXPOSURE_RATIO_ATOL = 1e-12
EXPOSURE_FLOW_RTOL = 1e-12
EXPOSURE_FLOW_ATOL = 1e-9


def catalogue_tariff_imposers() -> list[str]:
    """Return every tariff imposer whose exposure can be requested by the catalogue."""
    return sorted({event.imposer for event in EVENTS})


def _declared_years(values: list[int]) -> list[int]:
    numeric = pd.to_numeric(pd.Series(values, dtype=object), errors="coerce")
    array = numeric.to_numpy(dtype=float)
    if len(values) == 0 or not np.isfinite(array).all() or not np.equal(array, np.floor(array)).all():
        raise ValueError("声明的出口暴露度年份必须是非空、有限整数集合")
    return sorted({int(value) for value in array})


def validate_export_exposure(
    export_exposure: pd.DataFrame,
    *,
    countries: list[str] | None = None,
    years: list[int] | None = None,
    imposers: list[str] | None = None,
) -> pd.DataFrame:
    """Validate the complete OECD bilateral-flow table and its economics.

    ``countries`` is the fixed base ICIO country dimension.  Destinations are
    exactly that dimension plus catalogue composite imposers (currently EU),
    unless the equivalent exact set is supplied through ``imposers``.  Composite
    rows never enter the base-destination adding-up identity.
    """
    if not isinstance(export_exposure, pd.DataFrame) or export_exposure.empty:
        raise ValueError("OECD ICIO 出口暴露度必须是非空表")
    missing_columns = sorted(set(EXPOSURE_REQUIRED_COLUMNS) - set(export_exposure.columns))
    if missing_columns:
        raise ValueError(f"OECD ICIO 出口暴露度 schema 不完整；missing={missing_columns}")

    frame = export_exposure.copy()
    for column in ("country", "imposer"):
        normalized = frame[column].fillna("").astype(str).str.strip()
        if normalized.eq("").any():
            raise ValueError(f"OECD ICIO 出口暴露度 {column} 含空白标识符")
        frame[column] = normalized

    year_numeric = pd.to_numeric(frame["year"], errors="coerce")
    year_values = year_numeric.to_numpy(dtype=float)
    if not np.isfinite(year_values).all() or not np.equal(year_values, np.floor(year_values)).all():
        raise ValueError("OECD ICIO 出口暴露度 year 必须是有限整数")
    frame["year"] = year_values.astype(np.int64)

    duplicate = frame.duplicated(list(EXPOSURE_KEY_COLUMNS), keep=False)
    if duplicate.any():
        examples = frame.loc[duplicate, list(EXPOSURE_KEY_COLUMNS)].head(3).to_dict(orient="records")
        raise ValueError(f"OECD ICIO 出口暴露度键重复；examples={examples}")

    numeric: dict[str, np.ndarray] = {}
    for column in (*EXPOSURE_FLOW_COLUMNS, "export_exposure"):
        values = pd.to_numeric(frame[column], errors="coerce").to_numpy(dtype=float)
        if not np.isfinite(values).all():
            raise ValueError(f"OECD ICIO {column} 必须是数值有限值")
        numeric[column] = values
        frame[column] = values
    bilateral = numeric["bilateral_exports"]
    total = numeric["total_exports"]
    exposure_values = numeric["export_exposure"]
    if (bilateral < 0.0).any() or (total < 0.0).any():
        raise ValueError("bilateral_exports/total_exports 不得为负")
    if ((exposure_values < 0.0) | (exposure_values > 1.0)).any():
        raise ValueError("OECD ICIO export_exposure 必须位于 [0,1]")
    if (bilateral > total + EXPOSURE_FLOW_ATOL + EXPOSURE_FLOW_RTOL * total).any():
        raise ValueError("bilateral_exports 不得超过 total_exports")

    positive_total = total > 0.0
    expected_ratio = np.zeros(len(frame), dtype=float)
    expected_ratio[positive_total] = bilateral[positive_total] / total[positive_total]
    zero_total_invalid = (~positive_total) & (
        ~np.isclose(bilateral, 0.0, rtol=0.0, atol=EXPOSURE_RATIO_ATOL)
        | ~np.isclose(exposure_values, 0.0, rtol=0.0, atol=EXPOSURE_RATIO_ATOL)
    )
    if zero_total_invalid.any():
        raise ValueError(f"OECD ICIO 零出口规则不满足：{ZERO_TOTAL_EXPORTS_POLICY}")
    if not np.isclose(exposure_values, expected_ratio, rtol=EXPOSURE_RATIO_RTOL, atol=EXPOSURE_RATIO_ATOL).all():
        raise ValueError("export_exposure 与 bilateral_exports/total_exports 不一致")

    actual_countries = sorted(frame["country"].unique())
    if countries is None:
        country_values = actual_countries
    else:
        country_values = sorted(set(str(country).strip() for country in countries))
        if not country_values or any(not country for country in country_values):
            raise ValueError("声明的 ICIO countries 必须是非空标识符")
    year_list = sorted(int(value) for value in frame["year"].unique()) if years is None else _declared_years(years)
    composite_names = sorted(COMPOSITE_IMPOSER_MEMBERS)
    destination_values = sorted({*country_values, *composite_names})
    if imposers is not None:
        declared_destinations = sorted(set(str(imposer).strip() for imposer in imposers))
        if declared_destinations != destination_values:
            raise ValueError("声明的 ICIO destinations 必须精确等于基础国家加 catalogue composites")
    if not destination_values or any(not destination for destination in destination_values):
        raise ValueError("声明的 ICIO destinations 必须是非空标识符")

    expected_keys = pd.MultiIndex.from_product(
        [country_values, destination_values, year_list], names=list(EXPOSURE_KEY_COLUMNS)
    )
    actual_keys = pd.MultiIndex.from_frame(frame[list(EXPOSURE_KEY_COLUMNS)])
    missing = expected_keys.difference(actual_keys)
    extra = actual_keys.difference(expected_keys)
    if len(missing) or len(extra):
        raise ValueError(
            "OECD ICIO 出口暴露度维度/覆盖不精确；"
            f"missing={len(missing)}, extra={len(extra)}, "
            f"missing_examples={list(missing[:3])}, extra_examples={list(extra[:3])}"
        )

    indexed = frame.set_index(list(EXPOSURE_KEY_COLUMNS)).sort_index()
    for country in country_values:
        for year in year_list:
            group = indexed.loc[(country, slice(None), year), :].reset_index()
            totals = group["total_exports"].to_numpy(dtype=float)
            if not np.isclose(totals, totals[0], rtol=EXPOSURE_FLOW_RTOL, atol=EXPOSURE_FLOW_ATOL).all():
                raise ValueError(f"同一 country/year 的 total_exports 不一致: {(country, year)}")
            declared_total = float(totals[0])
            base = group[group["imposer"].isin(country_values)]
            bilateral_sum = float(base["bilateral_exports"].sum())
            if not np.isclose(
                bilateral_sum,
                declared_total,
                rtol=EXPOSURE_FLOW_RTOL,
                atol=EXPOSURE_FLOW_ATOL,
            ):
                raise ValueError(f"基础 ICIO 目的地 bilateral_exports 加总不等于 total_exports: {(country, year)}")
            expected_exposure_sum = 1.0 if declared_total > 0.0 else 0.0
            if not np.isclose(
                float(base["export_exposure"].sum()),
                expected_exposure_sum,
                rtol=EXPOSURE_RATIO_RTOL,
                atol=EXPOSURE_RATIO_ATOL,
            ):
                raise ValueError(f"基础 ICIO 目的地 export_exposure 加总不可能: {(country, year)}")
            own = base[base["imposer"] == country]
            if len(own) != 1 or not np.isclose(
                own.iloc[0]["bilateral_exports"], 0.0, rtol=0.0, atol=EXPOSURE_FLOW_ATOL
            ):
                raise ValueError(f"国内流量不得计入 bilateral_exports: {(country, year)}")
            for composite, members in COMPOSITE_IMPOSER_MEMBERS.items():
                if composite not in destination_values:
                    continue
                aggregate = base[base["imposer"].isin(set(members))]
                expected_bilateral = float(aggregate["bilateral_exports"].sum())
                composite_row = group[group["imposer"] == composite]
                if len(composite_row) != 1 or not np.isclose(
                    float(composite_row.iloc[0]["bilateral_exports"]),
                    expected_bilateral,
                    rtol=EXPOSURE_FLOW_RTOL,
                    atol=EXPOSURE_FLOW_ATOL,
                ):
                    raise ValueError(f"复合加征方 {composite} 与基础目的地聚合不一致: {(country, year)}")

    return frame.sort_values(list(EXPOSURE_KEY_COLUMNS)).reset_index(drop=True)


def tariff_exposure_disclaimer(shock_frame: pd.DataFrame) -> str:
    """Return source-specific API disclosure, rejecting mixed or unknown provenance."""
    required = {"tariff_exposure_source", "tariff_exposure_mode", "tariff_exposure_disclosure"}
    if not required.issubset(shock_frame.columns) or shock_frame.empty:
        raise ValueError("冲击面板缺少可验证的关税出口暴露度来源字段")
    sources = set(shock_frame["tariff_exposure_source"].fillna("").astype(str).str.strip())
    modes = set(shock_frame["tariff_exposure_mode"].fillna("").astype(str).str.strip())
    if len(sources) != 1 or not sources.issubset(EXPOSURE_SOURCES):
        raise ValueError(f"冲击面板关税出口暴露度来源未知或混合：{sorted(sources)}")
    if len(modes) != 1 or not modes.issubset(EXPOSURE_MODES):
        raise ValueError(f"冲击面板关税出口暴露度口径未知或混合：{sorted(modes)}")
    source = next(iter(sources))
    disclosures = shock_frame["tariff_exposure_disclosure"].fillna("").astype(str).str.strip()
    if source == EXPOSURE_SOURCE_OECD_ICIO:
        if disclosures.ne("").any():
            raise ValueError("OECD ICIO 暴露度行不得携带 fallback 披露")
        return OECD_EXPOSURE_DISCLOSURE
    if disclosures.ne(STYLIZED_EXPOSURE_DISCLOSURE).any():
        raise ValueError("风格化教学 fallback 缺少固定披露")
    return STYLIZED_EXPOSURE_DISCLOSURE


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

        for composite, members in COMPOSITE_IMPOSER_MEMBERS.items():
            bilateral = sum(
                country_to_dest(country, dest) for dest in arr.regions if dest in members and dest != country
            )
            rows.append(
                {
                    "country": country,
                    "imposer": composite,
                    "year": year,
                    "bilateral_exports": bilateral,
                    "total_exports": total,
                    "export_exposure": bilateral / total if total > 0 else 0.0,
                }
            )

    # Generation and release validation share exact dimensions and adding-up rules.
    return validate_export_exposure(pd.DataFrame(rows), countries=arr.regions, years=[year])


def recompute_raw_export_exposure(year: int, raw_dir, contract) -> pd.DataFrame:
    """Independently recompute exposure evidence from one strict raw ICIO file."""
    from gvcsim.data.raw_icio import raw_bilateral_exports

    frame = pd.DataFrame(raw_bilateral_exports(year, raw_dir, contract, COMPOSITE_IMPOSER_MEMBERS))
    return validate_export_exposure(
        frame,
        countries=list(contract.countries),
        years=[year],
    )


def write_export_exposure(arr: IcioArrays, year: int) -> pd.DataFrame:
    """计算并落盘某年的 ICIO 出口暴露度。"""
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    df = build_export_exposure(arr, year)
    df.to_csv(PROCESSED_DIR / f"{EXPOSURE_PREFIX}_{year}.csv", index=False)
    return df


def load_export_exposure(years: list[int] | None = None) -> pd.DataFrame | None:
    """读取已预计算的出口暴露度；缺少任一年返回 None，由调用方 fail closed。"""
    if years is None:
        paths = sorted(PROCESSED_DIR.glob(f"{EXPOSURE_PREFIX}_*.csv"))
    else:
        paths = [PROCESSED_DIR / f"{EXPOSURE_PREFIX}_{y}.csv" for y in years]
        if any(not p.exists() for p in paths):
            return None
    if not paths:
        return None
    return pd.concat([pd.read_csv(p, float_precision="round_trip") for p in paths], ignore_index=True)


def _exposure_map(export_exposure: pd.DataFrame | None) -> dict[tuple[str, str, int], float] | None:
    if export_exposure is None:
        return None
    validated = validate_export_exposure(export_exposure)
    return {
        (str(r.country), str(r.imposer), int(r.year)): float(r.export_exposure)
        for r in validated.itertuples(index=False)
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
    """Select the last strictly pretreatment ICIO year; never use a treated year as baseline."""
    if exposure_lookup is None:
        return None
    available = sorted(y for c, i, y in exposure_lookup if c == country and i == imposer)
    if not available:
        return None
    first = _first_tariff_year(country, imposer, years)
    if first is None:
        return max(available)
    pre = [year for year in available if year < first]
    if not pre:
        raise ValueError(
            f"固定处理前权重要求 {country}→{imposer} 在首次处理年 {first} 之前至少有一个发布年份；"
            "不得回退到最早处理年"
        )
    return max(pre)


def _stylized_exposure(country: str, imposer: str) -> float:
    """只供显式 allow_stylized_fallback 教学测试使用的风格化口径。"""
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
            key = (country, imposer, year)
        else:
            if mode != EXPOSURE_MODE_FIXED_PRETREATMENT:
                raise ValueError(f"未知出口暴露权重口径: {mode}")
            base_year = _fixed_exposure_year(country, imposer, panel_years or [year], exposure_lookup)
            if base_year is None:
                raise ValueError(f"OECD ICIO 出口暴露度缺少固定权重键: {(country, imposer)}")
            key = (country, imposer, base_year)
        try:
            return exposure_lookup[key]
        except KeyError as exc:
            raise ValueError(f"OECD ICIO 出口暴露度缺少必需键: {key}") from exc
    return _stylized_exposure(country, imposer)


def demo_shock_panel(
    countries: list[str],
    sectors: list[str],
    years: list[int],
    export_exposure: pd.DataFrame | None = None,
    exposure_mode: str = EXPOSURE_MODE_FIXED_PRETREATMENT,
    *,
    allow_stylized_fallback: bool = False,
) -> pd.DataFrame:
    """生成覆盖全部 (country, sector, year) 的冲击面板,未受冲击处为 0。

    列:tariff_shock(全部出口面对的平均额外关税)、treated、shock_type、
        announced_date / effective_date(取贡献最大事件,支持 DID 时间线)、note。
    """
    if exposure_mode not in EXPOSURE_MODES:
        raise ValueError(f"exposure_mode 必须是 {EXPOSURE_MODES}")
    if type(allow_stylized_fallback) is not bool:
        raise ValueError("allow_stylized_fallback 必须是布尔值")
    countries = sorted(countries)
    sectors = sorted(sectors)
    years = sorted(years)
    if export_exposure is None and not allow_stylized_fallback:
        raise ValueError(
            "缺少 OECD ICIO 出口暴露度；正式冲击面板禁止隐式使用风格化 fallback。"
            "仅教学测试可显式传入 allow_stylized_fallback=True。"
        )
    if export_exposure is not None:
        export_exposure = validate_export_exposure(export_exposure, years=years)
        missing_countries = sorted(set(countries) - set(export_exposure["country"]))
        if missing_countries:
            raise ValueError(f"OECD ICIO 出口暴露度缺少面板国家: {missing_countries[:5]}")
    exposure_source = EXPOSURE_SOURCE_OECD_ICIO if export_exposure is not None else EXPOSURE_SOURCE_STYLIZED
    shock: dict[tuple[str, str, int], float] = {}
    shock_contemporaneous: dict[tuple[str, str, int], float] = {}
    main_event: dict[tuple[str, str, int], tuple[float, TariffEvent]] = {}
    exposure_lookup = _exposure_map(export_exposure)
    available_imposers = (
        {imposer for _country, imposer, _year in exposure_lookup} if exposure_lookup is not None else None
    )

    requested_sectors = set(sectors)
    for tariff_event in EVENTS:
        if available_imposers is not None and tariff_event.imposer not in available_imposers:
            # Small synthetic dimension contracts may not contain every real
            # catalogue country. Production ICIO contracts contain them all.
            continue
        targets = (
            [c for c in countries if c != tariff_event.imposer]
            if tariff_event.targets == "ALL"
            else [c for c in tariff_event.targets if c in countries]
        )
        for c in targets:
            if c in tariff_event.exempt:
                continue
            for s, by_year in (tariff_event.overrides.get(c, tariff_event.rates)).items():
                if s not in requested_sectors:
                    continue
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
    base["tariff_exposure_source"] = exposure_source
    base["tariff_exposure_mode"] = exposure_mode
    base["tariff_exposure_disclosure"] = (
        STYLIZED_EXPOSURE_DISCLOSURE if exposure_source == EXPOSURE_SOURCE_STYLIZED else ""
    )
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
    allow_stylized_fallback: bool = False,
) -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    export_exposure = load_export_exposure(years)
    demo_shock_panel(
        countries,
        sectors,
        years,
        export_exposure=export_exposure,
        exposure_mode=exposure_mode,
        allow_stylized_fallback=allow_stylized_fallback,
    ).to_csv(PROCESSED_DIR / DEMO_FILE, index=False)


def events_metadata() -> list[dict]:
    """事件表的展示视图(步骤11 前端的事件时间线)。"""
    out = []
    for tariff_event in EVENTS:
        sector_codes = set(tariff_event.rates)
        for override in tariff_event.overrides.values():
            sector_codes.update(override)
        peak = {s: max(by_year.values()) for s, by_year in tariff_event.rates.items()}
        for override in tariff_event.overrides.values():
            for sector, by_year in override.items():
                peak[sector] = max(peak.get(sector, 0.0), max(by_year.values()))
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
                "n_sectors": len(sector_codes),
                "top_sectors": top_sectors[:3],
                "peak_rate": max(peak.values()),
                "target_codes": [] if tariff_event.targets == "ALL" else list(tariff_event.targets),
                "sector_codes": sorted(sector_codes),
                "all_targets": tariff_event.targets == "ALL",
                "timeline_note": tariff_event.timeline_note or None,
                "source_status": (EVENT_SOURCE_OFFICIAL if tariff_event.source_urls else EVENT_SOURCE_TEACHING),
                "source_disclosure": EVENT_SOURCE_DISCLOSURE,
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
                "source_status": (EVENT_SOURCE_OFFICIAL if entity_event_def.source_urls else EVENT_SOURCE_TEACHING),
                "source_disclosure": EVENT_SOURCE_DISCLOSURE,
                "source_urls": list(entity_event_def.source_urls),
            }
        )
    return out


def load_shocks() -> pd.DataFrame:
    """读取 (country, sector, year) 冲击面板。接入真实数据后在这里切换数据源。"""
    path = PROCESSED_DIR / DEMO_FILE
    if not path.exists():
        raise FileNotFoundError(f"未找到冲击数据 {path},请先运行 `gvcsim compute` 生成演示数据")
    return pd.read_csv(path, keep_default_na=False, float_precision="round_trip")
