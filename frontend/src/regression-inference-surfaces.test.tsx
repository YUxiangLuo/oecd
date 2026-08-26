import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarginalEffectsPanel, PretrendCheck, RegressionCoefficientTable } from "./regression";
import { GLOBAL_PRETREND_SUPPRESSION_COPY } from "./regression-event-support";
import type { EventSupport, RegressionResponse } from "./types";

function validEventSupportWithThinLead(): EventSupport {
  return {
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
        cohorts: { "2018": 4 }, period_supported: false, inference_supported: false,
        suppress_inference: true, reason_codes: ["insufficient_period_clusters"], reasons: ["支持不足"],
      },
      {
        term: "k=0", event_time: 0, is_reference: false, estimated: true,
        contributing_rows: 13, contributing_entities: 13, contributing_clusters: 13,
        cohorts: { "2018": 13 }, period_supported: true, inference_supported: true,
        suppress_inference: false, reason_codes: [], reasons: [],
      },
    ],
  };
}

function legacyEventResponse(eventSupport?: EventSupport): RegressionResponse {
  return {
    design: { method: "event_study", interaction: true },
    result: {
      status: "ok",
      support: { status: "ok", suppress_inference: false },
      event_support: eventSupport,
      coefs: [{
        name: "k=0", coef: 0.02, se: 0.005, t: 4,
        p: 0.001, stars: "***", ci_low: 0.01, ci_high: 0.03,
      }],
      diagnostics: {
        pretrend: {
          available: true,
          reason: null,
          terms: ["k=-2"],
          statistic: 9,
          df_num: 1,
          df_denom: 20,
          p: 0.001,
          interpretation: "旧诊断不应泄漏",
        },
      },
      marginal_effects: [{
        policy_term: "k=0",
        interaction_term: "k=0×base_gvc",
        level: "mean",
        label: "均值",
        reference: "mean",
        baseline_gvc_centered: 0,
        effect: 0.02,
        se: 0.005,
        t: 4,
        p: 0.001,
        ci_low: 0.01,
        ci_high: 0.03,
      }],
    },
  } as unknown as RegressionResponse;
}

