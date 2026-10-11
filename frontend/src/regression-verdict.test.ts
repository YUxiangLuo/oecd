import { describe, expect, test } from "bun:test";
import {
  barFigures, barUnitFor, buildRegressionVerdict, chartDisplayScale, distinctDigits, estimateDigits, networkIntervalDigits,
  REGRESSION_STATUS_LABELS,
  regressionStatusLabel, signed, standardizedEffect,
} from "./regression-verdict";
import type { CoefStat, RegressionOutcome, RegressionResponse, TreatmentSupport } from "./types";

const coefficient = (coef: number, low: number | null, high: number | null): CoefStat => ({
  name: "teaching_tariff_exposure", coef, se: 0.01, t: 1, p: low == null ? null : 0.2,
  stars: "", ci_low: low, ci_high: high,
});

function response(outcome: RegressionOutcome, coef: CoefStat, support: TreatmentSupport | null = null): RegressionResponse {
  return {
    design: {
      outcome, depvar: "y", depvar_label: "Y", granularity: "country_industry", shock_type: "tariff",
      shock_col: "teaching_tariff_exposure", treated_col: "teaching_treated", method: "twfe_intensity",
      control_mode: "none", interaction: false, price_mode: "nominal", scenario: "clean",
      scenario_label: "基准", sample_filter: "排除ROW", exclude_row: true, controls: [], control_labels: {},
      equation: "y=x", equation_parts: [], panel_file: "panel_teaching.csv", entity: "entity_id", cluster: "country",
    },
    result: {
      depvar: "y", coefs: [coef], n_obs: 10, n_entities: 2, n_times: 5, n_clusters: 2,
      r2_within: 0.1, depvar_mean: 2, depvar_std: 2, depvar_within_std: 2, diagnostics: {}, notes: [],
      status: support?.status ?? "ok", status_reasons: support?.reasons ?? [], support,
    },
    benchmark: {
      backend: "PanelOLS", policy_coefs: [], max_abs_coef_diff: 0, max_abs_se_diff: 0,
      coef_check_passed: true, se_check_mode: "informational", notes: [],
    },
    disclaimer: "mock",
  };
}

const blockedSupport = (status: "insufficient" | "invalid_design"): TreatmentSupport => ({
  treated_clusters: 1, untreated_clusters: 2, treated_entities: 2, reversal_entities: [],
  reversal_share: 0, absorbing: false, status, reasons: ["处理支持度不足"],
  min_treated_clusters: 5, max_reversal_share: 0.05, suppress_inference: true,
});

