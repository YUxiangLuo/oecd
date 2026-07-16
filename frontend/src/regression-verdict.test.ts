import { describe, expect, test } from "bun:test";
import {
  buildRegressionVerdict,
  placeboInterpretation,
  REGRESSION_STATUS_LABELS,
  regressionStatusLabel,
} from "./regression-verdict";
import type {
  CoefStat,
  RegressionOutcome,
  RegressionResponse,
  RegressionStatus,
  TreatmentSupport,
} from "./types";

const ALL_STATUSES: RegressionStatus[] = ["ok", "warning", "insufficient", "invalid_design"];

const coefficient = (coef: number, low: number, high: number): CoefStat => ({
  name: "treated×post", coef, se: 0.01, t: 1, p: 0.2, stars: "", ci_low: low, ci_high: high,
});

/** 推断被抑制的系数:服务端已抽掉 p 值与置信区间。 */
const suppressedCoefficient = (coef: number): CoefStat => ({
  name: "treated×post", coef, se: 0.01, t: 1, p: null, stars: "", ci_low: null, ci_high: null,
});

const support = (over: Partial<TreatmentSupport> = {}): TreatmentSupport => ({
  treated_clusters: 1, untreated_clusters: 75, treated_entities: 4, reversal_entities: [],
  reversal_share: 0, absorbing: true, status: "insufficient", reasons: ["处理支持度不足"],
  min_treated_clusters: 5, max_reversal_share: 0.05, suppress_inference: true, ...over,
});

function response(
  outcome: RegressionOutcome,
  coef: CoefStat,
  mean = 1,
  std = 2,
  method = "did",
  interaction = false,
  treatmentSupport: TreatmentSupport | null = null,
): RegressionResponse {
  return {
    design: {
      outcome, depvar: "y", depvar_label: "Y", granularity: "country", shock_type: "tariff",
      shock_col: "tariff_shock", treated_col: "treated", method, control_mode: "none",
      interaction, price_mode: "nominal", scenario: "clean", scenario_label: "基准", sample_filter: "排除ROW",
      exclude_row: true, controls: [], control_labels: {}, equation: "y=x", equation_parts: [], panel_file: "panel.csv",
      entity: "country", cluster: "country",
    },
    result: {
      depvar: "FVA_share", coefs: [coef], n_obs: 10, n_entities: 2, n_times: 5, n_clusters: 2, r2_within: 0.1,
      depvar_mean: mean, depvar_std: std, diagnostics: {}, notes: [],
      status: treatmentSupport?.status ?? "ok",
      status_reasons: treatmentSupport?.reasons ?? [],
      support: treatmentSupport,
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

  test("suppressed inference is not reported as a confidence interval crossing zero", () => {
    // 回归防线:null 区间若被当成数值比较,会静默落到 insufficient 分支,
    // 把“不可评估”说成“区间跨过 0”。
    const verdict = buildRegressionVerdict(
      "trade",
      response("trade", suppressedCoefficient(-0.0084), 1, 2, "did", false, support()),
    );
    expect(verdict.state).toBe("suppressed");
    expect(verdict.evidence).not.toContain("置信区间跨过 0");
    expect(verdict.evidence).not.toContain("未跨过 0");
    expect(verdict.interval).toBe("—");
    expect(verdict.title).toContain("处理支持度不足");
    expect(verdict.warnings.length).toBeGreaterThan(0);
  });

  test("single treated cluster never yields a directional evidence claim", () => {
    // 出口管制真实案例:HEAD 会给出“发现负向变化证据”和 p=1.3e-13。
    const verdict = buildRegressionVerdict(
      "trade",
      response("trade", suppressedCoefficient(-0.0084), 1, 2, "did", false,
        support({ treated_clusters: 1, status: "insufficient" })),
    );
    expect(verdict.title).not.toContain("发现负向变化证据");
    expect(verdict.interpretation).toContain("不能据此判断变化方向");
  });

  test("invalid design is labelled as a design problem, not weak evidence", () => {
    const verdict = buildRegressionVerdict(
      "trade",
      response("trade", suppressedCoefficient(-0.005), 1, 2, "did", false,
        support({ treated_clusters: 2, status: "invalid_design", reversal_entities: ["RUS_C24"], reversal_share: 0.095 })),
    );
    expect(verdict.state).toBe("suppressed");
    expect(verdict.title).toContain("不能用于统计推断");
    // 点估计仍然展示,便于讲“这个数字为什么不能用”。
    expect(verdict.effect).toContain("-0.50 个百分点");
  });

  test("warning-level design issues keep inference but surface the disclosure", () => {
    const verdict = buildRegressionVerdict(
      "trade",
      response("trade", coefficient(-0.012, -0.02, -0.004), 1, 2, "did", false,
        support({
          treated_clusters: 76, untreated_clusters: 0, status: "warning",
          suppress_inference: false, reasons: ["没有从未受处理的对照聚类"],
        })),
    );
    expect(verdict.state).toBe("negative");
    expect(verdict.interval).not.toBe("—");
    expect(verdict.warnings).toContain("没有从未受处理的对照聚类");
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
      response(outcome, coefficient(estimate, low, high), 2, 2, "twfe_intensity"),
    );
    expect(verdict.effectLabel).toBe("冲击强度每增加 1 个百分点");
    expect(verdict.effect).toContain(expected);
  });

  test("does not use a pre-treatment event coefficient as the policy verdict", () => {
    const pre = { ...coefficient(-0.2, -0.3, -0.1), name: "k=-2" };
    const result = response("trade", pre, 1, 2, "event_study");
    const verdict = buildRegressionVerdict("trade", result);
    expect(verdict.coefficient).toBeNull();
    expect(verdict.title).toContain("没有可解读的处理后");
  });

  test("labels event-time and centered-interaction estimands", () => {
    const event = { ...coefficient(-0.02, -0.03, -0.01), name: "k=0" };
    const verdict = buildRegressionVerdict("trade", response("trade", event, 1, 2, "event_study", true));
    expect(verdict.effectLabel).toBe("冲击当期变化（k=0）（基期 GVC 样本均值处）");
  });
});

describe("placeboInterpretation", () => {
  test("does not describe a low empirical p as causal proof", () => {
    expect(placeboInterpretation(0.01)).toContain("不是因果证明");
    expect(placeboInterpretation(0.2)).toContain("未提供额外");
  });
});

describe("设计有效性的摘要文案", () => {
  test("每个状态都有文案", () => {
    // 教师评阅页按 runs[].status 查这张表;缺一个键就会把原始键甩到界面上。
    for (const status of ALL_STATUSES) {
      expect(REGRESSION_STATUS_LABELS[status]).toBeTruthy();
      expect(regressionStatusLabel(status)).toBe(REGRESSION_STATUS_LABELS[status]);
    }
    expect(Object.keys(REGRESSION_STATUS_LABELS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  test("状态缺失或未知时不冒充 ok,也不显示裸键", () => {
    // 把没核实过的设计显示成“可解释”,比显示“未知”危险得多。
    const okLabel = REGRESSION_STATUS_LABELS.ok;
    for (const bogus of [null, undefined, "", "bogus_status"]) {
      expect(regressionStatusLabel(bogus)).toBe("设计有效性未知");
      expect(regressionStatusLabel(bogus)).not.toBe(okLabel);
      expect(regressionStatusLabel(bogus)).not.toContain("bogus");
    }
  });
});
