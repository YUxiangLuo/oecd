import {
  eventInferenceGate, eventMainPretrendContractIsSafe, eventPretrendScopesAreSafe,
  eventSupportCoversTerms, primaryEventTerm,
} from "./regression-event-support";
import type { CoefStat, EventSupport } from "./types";

/** Decide what to persist after a regression run.

The report gate needs one qualified run on each of steps 12–15.
Each step still shows the latest `run`, but an insufficient follow-up must
not erase a previously qualified estimate. */
export type RegressionResultStatus = {
  status?: string | null;
  support?: { status?: string | null; suppress_inference?: boolean } | null;
  coefs?: Pick<CoefStat, "name">[];
  event_support?: EventSupport | null;
  diagnostics?: {
    pretrend?: import("./types").PretrendDiagnostic;
    pretrend_tests?: Partial<Record<import("./types").PretrendScope, import("./types").PretrendDiagnostic>>;
  };
};

export function isQualifiedRegressionResult(
  result: RegressionResultStatus | undefined,
  method: string | undefined,
  interaction: boolean | undefined,
): boolean {
  if (!result || typeof method !== "string" || typeof interaction !== "boolean") return false;
  const support = result.support;
  const statuses = [result.status, support?.status].filter((status): status is string => typeof status === "string");
  if (statuses.length === 0 || statuses.some((status) => status !== "ok" && status !== "warning")) return false;
  if (result.status != null && support?.status != null && result.status !== support.status) return false;
  if (support?.suppress_inference === true) return false;
  if (method === "event_study") {
    const coefs = result.coefs ?? [];
    const term = primaryEventTerm(coefs);
    return term != null
      && eventSupportCoversTerms(
        result.event_support, coefs.map((coefficient) => coefficient.name), interaction,
      )
      && eventInferenceGate(result.event_support, term).state === "supported"
      && (interaction
        ? eventPretrendScopesAreSafe(result.event_support, result.diagnostics, true)
        : eventMainPretrendContractIsSafe(result.event_support, result.diagnostics));
  }
  return true;
}

function savedDesign(run: unknown): { method?: string; interaction?: boolean } {
  if (!run || typeof run !== "object" || !("design" in run)) return {};
  const design = (run as { design?: unknown }).design;
  if (!design || typeof design !== "object") return {};
  const method = "method" in design && typeof design.method === "string" ? design.method : undefined;
  const interaction = "interaction" in design && typeof design.interaction === "boolean" ? design.interaction : undefined;
  return { method, interaction };
}

export function nextRegressionSave<T extends { result?: RegressionResultStatus }>(
  current: { run?: T; qualified_run?: T } | undefined,
  nextRun: T,
): { run: T; qualified_run?: T } {
  const previousDesign = savedDesign(current?.qualified_run);
  const currentDesign = savedDesign(current?.run);
  const nextDesign = savedDesign(nextRun);
  const previousQualified = isQualifiedRegressionResult(
    current?.qualified_run?.result,
    previousDesign.method,
    previousDesign.interaction,
  )
    ? current?.qualified_run
    : (isQualifiedRegressionResult(
      current?.run?.result, currentDesign.method, currentDesign.interaction,
    ) ? current?.run : undefined);
  return {
    run: nextRun,
    qualified_run: isQualifiedRegressionResult(
      nextRun.result, nextDesign.method, nextDesign.interaction,
    ) ? nextRun : previousQualified,
  };
}
