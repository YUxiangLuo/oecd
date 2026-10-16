import { describe, expect, test } from "bun:test";
import { formatMetric } from "./format";

describe("formatMetric", () => {
  test("uses one precision contract for percentages, amounts and scalar metrics", () => {
    expect(formatMetric(0.12345, "pct")).toBe("12.345%");
    // Million-USD amounts: whole millions from 1 up, three decimals below (as on the step 6–9 cards).
    expect(formatMetric(1234.567, "amount")).toBe("1,235");
    expect(formatMetric(62.4, "amount")).toBe("62");
    expect(formatMetric(0.4567, "amount")).toBe("0.457");
    // A real but tiny flow is not an exact zero.
    expect(formatMetric(0.0000652, "amount")).toBe("<0.001");
    expect(formatMetric(1.2, "number")).toBe("1.200");
    // Whole counts (degree, eccentricity) carry no decimals.
    expect(formatMetric(43, "number")).toBe("43");
    expect(formatMetric(98.105, "count")).toBe("98");
    // A small but real betweenness is not the 0 of a node on no shortest route (round 5).
    expect(formatMetric(0.3, "count")).toBe("<1");
    expect(formatMetric(0.6, "count")).toBe("1");
    expect(formatMetric(0, "count")).toBe("0");
  });

  test("shows large dimensionless metrics as grouped integers instead of x.000", () => {
    expect(formatMetric(48123.4, "number")).toBe("48,123");
    expect(formatMetric(-48123.4, "number")).toBe("-48,123");
    expect(formatMetric(99.9, "number")).toBe("99.900");
    // A node without edges has degree and betweenness exactly 0.
    expect(formatMetric(0, "number")).toBe("0");
    expect(formatMetric(0)).toBe("0");
  });

  test("does not leak non-finite values into labels", () => {
    expect(formatMetric(Number.POSITIVE_INFINITY, "amount")).toBe("—");
    expect(formatMetric(Number.NaN)).toBe("—");
  });

  test("normalizes negative zero and tiny negatives that round to zero", () => {
    expect(formatMetric(-0, "amount")).toBe("0");
    expect(formatMetric(-1e-13, "amount")).toBe("0");
    expect(formatMetric(-1e-9, "pct")).toBe("0.000%");
    expect(formatMetric(-1e-9, "number")).toBe("0.000");
    // 真正的负数不受影响
    expect(formatMetric(-0.5, "amount")).toBe("-0.500");
  });
});
