import type { Step } from "./types";

export const STEP_PRIMARY_ACTION_ID = "step-primary-action";
export const STEP_MATERIAL_ACTION_ID = "step-material-action";

export function stepTaskTitleId(step: number): string {
  return `step-task-title-${step}`;
}

export function stepPrimaryActionLabel(step: Pick<Step, "title">): string {
  return `${step.title} · 操作区`;
}

export type StepMaterialStatus = "checking" | "saving" | "unsynced" | "ready" | "missing";

export const MATERIAL_STATUS_LABELS: Record<StepMaterialStatus, string> = {
  checking: "正在检查", saving: "正在保存", unsynced: "尚未保存", ready: "已齐全", missing: "尚未齐全",
};

export function materialStatusForStep(
  step: number,
  materialGate: Array<{ step: number }> | null,
  saving = false,
  saveFailed = false,
): StepMaterialStatus {
  if (saveFailed) return "unsynced";
  if (materialGate === null) return "checking";
  if (saving) return "saving";
  return materialGate.some((item) => item.step === step) ? "missing" : "ready";
}

export function focusStepPrimaryAction(content: HTMLElement | null, targetId = STEP_PRIMARY_ACTION_ID): boolean {
  const target = content?.querySelector<HTMLElement>(`#${targetId}`) ?? null;
  if (!content || !target) return false;
  if (target instanceof HTMLDetailsElement) target.open = true;
  const top = content.scrollTop + target.getBoundingClientRect().top - content.getBoundingClientRect().top - 12;
  target.focus({ preventScroll: true });
  content.scrollTo({
    top: Math.max(0, top),
    left: 0,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  return true;
}

export function StepTaskCard({
  step,
  complete,
  materialStatus,
}: {
  step: Step;
  complete: boolean;
  materialStatus: StepMaterialStatus;
}) {
  const materialLabel = MATERIAL_STATUS_LABELS[materialStatus];
  const completionLabel = step.lab === "rep" ? "报告" : "理解题";
  const compact = step.n >= 11 && step.n <= 14 && Boolean(step.regression_outcome);
  return (
    <section className={`step-task-card${compact ? " compact" : ""}`} aria-labelledby={stepTaskTitleId(step.n)}>
      <div className="step-task-main">
        <div>
          <span className="step-task-kicker">本步任务</span>
          <h3 id={stepTaskTitleId(step.n)} tabIndex={-1}>{step.goal}</h3>
        </div>
        <div className="step-task-statuses" role="group" aria-label="本步状态">
          <span className={complete ? "done" : "todo"}>{completionLabel}：{step.lab === "rep" ? (complete ? "已生成" : "未生成") : (complete ? "已完成" : "未完成")}</span>
          <span className={materialStatus === "ready" ? "done" : materialStatus === "missing" || materialStatus === "unsynced" ? "todo" : materialStatus}>
            报告材料：{materialLabel}
          </span>
        </div>
      </div>
      {!compact && <>
      {/* Tasks read as one light flow line; the step's reading caveat stays visible underneath.
          The concept is taught on the page itself (table guide, method intro, metric definitions). */}
      <ol className="step-task-list">
        {step.tasks.map((task) => <li key={task}>{task}</li>)}
      </ol>
      {step.tip && <p className="step-task-tip"><b>注意：</b>{step.tip}</p>}
      </>}
    </section>
  );
}
