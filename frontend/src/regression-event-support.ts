import type {
  CoefStat, EventPeriodSupport, EventSupport, PretrendDiagnostic, PretrendScope, RegressionStatus, TreatmentSupport,
} from "./types";

export const EVENT_SUPPORT_MIN_CLUSTERS = 5;
export const GLOBAL_PRETREND_SUPPRESSION_COPY = "整体设计门禁已抑制统计推断，因此未执行冲击前联合检验；不能据此判断冲击前趋势。";
const EVENT_SUPPORT_POLICY = "teaching_min_contributing_clusters_per_event_period";
const SAFE_UNAVAILABLE_PRETREND_REASONS = new Set([
  "no_pre_terms", "no_supported_pre_terms", "insufficient_cluster_df", "singular_covariance",
]);

/** Fail closed if any persisted whole-run status source suppresses inference. */
export function globalInferenceIsSuppressed(
  resultStatus: RegressionStatus | string | null | undefined,
  support: Pick<TreatmentSupport, "status" | "suppress_inference"> | null | undefined,
): boolean {
  return support?.suppress_inference === true
    || resultStatus === "insufficient"
    || resultStatus === "invalid_design"
    || support?.status === "insufficient"
    || support?.status === "invalid_design";
}

const isNonnegativeInteger = (value: unknown): value is number => (
  typeof value === "number" && Number.isInteger(value) && value >= 0
);

const eventTerm = (eventTime: number) => eventTime === 0 ? "k=0" : `k=${eventTime > 0 ? "+" : ""}${eventTime}`;

/** Runtime guard for saved/legacy payloads that bypass the compile-time API type. */
export function isValidEventSupport(value: unknown): value is EventSupport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const support = value as Partial<EventSupport>;
  if (
    support.policy !== EVENT_SUPPORT_POLICY
    || support.policy_is_statistical_theorem !== false
    || typeof support.cluster !== "string"
    || support.cluster.trim() === ""
    || typeof support.base_k !== "number"
    || !Number.isInteger(support.base_k)
    || support.base_k >= 0
    || typeof support.reference_term !== "string"
    || support.reference_term !== eventTerm(support.base_k)
    || support.min_contributing_clusters !== EVENT_SUPPORT_MIN_CLUSTERS
    || !Array.isArray(support.periods)
    || support.periods.length === 0
  ) return false;

  const terms = new Set<string>();
  const eventTimes = new Set<number>();
  for (const rawPeriod of support.periods as unknown[]) {
    if (!rawPeriod || typeof rawPeriod !== "object" || Array.isArray(rawPeriod)) return false;
    const period = rawPeriod as Partial<EventPeriodSupport>;
    if (
      typeof period.term !== "string"
      || terms.has(period.term)
      || typeof period.event_time !== "number"
      || !Number.isInteger(period.event_time)
      || eventTimes.has(period.event_time)
      || period.term !== eventTerm(period.event_time)
      || typeof period.is_reference !== "boolean"
      || typeof period.estimated !== "boolean"
      || !isNonnegativeInteger(period.contributing_rows)
      || !isNonnegativeInteger(period.contributing_entities)
      || !isNonnegativeInteger(period.contributing_clusters)
      || period.contributing_clusters > period.contributing_entities
      || period.contributing_entities > period.contributing_rows
      || !period.cohorts
      || typeof period.cohorts !== "object"
      || Array.isArray(period.cohorts)
      || !Object.values(period.cohorts).every((count) => isNonnegativeInteger(count) && count > 0)
      || Object.values(period.cohorts).reduce<number>((total, count) => total + Number(count), 0)
        !== period.contributing_entities
      || typeof period.period_supported !== "boolean"
      || typeof period.inference_supported !== "boolean"
      || typeof period.suppress_inference !== "boolean"
      || !Array.isArray(period.reason_codes)
      || !period.reason_codes.every((reason) => typeof reason === "string")
      || !Array.isArray(period.reasons)
      || !period.reasons.every((reason) => typeof reason === "string")
    ) return false;
    terms.add(period.term);
    eventTimes.add(period.event_time);
  }

  const referencePeriods = support.periods.filter((period) => period.is_reference);
  if (
    referencePeriods.length !== 1
    || referencePeriods[0].term !== support.reference_term
    || referencePeriods[0].event_time !== support.base_k
    || referencePeriods[0].estimated
  ) return false;
  const reference = referencePeriods[0];
  const referenceSupported = reference.contributing_clusters >= EVENT_SUPPORT_MIN_CLUSTERS;

  return support.periods.every((period) => {
    const isReference = period.term === support.reference_term;
    const periodSupported = period.contributing_clusters >= EVENT_SUPPORT_MIN_CLUSTERS;
    const inferenceSupported = periodSupported && referenceSupported;
    return period.is_reference === isReference
      && period.estimated === !isReference
      && period.period_supported === periodSupported
      && period.inference_supported === inferenceSupported
      && period.suppress_inference === !inferenceSupported;
  });
}

