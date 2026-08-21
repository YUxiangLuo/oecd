import type { CompletionSummary, Step } from "./types";

export const QC_COMPLETION_PENDING = "正在确认质检 contract 与结果，完成前不能提交本步。";

export interface CompletionBlockState {
  step: number;
  visit: number;
  reason: string | null;
}

/** A stale block can affect only the QC step and generation that created it. */
export function effectiveCompletionBlockReason(
  step: Step,
  state: CompletionBlockState | null,
  visit: number,
): string | null {
  if (step.lab !== "qc") return null;
  if (!state || state.step !== step.n || state.visit !== visit) return QC_COMPLETION_PENDING;
  return state.reason;
}

/** Hide, but never mutate, durable completion while the current step is fail-closed. */
export function completionForPresentation(
  completion: CompletionSummary | null,
  step: number,
  blockedReason: string | null,
): CompletionSummary | null {
  if (!completion || blockedReason == null || !completion.completed.includes(step)) return completion;
  const completed = completion.completed.filter((item) => item !== step);
  return {
    ...completion,
    completed,
    completed_count: completed.length,
    steps: completion.steps.map((item) => (
      item.step === step
        ? { ...item, complete: false, missing: ["当前质检结果尚未通过客户端 contract 验证"] }
        : item
    )),
  };
}

export function completedStepsForPresentation(
  completedSteps: ReadonlySet<number>,
  step: number,
  blockedReason: string | null,
): Set<number> {
  const visible = new Set(completedSteps);
  if (blockedReason != null) visible.delete(step);
  return visible;
}