describe("fixed TWFE verdict", () => {
  test.each([
    [-0.03, -0.01, "negative"], [0.01, 0.03, "positive"],
    [-0.03, 0, "insufficient"], [0, 0.03, "insufficient"],
  ] as const)("uses both valid interval endpoints %s, %s", (low, high, state) => {
    expect(buildRegressionVerdict("trade", response("trade", coefficient((low + high) / 2, low, high))).state)
      .toBe(state);
  });

  test.each([
    [null, -0.01], [0.01, null], [null, null],
    [0.02, -0.02], [Number.NaN, 0.02], [-0.02, Infinity], [0.01, 0.02],
  ])("does not infer direction from malformed interval %s, %s", (low, high) => {
    const verdict = buildRegressionVerdict("trade", response("trade", coefficient(-0.01, low, high)));
    expect(verdict.state).toBe("insufficient");
    expect(verdict.interval).toBe("—");
    expect(verdict.evidence).toContain("95% 区间没有记录完整");
    expect(verdict.evidence).not.toMatch(/区间（估计值可能落在的范围）为 .*包含 0/);
  });

  test.each([null, undefined, "unknown"])("suppresses an unknown result status %s", (status) => {
    const payload = response("trade", coefficient(-0.02, -0.03, -0.01));
    payload.result.status = status as RegressionResponse["result"]["status"];
    const verdict = buildRegressionVerdict("trade", payload);
    expect(verdict.state).toBe("suppressed");
    expect(verdict.title).toContain("结果状态没有记录完整");
    expect(verdict.interval).toBe("—");
  });

  test("uses confidence intervals rather than coefficient sign", () => {
    const verdict = buildRegressionVerdict("trade", response("trade", coefficient(-0.01, -0.03, 0.01)));
    expect(verdict.state).toBe("insufficient");
    expect(verdict.evidence).toContain("不能说“没有关联”");
  });

  test("scales the fixed intensity coefficient to a one-point increase", () => {
    expect(buildRegressionVerdict("trade", response("trade", coefficient(0.4, 0.2, 0.6))).effect)
      .toBe("+0.40 个百分点");
    expect(buildRegressionVerdict("length", response("length", coefficient(2, 1, 3))).effect)
      .toContain("+0.0200 个长度单位");
    expect(chartDisplayScale("network")).toEqual({ scale: 0.01, unit: "中心性原始单位" });
  });

  test("never turns suppressed inference into a zero-crossing claim", () => {
    const verdict = buildRegressionVerdict(
      "trade", response("trade", coefficient(-0.0084, null, null), blockedSupport("insufficient")),
    );
    expect(verdict.state).toBe("suppressed");
    expect(verdict.interval).toBe("—");
    expect(verdict.evidence).not.toContain("跨过 0");
  });

  test("labels invalid designs separately", () => {
    const verdict = buildRegressionVerdict(
      "trade", response("trade", coefficient(-0.005, null, null), blockedSupport("invalid_design")),
    );
    expect(verdict.title).toContain("计算设定不能用来判断方向");
  });
});

test("every regression status has safe display copy", () => {
  expect(Object.keys(REGRESSION_STATUS_LABELS).sort()).toEqual(
    ["insufficient", "invalid_design", "ok", "warning"],
  );
  expect(regressionStatusLabel("bogus")).toBe("设计有效性未知");
});

describe("network size in standard deviations (same digits as the report)", () => {
  const network = (coef: number, low: number, high: number, sd: number) => {
    const data = response("network", coefficient(coef, low, high));
    data.result.depvar_within_std = sd;
    return buildRegressionVerdict("network", data);
  };

  test("step 14 weighted degree reads 0.047 inside [-0.048, -0.046]", () => {
    const verdict = network(-4010.70, -4109.84, -3911.56, 856);
    expect(verdict.effect).toContain("（幅度约 0.047 个标准差，");
    expect(verdict.interval).toContain("约 [-0.048, -0.046] 个标准差");
  });

  test("both ends of a network interval use the estimate's digits: closeness is not [-0.01, -0.0047]", () => {
    // Closeness: β = -0.4884, [-0.5045, -0.4722]; per 1 percentage point (× 0.01) all three are below 0.01.
    const closeness = network(-0.4884, -0.5045, -0.4722, 0.11);
    expect(closeness.intervalShort).toBe("[-0.0050, -0.0047] 个中心性原始单位");
    expect(closeness.effect).toMatch(/^-0\.0049 个中心性原始单位/);
    expect(closeness.interval.startsWith("[-0.0050, -0.0047] 个中心性原始单位；约 [")).toBe(true);
    expect(closeness.evidence).toContain("[-0.0050, -0.0047] 个中心性原始单位");
    // The other network Ys keep their two decimals.
    expect(network(-4080, -4180, -3980, 850).intervalShort).toBe("[-41.80, -39.80] 个中心性原始单位");
    expect(network(-4080, -4180, -3980, 850).effect).toMatch(/^-40\.80 个中心性原始单位/);
    expect(network(-5933, -6400, -5466, 1300).intervalShort).toBe("[-64.00, -54.66] 个中心性原始单位");
    expect(network(-5933, -6400, -5466, 1300).effect).toMatch(/^-59\.33 个中心性原始单位/);
  });

  test("signed numbers group thousands, as the report's _signed does", () => {
    expect(signed(-1140.254, 2)).toBe("-1,140.25");
    expect(signed(1234567.5, 1)).toBe("+1,234,567.5");
    expect(signed(-140.25, 2)).toBe("-140.25");
    expect(signed(-0.00049, 2)).toBe("-0.00049");
  });

  test("network digits: two decimals, two significant digits for a value that would round to 0, more until the ends differ", () => {
    expect(networkIntervalDigits(-40.8, [-41.8, -39.8])).toBe(2);
    expect(networkIntervalDigits(-0.004884, [-0.005045, -0.004722])).toBe(4);
    expect(networkIntervalDigits(-0.004884, null)).toBe(4);
    // Ends that agree at two significant digits get a third.
    expect(networkIntervalDigits(-0.004884, [-0.004891, -0.004877])).toBe(5);
    // The estimate always prints inside its printed interval.
    for (const [point, low, high] of [[-0.004884, -0.005045, -0.004722], [-40.8, -41.8, -39.8], [0.00012, -0.0004, 0.0007]]) {
      const digits = networkIntervalDigits(point, [low, high]);
      expect(Number(point.toFixed(digits))).toBeGreaterThanOrEqual(Number(low.toFixed(digits)));
      expect(Number(point.toFixed(digits))).toBeLessThanOrEqual(Number(high.toFixed(digits)));
      expect(low.toFixed(digits)).not.toBe(high.toFixed(digits));
    }
  });

  test("below 0.1 the size keeps 3 decimals, so the point never sits on its interval's edge", () => {
    const verdict = network(-4590, -4800, -4300, 1000);
    expect(verdict.effect).toContain("（幅度约 0.046 个标准差，");
    expect(verdict.interval).toContain("约 [-0.048, -0.043] 个标准差");
    const large = network(-4590, -6000, -3000, 100);
    expect(large.effect).toContain("（幅度约 0.46 个标准差，");
    expect(large.interval).toContain("约 [-0.60, -0.30] 个标准差");
  });
});

