import { describe, expect, test } from "bun:test";
import {
  eventInferenceAllowed, eventInferenceGate, eventInferenceMessage, eventMainPretrendContractIsSafe,
  eventPretrendIsSafe, eventPretrendScopesAreSafe, eventSupportCoversTerms, globalInferenceIsSuppressed,
  isValidEventSupport, primaryEventTerm,
} from "./regression-event-support";
import type { EventSupport } from "./types";

const support: EventSupport = {
  policy: "teaching_min_contributing_clusters_per_event_period",
  policy_is_statistical_theorem: false,
  cluster: "country", base_k: -1, reference_term: "k=-1", min_contributing_clusters: 5,
  periods: [
    {
      term: "k=-1", event_time: -1, is_reference: true, estimated: false,
      contributing_rows: 6, contributing_entities: 6, contributing_clusters: 6,
      cohorts: { "2018": 6 }, period_supported: true, inference_supported: true,
      suppress_inference: false, reason_codes: [], reasons: [],
    },
    {
      term: "k=0", event_time: 0, is_reference: false, estimated: true,
      contributing_rows: 8, contributing_entities: 8, contributing_clusters: 4,
      cohorts: { "2018": 8 }, period_supported: false, inference_supported: false,
      suppress_inference: true, reason_codes: ["insufficient_period_clusters"], reasons: ["支持不足"],
    },
  ],
};

