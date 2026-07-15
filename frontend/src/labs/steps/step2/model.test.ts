import { describe, expect, it } from "bun:test";
import type { Meta, ShockEvent } from "../../../types";
import {
  closestSupportedYear,
  eventKey,
  filtersForEvent,
  filtersMatchEvent,
  representativeSector,
} from "./model";

const meta: Meta = {
  years: [2016, 2017, 2018, 2019, 2020],
  countries: ["CHN", "USA", "DEU"],
  sectors: ["A01_02", "C24", "C29"],
};

const event: ShockEvent = {
  name: "美国301对华关税",
  shock_type: "关税冲击",
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
};

describe("step2 shock event model", () => {
  it("uses a stable event key", () => {
    expect(eventKey(event)).toBe("美国301对华关税::2018-07-06");
  });

  it("maps an event to its supported year and unique target", () => {
    const filters = filtersForEvent(event, meta);
    expect(filters.year).toBe(2018);
    expect(filters.country).toBe("CHN");
    expect(filters.shockType).toBe("关税冲击");
    expect(filters.onlyHit).toBe(true);
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

  it("detects manual changes after event synchronization", () => {
    const expected = filtersForEvent(event, meta);
    expect(filtersMatchEvent(expected, expected)).toBe(true);
    expect(filtersMatchEvent({ ...expected, sector: "C24" }, expected)).toBe(false);
    expect(filtersMatchEvent({ ...expected, page: 2 }, expected)).toBe(true);
  });
});