describe("bars repeat the headline's numbers", () => {
  const estimate = (coef: number, low: number | null, high: number | null, std: number | null = 0.1, suppressed = false) =>
    ({ coef, ci_low: low, ci_high: high, depvar_std: std, suppressed });

  test("a family of shares is drawn in 个百分点; any other family in 个标准差", () => {
    expect(barUnitFor(["share", "share"])).toBe("points");
    expect(barUnitFor(["length", "length", "position"])).toBe("sd");
    expect(barUnitFor(["network", "network"])).toBe("sd");
  });

  test("a share bar is the headline's signed number and interval", () => {
    const bar = barFigures(estimate(-0.5493, -0.5711, -0.5274), "share", "points");
    expect(bar).toEqual({
      value: -0.5493, low: -0.5711, high: -0.5274, uncertain: false, valueLabel: "-0.55", intervalLabel: "[-0.57, -0.53] 个百分点",
      spokenLabel: "-0.55 个百分点，95% 区间 [-0.57, -0.53]",
    });
    const headline = buildRegressionVerdict("trade", response("trade", coefficient(-0.5493, -0.5711, -0.5274)));
    expect(headline.effect).toBe(`${bar.valueLabel} 个百分点`);
    expect(headline.interval).toBe(bar.intervalLabel);
    // The weak Y: 3 decimals, and an interval that includes 0 is uncertain.
    const weak = barFigures(estimate(0.00752, -0.0112, 0.0262), "share", "points");
    expect(weak.valueLabel).toBe("+0.008");
    expect(weak.uncertain).toBe(true);
    // Below 0.005 point the value keeps 2 significant digits, and its interval the same decimals (v10's weak Y).
    const tiny = barFigures(estimate(0.0048, -0.0072, 0.0168), "share", "points");
    expect(tiny.valueLabel).toBe("+0.0048");
    expect(tiny.spokenLabel).toBe("+0.0048 个百分点，95% 区间 [-0.0072, +0.0168]");
    expect(buildRegressionVerdict("production", response("production", coefficient(0.0048, -0.0072, 0.0168))).interval)
      .toBe("[-0.0072, +0.0168] 个百分点");
  });

  test("a network bar is its size in standard deviations, labelled with the native value as the headline gives it", () => {
    expect(standardizedEffect(-4010.70, 856)).toBeCloseTo(-0.04685, 5);
    const bar = barFigures(estimate(-4010.70, -4109.84, -3911.56, 856), "network", "sd");
    expect(bar.valueLabel).toBe("-40.11（-0.047 个标准差）");
    expect(bar.intervalLabel).toBe("[-0.048, -0.046] 个标准差");
    expect(bar.value).toBeCloseTo(-0.04685, 5);
    const data = response("network", coefficient(-4010.70, -4109.84, -3911.56));
    data.result.depvar_within_std = 856;
    expect(buildRegressionVerdict("network", data).effect).toMatch(/^-40\.11 个中心性原始单位（幅度约 0\.047 个标准差/);
    // Step 15 mixes units, so the native value names its unit.
    expect(barFigures(estimate(-0.5493, -0.5711, -0.5274, 0.05), "share", "sd", true).valueLabel).toBe("-0.55 个百分点（-0.110 个标准差）");
    expect(barFigures(estimate(-1.8143, -1.9, -1.7, 0.4), "length", "sd", true).valueLabel).toBe("-0.0181 个长度单位（-0.045 个标准差）");
  });

  test("a size in standard deviations keeps its sign, so it sits inside its signed interval on the signed axis", () => {
    const negative = barFigures(estimate(-1.8143, -1.9, -1.7, 0.4), "length", "sd");
    expect(negative.valueLabel).toBe("-0.0181（-0.045 个标准差）");
    expect(negative.intervalLabel).toBe("[-0.047, -0.043] 个标准差");
    const positive = barFigures(estimate(0.00752, -0.0112, 0.0262, 0.05), "share", "sd", true);
    expect(positive.valueLabel).toBe("+0.008 个百分点（+0.002 个标准差）");
    // Every SD number on a bar, its label and its tooltip has a sign; only 幅度约 … in the headline is a size.
    for (const bar of [negative, positive]) expect(bar.valueLabel).toMatch(/（[+-]\d/);
  });

  test("suppressed inference or a missing interval draws no whisker and reads 方向不确定", () => {
    const suppressed = barFigures(estimate(-0.5, -0.6, -0.4, 0.1, true), "share", "points");
    expect([suppressed.low, suppressed.high, suppressed.uncertain, suppressed.intervalLabel]).toEqual([null, null, true, "—"]);
    expect(barFigures(estimate(-0.5, null, null), "length", "sd").uncertain).toBe(true);
  });
});

