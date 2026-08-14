import { describe, expect, test } from "bun:test";
import { scaleForestCoefs } from "./charts";

describe("forest chart display scale", () => {
  test("converts share coefficients to percentage points", () => {
    const scaled = scaleForestCoefs(
      [{ name: "treated×post", coef: 0.0009, ci_low: -0.0023, ci_high: 0.0040 }],
      100,
    );
    expect(scaled[0].coef).toBeCloseTo(0.09);
    expect(scaled[0].ci_low).toBeCloseTo(-0.23);
    expect(scaled[0].ci_high).toBeCloseTo(0.40);
  });

  test("leaves a scale of 1 unchanged", () => {
    const coefs = [{ name: "k=0", coef: -0.001, ci_low: -0.015, ci_high: 0.012 }];
    expect(scaleForestCoefs(coefs, 1)).toBe(coefs);
  });
});
