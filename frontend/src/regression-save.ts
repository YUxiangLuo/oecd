/** Decide what to persist after a regression run.

The report gate needs one qualified run on each of steps 12–15.
Each step still shows the latest `run`, but an insufficient follow-up must
not erase a previously qualified estimate. */
export type RegressionResultStatus = {
  status?: string | null;
  support?: { status?: string | null; suppress_inference?: boolean } | null;
};

export function isQualifiedRegressionResult(result: RegressionResultStatus | undefined): boolean {
  if (!result) return false;
  const support = result.support;
  const statuses = [result.status, support?.status].filter((status): status is string => typeof status === "string");
  if (statuses.length === 0 || statuses.some((status) => status !== "ok" && status !== "warning")) return false;
  return support?.suppress_inference !== true;
}

export function nextRegressionSave<T extends { result?: RegressionResultStatus }>(
  current: { run?: T; qualified_run?: T } | undefined,
  nextRun: T,
): { run: T; qualified_run?: T } {
  const previousQualified = current?.qualified_run
    ?? (isQualifiedRegressionResult(current?.run?.result) ? current?.run : undefined);
  return {
    run: nextRun,
    qualified_run: isQualifiedRegressionResult(nextRun.result) ? nextRun : previousQualified,
  };
}