/** Keep the teaching estimand stable: k=0 first, then the first available post period. */
export function primaryEventTerm(coefs: Pick<CoefStat, "name">[]): string | null {
  const main = coefs.filter((coef) => !coef.name.includes("×base_gvc"));
  return main.find((coef) => coef.name === "k=0")?.name
    ?? main.find((coef) => coef.name.startsWith("k=+"))?.name
    ?? null;
}

export function eventPeriodForTerm(
  eventSupport: EventSupport | null | undefined,
  term: string,
): EventPeriodSupport | null {
  if (!isValidEventSupport(eventSupport)) return null;
  const mainTerm = term.replace("×base_gvc", "");
  return eventSupport.periods.find((period) => period.term === mainTerm) ?? null;
}

export type EventInferenceGate =
  | { state: "supported"; period: EventPeriodSupport }
  | { state: "unsupported"; period: EventPeriodSupport }
  | { state: "unknown"; period: null };

export function eventInferenceGate(
  eventSupport: EventSupport | null | undefined,
  term: string,
): EventInferenceGate {
  if (!isValidEventSupport(eventSupport)) return { state: "unknown", period: null };
  const period = eventPeriodForTerm(eventSupport, term);
  const reference = eventSupport.periods.find((item) => item.is_reference);
  if (!period || !reference) return { state: "unknown", period: null };
  const supported = period.contributing_clusters >= EVENT_SUPPORT_MIN_CLUSTERS
    && reference.contributing_clusters >= EVENT_SUPPORT_MIN_CLUSTERS;
  return supported ? { state: "supported", period } : { state: "unsupported", period };
}

export function eventSupportCoversTerms(
  eventSupport: EventSupport | null | undefined,
  terms: Iterable<string>,
  interaction = false,
): boolean {
  if (!isValidEventSupport(eventSupport)) return false;
  const mainCoefficientTerms = new Set<string>();
  const interactionCoefficientTerms = new Set<string>();
  for (const term of terms) {
    if (!term.startsWith("k=")) continue;
    const mainTerm = term.replace("×base_gvc", "");
    if (eventPeriodForTerm(eventSupport, mainTerm) == null) return false;
    (term.endsWith("×base_gvc") ? interactionCoefficientTerms : mainCoefficientTerms).add(mainTerm);
  }
  const estimatedTerms = new Set(
    eventSupport.periods.filter((period) => period.estimated).map((period) => period.term),
  );
  const isExact = (actual: Set<string>) => actual.size === estimatedTerms.size
    && [...actual].every((term) => estimatedTerms.has(term));
  return isExact(mainCoefficientTerms)
    && (interaction ? isExact(interactionCoefficientTerms) : (
      interactionCoefficientTerms.size === 0 || isExact(interactionCoefficientTerms)
    ));
}

const termMatchesScope = (term: string, scope: PretrendScope) => {
  const interaction = term.endsWith("×base_gvc");
  return term.startsWith("k=-") && (
    scope === "joint" || (scope === "interaction" ? interaction : !interaction)
  );
};

function expectedPretrendTerms(eventSupport: EventSupport, scope: PretrendScope) {
  const estimatedNegative = eventSupport.periods.filter(
    (period) => period.estimated && period.event_time < 0,
  );
  const main = estimatedNegative.map((period) => period.term);
  const interaction = main.map((term) => `${term}×base_gvc`);
  const scoped = scope === "main" ? main : scope === "interaction" ? interaction : [...main, ...interaction];
  const supported = new Set(scoped.filter(
    (term) => eventInferenceGate(eventSupport, term).state === "supported",
  ));
  const unsupported = new Set(scoped.filter((term) => !supported.has(term)));
  return { all: new Set(scoped), supported, unsupported };
}

