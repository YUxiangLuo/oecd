import type { RefObject } from "react";
import type { Step } from "./types";

export const STEP_PRIMARY_ACTION_ID = "step-primary-action";

export function stepTaskTitleId(step: number): string {
  return `step-task-title-${step}`;
}

export function stepPrimaryActionLabel(step: Pick<Step, "title">): string {
  return `${step.title} · 操作区`;
}

export type StepMaterialStatus = "checking" | "saving" | "unsynced" | "ready" | "missing";

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

export function focusStepPrimaryAction(content: HTMLElement | null): boolean {
  const target = content?.querySelector<HTMLElement>(`#${STEP_PRIMARY_ACTION_ID}`) ?? null;
  if (!content || !target) return false;
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
  contentRef,
}: {
  step: Step;
  complete: boolean;
  materialStatus: StepMaterialStatus;
  contentRef: RefObject<HTMLElement | null>;
}) {
  const materialLabel = materialStatus === "checking"
    ? "正在检查"
    : materialStatus === "saving" ? "正在保存"
    : materialStatus === "unsynced" ? "尚未保存"
    : materialStatus === "ready" ? "已齐全" : "尚未齐全";
  const completionLabel = step.lab === "rep" ? "报告" : "理解题";
  const compact = step.n >= 11 && step.n <= 14 && Boolean(step.regression_outcome);
  return (
    <section className={`step-task-card${compact ? " compact" : ""}`} aria-labelledby={stepTaskTitleId(step.n)}>
      <div className="step-task-main">
        <div>
          <span className="step-task-kicker">本步任务</span>
          <h3 id={stepTaskTitleId(step.n)} tabIndex={-1}>{compact ? "先运行回归，再看结果、完成理解题。" : step.goal}</h3>
        </div>
        <div className="step-task-statuses" role="group" aria-label="本步状态">
          <span className={complete ? "done" : "todo"}>{completionLabel}：{complete ? "已完成" : "未完成"}</span>
          <span className={materialStatus === "ready" ? "done" : materialStatus === "missing" || materialStatus === "unsynced" ? "todo" : materialStatus}>
            报告材料：{materialLabel}
          </span>
        </div>
      </div>
      {!compact && <>
      <ol className="step-task-list">
        {step.tasks.map((task) => <li key={task}>{task}</li>)}
      </ol>
      <div className="step-task-actions">
        <button
          type="button"
          className="primary"
          aria-controls={STEP_PRIMARY_ACTION_ID}
          onClick={() => focusStepPrimaryAction(contentRef.current)}
        >
          开始本步
        </button>
        <details className="step-task-context">
          <summary>为什么做这一步</summary>
          <p>{step.concept}</p>
          <div className="step-task-flow">
            <span><b>输入</b>{step.handoff.input}</span>
            <span><b>动作</b>{step.handoff.action}</span>
            <span><b>输出</b>{step.handoff.output}</span>
          </div>
          <p className="step-task-tip"><b>解释边界：</b>{step.tip}</p>
          <div className="rail-chips" role="group" aria-label="关联数据与依赖">
            {step.deps.map((dependency) => <span key={dependency} className="rail-chip">{dependency}</span>)}
          </div>
        </details>
      </div>
      </>}
    </section>
  );
}
