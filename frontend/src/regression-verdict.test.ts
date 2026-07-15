import { describe, expect, test } from "bun:test";
import { buildRegressionVerdict, placeboInterpretation } from "./regression-verdict";
import type { CoefStat, RegressionOutcome, RegressionResponse } from "./types";

const coefficient = (coef: number, low: number, high: number): CoefStat => ({
  name: "treated×post", coef, se: 0.01, t: 1, p: 0.2, stars: "", ci_low: low, ci_high: high,
});

function response(
  outcome: RegressionOutcome,
  coef: CoefStat,
  mean = 1,
  std = 2,
  method = "双重差分 (DID)",
  interaction = false,
): RegressionResponse {
  return {
    design: {
      outcome, depvar: "y", depvar_label: "Y", granularity: "国家级", shock_type: "关税冲击",
      shock_col: "tariff_shock", treated_col: "treated", method, control_mode: "不加控制变量",
      interaction, price_mode: "名义值", scenario: "clean", scenario_label: "基准", sample_filter: "排除ROW",
      exclude_row: true, controls: [], control_labels: {}, equation: "y=x", equation_parts: [], panel_file: "panel.csv",
      entity: "country", cluster: "country",
    },
    result: {
      coefs: [coef], n_obs: 10, n_entities: 2, n_times: 5, n_clusters: 2, r2_within: 0.1,
      depvar_mean: mean, depvar_std: std, diagnostics: {}, notes: [],
    },
    benchmark: {
      backend: "PanelOLS", policy_coefs: [], max_abs_coef_diff: 0, max_abs_se_diff: 0,
      coef_check_passed: true, se_check_mode: "informational", notes: [],
    },
    disclaimer: "mock",
  };
}

describe("buildRegressionVerdict", () => {
  test("uses confidence interval, not sign alone, for evidence", () => {
    const verdict = buildRegressionVerdict("trade", response("trade", coefficient(-0.01, -0.03, 0.01)));
    expect(verdict.state).toBe("insufficient");
    expect(verdict.title).toContain("证据不足");
    expect(verdict.evidence).toContain("不等于“没有效应”");
  });

  test("renders share outcomes in percentage points", () => {
    const verdict = buildRegressionVerdict("production", response("production", coefficient(-0.012, -0.02, -0.004)));
    expect(verdict.state).toBe("negative");
    expect(verdict.effect).toContain("-1.20 个百分点");
    expect(verdict.interpretation).not.toContain("证明");
  });

  test("adds relative mean context for length", () => {
    const verdict = buildRegressionVerdict("length", response("length", coefficient(0.2, 0.1, 0.3), 2, 0.5));
    expect(verdict.effect).toContain("样本均值的 +10.00%");
  });

  test("adds standard-deviation context for network", () => {
    const verdict = buildRegressionVerdict("network", response("network", coefficient(-10, -15, -5), 100, 20));
    expect(verdict.effect).toContain("-0.50 个样本标准差");
  });

  test.each([
    ["trade", 0.4, 0.2, 0.6, "+0.40 个百分点"],
    ["production", -0.4, -0.6, -0.2, "-0.40 个百分点"],
    ["length", 2, 1, 3, "+0.020 个长度单位"],
    ["network", 20, 10, 30, "+0.20 个中心性原始单位"],
  ] as const)("scales %s FE effects to a one-percentage-point shock increase", (outcome, estimate, low, high, expected) => {
    const verdict = buildRegressionVerdict(
      outcome,
      response(outcome, coefficient(estimate, low, high), 2, 2, "双向固定效应"),
    );
    expect(verdict.effectLabel).toBe("冲击强度每增加 1 个百分点");
    expect(verdict.effect).toContain(expected);
  });

  test("does not use a pre-treatment event coefficient as the policy verdict", () => {
    const pre = { ...coefficient(-0.2, -0.3, -0.1), name: "k=-2" };
    const result = response("trade", pre, 1, 2, "事件研究");
    const verdict = buildRegressionVerdict("trade", result);
    expect(verdict.coefficient).toBeNull();
    expect(verdict.title).toContain("没有可解读的处理后");
  });

  test("labels event-time and centered-interaction estimands", () => {
    const event = { ...coefficient(-0.02, -0.03, -0.01), name: "k=0" };
    const verdict = buildRegressionVerdict("trade", response("trade", event, 1, 2, "事件研究", true));
    expect(verdict.effectLabel).toBe("冲击当期变化（k=0）（基期 GVC 样本均值处）");
  });
});

describe("placeboInterpretation", () => {
  test("does not describe a low empirical p as causal proof", () => {
    expect(placeboInterpretation(0.01)).toContain("不是因果证明");
    expect(placeboInterpretation(0.2)).toContain("未提供额外");
  });
});
