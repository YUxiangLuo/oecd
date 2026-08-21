import { describe, expect, test } from "bun:test";
import { decompositionDomainRows, type DecompositionSpec } from "../decomposition-model";
import { signedDomain, signedStack } from "./signed-layout";

const directAmount: DecompositionSpec = {
  total: "total",
  parts: [{ key: "a" }, { key: "b" }],
};

describe("signedStack", () => {
  test("keeps an all-positive normalized row compatible with a 100% bar", () => {
    const domain = signedDomain([[2, 3, 5]], true);
    const layout = signedStack([2, 3, 5], domain, true);
    expect(layout.zeroPct).toBe(0);
    expect(layout.segments.map((segment) => segment.widthPct)).toEqual([20, 30, 50]);
  });

  test("places negative components left of one shared zero", () => {
    const domain = signedDomain([[80, 30, -10], [50, 50, 0]], true);
    const layout = signedStack([80, 30, -10], domain, true);
    const negative = layout.segments[2];
    expect(negative.negative).toBe(true);
    expect(negative.leftPct + negative.widthPct).toBeCloseTo(layout.zeroPct);
    expect(layout.segments[0].leftPct).toBeCloseTo(layout.zeroPct);
  });

  test("uses an authoritative normalization total and leaves a visible closure gap", () => {
    const domain = signedDomain([[6, 2]], true, [10]);
    const layout = signedStack([6, 2], domain, true, 10);
    expect(layout.segments.map((segment) => segment.widthPct)).toEqual([60, 20]);
    expect(layout.segments[1].leftPct + layout.segments[1].widthPct).toBe(80);
  });

  test("isolates a zero-total signed row without distorting positive compare geometry", () => {
    const sharedRows = decompositionDomainRows([
      { total: 0, a: 2, b: -2 },
      { total: 10, a: 6, b: 2 },
    ], directAmount);
    expect(sharedRows).toEqual([{ values: [6, 2], total: 10 }]);
    const sharedPositiveDomain = signedDomain(
      sharedRows.map((row) => row.values),
      true,
      sharedRows.map((row) => row.total),
    );
    const positiveLayout = signedStack([6, 2], sharedPositiveDomain, true, 10);
    expect(positiveLayout.segments.map((segment) => segment.widthPct)).toEqual([60, 20]);
    expect(positiveLayout.segments[1].leftPct + positiveLayout.segments[1].widthPct).toBe(80);

    const zeroTotalRawDomain = signedDomain([[2, -2]]);
    const zeroTotalLayout = signedStack([2, -2], zeroTotalRawDomain);
    expect(zeroTotalLayout.zeroPct).toBe(50);
    expect(zeroTotalLayout.segments.map((segment) => segment.widthPct)).toEqual([50, 50]);

    const positiveLayoutAfterZeroPanel = signedStack([6, 2], sharedPositiveDomain, true, 10);
    expect(positiveLayoutAfterZeroPanel).toEqual(positiveLayout);
  });

  test("keeps sum-of-parts normalization as the default for unrelated charts", () => {
    const domain = signedDomain([[6, 2]], true);
    const layout = signedStack([6, 2], domain, true);
    expect(layout.segments.map((segment) => segment.widthPct)).toEqual([75, 25]);
  });

  test("uses the largest positive and negative extents across rows", () => {
    expect(signedDomain([[4, -2], [3, -5]])).toEqual({ positive: 4, negative: 5 });
  });
});