describe("an interval end never reads as the estimate", () => {
  test("one more decimal for the estimate and both ends, in the headline, the interval and the bar", () => {
    // Step 13: -0.0184 with [-0.0192, -0.0176] read "-0.018" with "[-0.019, -0.018]" at 3 decimals.
    expect(distinctDigits(3, -0.018414, [-0.0192, -0.0176])).toBe(4);
    expect(distinctDigits(3, -0.0184, [-0.025, -0.012])).toBe(3);
    expect(estimateDigits("share", -0.5493, [-0.5711, -0.5274])).toBe(2);
    const verdict = buildRegressionVerdict("length", response("length", coefficient(-1.8414, -1.92, -1.76)));
    expect(verdict.effect.startsWith("-0.0184 个长度单位")).toBe(true);
    expect(verdict.intervalShort).toBe("[-0.0192, -0.0176] 个长度单位");
    const bar = barFigures({ coef: -1.8414, ci_low: -1.92, ci_high: -1.76, depvar_std: 0.58, suppressed: false }, "length", "sd");
    expect(bar.valueLabel).toMatch(/^-0\.0184（/);
    // Read aloud with its native unit (the drawing leaves it to the name's second line) and its interval.
    expect(bar.spokenLabel).toBe("-0.0184 个长度单位（-0.032 个标准差），95% 区间 [-0.033, -0.030] 个标准差");
  });
});
