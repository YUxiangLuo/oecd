/**
 * 本步报告材料: the one card every step 1–14 shows under its main chart or table, above the quiz. It says what is
 * recorded (one sentence), how it got there (automatically with the student's choice, or by the one button inside
 * the card), and holds the only "核对读数" fold. Steps record in different ways; the card looks the same everywhere.
 */
import type { ReactNode } from "react";
import { MATERIAL_LOCKED_NOTE, MATERIAL_RECHOSEN_NEXT, STEP_MATERIAL_ACTION_ID } from "./step-task-card";

export type MaterialState = "recorded" | "missing" | "blocked";
export const MATERIAL_CARD_TITLE = "本步报告材料";
export const MATERIAL_STATE_LABELS: Record<MaterialState, string> = { recorded: "已记录", missing: "尚未记录", blocked: "暂不能记录" };
/** How the automatic steps say it (1–5, 10, 11–14): no button, the record follows the choice. */
export const AUTO_RECORD_HOW = "随你的选择自动记录，无需另外保存。";

export function MaterialCard({ state, summary, how, action, check, extra, locked = false, rechosen = false, syncing = false, syncError = null, onRetrySync, id = STEP_MATERIAL_ACTION_ID, cardRef }: {
  state: MaterialState;
  /** What is recorded, in one sentence; or why nothing is (blocked), or what to do (missing). */
  summary: ReactNode;
  /** How the record is made on this step. */
  how?: ReactNode;
  /** The one button a step offers (steps 6–9: 把这张图记为本步报告材料 / 替换 / disabled 已记录). */
  action?: { label: string; onClick?: () => void; disabled?: boolean } | null;
  /** The one fold to check the recorded readings. */
  check?: { label: string; content: ReactNode } | null;
  /** A second line (steps 11–14: the model experiment put into the report). */
  extra?: ReactNode;
  /** The report is handed in: say so, and what to do after re-recording. */
  locked?: boolean;
  rechosen?: boolean;
  syncing?: boolean;
  syncError?: string | null;
  onRetrySync?: () => void;
  id?: string;
  cardRef?: (node: HTMLElement | null) => void;
}) {
  return (
    <section id={id} ref={cardRef} tabIndex={-1} className={`material-card material-card--${state}`} aria-label={MATERIAL_CARD_TITLE}>
      <div className="material-card-head">
        <b>{MATERIAL_CARD_TITLE}</b>
        <span className={`material-chip material-chip--${state}`}>{MATERIAL_STATE_LABELS[state]}</span>
      </div>
      <p className="material-card-summary" role="status">{summary}</p>
      {extra && <p className="material-card-extra">{extra}</p>}
      {(how || locked || rechosen) && (
        <p className="muted material-card-how">
          {how}{locked ? ` ${MATERIAL_LOCKED_NOTE}` : ""}{rechosen ? MATERIAL_RECHOSEN_NEXT : ""}
        </p>
      )}
      {action && (
        <button type="button" className="secondary material-card-action" disabled={action.disabled} aria-disabled={action.disabled || undefined} onClick={(event) => {
          const ownsFocus = document.activeElement === event.currentTarget;
          const card = event.currentTarget.closest<HTMLElement>(".material-card");
          action.onClick?.();
          if (ownsFocus) card?.focus({ preventScroll: true });
        }}>
          {action.label}
        </button>
      )}
      {check && <details className="material-card-check"><summary>{check.label}</summary>{check.content}</details>}
      {syncError
        ? <p role="alert" className="material-card-sync">材料还没保存成功，请重试。{onRetrySync && <button type="button" className="secondary" onClick={onRetrySync}>重试同步</button>}</p>
        : syncing && <p className="muted material-card-sync" role="status">正在同步实验记录…</p>}
    </section>
  );
}
