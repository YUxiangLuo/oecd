import { describe, expect, test } from "bun:test";
import { isQualifiedRegressionResult, nextRegressionSave } from "./regression-save";

const qualified = {
  settings: { shockType: "tariff" },
  design: { outcome: "trade", method: "did", interaction: false },
  result: { status: "warning", support: { status: "warning", suppress_inference: false } },
};

const insufficient = {
  settings: { shockType: "export_control" },
  design: { outcome: "trade", method: "did", interaction: false },
  result: { status: "insufficient", support: { status: "insufficient", suppress_inference: true } },
};

const eventPeriod = (term: string, supported: boolean) => ({
  term, event_time: term === "k=0" ? 0 : term === "k=-1" ? -1 : -4,
  is_reference: term === "k=-1", estimated: term !== "k=-1",
  contributing_rows: supported ? 5 : 4, contributing_entities: supported ? 5 : 4,
  contributing_clusters: supported ? 5 : 4, cohorts: { "2020": supported ? 5 : 4 },
  period_supported: supported, inference_supported: supported, suppress_inference: !supported,
  reason_codes: supported ? [] : ["insufficient_period_clusters"],
  reasons: supported ? [] : [`${term} 支持不足`],
});

const eventRun = (k0Supported: boolean, includeThinLead = false) => ({
  settings: { shockType: "tariff" },
  design: { outcome: "trade", method: "event_study", interaction: false },
  result: {
    status: "ok", support: { status: "ok", suppress_inference: false },
    coefs: [{ name: "k=0" }, ...(includeThinLead ? [{ name: "k=-4" }] : [])],
    diagnostics: {
      pretrend: includeThinLead ? {
        scope: "main" as const, available: false, reason: "no_supported_pre_terms" as const,
        terms: [], excluded_terms: [{ term: "k=-4", reasons: ["k=-4 支持不足"] }],
        statistic: null, df_num: 0, df_denom: 10, p: null, interpretation: "没有受支持的处理前时期。",
      } : {
        scope: "main" as const, available: false, reason: "no_pre_terms" as const,
        terms: [], excluded_terms: [], statistic: null, df_num: 0, df_denom: 10, p: null,
        interpretation: "没有可估计的处理前时期。",
      },
    },
    event_support: {
      policy: "teaching_min_contributing_clusters_per_event_period" as const,
      policy_is_statistical_theorem: false as const,
      cluster: "country", base_k: -1, reference_term: "k=-1", min_contributing_clusters: 5,
      periods: [
        eventPeriod("k=-1", true), eventPeriod("k=0", k0Supported),
        ...(includeThinLead ? [eventPeriod("k=-4", false)] : []),
      ],
    },
  },
});

describe("regression persistence for the report gate", () => {
  test("treats ok/warning without suppressed inference as qualified", () => {
    expect(isQualifiedRegressionResult(qualified.result, "did", false)).toBe(true);
    expect(isQualifiedRegressionResult({ status: "ok" }, "did", false)).toBe(true);
    expect(isQualifiedRegressionResult(insufficient.result, "did", false)).toBe(false);
    expect(isQualifiedRegressionResult(
      { status: "warning", support: { status: "insufficient" } }, "did", false,
    )).toBe(false);
    expect(isQualifiedRegressionResult(
      { status: "ok", support: { suppress_inference: true } }, "did", false,
    )).toBe(false);
    expect(isQualifiedRegressionResult({
      status: "ok", support: { status: "warning", suppress_inference: false },
    }, "did", false)).toBe(false);
  });

  test("keeps the last qualified run when a later result cannot be reported", () => {
    const afterQualified = nextRegressionSave(undefined, qualified);
    expect(afterQualified).toEqual({ run: qualified, qualified_run: qualified });

    const afterInsufficient = nextRegressionSave(afterQualified, insufficient);
    expect(afterInsufficient.run).toBe(insufficient);
    expect(afterInsufficient.qualified_run).toBe(qualified);
  });

  test("does not invent a qualified snapshot from an insufficient-only history", () => {
    expect(nextRegressionSave(undefined, insufficient)).toEqual({ run: insufficient });
  });

  test("requires known support for the selected event period but permits a thin remote lead", () => {
    const mixed = eventRun(true, true);
    expect(isQualifiedRegressionResult(mixed.result, mixed.design.method, false)).toBe(true);
    expect(nextRegressionSave(undefined, mixed).qualified_run).toBe(mixed);

    const thinK0 = eventRun(false, false);
    expect(isQualifiedRegressionResult(thinK0.result, thinK0.design.method, false)).toBe(false);
    expect(nextRegressionSave(undefined, thinK0)).toEqual({ run: thinK0 });

    const strippedDiagnostic = eventRun(true, false);
    delete (strippedDiagnostic.result as { diagnostics?: unknown }).diagnostics;
    expect(isQualifiedRegressionResult(strippedDiagnostic.result, strippedDiagnostic.design.method, false)).toBe(false);

    const legacy = eventRun(true, false);
    delete (legacy.result as { event_support?: unknown }).event_support;
    expect(isQualifiedRegressionResult(legacy.result, legacy.design.method, false)).toBe(false);
    expect(nextRegressionSave({ run: legacy, qualified_run: legacy }, thinK0)).toEqual({ run: thinK0 });
  });

  test("interaction event persistence fails closed for missing or malformed diagnostic scopes", () => {
    const run: any = eventRun(true, false);
    run.design.interaction = true;
    run.result.coefs.push({ name: "k=0×base_gvc" });
    const unavailable = (scope: "main" | "interaction" | "joint") => ({
      scope,
      available: false,
      reason: "no_pre_terms",
      terms: [],
      excluded_terms: [],
      statistic: null,
      df_num: 0,
      df_denom: 10,
      p: null,
      interpretation: `${scope} 没有可检验的处理前系数。`,
    });
    const tests = {
      main: unavailable("main"),
      interaction: unavailable("interaction"),
      joint: unavailable("joint"),
    };
    Object.assign(run.result, { diagnostics: { pretrend: tests.joint, pretrend_tests: tests } });
    expect(isQualifiedRegressionResult(run.result, "event_study", true)).toBe(true);
    expect(nextRegressionSave(undefined, run).qualified_run).toBe(run);

    const malformed = structuredClone(run);
    delete malformed.result.diagnostics.pretrend_tests.interaction;
    expect(isQualifiedRegressionResult(malformed.result, "event_study", true)).toBe(false);
    expect(nextRegressionSave(undefined, malformed)).toEqual({ run: malformed });
  });
});
