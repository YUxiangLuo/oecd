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
  checking: "检查中", saving: "保存中", unsynced: "未保存", ready: "已齐全", missing: "未齐全",
};

/** Step 15 has no report material of its own: its status counts the student's three analysis answers. */
export const ANALYSIS_STATUS_LABELS: Record<StepMaterialStatus, string> = {
  ...MATERIAL_STATUS_LABELS, ready: "已完成", missing: "未完成",
};

/** The second status of a step, named after what it counts: 报告材料 (steps 1–14) or 你的分析 (step 15). */
export function stepMaterialStatusText(step: Pick<Step, "lab">, status: StepMaterialStatus): { name: string; value: string } {
  return step.lab === "rep"
    ? { name: "你的分析", value: ANALYSIS_STATUS_LABELS[status] }
    : { name: "报告材料", value: MATERIAL_STATUS_LABELS[status] };
}

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

/** Step 15's chip ("你的分析") counts only step 15's own items, the three analysis answers: steps 1–14 have
 * their own chips and the gate card lists them. Counting them here made the chip read 未齐全 next to a card
 * saying the material was complete. The sidebar counts the same step-15 items. */
export function reportMaterialStatus(
  reportGate: Array<{ step: number }> | null,
  saving = false,
  saveFailed = false,
): StepMaterialStatus {
  if (saveFailed) return "unsynced";
  if (reportGate === null) return "checking";
  if (saving) return "saving";
  return reportGate.some((item) => item.step >= 15) ? "missing" : "ready";
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

/** Shown on material cards once the report is submitted (steps that record automatically). The task card itself
 * says nothing about it: the material card of each step is the one place that does. */
export const MATERIAL_LOCKED_NOTE = "报告已提交：浏览不再自动改动报告材料。";
export const MATERIAL_LOCKED_ACTION = "改用当前图表作为报告材料（之后需在步骤 15 更新报告）";
/** After the student re-uses a choice as material on a submitted report: what to do next (as step 13 says). */
export const MATERIAL_RECHOSEN_NEXT = "请到步骤 15 更新报告并重新提交给老师。";

type ReportState = "draft" | "pending" | "graded";

/**
 * Step 15 status: a report that no longer matches the saved records needs updating, not generating;
 * a current report says where it stands with the teacher (生成 alone is not 提交).
 */
/** Step 15's report status: whether one exists, whether it still matches the record (`current`, the server's
 *  report_current), and its state. A handed-in report changed afterwards reads 需更新; the step still counts as done. */
export function reportStatusLabel(current: boolean | null | undefined, reportExists: boolean, reportState?: ReportState | null): string {
  if (!reportExists) return "未生成";
  if (current === false) return "需更新";
  return reportState === "graded" ? "已评阅" : reportState === "pending" ? "待评阅" : reportState === "draft" ? "草稿（未提交）" : "已生成";
}

export function StepTaskCard({
  step,
  complete,
  materialStatus,
  reportExists = false,
  reportState,
  reportCurrent,
}: {
  step: Step;
  complete: boolean;
  materialStatus: StepMaterialStatus;
  reportExists?: boolean;
  reportState?: ReportState | null;
  /** Whether the latest report matches the saved record (server report_current). */
  reportCurrent?: boolean | null;
}) {
  // The server counts step 15 complete only once the report is handed in, so a draft is still to do.
  const done = complete;
  const material = stepMaterialStatusText(step, materialStatus);
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
          <span className={done ? "done" : "todo"}>{completionLabel}：{step.lab === "rep" ? reportStatusLabel(reportCurrent, reportExists, reportState) : (complete ? "已完成" : "未完成")}</span>
          <span className={materialStatus === "ready" ? "done" : materialStatus === "missing" || materialStatus === "unsynced" ? "todo" : materialStatus}>
            {material.name}：{material.value}
          </span>
        </div>
      </div>
      {/* Tasks read as one light flow line (steps 11–14 have two short ones). The step's reading caveat
          (step.tip) is deliberately not shown: it distracted students. The concept is taught on the page itself. */}
      <ol className="step-task-list">
        {step.tasks.map((task) => <li key={task}>{task}</li>)}
      </ol>
    </section>
  );
}
