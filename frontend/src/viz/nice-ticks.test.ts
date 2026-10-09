import { describe, expect, test } from "bun:test";
import { divergingAxis, integerDomain, niceDomain } from "./nice-ticks";

describe("niceDomain", () => {
  test("rounds a share axis to readable steps instead of max ÷ 4", () => {
    expect(niceDomain(0, 12.5).ticks).toEqual([0, 2.5, 5, 7.5, 10, 12.5]);
    expect(niceDomain(0, 54.22).ticks).toEqual([0, 20, 40, 60]);
  });

  test("a tiny negative value costs one small step below zero, not half the range", () => {
    const { lo, hi } = niceDomain(-0.003, 1.03);
    expect(lo).toBeGreaterThanOrEqual(-0.2);
    expect(hi).toBeLessThanOrEqual(1.2);
    expect(lo).toBeLessThanOrEqual(-0.003);
    expect(hi).toBeGreaterThanOrEqual(1.03);
  });

  test("covers the data and keeps non-negative data at or above zero", () => {
    const { lo, hi, ticks } = niceDomain(230_000, 2_813_427);
    expect(lo).toBeLessThanOrEqual(230_000);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeGreaterThanOrEqual(2_813_427);
    expect(ticks.every((tick) => Number.isInteger(tick / 500_000))).toBe(true);
  });

  test("handles negative ranges, a flat series and non-finite input", () => {
    expect(niceDomain(-0.37, -0.3).ticks.every((tick) => tick <= 0)).toBe(true);
    expect(niceDomain(3, 3).ticks.length).toBeGreaterThan(1);
    expect(niceDomain(Number.NaN, 1)).toEqual({ lo: 0, hi: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
  });
});

describe("integerDomain", () => {
  test("whole-number metrics get integer ticks only, never repeated once rounded", () => {
    // 离心率 between 2 and 3 used to tick at 2, 2.25, 2.5, 2.75, 3 ("2, 2, 3, 3, 3").
    expect(integerDomain(2, 3).ticks).toEqual([2, 3]);
    expect(integerDomain(2, 2.5).ticks).toEqual([2, 3]);
    expect(integerDomain(0, 10).ticks).toEqual([0, 2, 4, 6, 8, 10]);
    expect(integerDomain(4, 4).ticks.every((tick) => Number.isInteger(tick))).toBe(true);
  });

  test("keeps the ordinary steps when they are already whole", () => {
    expect(integerDomain(0, 54).ticks).toEqual(niceDomain(0, 54).ticks);
    expect(integerDomain(1, 7).ticks.every((tick) => Number.isInteger(tick))).toBe(true);
    const wide = integerDomain(0, 230);
    expect(wide.ticks.every((tick) => Number.isInteger(tick))).toBe(true);
    expect(wide.hi).toBeGreaterThanOrEqual(230);
  });
});

describe("divergingAxis", () => {
  // Step 15's summary (个标准差): bars and whiskers from -0.0645 to +0.0033.
  const summary = [0, -0.0619, -0.0645, -0.0594, 0.001, -0.0014, 0.0033, -0.0034, -0.0054, -0.0014, -0.0489, -0.0498, -0.048];

  test("the range comes from the data alone: the same however many ticks fit (page widths, report, print)", () => {
    // The page at 1440 px used to read −0.1…0 and at 1024 px and in the report −0.15…0.
    const ranges = [2, 3, 4, 5, 6, 8, 12].map((intervals) => divergingAxis(summary, intervals));
    for (const axis of ranges) {
      expect([axis.lo, axis.hi]).toEqual([-0.075, 0.025]);
      expect([axis.ticks[0], axis.ticks.at(-1)]).toEqual([-0.075, 0.025]);
      expect(axis.ticks).toContain(0);
    }
    // Only the density changes.
    expect(ranges[0].ticks).toEqual([-0.075, -0.05, -0.025, 0, 0.025]);
    expect(divergingAxis(summary, 20).ticks.length).toBeGreaterThan(5);
  });

  test("ticks never print rounded and the range stays tight", () => {
    // Step 11: ±0.58 points reads -0.6…0.6, not -1…1.
    expect(divergingAxis([-0.5711, 0.577], 6).ticks).toEqual([-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6]);
    // Step 13 in standard deviations: -0.04…0 with a coarser step where the room is small.
    expect(divergingAxis([-0.0329, -0.0031], 2).ticks).toEqual([-0.04, -0.02, 0]);
    expect(divergingAxis([-0.0329, -0.0031], 4).ticks).toEqual([-0.04, -0.03, -0.02, -0.01, 0]);
    expect(divergingAxis([0, 0], 4).ticks).toContain(0);
  });
});
