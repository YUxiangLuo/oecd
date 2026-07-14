import { describe, expect, test } from "bun:test";
import { formatMetric } from "./format";

describe("formatMetric", () => {
  test("uses one precision contract for percentages, amounts and scalar metrics", () => {
    expect(formatMetric(0.12345, "pct")).toBe("12.35%");
    expect(formatMetric(1234.567, "amount")).toBe("1,234.57");
    expect(formatMetric(1.2, "number")).toBe("1.200");
  });

  test("shows large dimensionless metrics as grouped integers instead of x.000", () => {
    expect(formatMetric(48123.4, "number")).toBe("48,123");
    expect(formatMetric(-48123.4, "number")).toBe("-48,123");
    expect(formatMetric(99.9, "number")).toBe("99.900");
  });

  test("does not leak non-finite values into labels", () => {
    expect(formatMetric(Number.POSITIVE_INFINITY, "amount")).toBe("—");
    expect(formatMetric(Number.NaN)).toBe("—");
  });

  test("normalizes negative zero and tiny negatives that round to zero", () => {
    expect(formatMetric(-0, "amount")).toBe("0");
    expect(formatMetric(-1e-13, "amount")).toBe("0");
    expect(formatMetric(-1e-9, "pct")).toBe("0.00%");
    expect(formatMetric(-1e-9, "number")).toBe("0.000");
    // 真正的负数不受影响
    expect(formatMetric(-0.5, "amount")).toBe("-0.5");
  });
});
