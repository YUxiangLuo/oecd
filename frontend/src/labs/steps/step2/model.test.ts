import { describe, expect, it, test } from "bun:test";
import type { Meta, ShockEvent } from "../../../types";
import {
  applyManualFilterPatch,
  closestSupportedYear,
  eventKey,
  filtersForEvent,
  filtersMatchEvent,
  restoreSavedEvent,
  representativeSector,
  SHOCK_TYPE_COLORS,
  SHOCK_TYPE_LABELS,
  SHOCK_TYPES,
  shockEventsProvenanceError,
  shockPanelRequestKey,
  shockSortChange,
  shockTypeColor,
  shockTypeLabel,
} from "./model";

const meta: Meta = {
  years: [2016, 2017, 2018, 2019, 2020],
  countries: ["CHN", "USA", "DEU"],
  sectors: ["A01_02", "C24", "C29"],
};

const event: ShockEvent = {
  name: "美国301对华关税",
  shock_type: "tariff",
  imposer: "USA",
  targets: "CHN",
  exempt: "",
  announced: "2018-06-15",
  effective: "2018-07-06",
  n_sectors: 3,
  top_sectors: ["C29", "C24"],
  peak_rate: 0.24,
  target_codes: ["CHN"],
  sector_codes: ["A01_02", "C24", "C29"],
  all_targets: false,
  source_status: "partial_official_event_source",
  source_disclosure: "ICIO 行业与数值是教学编码。",
  source_urls: ["https://example.gov/event"],
};

describe("step2 shock event model", () => {
  it("fails closed on missing or contradictory event provenance", () => {
    expect(shockEventsProvenanceError([event])).toBeNull();
    expect(shockEventsProvenanceError([{
      ...event, source_status: "official_event_source_complete", source_urls: [],
    }])).toContain("没有 URL");
    expect(shockEventsProvenanceError([{
      ...event, source_status: "teaching_encoding_no_event_source", source_urls: ["https://example.gov"],
    }])).toContain("矛盾");
  });

  it("uses a stable event key", () => {
    expect(eventKey(event)).toBe("美国301对华关税::2018-07-06");
  });

  it("preserves an explicit event deselection while retaining legacy restoration", () => {
    expect(restoreSavedEvent([event], {
      selected_event_key: null,
      viewed_events: [event.name],
    })).toBeNull();
    expect(restoreSavedEvent([event], { viewed_events: [event.name] })).toEqual(event);
    expect(restoreSavedEvent([event], { selected_event_key: eventKey(event), viewed_events: [] })).toEqual(event);
  });

  it("maps an event to its supported year and unique target", () => {
    const filters = filtersForEvent(event, meta);
    expect(filters.year).toBe(2018);
    expect(filters.country).toBe("CHN");
    expect(filters.shockType).toBe("tariff");
    expect(filters.filter).toBe("treated");
    expect(filters.sort).toBe("intensity_desc");
    expect(filters.page).toBe(1);
  });

  it("prefers a representative top sector over alphabetically sorted coverage", () => {
    expect(representativeSector(event, meta.sectors)).toBe("C29");
    expect(filtersForEvent(event, meta).sector).toBe("C29");
  });

  it("falls back to a supported covered sector and then all industries", () => {
    expect(representativeSector({ ...event, top_sectors: ["C30"] }, meta.sectors)).toBe("A01_02");
    expect(representativeSector({ ...event, top_sectors: ["C30"], sector_codes: ["C31"] }, meta.sectors)).toBe("");
  });

  it("keeps all-target or unsupported-target events at all economies", () => {
    expect(filtersForEvent({ ...event, all_targets: true, target_codes: [] }, meta).country).toBe("");
    expect(filtersForEvent({ ...event, target_codes: ["ROW"] }, meta).country).toBe("");
    expect(filtersForEvent({ ...event, target_codes: ["CHN", "USA"] }, meta).country).toBe("");
  });

  it("uses the closest supported year and safely falls back for invalid dates", () => {
    expect(closestSupportedYear("2022-01-01", meta.years, 2020)).toBe(2020);
    expect(closestSupportedYear("not-a-date", meta.years, 2020)).toBe(2020);
    expect(closestSupportedYear("2018-01-01", [], 2020)).toBe(2020);
  });

  it("keys every control-dependent panel request including treated/nonzero/all", () => {
    const filters = filtersForEvent(event, meta);
    const treated = shockPanelRequestKey("release", filters);
    expect(shockPanelRequestKey("release", { ...filters, filter: "nonzero" })).not.toBe(treated);
    expect(shockPanelRequestKey("release", { ...filters, sort: "country_asc" })).not.toBe(treated);
    expect(shockPanelRequestKey("release", { ...filters, page: 2 })).not.toBe(treated);
    expect(shockPanelRequestKey("release", filters)).toBe(treated);
  });

  it("detects manual changes after event synchronization", () => {
    const expected = filtersForEvent(event, meta);
    expect(filtersMatchEvent(expected, expected)).toBe(true);
    expect(filtersMatchEvent({ ...expected, sector: "C24" }, expected)).toBe(false);
    expect(filtersMatchEvent({ ...expected, sort: "country_asc" }, expected)).toBe(false);
    expect(filtersMatchEvent({ ...expected, page: 2 }, expected)).toBe(true);
  });

  it("resets pagination whenever the sort changes", () => {
    expect(shockSortChange("industry_asc")).toEqual({ sort: "industry_asc", page: 1 });
  });

  it("clears event-specific scope when the shock type changes manually", () => {
    const current = filtersForEvent(event, meta);
    const transition = applyManualFilterPatch(current, { shockType: "sanctions", page: 4 });

    expect(transition.clearSelectedEvent).toBe(true);
    expect(transition.filters).toEqual({
      ...current,
      shockType: "sanctions",
      country: "",
      sector: "",
      filter: "treated",
      page: 1,
    });
  });

  it("keeps the selected event available for reversible within-type filter changes", () => {
    const current = filtersForEvent(event, meta);
    const transition = applyManualFilterPatch(current, { sector: "C24", filter: "all", page: 1 });

    expect(transition.clearSelectedEvent).toBe(false);
    expect(transition.filters.country).toBe("CHN");
    expect(transition.filters.sector).toBe("C24");
    expect(transition.filters.filter).toBe("all");
  });

  it("uses the stable tariff key when legacy event metadata omits its type", () => {
    expect(filtersForEvent({ ...event, shock_type: undefined }, meta).shockType).toBe("tariff");
  });
});