const sameTerms = (actual: string[], expected: Set<string>) => (
  actual.length === expected.size && actual.every((term) => expected.has(term))
);

export function eventPretrendScopeIsSafe(
  eventSupport: EventSupport | null | undefined,
  diagnostic: PretrendDiagnostic | null | undefined,
  expectedScope: PretrendScope,
): boolean {
  if (!isValidEventSupport(eventSupport) || !diagnostic || typeof diagnostic !== "object") return false;
  if (diagnostic.scope !== expectedScope) return false;
  if (
    !Array.isArray(diagnostic.terms)
    || !diagnostic.terms.every((term) => typeof term === "string")
    || new Set(diagnostic.terms).size !== diagnostic.terms.length
    || !Array.isArray(diagnostic.excluded_terms) && diagnostic.scope != null
  ) return false;
  const excluded = diagnostic.excluded_terms ?? [];
  if (
    !Array.isArray(excluded)
    || excluded.some((item) => !item || typeof item !== "object"
      || typeof item.term !== "string"
      || !termMatchesScope(item.term, expectedScope)
      || !Array.isArray(item.reasons)
      || item.reasons.length === 0
      || !item.reasons.every((reason) => typeof reason === "string" && reason.trim() !== ""))
    || new Set(excluded.map((item) => item.term)).size !== excluded.length
    || excluded.some((item) => diagnostic.terms.includes(item.term))
  ) return false;
  if (
    typeof diagnostic.available !== "boolean"
    || typeof diagnostic.interpretation !== "string"
    || diagnostic.interpretation.trim() === ""
  ) return false;
  const expected = expectedPretrendTerms(eventSupport, expectedScope);
  const expectedTerms = diagnostic.reason === "global_inference_suppressed"
    || diagnostic.reason === "no_supported_pre_terms"
    || diagnostic.reason === "no_pre_terms"
    ? new Set<string>()
    : expected.supported;
  const expectedExcluded = diagnostic.reason === "global_inference_suppressed"
    ? expected.all
    : expected.unsupported;
  if (!sameTerms(diagnostic.terms, expectedTerms)
    || !sameTerms(excluded.map((item) => item.term), expectedExcluded)) return false;
  const termsSupported = diagnostic.terms.every((term) => {
    const period = eventPeriodForTerm(eventSupport, term);
    return termMatchesScope(term, expectedScope)
      && period?.estimated === true
      && period.event_time < 0
      && eventInferenceGate(eventSupport, term).state === "supported";
  });
  if (!termsSupported) return false;
  if (
    diagnostic.reason !== "global_inference_suppressed"
    && excluded.some((item) => eventInferenceGate(eventSupport, item.term).state !== "unsupported")
  ) return false;
  if (!diagnostic.available) {
    const reason = diagnostic.reason;
    const reasonSemantics = reason === "no_pre_terms"
      ? expected.all.size === 0
      : reason === "no_supported_pre_terms"
        ? expected.all.size > 0 && expected.supported.size === 0
        : reason === "insufficient_cluster_df"
          ? diagnostic.terms.length > diagnostic.df_denom
          : reason === "singular_covariance"
            ? diagnostic.terms.length > 0 && diagnostic.terms.length <= diagnostic.df_denom
            : false;
    return typeof reason === "string"
      && SAFE_UNAVAILABLE_PRETREND_REASONS.has(reason)
      && reasonSemantics
      && diagnostic.statistic == null
      && diagnostic.p == null
      && Number.isInteger(diagnostic.df_num)
      && diagnostic.df_num === diagnostic.terms.length
      && Number.isInteger(diagnostic.df_denom)
      && diagnostic.df_denom >= 0;
  }
  return diagnostic.reason == null
    && diagnostic.terms.length > 0
    && typeof diagnostic.statistic === "number"
    && Number.isFinite(diagnostic.statistic)
    && typeof diagnostic.p === "number"
    && Number.isFinite(diagnostic.p)
    && diagnostic.p >= 0
    && diagnostic.p <= 1
    && diagnostic.statistic >= 0
    && Number.isInteger(diagnostic.df_num)
    && diagnostic.df_num === diagnostic.terms.length
    && Number.isInteger(diagnostic.df_denom)
    && diagnostic.df_denom > 0
    && diagnostic.terms.length <= diagnostic.df_denom;
}

