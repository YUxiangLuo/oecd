import { describe, expect, test } from "bun:test";
import {
  buildRegressionVerdict,
  chartDisplayScale,
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
  treated_clusters: 1, untreated_clusters: 75, treated_entities: 4, untreated_entities: 296,
  total_entities: 300, reversal_entities: [],
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
  const eventSupport = method === "event_study" ? {
    policy: "teaching_min_contributing_clusters_per_event_period" as const,
    policy_is_statistical_theorem: false as const,
    cluster: "country",
    base_k: -1,
    reference_term: "k=-1",
    min_contributing_clusters: 12,
    periods: [
      {
        term: coef.name.replace("×base_gvc", ""), event_time: Number(coef.name.replace("k=", "")),
        is_reference: false, estimated: true, contributing_rows: 13, contributing_entities: 13,
        contributing_clusters: 13, cohorts: { "2018": 13 }, period_supported: true,
        inference_supported: true, suppress_inference: false, reason_codes: [], reasons: [],
      },
      {
        term: "k=-1", event_time: -1, is_reference: true, estimated: false,
        contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
        cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
        suppress_inference: false, reason_codes: [], reasons: [],
      },
    ],
  } : undefined;
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
      depvar_mean: mean, depvar_std: std, diagnostics: method === "event_study" ? {
        pretrend: {
          scope: "main", available: false, reason: "no_pre_terms", terms: [], excluded_terms: [],
          statistic: null, df_num: 0, df_denom: 10, p: null, interpretation: "没有可估计的冲击前时期。",
        },
      } : {}, notes: [],
      status: treatmentSupport?.status ?? "ok",
      status_reasons: treatmentSupport?.reasons ?? [],
      support: treatmentSupport,
      event_support: eventSupport,
    },
    benchmark: {
      backend: "PanelOLS", policy_coefs: [], max_abs_coef_diff: 0, max_abs_se_diff: 0,
      coef_check_passed: true, se_check_mode: "informational", notes: [],
    },
    disclaimer: "mock",
  };
}

