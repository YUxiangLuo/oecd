import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GLOBAL_PRETREND_SUPPRESSION_COPY } from "../../regression-event-support";
import type { EventSupport, PretrendDiagnostic, RegressionStatus, TreatmentSupport } from "../../types";
import { CoefForestChart, EventStudyChart, scaleForestCoefs } from "./charts";

function supportedInteractionDiagnosticsFixture() {
  const eventSupport: EventSupport = {
    policy: "teaching_min_contributing_clusters_per_event_period",
    policy_is_statistical_theorem: false,
    cluster: "country", base_k: -1, reference_term: "k=-1", min_contributing_clusters: 12,
    periods: [
      {
        term: "k=-1", event_time: -1, is_reference: true, estimated: false,
        contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
        cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
        suppress_inference: false, reason_codes: [], reasons: [],
      },
      {
        term: "k=-2", event_time: -2, is_reference: false, estimated: true,
        contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
        cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
        suppress_inference: false, reason_codes: [], reasons: [],
      },
      {
        term: "k=0", event_time: 0, is_reference: false, estimated: true,
        contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
        cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
        suppress_inference: false, reason_codes: [], reasons: [],
      },
    ],
  };
  const main: PretrendDiagnostic = {
    scope: "main", available: true, reason: null, terms: ["k=-2"], excluded_terms: [],
    statistic: 1.2, df_num: 1, df_denom: 20, p: 0.28,
    interpretation: "主效应冲击前趋势诊断有效。",
  };
  const interaction: PretrendDiagnostic = {
    scope: "interaction", available: true, reason: null,
    terms: ["k=-2×base_gvc"], excluded_terms: [],
    statistic: 1.5, df_num: 1, df_denom: 20, p: 0.23,
    interpretation: "交互效应冲击前趋势诊断有效。",
  };
  const joint: PretrendDiagnostic = {
    scope: "joint", available: true, reason: null,
    terms: ["k=-2", "k=-2×base_gvc"], excluded_terms: [],
    statistic: 1.7, df_num: 2, df_denom: 20, p: 0.21,
    interpretation: "联合冲击前趋势诊断有效。",
  };
  return {
    eventSupport,
    diagnostics: { pretrend: joint, pretrend_tests: { main, interaction, joint } },
  };
}

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

  test("marks mixed per-period support accessibly and never restores a thin period CI", () => {
    const support: EventSupport = {
      policy: "teaching_min_contributing_clusters_per_event_period",
      policy_is_statistical_theorem: false,
      cluster: "country", base_k: -1, reference_term: "k=-1", min_contributing_clusters: 12,
      periods: [
        {
          term: "k=-1", event_time: -1, is_reference: true, estimated: false,
          contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
          cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
          suppress_inference: false, reason_codes: [], reasons: [],
        },
        {
          term: "k=-4", event_time: -4, is_reference: false, estimated: true,
          contributing_rows: 4, contributing_entities: 4, contributing_clusters: 4,
          cohorts: { "2020": 4 }, period_supported: false, inference_supported: false,
          suppress_inference: true, reason_codes: ["insufficient_period_clusters"],
          reasons: ["k=-4 只有 4 个贡献处理聚类，低于课程政策下限 5。"],
        },
        {
          term: "k=0", event_time: 0, is_reference: false, estimated: true,
          contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
          cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
          suppress_inference: false, reason_codes: [], reasons: [],
        },
      ],
    };
    const markup = renderToStaticMarkup(createElement(EventStudyChart, {
      coefs: [
        { name: "k=-4", coef: -0.2, ci_low: -0.3, ci_high: -0.1 },
        { name: "k=0", coef: 0.1, ci_low: 0.02, ci_high: 0.18 },
      ],
      notes: [], eventSupport: support,
    }));
    expect(markup).toContain("支持充分期：点和 95% 置信区间");
    expect(markup).toContain("菱形描述性点");
    expect(markup).toContain("4 个贡献聚类，逐期推断已抑制");
    expect(markup).toContain("k=-4 只有 4 个贡献处理聚类");
    expect(markup).toContain("<title>k=-4，系数");
    expect(markup).not.toContain("<g aria-label=");
    expect(markup).toContain("<path");

    const unsafePretrendMarkup = renderToStaticMarkup(createElement(EventStudyChart, {
      coefs: [
        { name: "k=-4", coef: -0.2, ci_low: -0.3, ci_high: -0.1 },
        { name: "k=0", coef: 0.1, ci_low: 0.02, ci_high: 0.18 },
      ],
      notes: [], eventSupport: support,
      pretrend: {
        available: true, reason: null, terms: ["k=-4"], statistic: 9,
        df_num: 1, df_denom: 20, p: 0.001, interpretation: "不安全的旧 pretrend 解释",
      },
    }));
    expect(unsafePretrendMarkup).toContain("诊断已损坏");
    expect(unsafePretrendMarkup).not.toContain("不安全的旧 pretrend 解释");

    const forged = structuredClone(support);
    const forgedLead = forged.periods.find((period) => period.term === "k=-4")!;
    forgedLead.inference_supported = true;
    forgedLead.suppress_inference = false;
    const forgedMarkup = renderToStaticMarkup(createElement(EventStudyChart, {
      coefs: [{ name: "k=-4", coef: -0.2, ci_low: -0.3, ci_high: -0.1 }],
      notes: [], eventSupport: forged,
    }));
    expect(forgedMarkup).toContain("逐期支持未知");
    expect(forgedMarkup).not.toContain("逐期支持充分");
  });

  test("prioritizes the whole-run design gate over locally supported periods", () => {
    const localSupport: EventSupport = {
      policy: "teaching_min_contributing_clusters_per_event_period",
      policy_is_statistical_theorem: false,
      cluster: "country", base_k: -1, reference_term: "k=-1", min_contributing_clusters: 12,
      periods: [
        {
          term: "k=-1", event_time: -1, is_reference: true, estimated: false,
          contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
          cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
          suppress_inference: false, reason_codes: [], reasons: [],
        },
        {
          term: "k=0", event_time: 0, is_reference: false, estimated: true,
          contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
          cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
          suppress_inference: false, reason_codes: [], reasons: [],
        },
      ],
    };
    const globalSupport = {
      status: "invalid_design", suppress_inference: false,
      reasons: ["整体设计与可逆处理路径不相容。"],
    } as TreatmentSupport;
    const markup = renderToStaticMarkup(createElement(EventStudyChart, {
      coefs: [{ name: "k=0", coef: 0.1, ci_low: 0.02, ci_high: 0.18 }],
      notes: [], eventSupport: localSupport, globalSupport, globalStatus: "ok",
      pretrend: {
        available: false, reason: "global_inference_suppressed", support_status: "invalid_design",
        support_reasons: ["整体设计与可逆处理路径不相容。"], terms: [], excluded_terms: [],
        statistic: null, df_num: 0, df_denom: 20, p: null,
        interpretation: "检测到显著冲击前差异，F=9，p=0.001。",
      },
    }));
    expect(markup).toContain("整体设计门禁已抑制推断");
    expect(markup).toContain("方形描述性点");
    expect(markup).toContain("整体设计与可逆处理路径不相容");
    expect(markup).toContain(GLOBAL_PRETREND_SUPPRESSION_COPY);
    expect(markup).not.toContain("检测到显著冲击前差异");
    expect(markup).not.toContain("p=0.001");
    expect(markup).not.toContain("逐期支持不足或未知，仅显示描述性点");

    const reasonOnlyMarkup = renderToStaticMarkup(createElement(EventStudyChart, {
      coefs: [{ name: "k=0", coef: 0.1, ci_low: 0.02, ci_high: 0.18 }],
      notes: [], eventSupport: localSupport, globalStatus: "ok",
      globalSupport: { ...globalSupport, status: "ok", suppress_inference: false },
      pretrend: {
        available: false, reason: "global_inference_suppressed", support_status: "invalid_design",
        support_reasons: ["整体设计与可逆处理路径不相容。"], terms: [], excluded_terms: [],
        statistic: null, df_num: 0, df_denom: 20, p: null,
        interpretation: "检测到显著冲击前差异，F=9，p=0.001。",
      },
    }));
    expect(reasonOnlyMarkup).toContain("诊断已损坏或状态未知");
    expect(reasonOnlyMarkup).not.toContain(GLOBAL_PRETREND_SUPPRESSION_COPY);
    expect(reasonOnlyMarkup).not.toContain("检测到显著冲击前差异");
  });

  test("does not render a legacy pretrend interpretation without a valid event contract", () => {
    const markup = renderToStaticMarkup(createElement(EventStudyChart, {
      coefs: [{ name: "k=0", coef: 0.1, ci_low: 0.02, ci_high: 0.18 }],
      notes: [], eventSupport: {} as EventSupport,
      pretrend: {
        available: true, reason: null, terms: ["k=-2"], statistic: 9,
        df_num: 1, df_denom: 20, p: 0.001, interpretation: "旧图表诊断不应泄漏",
      },
    }));
    expect(markup).toContain("逐期支持不足或未知");
    expect(markup).not.toContain("旧图表诊断不应泄漏");
  });

  test("interaction main chart consumes the validated main diagnostic, not legacy joint", () => {
    const { eventSupport, diagnostics } = supportedInteractionDiagnosticsFixture();
    const props = {
      coefs: [
        { name: "k=-2", coef: -0.02, ci_low: -0.04, ci_high: 0.01 },
        { name: "k=0", coef: 0.1, ci_low: 0.02, ci_high: 0.18 },
      ],
      notes: [], eventSupport, interaction: true,
      pretrend: diagnostics.pretrend, pretrendDiagnostics: diagnostics,
    };
    const markup = renderToStaticMarkup(createElement(EventStudyChart, props));
    expect(markup).toContain("主效应冲击前趋势诊断有效");
    expect(markup).not.toContain("联合冲击前趋势诊断有效");
    expect(markup).not.toContain("诊断已损坏");

    const missingScope = {
      pretrend: diagnostics.pretrend,
      pretrend_tests: {
        main: diagnostics.pretrend_tests.main,
        joint: diagnostics.pretrend_tests.joint,
      },
    };
    const wrongScope = structuredClone(diagnostics);
    wrongScope.pretrend_tests.interaction.scope = "main";
    for (const tampered of [missingScope, wrongScope]) {
      const tamperedMarkup = renderToStaticMarkup(createElement(EventStudyChart, {
        ...props, pretrendDiagnostics: tampered,
      }));
      expect(tamperedMarkup).toContain("诊断已损坏");
      expect(tamperedMarkup).not.toContain("主效应冲击前趋势诊断有效");
      expect(tamperedMarkup).not.toContain("联合冲击前趋势诊断有效");
    }
  });

  test("DID forest chart fails closed for every persisted whole-run suppression source", () => {
    const variants: {
      label: string;
      resultStatus: RegressionStatus;
      supportStatus: RegressionStatus;
      suppressInference: boolean;
    }[] = [
      { label: "result invalid_design", resultStatus: "invalid_design", supportStatus: "ok", suppressInference: false },
      { label: "result insufficient", resultStatus: "insufficient", supportStatus: "ok", suppressInference: false },
      { label: "support invalid_design contradicts result", resultStatus: "ok", supportStatus: "invalid_design", suppressInference: false },
      { label: "support insufficient contradicts result", resultStatus: "ok", supportStatus: "insufficient", suppressInference: false },
      { label: "support suppress_inference", resultStatus: "ok", supportStatus: "ok", suppressInference: true },
    ];
    for (const variant of variants) {
      const markup = renderToStaticMarkup(createElement(CoefForestChart, {
        coefs: [{
          name: "treated×post", coef: -0.2, ci_low: -91.234, ci_high: 87.654,
          p: 0.001, stars: "***",
        }],
                globalStatus: variant.resultStatus,
        globalSupport: {
          status: variant.supportStatus,
          suppress_inference: variant.suppressInference,
        } as TreatmentSupport,
      }));
      expect(markup, variant.label).toContain("整体设计门禁已抑制统计推断；仅显示描述性点估计");
      expect(markup, variant.label).toContain("<circle");
      expect(markup, variant.label).not.toContain("95%");
      expect(markup, variant.label).not.toContain("p 值");
      expect(markup, variant.label).not.toContain("***");
      expect(markup, variant.label).not.toContain("91.234");
      expect(markup, variant.label).not.toContain("87.654");
      expect(markup, variant.label).not.toContain('stroke="#aaa7eb"');
    }
  });

  test("normal ok DID forest chart retains its confidence interval", () => {
    const markup = renderToStaticMarkup(createElement(CoefForestChart, {
      coefs: [{
        name: "treated×post", coef: -0.2, ci_low: -0.3, ci_high: -0.1,
        p: 0.001, stars: "***",
      }],
            globalStatus: "ok",
      globalSupport: { status: "ok", suppress_inference: false } as TreatmentSupport,
    }));
    expect(markup).toContain("点 = 估计值 · 横线 = 95% 置信区间");
    expect(markup).toContain('stroke="#aaa7eb"');
    expect(markup).not.toContain("整体设计门禁已抑制统计推断");
  });
});
