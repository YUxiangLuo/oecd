import type { Meta, ShockEvent } from "../../../types";

/** 冲击类型的稳定键(API 契约,见 gvcsim/shocks.py 的 SHOCK_SPECS)。 */
export const SHOCK_TYPES = ["tariff", "sanctions", "export_control"] as const;
export type ShockType = (typeof SHOCK_TYPES)[number];

/** 键 → 展示文案。界面任何地方都不得直接渲染 shock_type 原始键。 */
export const SHOCK_TYPE_LABELS: Record<ShockType, string> = {
  tariff: "关税冲击",
  sanctions: "制裁清单",
  export_control: "出口管制",
};

/** 键 → 时间线配色。三类冲击的处理密度完全不同,颜色是学生一眼分辨它们的主要线索。
 *
 * 与 SHOCK_TYPE_LABELS 同键、同源:这张表曾经按中文名索引,枚举改成稳定键后
 * 查表全部落空、所有事件退化成同一个兜底色,而没有任何测试会红。
 * model.test.ts 现在断言两张表都覆盖 SHOCK_TYPES。 */
export const SHOCK_TYPE_COLORS: Record<ShockType, string> = {
  tariff: "#175a9e",
  sanctions: "#a61b1b",
  export_control: "#6b5200",
};

/** 安全取文案/配色:键未知时不把原始键甩到界面上。 */
export const shockTypeLabel = (key: string | undefined) =>
  SHOCK_TYPE_LABELS[(key ?? "tariff") as ShockType] ?? SHOCK_TYPE_LABELS.tariff;
export const shockTypeColor = (key: string | undefined) =>
  SHOCK_TYPE_COLORS[(key ?? "tariff") as ShockType] ?? SHOCK_TYPE_COLORS.tariff;

export const SHOCK_FILTERS = ["treated", "nonzero", "all"] as const;
export type ShockFilter = (typeof SHOCK_FILTERS)[number];
export const SHOCK_FILTER_LABELS: Record<ShockFilter, string> = {
  treated: "受处理（权威标记）",
  nonzero: "非零强度",
  all: "全部记录",
};

export const SHOCK_SORTS = ["intensity_desc", "intensity_asc", "country_asc", "industry_asc"] as const;
export type ShockSort = (typeof SHOCK_SORTS)[number];
export const SHOCK_SORT_LABELS: Record<ShockSort, string> = {
  intensity_desc: "冲击强度：从高到低",
  intensity_asc: "冲击强度：从低到高",
  country_asc: "国家：A→Z",
  industry_asc: "行业：A→Z",
};

export type ShockPanelFilters = {
  year: number;
  shockType: string;
  country: string;
  sector: string;
  filter: ShockFilter;
  sort: ShockSort;
  page: number;
};

export function shockPanelRequestKey(release: string, filters: ShockPanelFilters): string {
  return [
    release, "shock-panel", filters.year, filters.shockType, filters.country,
    filters.sector, filters.filter, filters.sort, filters.page,
  ].join(":");
}

export function shockSortChange(sort: ShockSort): Pick<ShockPanelFilters, "sort" | "page"> {
  return { sort, page: 1 };
}

export function shockEventsProvenanceError(events: ShockEvent[]): string | null {
  for (const event of events) {
    if (!event.source_disclosure || !Array.isArray(event.source_urls)) {
      return `事件 ${event.name || "未命名"} 缺少固定来源披露或 URL 数组。`;
    }
    if (event.source_status === "official_event_source_complete" || event.source_status === "partial_official_event_source") {
      if (event.source_urls.length === 0) return `事件 ${event.name} 声称有官方来源但没有 URL。`;
    } else if (event.source_status === "teaching_encoding_no_event_source") {
      if (event.source_urls.length !== 0) return `事件 ${event.name} 的教学来源状态与 URL 矛盾。`;
    } else {
      return `事件 ${event.name} 的 source_status 不受支持。`;
    }
  }
  return null;
}

export function eventKey(event: ShockEvent): string {
  return `${event.name}::${event.effective}`;
}

export function closestSupportedYear(effective: string, years: number[], fallback: number): number {
  const effectiveYear = Number.parseInt(effective.slice(0, 4), 10);
  if (!Number.isFinite(effectiveYear) || years.length === 0) return fallback;
  return years.reduce((closest, candidate) => (
    Math.abs(candidate - effectiveYear) < Math.abs(closest - effectiveYear) ? candidate : closest
  ));
}

export function representativeSector(event: ShockEvent, supportedSectors: string[]): string {
  const supported = new Set(supportedSectors);
  return event.top_sectors.find((code) => supported.has(code))
    ?? event.sector_codes?.find((code) => supported.has(code))
    ?? "";
}

export function filtersForEvent(
  event: ShockEvent,
  meta: Meta,
  fallbackYear = meta.years.at(-1) ?? 2020,
): ShockPanelFilters {
  const uniqueTarget = !event.all_targets && event.target_codes?.length === 1
    ? event.target_codes[0]
    : "";
  return {
    shockType: event.shock_type ?? "关税冲击",
    year: closestSupportedYear(event.effective, meta.years, fallbackYear),
    country: uniqueTarget && meta.countries.includes(uniqueTarget) ? uniqueTarget : "",
    sector: representativeSector(event, meta.sectors),
    filter: "treated",
    sort: "intensity_desc",
    page: 1,
  };
}

export function filtersMatchEvent(filters: ShockPanelFilters, expected: ShockPanelFilters): boolean {
  return filters.shockType === expected.shockType
    && filters.year === expected.year
    && filters.country === expected.country
    && filters.sector === expected.sector
    && filters.filter === expected.filter
    && filters.sort === expected.sort;
}
