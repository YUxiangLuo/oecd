import { describe, expect, test } from "bun:test";
import { signedDomain, signedStack } from "./signed-layout";

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

  test("uses the largest positive and negative extents across rows", () => {
    expect(signedDomain([[4, -2], [3, -5]])).toEqual({ positive: 4, negative: 5 });
  });
});