describe("buildRegressionVerdict", () => {
  test("failed pretrend is not a directional evidence claim", () => {
    const payload = response("trade", { ...coefficient(0.02, 0.012, 0.028), name: "k=0" }, 1, 2, "event_study");
    payload.result.coefs.unshift({ ...coefficient(-0.01, -0.03, 0.01), name: "k=-2" });
    payload.result.event_support?.periods.push({
      term: "k=-2", event_time: -2, is_reference: false, estimated: true,
      contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
      cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
      suppress_inference: false, reason_codes: [], reasons: [],
    });
    payload.result.diagnostics = {
      pretrend: {
        scope: "main", available: true, reason: null, terms: ["k=-2"], excluded_terms: [],
        statistic: 8, df_num: 1, df_denom: 10, p: 0.00001,
        interpretation: "检测到明显的冲击前差异，因果解释需谨慎。",
      },
    };
    const verdict = buildRegressionVerdict("trade", payload);
    expect(verdict.state).toBe("pretrend");
    expect(verdict.title).toContain("冲击前趋势");
    expect(verdict.evidence).toContain("只能描述该数值");
    expect(verdict.title).not.toContain("发现正向");
  });

  test("a passing one-lead pretrend test never becomes affirmative parallel-trends evidence", () => {
    const payload = response("trade", { ...coefficient(0.02, 0.012, 0.028), name: "k=0" }, 1, 2, "event_study");
    payload.result.coefs.unshift({ ...coefficient(0.001, -0.01, 0.012), name: "k=-2" });
    payload.result.event_support?.periods.push({
      term: "k=-2", event_time: -2, is_reference: false, estimated: true,
      contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
      cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
      suppress_inference: false, reason_codes: [], reasons: [],
    });
    payload.result.diagnostics.pretrend = {
      scope: "main", available: true, reason: null, terms: ["k=-2"], excluded_terms: [],
      statistic: 0.1, df_num: 1, df_denom: 10, p: 0.76,
      interpretation: "未检出明显差异。",
    };

    const verdict = buildRegressionVerdict("trade", payload);
    expect(verdict.state).toBe("positive");
    expect(verdict.evidence).toContain("只覆盖 1 个受支持时期");
    expect(verdict.evidence).toContain("不是平行趋势成立的证据");
  });

  test("interaction event study uses the joint pretrend, not a passing main test", () => {
    const k0 = { ...coefficient(0.02, 0.012, 0.028), name: "k=0" };
    const payload = response("trade", k0, 1, 2, "event_study", true);
    payload.result.coefs = [
      { ...coefficient(-0.01, -0.03, 0.01), name: "k=-2" },
      k0,
      { ...coefficient(0.001, -0.01, 0.012), name: "k=-2×base_gvc" },
      { ...coefficient(0.002, -0.01, 0.014), name: "k=0×base_gvc" },
    ];
    payload.result.event_support?.periods.push({
      term: "k=-2", event_time: -2, is_reference: false, estimated: true,
      contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
      cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
      suppress_inference: false, reason_codes: [], reasons: [],
    });
    const scoped = (scope: "main" | "interaction" | "joint", terms: string[], p: number) => ({
      scope,
      available: true,
      reason: null,
      terms,
      excluded_terms: [],
      statistic: p < 0.05 ? 8 : 1.2,
      df_num: terms.length,
      df_denom: 20,
      p,
      interpretation: p < 0.05
        ? "联合检验检测到明显的冲击前差异。"
        : `${scope} 冲击前差异不显著。`,
    });
    const tests = {
      main: scoped("main", ["k=-2"], 0.42),
      interaction: scoped("interaction", ["k=-2×base_gvc"], 0.31),
      joint: scoped("joint", ["k=-2", "k=-2×base_gvc"], 0.00001),
    };
    payload.result.diagnostics = { pretrend: tests.joint, pretrend_tests: tests };
    const verdict = buildRegressionVerdict("trade", payload);
    expect(verdict.state).toBe("pretrend");
    expect(verdict.title).toContain("冲击前趋势");
    expect(verdict.title).not.toContain("发现正向");
    expect(verdict.evidence).toContain("只能描述该数值");
    expect(verdict.evidence).toContain("联合检验检测到明显的冲击前差异");
  });

  test("passing interaction pretrend counts one lead rather than two restrictions", () => {
    const k0 = { ...coefficient(0.02, 0.012, 0.028), name: "k=0" };
    const payload = response("trade", k0, 1, 2, "event_study", true);
    payload.result.coefs = [
      { ...coefficient(0.001, -0.01, 0.012), name: "k=-2" },
      k0,
      { ...coefficient(0.001, -0.01, 0.012), name: "k=-2×base_gvc" },
      { ...coefficient(0.002, -0.01, 0.014), name: "k=0×base_gvc" },
    ];
    payload.result.event_support?.periods.push({
      term: "k=-2", event_time: -2, is_reference: false, estimated: true,
      contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
      cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
      suppress_inference: false, reason_codes: [], reasons: [],
    });
    const scoped = (scope: "main" | "interaction" | "joint", terms: string[]) => ({
      scope,
      available: true,
      reason: null,
      terms,
      excluded_terms: [],
      statistic: 1.2,
      df_num: terms.length,
      df_denom: 20,
      p: 0.25,
      interpretation: `${scope} 未检出明显的冲击前差异。`,
    });
    const tests = {
      main: scoped("main", ["k=-2"]),
      interaction: scoped("interaction", ["k=-2×base_gvc"]),
      joint: scoped("joint", ["k=-2", "k=-2×base_gvc"]),
    };
    payload.result.diagnostics = { pretrend: tests.joint, pretrend_tests: tests };

    const verdict = buildRegressionVerdict("trade", payload);

    expect(tests.joint.df_num).toBe(2);
    expect(verdict.state).toBe("positive");
    expect(verdict.evidence).toContain("只覆盖 1 个受支持时期");
    expect(verdict.evidence).not.toContain("覆盖 2 个受支持时期");
  });

  test("uses confidence interval, not sign alone, for evidence", () => {
    const verdict = buildRegressionVerdict("trade", response("trade", coefficient(-0.01, -0.03, 0.01)));
    expect(verdict.state).toBe("insufficient");
    expect(verdict.title).toContain("证据不足");
    expect(verdict.evidence).toContain("不等于“没有效应”");
  });

  test("renders share outcomes in percentage points without scale overstatement", () => {
    const negative = buildRegressionVerdict("production", response("production", coefficient(-0.012, -0.02, -0.004)));
    const positive = buildRegressionVerdict("production", response("production", coefficient(0.012, 0.004, 0.02)));
    expect(negative.state).toBe("negative");
    expect(negative.effect).toContain("-1.20 个百分点");
    expect(negative.interpretation).toBe("SVA 中复杂 GVC 增加值份额降低；这是构成占比变化，不能单凭该比例判断生产规模扩张/收缩。");
    expect(positive.interpretation).toBe("SVA 中复杂 GVC 增加值份额提高；这是构成占比变化，不能单凭该比例判断生产规模扩张/收缩。");
    expect(`${negative.interpretation} ${positive.interpretation}`).not.toMatch(/与.*(?:扩张|收缩)一致/);
  });

  test("chart display scale matches the verdict unit for share outcomes", () => {
    expect(chartDisplayScale("trade", "did")).toEqual({ scale: 100, unit: "个百分点" });
    expect(chartDisplayScale("production", "event_study")).toEqual({ scale: 100, unit: "个百分点" });
    expect(chartDisplayScale("trade", "twfe_intensity")).toEqual({ scale: 1, unit: "个百分点" });
    expect(chartDisplayScale("length", "did")).toEqual({ scale: 1 });
    expect(chartDisplayScale("network", "did")).toEqual({ scale: 1 });
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

  test("stale suppress flags cannot override invalid or insufficient global status", () => {
    const k0 = { ...coefficient(-0.02, -0.03, -0.01), name: "k=0", p: 0.001 };
    const staleInvalid = response(
      "trade", k0, 1, 2, "event_study", false,
      support({ status: "invalid_design", suppress_inference: false }),
    );
    const invalidVerdict = buildRegressionVerdict("trade", staleInvalid);
    expect(invalidVerdict.state).toBe("suppressed");
    expect(invalidVerdict.title).toContain("不能用于统计推断");
    expect(invalidVerdict.interval).toBe("—");
    expect(invalidVerdict.title).not.toContain("发现负向变化证据");

    const staleInsufficient = response(
      "trade", k0, 1, 2, "event_study", false,
      support({ status: "ok", suppress_inference: false, treated_clusters: 6 }),
    );
    staleInsufficient.result.status = "insufficient";
    staleInsufficient.result.status_reasons = ["保存载荷中的整体状态为支持不足"];
    const insufficientVerdict = buildRegressionVerdict("trade", staleInsufficient);
    expect(insufficientVerdict.state).toBe("suppressed");
    expect(insufficientVerdict.title).toContain("处理支持度不足");
    expect(insufficientVerdict.interval).toBe("—");
    expect(insufficientVerdict.title).not.toContain("发现负向变化证据");
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

  test("keeps k=0 and fails closed when its period support is thin or unknown", () => {
    const k0 = { ...coefficient(-0.02, -0.03, -0.01), name: "k=0" };
    const supportedLater = { ...coefficient(0.04, 0.02, 0.06), name: "k=+1" };
    const thin = response("trade", k0, 1, 2, "event_study");
    thin.result.coefs.push(supportedLater);
    thin.result.event_support?.periods.push({
      term: "k=+1", event_time: 1, is_reference: false, estimated: true,
      contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
      cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
      suppress_inference: false, reason_codes: [], reasons: [],
    });
    const period = thin.result.event_support?.periods.find((item) => item.term === "k=0");
    if (!period) throw new Error("missing test period");
    period.contributing_clusters = 4;
    period.period_supported = false;
    period.inference_supported = false;
    period.suppress_inference = true;
    period.reasons = ["k=0 只有 4 个贡献处理聚类，低于课程停止线 12。"];
    const thinVerdict = buildRegressionVerdict("trade", thin);
    expect(thinVerdict.coefficient?.name).toBe("k=0");
    expect(thinVerdict.state).toBe("suppressed");
    expect(thinVerdict.evidence).toContain("4 个贡献处理聚类");
    expect(thinVerdict.evidence).not.toContain("跨过 0");

    const legacy = response("trade", k0, 1, 2, "event_study");
    delete legacy.result.event_support;
    const legacyVerdict = buildRegressionVerdict("trade", legacy);
    expect(legacyVerdict.title).toContain("支持度未知");
    expect(legacyVerdict.evidence).toContain("旧结果");
    expect(legacyVerdict.evidence).not.toContain("未跨过 0");
  });

  test("stripped noninteraction pretrend remains descriptive and cannot become directional", () => {
    const payload = response(
      "trade", { ...coefficient(0.02, 0.012, 0.028), name: "k=0" }, 1, 2, "event_study",
    );
    payload.result.diagnostics = {};
    const verdict = buildRegressionVerdict("trade", payload);
    expect(verdict.state).toBe("suppressed");
    expect(verdict.title).toContain("冲击前诊断");
    expect(verdict.interval).toBe("—");
    expect(verdict.title).not.toContain("发现正向");
    expect(verdict.evidence).not.toContain("未跨过 0");
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
    expect(verdict.effectLabel).toBe("冲击当期变化（k=0）（处理前 GVC 样本均值处）");
  });
});

describe("placeboInterpretation", () => {
  test("always describes the tail share as non-calibrated", () => {
    expect(placeboInterpretation(0.01)).toContain("1.0%");
    expect(placeboInterpretation(0.01)).toContain("不是 p 值");
    expect(placeboInterpretation(0.2)).toContain("不能支持或否定因果结论");
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


test("no-pair diagnosis means inference blocked, not a zero effect or a CI crossing zero", () => {
  const result = response("trade", suppressedCoefficient(0), 1, 2, "did", false, support());
  result.result.coefs = [];
  result.result.diagnostics = { study_contract: "economics-v2", diagnostic_only: true };
  const verdict = buildRegressionVerdict("trade", result);
  expect(verdict.state).toBe("suppressed");
  expect(verdict.effect).toBe("—");
  expect(verdict.evidence).toContain("报告该诊断");
});