describe("event-study inference surfaces fail closed for legacy payloads", () => {
  test("marginal table keeps the point estimate but hides seeded CI and p values", () => {
    const markup = renderToStaticMarkup(createElement(MarginalEffectsPanel, {
      response: legacyEventResponse(),
    }));
    expect(markup).toContain("+2.00 个百分点");
    expect(markup).toContain("逐期支持未知");
    expect(markup).toContain("已抑制");
    expect(markup).not.toContain("[+1.00, +3.00]");
    expect(markup).not.toContain(">0.001<");
  });

  test("complete coefficient table keeps coef/SE/t but hides seeded CI and p", () => {
    const markup = renderToStaticMarkup(createElement(RegressionCoefficientTable, {
      response: legacyEventResponse(),
    }));
    expect(markup).toContain("0.0200");
    expect(markup).toContain("0.0050");
    expect(markup).toContain("4.00");
    expect(markup).toContain("逐期支持未知");
    expect(markup).not.toContain("[0.0100, 0.0300]");
    expect(markup).not.toContain(">0.001<");
  });

  test("cohort-time point-only payload renders unavailable SE and t without crashing", () => {
    const response = legacyEventResponse(validEventSupportWithThinLead());
    response.result.status = "insufficient";
    response.result.support = {
      status: "insufficient", suppress_inference: true,
    } as RegressionResponse["result"]["support"];
    response.result.coefs[0].se = null;
    response.result.coefs[0].t = null;
    response.result.coefs[0].p = null;
    response.result.coefs[0].ci_low = null;
    response.result.coefs[0].ci_high = null;

    const markup = renderToStaticMarkup(createElement(RegressionCoefficientTable, { response }));
    expect(markup).toContain("0.0200");
    expect((markup.match(/>—</g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(markup).not.toContain("NaN");
  });

  test("pretrend panel hides seeded interpretation, F statistic, and p for malformed support", () => {
    const response = legacyEventResponse({} as EventSupport);
    const markup = renderToStaticMarkup(createElement(PretrendCheck, { response }));
    expect(markup).toContain("逐期支持未知");
    expect(markup).toContain("不可用于教学推断");
    expect(markup).not.toContain("旧诊断不应泄漏");
    expect(markup).not.toContain("9.000");
    expect(markup).not.toContain("0.001");
  });

  test("pretrend panel rejects a diagnostic that tests a locally unsupported lead", () => {
    const response = legacyEventResponse(validEventSupportWithThinLead());
    const markup = renderToStaticMarkup(createElement(PretrendCheck, { response }));
    expect(markup).toContain("诊断已损坏");
    expect(markup).not.toContain("旧诊断不应泄漏");
    expect(markup).not.toContain("9.000");
    expect(markup).not.toContain("0.001");
  });

  test("semantically forged support cannot restore coefficient or marginal inference", () => {
    const forged = validEventSupportWithThinLead();
    const k0 = forged.periods.find((period) => period.term === "k=0")!;
    k0.contributing_clusters = 4;
    k0.period_supported = false;
    // Contradict the count and period gate as a damaged saved payload would.
    k0.inference_supported = true;
    k0.suppress_inference = false;
    const response = legacyEventResponse(forged);
    const coefficientMarkup = renderToStaticMarkup(createElement(RegressionCoefficientTable, { response }));
    const marginalMarkup = renderToStaticMarkup(createElement(MarginalEffectsPanel, { response }));
    expect(coefficientMarkup).toContain("逐期支持未知");
    expect(marginalMarkup).toContain("逐期支持未知");
    expect(coefficientMarkup).not.toContain("[0.0100, 0.0300]");
    expect(marginalMarkup).not.toContain("[+1.00, +3.00]");
  });

  test("whole-run suppression hides stale inference for every persisted status source", () => {
    const variants = [
      { resultStatus: "invalid_design" as const, supportStatus: "ok" as const, flag: false },
      { resultStatus: "ok" as const, supportStatus: "insufficient" as const, flag: false },
      { resultStatus: "ok" as const, supportStatus: "ok" as const, flag: true },
    ];
    for (const variant of variants) {
      const response = legacyEventResponse(validEventSupportWithThinLead());
      response.result.status = variant.resultStatus;
      response.result.support = {
        status: variant.supportStatus, suppress_inference: variant.flag,
      } as RegressionResponse["result"]["support"];
      const coefficientMarkup = renderToStaticMarkup(createElement(RegressionCoefficientTable, { response }));
      const marginalMarkup = renderToStaticMarkup(createElement(MarginalEffectsPanel, { response }));
      const pretrendMarkup = renderToStaticMarkup(createElement(PretrendCheck, { response }));
      expect(coefficientMarkup).not.toContain("[0.0100, 0.0300]");
      expect(coefficientMarkup).not.toContain(">0.001<");
      expect(marginalMarkup).not.toContain("[+1.00, +3.00]");
      expect(marginalMarkup).not.toContain(">0.001<");
      expect(pretrendMarkup).toContain("整体设计门禁已抑制");
      expect(pretrendMarkup).not.toContain("旧诊断不应泄漏");
      expect(pretrendMarkup).not.toContain("9.000");
    }
  });

  test("a suppressed event run explains the whole-run gate even when a stale payload omitted diagnostics", () => {
    const response = legacyEventResponse(validEventSupportWithThinLead());
    response.result.status = "insufficient";
    response.result.support = {
      status: "ok", suppress_inference: false,
    } as RegressionResponse["result"]["support"];
    response.result.diagnostics = {};
    const markup = renderToStaticMarkup(createElement(PretrendCheck, { response }));
    expect(markup).toContain(GLOBAL_PRETREND_SUPPRESSION_COPY);
  });

  test("pretrend panel replaces a forged global-suppression interpretation with trusted copy", () => {
    const response = legacyEventResponse(validEventSupportWithThinLead());
    response.result.status = "invalid_design";
    response.result.support = {
      status: "invalid_design", suppress_inference: true,
    } as RegressionResponse["result"]["support"];
    response.result.diagnostics.pretrend = {
      available: false,
      reason: "global_inference_suppressed",
      support_status: "invalid_design",
      support_reasons: ["处理路径不相容"],
      terms: [],
      excluded_terms: [{ term: "k=-4", reasons: ["整体设计门禁"] }],
      statistic: null,
      df_num: 0,
      df_denom: 20,
      p: null,
      interpretation: "检测到显著冲击前差异，F=9，p=0.001。",
    };
    const markup = renderToStaticMarkup(createElement(PretrendCheck, { response }));
    expect(markup).toContain(GLOBAL_PRETREND_SUPPRESSION_COPY);
    expect(markup).not.toContain("检测到显著冲击前差异");
    expect(markup).not.toContain("F=9");
    expect(markup).not.toContain("p=0.001");

    response.result.status = "ok";
    response.result.support = {
      status: "ok", suppress_inference: false,
    } as RegressionResponse["result"]["support"];
    const reasonOnlyMarkup = renderToStaticMarkup(createElement(PretrendCheck, { response }));
    expect(reasonOnlyMarkup).toContain("诊断已损坏或状态未知");
    expect(reasonOnlyMarkup).not.toContain(GLOBAL_PRETREND_SUPPRESSION_COPY);
    expect(reasonOnlyMarkup).not.toContain("检测到显著冲击前差异");
  });
});
