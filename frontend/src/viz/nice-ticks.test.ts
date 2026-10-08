import { describe, expect, test } from "bun:test";
import { integerDomain, niceDomain } from "./nice-ticks";

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