/** A saved pretrend is inferential only when every tested lead passes the current contract. */
export function eventPretrendIsSafe(
  eventSupport: EventSupport | null | undefined,
  diagnostic: PretrendDiagnostic | null | undefined,
): boolean {
  return eventPretrendScopeIsSafe(eventSupport, diagnostic, "main");
}

export type PretrendDiagnostics = {
  pretrend?: PretrendDiagnostic;
  pretrend_tests?: Partial<Record<PretrendScope, PretrendDiagnostic>>;
};

/** Noninteraction inference requires an exhaustive main diagnostic; validate pretrend_tests when present. */
export function eventMainPretrendContractIsSafe(
  eventSupport: EventSupport | null | undefined,
  diagnostics: PretrendDiagnostics | null | undefined,
): boolean {
  if (!diagnostics || typeof diagnostics !== "object" || !diagnostics.pretrend
    || !eventPretrendScopeIsSafe(eventSupport, diagnostics.pretrend, "main")) return false;
  if (!("pretrend_tests" in diagnostics)) return true;
  const tests = diagnostics.pretrend_tests;
  return !!tests
    && typeof tests === "object"
    && !Array.isArray(tests)
    && Object.keys(tests).length === 1
    && Object.keys(tests)[0] === "main"
    && eventPretrendScopeIsSafe(eventSupport, tests.main, "main")
    && JSON.stringify(diagnostics.pretrend) === JSON.stringify(tests.main);
}

/** v7 interaction inference requires the exact main/interaction/joint scope set. */
export function eventPretrendScopesAreSafe(
  eventSupport: EventSupport | null | undefined,
  diagnostics: PretrendDiagnostics | null | undefined,
  interaction: boolean,
): boolean {
  if (!diagnostics || typeof diagnostics !== "object" || !diagnostics.pretrend) return false;
  const tests = diagnostics.pretrend_tests;
  if (!tests || typeof tests !== "object" || Array.isArray(tests)) return false;
  const expected: PretrendScope[] = interaction ? ["main", "interaction", "joint"] : ["main"];
  if (Object.keys(tests).length !== expected.length || Object.keys(tests).some((scope) => !expected.includes(scope as PretrendScope))) {
    return false;
  }
  if (!expected.every((scope) => eventPretrendScopeIsSafe(eventSupport, tests[scope], scope))) return false;
  if (interaction) {
    const main = tests.main!;
    const interactionTest = tests.interaction!;
    const joint = tests.joint!;
    const combinedTerms = new Set([...main.terms, ...interactionTest.terms]);
    const combinedExcluded = new Set([
      ...(main.excluded_terms ?? []).map((item) => item.term),
      ...(interactionTest.excluded_terms ?? []).map((item) => item.term),
    ]);
    if (
      joint.terms.length !== combinedTerms.size
      || joint.terms.some((term) => !combinedTerms.has(term))
      || (joint.excluded_terms ?? []).length !== combinedExcluded.size
      || (joint.excluded_terms ?? []).some((item) => !combinedExcluded.has(item.term))
    ) return false;
  }
  const legacyScope: PretrendScope = interaction ? "joint" : "main";
  return JSON.stringify(diagnostics.pretrend) === JSON.stringify(tests[legacyScope]);
}

export function eventInferenceAllowed(
  method: string,
  eventSupport: EventSupport | null | undefined,
  term: string,
): boolean {
  return method !== "event_study"
    || !term.startsWith("k=")
    || eventInferenceGate(eventSupport, term).state === "supported";
}

export function eventInferenceMessage(
  gate: EventInferenceGate,
  _minClusters?: number,
): string | null {
  if (gate.state === "supported") return null;
  if (gate.state === "unknown") return "逐期支持未知，推断不可用";
  return `逐期支持不足（${gate.period.contributing_clusters}/${EVENT_SUPPORT_MIN_CLUSTERS} 个聚类），推断已抑制`;
}