describe("event-study support consumers", () => {
  test("whole-run suppression honors result status, support status, and the explicit flag", () => {
    expect(globalInferenceIsSuppressed("invalid_design", { status: "ok", suppress_inference: false })).toBe(true);
    expect(globalInferenceIsSuppressed("ok", { status: "insufficient", suppress_inference: false })).toBe(true);
    expect(globalInferenceIsSuppressed("ok", { status: "ok", suppress_inference: true })).toBe(true);
    expect(globalInferenceIsSuppressed("warning", { status: "warning", suppress_inference: false })).toBe(false);
  });

  test("keeps k=0 as the primary estimand even when a later period exists", () => {
    expect(primaryEventTerm([{ name: "k=+1" }, { name: "k=0" }])).toBe("k=0");
  });

  test("interaction, technical table, and marginal rows inherit the main-period gate", () => {
    const gate = eventInferenceGate(support, "k=0×base_gvc");
    expect(gate.state).toBe("unsupported");
    expect(eventInferenceMessage(gate, support.min_contributing_clusters))
      .toBe("逐期支持不足（4/5 个聚类），推断已抑制");
  });

  test("legacy or malformed support is unknown rather than inferred from an existing CI", () => {
    const missing = eventInferenceGate(undefined, "k=0");
    expect(missing.state).toBe("unknown");
    expect(eventInferenceMessage(missing, 5)).toBe("逐期支持未知，推断不可用");

    for (const malformed of [{}, { periods: [] }, { periods: "forged" }]) {
      expect(isValidEventSupport(malformed)).toBe(false);
      expect(eventInferenceGate(malformed as unknown as EventSupport, "k=0").state).toBe("unknown");
      expect(eventInferenceAllowed("event_study", malformed as unknown as EventSupport, "k=0")).toBe(false);
    }
    expect(eventInferenceAllowed("event_study", undefined, "control")).toBe(true);
    expect(eventSupportCoversTerms(
      { ...support, periods: support.periods.filter((period) => period.is_reference) }, ["k=0"],
    )).toBe(false);
  });

  test("rejects semantically contradictory saved contracts", () => {
    const forgedThin = structuredClone(support);
    forgedThin.periods[1].inference_supported = true;
    forgedThin.periods[1].suppress_inference = false;
    expect(isValidEventSupport(forgedThin)).toBe(false);
    expect(eventInferenceGate(forgedThin, "k=0").state).toBe("unknown");

    const wrongThreshold = structuredClone(support);
    wrongThreshold.min_contributing_clusters = 4;
    expect(isValidEventSupport(wrongThreshold)).toBe(false);

    const badReference = structuredClone(support);
    badReference.periods[0].period_supported = false;
    expect(isValidEventSupport(badReference)).toBe(false);

    const badSuppress = structuredClone(support);
    badSuppress.periods[1].suppress_inference = false;
    expect(isValidEventSupport(badSuppress)).toBe(false);

    const duplicateReference = structuredClone(support);
    duplicateReference.periods[1] = { ...duplicateReference.periods[0] };
    expect(isValidEventSupport(duplicateReference)).toBe(false);

    const impossibleCardinality = structuredClone(support);
    Object.assign(impossibleCardinality.periods[1], {
      contributing_rows: 0, contributing_entities: 0, contributing_clusters: 5,
      cohorts: {}, period_supported: true, inference_supported: true, suppress_inference: false,
    });
    expect(isValidEventSupport(impossibleCardinality)).toBe(false);
    expect(eventInferenceGate(impossibleCardinality, "k=0").state).toBe("unknown");

    const badCohortTotal = structuredClone(support);
    badCohortTotal.periods[1].cohorts = { "2018": 7 };
    expect(isValidEventSupport(badCohortTotal)).toBe(false);

    const noncanonicalTerm = structuredClone(support);
    noncanonicalTerm.periods[1].term = "k=00";
    expect(isValidEventSupport(noncanonicalTerm)).toBe(false);

    const missingBase = structuredClone(support) as Partial<EventSupport>;
    delete missingBase.base_k;
    expect(isValidEventSupport(missingBase)).toBe(false);
    expect(isValidEventSupport({ ...support, base_k: 0 })).toBe(false);
    expect(isValidEventSupport({ ...support, base_k: -2 })).toBe(false);
  });

  test("accepts valid generated semantics and rejects a pretrend that tests a thin lead", () => {
    const withThinLead = structuredClone(support);
    withThinLead.periods.push({
      ...withThinLead.periods[1], term: "k=-4", event_time: -4,
      contributing_rows: 4, contributing_entities: 4, cohorts: { "2018": 4 },
    });
    expect(isValidEventSupport(withThinLead)).toBe(true);
    const unsafe = {
      available: true, reason: null, terms: ["k=-4"], statistic: 9,
      df_num: 1, df_denom: 20, p: 0.001, interpretation: "不应消费",
    };
    expect(eventPretrendIsSafe(withThinLead, unsafe)).toBe(false);

    const unavailable = {
      ...unsafe, scope: "main" as const, available: false, terms: [],
      excluded_terms: [{ term: "k=-4", reasons: ["支持不足"] }],
      statistic: null, df_num: 0, p: null,
      reason: "no_supported_pre_terms" as const, interpretation: "逐期支持不足，冲击前趋势不可评估。",
    };
    expect(eventPretrendIsSafe(withThinLead, unavailable)).toBe(true);
    expect(eventPretrendIsSafe(withThinLead, { ...unavailable, reason: "forged_reason" })).toBe(false);
    expect(eventPretrendIsSafe(withThinLead, { ...unavailable, df_num: 99 })).toBe(false);

    const globalSuppression = {
      ...unavailable,
      reason: "global_inference_suppressed",
      support_status: "invalid_design" as const,
      support_reasons: ["处理路径与吸收型设计不相容"],
      interpretation: "整体设计门禁已抑制推断，因此未执行联合检验。",
    };
    expect(eventPretrendIsSafe(withThinLead, globalSuppression)).toBe(false);
    expect(eventPretrendIsSafe(withThinLead, { ...globalSuppression, support_status: "ok" })).toBe(false);
    expect(eventPretrendIsSafe(withThinLead, { ...globalSuppression, terms: ["k=-4"], df_num: 1 })).toBe(false);
    expect(eventPretrendIsSafe(withThinLead, { ...globalSuppression, statistic: 9 })).toBe(false);

    const withSupportedLead = structuredClone(support);
    withSupportedLead.periods.push({
      ...withSupportedLead.periods[0], term: "k=-2", event_time: -2,
      is_reference: false, estimated: true,
    });
    const valid = {
      scope: "main" as const, available: true, reason: null, terms: ["k=-2"], excluded_terms: [],
      statistic: 1.5, df_num: 1, df_denom: 20, p: 0.25, interpretation: "仅检验支持充分的 lead。",
    };
    expect(isValidEventSupport(withSupportedLead)).toBe(true);
    expect(eventPretrendIsSafe(withSupportedLead, valid)).toBe(true);
    expect(eventPretrendIsSafe(withSupportedLead, { ...valid, terms: ["k=-2", "k=-2"], df_num: 2 })).toBe(false);
    expect(eventPretrendIsSafe(withSupportedLead, { ...valid, df_num: 2 })).toBe(false);
    expect(eventPretrendIsSafe(withSupportedLead, { ...valid, statistic: -0.1 })).toBe(false);
    expect(eventPretrendIsSafe(withSupportedLead, { ...valid, p: 1.1 })).toBe(false);
    expect(eventPretrendIsSafe(withSupportedLead, { ...valid, df_denom: 0 })).toBe(false);
    const unavailableInsufficient = {
      ...valid, available: false, reason: "insufficient_cluster_df", statistic: null, p: null,
      df_denom: 0,
    };
    expect(eventPretrendIsSafe(withSupportedLead, unavailableInsufficient)).toBe(true);
    expect(eventPretrendIsSafe(withSupportedLead, { ...unavailableInsufficient, df_denom: 1 })).toBe(false);
    expect(eventPretrendIsSafe(withSupportedLead, {
      ...unavailableInsufficient, reason: "singular_covariance", df_denom: 1,
    })).toBe(true);
    expect(eventPretrendIsSafe(withSupportedLead, {
      ...valid, available: false, reason: "no_pre_terms", statistic: null, p: null,
    })).toBe(false);
    expect(eventMainPretrendContractIsSafe(withSupportedLead, { pretrend: valid })).toBe(true);
    expect(eventMainPretrendContractIsSafe(withSupportedLead, {
      pretrend: valid, pretrend_tests: { main: valid },
    })).toBe(true);
    expect(eventMainPretrendContractIsSafe(withSupportedLead, {
      pretrend: valid, pretrend_tests: { main: valid, joint: { ...valid, scope: "joint" } },
    })).toBe(false);
  });

  test("interaction diagnostics require exact valid main interaction and joint scopes", () => {
    const withSupportedLead = structuredClone(support);
    withSupportedLead.periods.push({
      ...withSupportedLead.periods[0], term: "k=-2", event_time: -2,
      is_reference: false, estimated: true,
    });
    const scoped = (scope: "main" | "interaction" | "joint", terms: string[]) => ({
      scope,
      available: true,
      reason: null,
      terms,
      excluded_terms: [],
      statistic: 2,
      df_num: terms.length,
      df_denom: 20,
      p: 0.1,
      interpretation: `${scope} valid`,
    });
    const tests = {
      main: scoped("main", ["k=-2"]),
      interaction: scoped("interaction", ["k=-2×base_gvc"]),
      joint: scoped("joint", ["k=-2", "k=-2×base_gvc"]),
    };
    const diagnostics = { pretrend: tests.joint, pretrend_tests: tests };
    expect(eventSupportCoversTerms(withSupportedLead, ["k=-2", "k=0"], true)).toBe(false);
    expect(eventSupportCoversTerms(
      withSupportedLead,
      ["k=-2", "k=0", "k=-2×base_gvc", "k=0×base_gvc"],
      true,
    )).toBe(true);
    expect(eventPretrendScopesAreSafe(withSupportedLead, diagnostics, true)).toBe(true);
    expect(eventPretrendScopesAreSafe(withSupportedLead, {
      pretrend: tests.joint, pretrend_tests: { main: tests.main, joint: tests.joint },
    }, true)).toBe(false);
    expect(eventPretrendScopesAreSafe(withSupportedLead, {
      pretrend: tests.main, pretrend_tests: tests,
    }, true)).toBe(false);
    expect(eventPretrendScopesAreSafe(withSupportedLead, {
      pretrend: tests.joint,
      pretrend_tests: { ...tests, interaction: { ...tests.interaction, scope: "main" as const } },
    }, true)).toBe(false);

    const coordinatedOmission = structuredClone(withSupportedLead);
    coordinatedOmission.periods.push({
      ...coordinatedOmission.periods.find((period) => period.term === "k=-2")!,
      term: "k=-3", event_time: -3,
    });
    expect(isValidEventSupport(coordinatedOmission)).toBe(true);
    expect(eventPretrendScopesAreSafe(coordinatedOmission, diagnostics, true)).toBe(false);
  });
});
