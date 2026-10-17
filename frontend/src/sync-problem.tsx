import { createContext, useContext } from "react";

export interface SyncProblem {
  error: string | null;
  conflict: boolean;
  syncing: boolean;
  /** The save will be sent again on its own (the server or network was briefly unreachable). */
  autoRetry?: boolean;
  /** Retry the save, or load the server version after a conflict. */
  act: () => void;
}

/**
 * The tab's unsaved-record problem. A fullscreen workspace covers the page banner, so it reads this to
 * show the same warning inside the dialog: otherwise a student keeps working there believing it saved.
 */
export const SyncProblemContext = createContext<SyncProblem | null>(null);

export const SAVE_PAUSED_NOTE = "保存已暂停，当前材料尚未确认。请按页面顶部的说明处理。";

export function SyncProblemBanner({ problem, compact = false }: { problem: SyncProblem; compact?: boolean }) {
  if (!problem.error) return null;
  const conflictNote = "保存状态异常，已暂停保存以保护作业。请先复制需要保留的内容；重新载入会清除本页待保存草稿。";
  return (
    <div className={`error-box persistent-qc-warning${compact ? " sync-problem--compact" : ""}`} role="alert">
      <b>{problem.conflict ? "保存需要处理" : "实验记录尚未确认保存成功"}</b>
      {!compact && (
        <p>
          {problem.conflict
            ? conflictNote
            : `${problem.error} 本页内容还在，${problem.autoRetry ? "系统会自动重试，也可以现在重试" : "可以直接重试"}；关闭标签页可能丢失未保存的修改。`}
        </p>
      )}
      {compact && <span>{problem.conflict ? conflictNote : problem.error}</span>}
      <button type="button" className="secondary" disabled={problem.syncing} onClick={problem.act}>
        {problem.syncing
          ? problem.conflict ? "正在载入…" : "正在重试…"
          : problem.conflict ? "重新载入（清除待保存草稿）" : "重试保存"}
      </button>
    </div>
  );
}

/** Rendered inside an expanded fullscreen panel; nothing outside a student workspace or without a problem. */
export function FullscreenSyncProblem() {
  const problem = useContext(SyncProblemContext);
  return problem ? <SyncProblemBanner problem={problem} compact /> : null;
}
