import { describe, expect, test } from "bun:test";
import { linearFit } from "./statistics";

describe("linearFit", () => {
  test("returns an exact OLS line and Pearson correlation", () => {
    const fit = linearFit([{ x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }]);
    expect(fit).toEqual({ n: 3, slope: 2, intercept: 1, correlation: 1 });
  });

  test("does not invent a line for a zero-variance axis", () => {
    const fit = linearFit([{ x: 2, y: 1 }, { x: 2, y: 4 }]);
    expect(fit.slope).toBeNull();
    expect(fit.correlation).toBeNull();
  });

  test("drops non-finite points", () => {
    expect(linearFit([{ x: 1, y: 1 }, { x: Number.NaN, y: 2 }]).n).toBe(1);
  });
});
