import { describe, expect, test } from "bun:test";
import {
  buildRegressionVerdict, chartDisplayScale, REGRESSION_STATUS_LABELS, regressionStatusLabel,
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
      r2_within: 0.1, depvar_mean: 2, depvar_std: 2, diagnostics: {}, notes: [],
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
      .toContain("+0.020 个长度单位");
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
    data.result.depvar_std = sd;
    return buildRegressionVerdict("network", data);
  };

  test("step 14 weighted degree reads 0.047 inside [-0.048, -0.046]", () => {
    const verdict = network(-4010.70, -4109.84, -3911.56, 856);
    expect(verdict.effect).toContain("（幅度约 0.047 个标准差，");
    expect(verdict.interval).toContain("约 [-0.048, -0.046] 个标准差");
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
