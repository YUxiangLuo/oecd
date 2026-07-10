import { describe, expect, test } from "bun:test";
import { formatMetric } from "./format";

describe("formatMetric", () => {
  test("uses one precision contract for percentages, amounts and scalar metrics", () => {
    expect(formatMetric(0.12345, "pct")).toBe("12.35%");
    expect(formatMetric(1234.567, "amount")).toBe("1,234.57");
    expect(formatMetric(1.2, "number")).toBe("1.200");
  });

  test("does not leak non-finite values into labels", () => {
    expect(formatMetric(Number.POSITIVE_INFINITY, "amount")).toBe("—");
    expect(formatMetric(Number.NaN)).toBe("—");
  });
});