describe("冲击类型的键与展示", () => {
  test("每个稳定键都有文案和配色", () => {
    // 这条守的是一次真实回归:配色表原来按中文名索引,枚举改成稳定键后
    // 查表全部落空,时间线上所有事件退化成同一个兜底色,而没有任何测试会红。
    for (const key of SHOCK_TYPES) {
      expect(SHOCK_TYPE_LABELS[key]).toBeTruthy();
      expect(SHOCK_TYPE_COLORS[key]).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(Object.keys(SHOCK_TYPE_LABELS).sort()).toEqual([...SHOCK_TYPES].sort());
    expect(Object.keys(SHOCK_TYPE_COLORS).sort()).toEqual([...SHOCK_TYPES].sort());
  });

  test("三类冲击的前景色在白底达到 WCAG AA", () => {
    const channel = (value: number) => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string) => {
      const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    };
    for (const color of Object.values(SHOCK_TYPE_COLORS)) {
      expect(1.05 / (luminance(color) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("三类冲击的颜色互不相同", () => {
    // 颜色是学生一眼区分三类冲击的主要线索;撞色等于没有编码。
    expect(new Set(Object.values(SHOCK_TYPE_COLORS)).size).toBe(SHOCK_TYPES.length);
  });

  test("取文案/配色不会把原始键甩到界面上", () => {
    expect(shockTypeLabel("tariff")).toBe("关税冲击");
    expect(shockTypeLabel("sanctions")).toBe("制裁清单");
    expect(shockTypeLabel("export_control")).toBe("出口管制");
    // 未知或缺失的键要退回一个可读文案,而不是显示 undefined / 裸键。
    expect(shockTypeLabel(undefined)).toBe("关税冲击");
    expect(shockTypeLabel("bogus")).toBe("关税冲击");
    expect(shockTypeColor("bogus")).toMatch(/^#/);
  });
});
