/** Persistence rules for the course's single fixed TWFE design. */
export type RegressionResultStatus = {
  status?: string | null;
  support?: { status?: string | null; suppress_inference?: boolean } | null;
};

export function isQualifiedRegressionResult(
  result: RegressionResultStatus | undefined,
  method: string | undefined,
  interaction: boolean | undefined,
): boolean {
  if (!result || method !== "twfe_intensity" || interaction !== false) return false;
  const support = result.support;
  const statuses = [result.status, support?.status]
    .filter((status): status is string => typeof status === "string");
  return statuses.length > 0
    && statuses.every((status) => status === "ok" || status === "warning")
    && (result.status == null || support?.status == null || result.status === support.status)
    && support?.suppress_inference !== true;
}

function savedDesign(run: unknown): { method?: string; interaction?: boolean } {
  if (!run || typeof run !== "object" || !("design" in run)) return {};
  const design = (run as { design?: unknown }).design;
  if (!design || typeof design !== "object") return {};
  return {
    method: "method" in design && typeof design.method === "string" ? design.method : undefined,
    interaction: "interaction" in design && typeof design.interaction === "boolean" ? design.interaction : undefined,
  };
}

export function nextRegressionSave<T extends { result?: RegressionResultStatus }>(
  current: { run?: T; qualified_run?: T } | undefined,
  nextRun: T,
): { run: T; qualified_run?: T } {
  const previousDesign = savedDesign(current?.qualified_run);
  const currentDesign = savedDesign(current?.run);
  const nextDesign = savedDesign(nextRun);
  const previousQualified = isQualifiedRegressionResult(
    current?.qualified_run?.result, previousDesign.method, previousDesign.interaction,
  ) ? current?.qualified_run : isQualifiedRegressionResult(
    current?.run?.result, currentDesign.method, currentDesign.interaction,
  ) ? current?.run : undefined;
  return {
    run: nextRun,
    qualified_run: isQualifiedRegressionResult(
      nextRun.result, nextDesign.method, nextDesign.interaction,
    ) ? nextRun : previousQualified,
  };
}
